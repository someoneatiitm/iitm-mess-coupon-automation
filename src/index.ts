import 'dotenv/config';
import * as readline from 'readline';
import pkg from 'whatsapp-web.js';

import { initWhatsAppClient, sendMessage, sendMediaMessage, getGroupChats, getMyWhatsAppId, makeCall, logout, reinitializeClient, fetchChatMediaMessages } from './whatsapp/client.js';
import { GroupMonitor } from './whatsapp/groupMonitor.js';
import { DirectMessageHandler } from './whatsapp/messageHandler.js';
import { ConversationManager } from './conversation/stateMachine.js';
import { DailyTracker } from './state/dailyTracker.js';
import { loadState, saveState, loadStateForAccount, clearCurrentAccount, setCurrentAccount } from './state/persistence.js';
import { initGroqClient } from './llm/groqClient.js';
import { getConfig, phoneToWhatsAppId } from './utils/config.js';
import { logger } from './utils/logger.js';
import { detectSellMessage, detectUserCancellation } from './llm/messageParser.js';
import { generateWaitPayingMessage, generateUserDeclinedMessage, detectMessNameInMessage } from './llm/conversationAI.js';
import { Conversation, CouponType, SellMessage } from './conversation/types.js';
import { WebServer } from './web/server.js';
import { initDatabase, databaseExists } from './database/index.js';
import { needsMigration, runMigration } from './database/migrate.js';
import { startImageCleanupJob, stopImageCleanupJob } from './jobs/imageCleanup.js';

type BotMode = 'test' | 'real';

class MessCouponBot {
  private dailyTracker!: DailyTracker;
  private conversationManager!: ConversationManager;
  private groupMonitor!: GroupMonitor;
  private dmHandler!: DirectMessageHandler;
  private conversations: Map<string, Conversation> = new Map();
  private processedMessageIds: Set<string> = new Set();
  private activeSellerIds: Set<string> = new Set();

  // Confirmation resolvers
  private userConfirmationResolvers: Map<string, (value: boolean) => void> = new Map();
  private paymentConfirmationResolvers: Map<string, (value: boolean) => void> = new Map();
  private pendingConfirmationConvId: string | null = null;
  private pendingPaymentConvId: string | null = null;

  // My WhatsApp ID for confirmations
  private myWhatsAppId: string = '';
  private testPhoneIds: Set<string> = new Set();

  // Bot mode
  private mode: BotMode = 'real';

  // Preference tracking
  private pendingPreferenceType: CouponType | null = null; // Which preference we're waiting for
  private preferenceCheckDone: boolean = false; // Whether we've done morning check today
  private pendingPreferenceUpdate: boolean = false; // Whether we're waiting for preference update via "hi"

  // Skipped sell messages due to preference mismatch (can be re-processed when preference changes)
  private skippedSellMessages: Map<string, SellMessage> = new Map();

  // Web server
  private webServer: WebServer | null = null;

  async start(mode: BotMode = 'real'): Promise<void> {
    this.mode = mode;

    console.log('\n' + '='.repeat(60));
    console.log(`  MESS COUPON BOT - ${mode.toUpperCase()} MODE`);
    console.log('='.repeat(60));
    if (mode === 'test') {
      console.log('  📋 Test mode: Only test account messages will be processed');
      console.log('  📋 Groups will NOT be scanned');
    } else {
      console.log('  📋 Real mode: Full operation');
      console.log('  📋 Groups will be scanned + test account works too');
    }
    console.log('='.repeat(60) + '\n');

    logger.info(`Starting Mess Coupon Bot in ${mode.toUpperCase()} mode...`);

    // Initialize database
    logger.info('Initializing database...');
    initDatabase();

    // Run migration if needed (JSON files exist but no DB)
    if (needsMigration()) {
      logger.info('JSON files found, running migration to SQLite...');
      const migrationResult = runMigration();
      if (migrationResult.success) {
        logger.info('Migration completed successfully', {
          stateFiles: migrationResult.stateFilesMigrated,
          historyFiles: migrationResult.historyFilesMigrated,
          conversations: migrationResult.conversationsMigrated,
          deals: migrationResult.dealsMigrated
        });
      } else {
        logger.warn('Migration completed with errors', { errors: migrationResult.errors.length });
      }
    }

    // Start image cleanup job (hourly cleanup of expired coupon images)
    startImageCleanupJob();

    const config = getConfig();
    logger.info('Configuration loaded', { groups: config.groups, maxPrice: config.maxPrice });

    // Set up my WhatsApp ID and test phone IDs
    this.myWhatsAppId = phoneToWhatsAppId(config.myPhoneNumber);
    for (const phone of config.testPhoneNumbers) {
      this.testPhoneIds.add(phoneToWhatsAppId(phone));
    }
    logger.info('My WhatsApp ID', { id: this.myWhatsAppId });
    logger.info('Test phone IDs', { ids: Array.from(this.testPhoneIds) });

    initGroqClient();

    // Initialize with empty state first (will load account-specific state after login)
    const emptyState = {
      dailyState: { date: new Date().toISOString().split('T')[0], lunchBought: false, dinnerBought: false },
      conversations: new Map(),
      processedMessageIds: new Set<string>()
    };
    this.conversations = emptyState.conversations;
    this.processedMessageIds = emptyState.processedMessageIds;

    this.dailyTracker = new DailyTracker(emptyState.dailyState, () => this.saveCurrentState(), mode === 'test');
    logger.info('Initial empty state loaded (will load account data after login)');

    // Initialize conversation manager with both confirmation callbacks
    this.conversationManager = new ConversationManager(
      this.conversations,
      async (chatId, message) => {
        await this.delay(config.messageDelayMs);
        await sendMessage(chatId, message);
      },
      async (chatId, mediaBuffer, caption) => {
        await this.delay(config.messageDelayMs);
        await sendMediaMessage(chatId, mediaBuffer, caption);
      },
      () => this.myWhatsAppId,
      (sellerId) => this.testPhoneIds.has(sellerId),  // isTestAccount checker
      (convId) => this.waitForUserConfirmation(convId),
      (convId) => this.waitForPaymentConfirmation(convId),
      () => this.saveCurrentState(),
      (type, convId) => {
        this.dailyTracker.markCouponBought(type, convId);
        // Broadcast coupon purchased event to web dashboard
        if (this.webServer) {
          const conv = this.conversations.get(convId);
          this.webServer.broadcastNotification('success', 'Coupon Purchased!', `${type} coupon from ${conv?.sellerName || 'seller'}`);
          this.webServer.getIO().emit('conversationEnd', { convId, result: 'success', type });
          this.broadcastWebStatus();
        }
      },
      (type) => this.dailyTracker.getPreference(type),  // getMessPreference
      (convId, reason) => {
        // Broadcast deal failed event to web dashboard
        if (this.webServer) {
          const conv = this.conversations.get(convId);
          this.webServer.broadcastNotification('error', 'Deal Failed', `${conv?.couponType || ''} - ${reason}`);
          this.webServer.getIO().emit('conversationEnd', { convId, result: 'failed', reason });
          this.broadcastWebStatus();
        }
      },
      // fetchChatMedia callback - scan chat for existing coupon images
      // afterTimestamp: Only look for images sent after this time (to scope to current conversation)
      async (chatId, limit = 30, afterTimestamp?: Date) => {
        return fetchChatMediaMessages(chatId, limit, afterTimestamp);
      }
    );

    this.dmHandler = new DirectMessageHandler(
      async (senderId, message, mediaBuffer) => {
        await this.conversationManager.handleSellerMessage(senderId, message, mediaBuffer);
      },
      this.activeSellerIds
    );

    // Set up handler for detecting when user cancels a deal
    this.dmHandler.setUserCancellationHandler(async (sellerId, message) => {
      const isCancelling = await detectUserCancellation(message);
      if (isCancelling) {
        logger.info('User cancelled deal with seller', { sellerId: sellerId.substring(0, 15) });
        // Find and fail the conversation
        const conv = Array.from(this.conversations.values()).find(
          c => c.sellerId === sellerId &&
            c.state !== 'COMPLETED' && c.state !== 'FAILED'
        );
        if (conv) {
          conv.state = 'FAILED' as any;
          conv.failureReason = 'User cancelled';
          this.activeSellerIds.delete(sellerId);
          this.dmHandler.setActiveSellerIds(this.activeSellerIds);
          this.saveCurrentState();
          logger.info('Marked conversation as cancelled by user', { conversationId: conv.id });
        }
      }
    });

    this.groupMonitor = new GroupMonitor(
      this.processedMessageIds,
      async (sellMessage) => this.handleSellMessage(sellMessage),
      (type) => this.dailyTracker.canBuyCoupon(type) && !this.conversationManager.hasActiveConversationInProgress()
    );

    // Start web server FIRST so QR code can be displayed on frontend
    this.startWebServer();

    // Start terminal input
    this.startTerminalInput();

    // Now initialize WhatsApp client (this will trigger QR code generation)
    const client = await initWhatsAppClient(async (message) => {
      await this.handleIncomingMessage(message);
    });

    await this.waitForReady(client);

    // Get the correct WhatsApp ID for self-messaging (must be after client ready)
    const actualMyId = getMyWhatsAppId();
    if (actualMyId) {
      this.myWhatsAppId = actualMyId;
      logger.info('Updated my WhatsApp ID from client', { id: this.myWhatsAppId });

      // Extract phone number and load account-specific state
      const phoneNumber = actualMyId.replace(/@c\.us$/, '').replace(/@s\.whatsapp\.net$/, '');
      await this.loadAccountState(phoneNumber);
    }

    // Only scan groups in real mode
    if (this.mode === 'real') {
      const groups = await getGroupChats(config.groups);
      this.groupMonitor.setMonitoredGroups(groups);

      logger.info('Bot is now running in REAL mode!');
      this.printStatus();

      // Start midnight reset timer for preferences
      this.startMidnightReset();

      // Check for morning preferences
      await this.checkMorningPreferences();

      // Also check preferences every 30 minutes in case user didn't respond
      setInterval(async () => {
        await this.checkMorningPreferences();
      }, 30 * 60 * 1000);

      await this.resumeIncompleteConversations();

      logger.info('Scanning existing messages for sell offers...');
      await this.groupMonitor.scanExistingMessages();

      const POLL_INTERVAL_MS = 5 * 60 * 1000;
      setInterval(async () => {
        logger.info('Running scheduled poll...');
        await this.groupMonitor.pollLatestMessages();
        this.saveCurrentState();
      }, POLL_INTERVAL_MS);

      logger.info(`Polling scheduled every ${POLL_INTERVAL_MS / 1000 / 60} minutes`);
    } else {
      logger.info('Bot is now running in TEST mode!');
      logger.info('Waiting for messages from test account only...');
      this.printStatus();
    }
  }

  private async waitForReady(client: pkg.Client): Promise<void> {
    return new Promise((resolve) => {
      if (client.info) {
        resolve();
        return;
      }
      client.on('ready', () => resolve());
    });
  }

  private async handleIncomingMessage(message: pkg.Message): Promise<void> {
    // Debug: log all incoming messages
    logger.debug('Incoming message', {
      from: message.from,
      to: message.to,
      fromMe: message.fromMe,
      body: message.body?.substring(0, 50),
      myId: this.myWhatsAppId
    });

    // Check if this is a message from myself (for confirmations)
    // Self-chat messages have fromMe=true, so we check if it's from our own number
    const isSelfMessage = message.from === this.myWhatsAppId ||
                          (message.fromMe && !message.to?.includes('@g.us'));

    if (isSelfMessage) {
      logger.info('Detected self-message, routing to handleMyMessage');
      await this.handleMyMessage(message);
      return;
    }

    // Check if this is from a test phone number (treat as seller)
    if (this.testPhoneIds.has(message.from) && !message.fromMe) {
      await this.handleTestPhoneMessage(message);
      return;
    }

    // First check if it's a DM from an active seller
    await this.dmHandler.handleMessage(message);

    // Then check if it's a group message
    await this.groupMonitor.handleMessage(message);
  }

  // Handle messages from my own WhatsApp (for confirmations)
  private async handleMyMessage(message: pkg.Message): Promise<void> {
    const text = message.body.trim();
    const lowerText = text.toLowerCase();

    logger.info('=== SELF MESSAGE RECEIVED ===', {
      text: text.substring(0, 50),
      lowerText: lowerText.substring(0, 50),
      from: message.from,
      to: message.to,
      fromMe: message.fromMe,
      pendingConfirmation: this.pendingConfirmationConvId,
      pendingPayment: this.pendingPaymentConvId,
      pendingPreference: this.pendingPreferenceType,
      isOkMessage: ['ok', 'okay', 'yes', 'y'].includes(lowerText)
    });

    // Check for preference response (number input)
    if (this.pendingPreferenceType && /^\d+$/.test(text)) {
      const preference = DailyTracker.parsePreferenceResponse(text);

      if (preference === undefined) {
        // Invalid number, ask again
        await this.sendToSelf('Invalid number. Please enter a valid option number.');
        return;
      }

      // Handle preference update via "hi" command
      // Convert single preference to array (null = any, string = single-element array)
      const preferenceArray = preference ? [preference] : null;
      if (this.pendingPreferenceUpdate) {
        const updatedType = this.pendingPreferenceType!;
        if (updatedType === 'lunch') {
          this.dailyTracker.setLunchPreference(preferenceArray);
        } else {
          this.dailyTracker.setDinnerPreference(preferenceArray);
        }

        const prefDisplay = preference || 'Any';
        await this.sendToSelf(`✅ ${updatedType.toUpperCase()} preference updated to: ${prefDisplay}\n\n${this.dailyTracker.getStatus()}`);
        logger.info('Preference updated via hi command', { type: updatedType, preference: prefDisplay });

        this.pendingPreferenceType = null;
        this.pendingPreferenceUpdate = false;
        this.saveCurrentState();

        // Re-process skipped messages with new preference (newest first)
        await this.reprocessSkippedMessages(updatedType);
        return;
      }

      // Handle initial morning preference setup
      if (this.pendingPreferenceType === 'lunch') {
        this.dailyTracker.setLunchPreference(preferenceArray);
        logger.info('Lunch preference set', { preference: preference || 'any' });
        this.pendingPreferenceType = null;

        // Now ask for dinner preference
        if (this.dailyTracker.needsDinnerPreference()) {
          await this.askForPreference('dinner');
        }
      } else if (this.pendingPreferenceType === 'dinner') {
        this.dailyTracker.setDinnerPreference(preferenceArray);
        logger.info('Dinner preference set', { preference: preference || 'any' });
        this.pendingPreferenceType = null;

        // Both preferences collected
        const lunchPref = this.dailyTracker.getLunchPreference();
        const dinnerPref = this.dailyTracker.getDinnerPreference();
        const lunchDisplay = lunchPref && lunchPref.length > 0 ? lunchPref.join(', ') : 'Any';
        const dinnerDisplay = dinnerPref && dinnerPref.length > 0 ? dinnerPref.join(', ') : 'Any';
        await this.sendToSelf(`✅ Preferences saved!\n\nLunch: ${lunchDisplay}\nDinner: ${dinnerDisplay}\n\nNow looking for matching coupons...`);
      }
      return;
    }

    // Check for "stop" command - pause current session
    if (lowerText === 'stop') {
      const { stoppedSession, nextSession } = this.dailyTracker.stopCurrentSession();

      if (!stoppedSession) {
        await this.sendToSelf('No active session to stop.');
        return;
      }

      let message = `⏹️ ${stoppedSession.toUpperCase()} session STOPPED.`;

      if (nextSession) {
        message += `\n\nNow looking for ${nextSession.toUpperCase()} coupons.`;
      } else {
        message += `\n\nNo more sessions for today.`;
      }

      message += `\n\n${this.dailyTracker.getStatus()}`;
      await this.sendToSelf(message);
      this.saveCurrentState();
      logger.info('Session stopped via WhatsApp', { stopped: stoppedSession, next: nextSession });
      return;
    }

    // Check for "start" command - resume paused session
    if (lowerText === 'start') {
      const { startedSession } = this.dailyTracker.startSession();

      if (!startedSession) {
        await this.sendToSelf('No session to start. All sessions are either completed or past their cutoff time.');
        return;
      }

      const message = `▶️ ${startedSession.toUpperCase()} session STARTED.\n\nNow looking for ${startedSession} coupons.\n\n${this.dailyTracker.getStatus()}`;
      await this.sendToSelf(message);
      this.saveCurrentState();
      logger.info('Session started via WhatsApp', { started: startedSession });
      return;
    }

    // Check for "status" command via WhatsApp
    if (lowerText === 'status') {
      await this.sendToSelf(this.dailyTracker.getStatus());
      return;
    }

    // Check for "reset" command - reset both sessions to needed
    if (lowerText === 'reset') {
      this.dailyTracker.forceResetSession('lunch');
      this.dailyTracker.forceResetSession('dinner');
      await this.sendToSelf(`🔄 SESSIONS RESET\n\nBoth lunch and dinner sessions have been reset.\nNow searching for coupons again.\n\n${this.dailyTracker.getStatus()}`);
      this.saveCurrentState();
      logger.info('Both sessions reset via WhatsApp');
      return;
    }

    // Check for "hi" command - show preference menu for current session
    if (lowerText === 'hi' || lowerText === 'hello') {
      const currentSession = this.dailyTracker.getCurrentSession();
      if (!currentSession) {
        await this.sendToSelf('No active session right now. Both lunch and dinner are either bought or past cutoff time.');
        return;
      }

      const currentPref = this.dailyTracker.getPreference(currentSession);
      const currentPrefDisplay = currentPref && currentPref.length > 0 ? currentPref.join(', ') : 'Any';
      let message = `🍽️ ${currentSession.toUpperCase()} PREFERENCE UPDATE\n\n`;
      message += `Current preference: ${currentPrefDisplay}\n\n`;
      message += `Select new preference:\n\n`;
      message += `0. Any (no preference)\n`;

      const { IITM_MESSES } = await import('./conversation/types.js');
      IITM_MESSES.forEach((mess, index) => {
        message += `${index + 1}. ${mess}\n`;
      });

      message += `\nReply with the number to update.`;

      this.pendingPreferenceUpdate = true;
      this.pendingPreferenceType = currentSession;
      await this.sendToSelf(message);
      return;
    }

    // Check for "ok" confirmation
    if (lowerText === 'ok' || lowerText === 'okay' || lowerText === 'yes' || lowerText === 'y') {
      logger.info('Detected OK/YES message', {
        pendingConfirmationConvId: this.pendingConfirmationConvId,
        pendingPaymentConvId: this.pendingPaymentConvId,
        resolversCount: this.userConfirmationResolvers.size
      });

      if (this.pendingConfirmationConvId) {
        const resolver = this.userConfirmationResolvers.get(this.pendingConfirmationConvId);
        const conv = this.conversations.get(this.pendingConfirmationConvId);
        logger.info('Looking up conversation for confirmation', {
          hasResolver: !!resolver,
          hasConv: !!conv,
          convId: this.pendingConfirmationConvId,
          conversationIds: Array.from(this.conversations.keys())
        });

        if (resolver && conv) {
          logger.info('User confirmed via WhatsApp, sending wait message to seller', {
            seller: conv.sellerName,
            sellerId: conv.sellerId
          });

          // Send "wait, paying" message to seller
          try {
            const waitMsg = await generateWaitPayingMessage();
            await sendMessage(conv.sellerId, waitMsg);
            logger.info('Wait message sent to seller');
          } catch (error) {
            logger.error('Failed to send wait message to seller', error);
          }

          // Clear confirmation state BEFORE resolving to avoid race conditions
          const convId = this.pendingConfirmationConvId;
          this.pendingConfirmationConvId = null;
          this.userConfirmationResolvers.delete(convId);

          // Resolve the promise (this triggers payment confirmation flow)
          resolver(true);
          logger.info('Confirmation resolved, payment flow should start');

          // Broadcast updated status
          this.broadcastWebStatus();
        } else {
          logger.warn('Could not find resolver or conversation', {
            pendingId: this.pendingConfirmationConvId,
            conversationIds: Array.from(this.conversations.keys()),
            resolverKeys: Array.from(this.userConfirmationResolvers.keys())
          });
        }
      } else {
        logger.info('No pending confirmation to process (user may have already confirmed or timed out)');
      }
      return; // Don't process further after handling confirmation
    }

    // Check for "no" / "cancel"
    if (lowerText === 'no' || lowerText === 'cancel' || lowerText === 'n') {
      if (this.pendingConfirmationConvId) {
        const resolver = this.userConfirmationResolvers.get(this.pendingConfirmationConvId);
        const conv = this.conversations.get(this.pendingConfirmationConvId);
        if (resolver) {
          logger.info('User declined via WhatsApp');

          // Send cancellation message to seller
          if (conv) {
            const cancelMsg = await generateUserDeclinedMessage();
            await sendMessage(conv.sellerId, cancelMsg);
            logger.info('Sent cancellation message to seller', { sellerId: conv.sellerId });
          }

          resolver(false);
          this.userConfirmationResolvers.delete(this.pendingConfirmationConvId);
          this.pendingConfirmationConvId = null;
        }
      }
    }

    // Check for "paid" confirmation
    if (lowerText === 'paid' || lowerText === 'done' || lowerText === 'sent') {
      if (this.pendingPaymentConvId) {
        const resolver = this.paymentConfirmationResolvers.get(this.pendingPaymentConvId);
        if (resolver) {
          logger.info('Payment confirmed via WhatsApp');
          resolver(true);
          this.paymentConfirmationResolvers.delete(this.pendingPaymentConvId);
          this.pendingPaymentConvId = null;
        }
      }
    }
  }

  // Handle messages from test phone number (simulate seller)
  private async handleTestPhoneMessage(message: pkg.Message): Promise<void> {
    logger.info('Received message from test phone', {
      from: message.from,
      body: message.body.substring(0, 100)
    });

    // Check if this is already an active seller
    if (this.activeSellerIds.has(message.from)) {
      // Process as seller message
      let mediaBuffer: Buffer | undefined;
      if (message.hasMedia) {
        try {
          const media = await message.downloadMedia();
          if (media && media.data) {
            mediaBuffer = Buffer.from(media.data, 'base64');
          }
        } catch (error) {
          logger.error('Failed to download media', error);
        }
      }
      await this.conversationManager.handleSellerMessage(message.from, message.body || '', mediaBuffer);
      return;
    }

    // Check if this is a sell message
    const detection = await detectSellMessage(message.body);

    if (detection.isSelling && detection.couponType && detection.confidence > 0.5) {
      logger.info('Test phone sell message detected!', {
        couponType: detection.couponType,
        confidence: detection.confidence
      });

      if (!this.dailyTracker.canBuyCoupon(detection.couponType)) {
        logger.info('Already have this coupon type, skipping');
        return;
      }

      const contact = await message.getContact();

      const sellMessage: SellMessage = {
        messageId: message.id._serialized,
        senderId: message.from,
        senderName: contact.pushname || contact.name || 'Test Seller',
        groupId: 'test_chat',
        groupName: 'Test Chat',
        couponType: detection.couponType,
        rawMessage: message.body,
        timestamp: new Date(message.timestamp * 1000)
      };

      await this.handleSellMessage(sellMessage);
    }
  }

  private async resumeIncompleteConversations(): Promise<void> {
    const activeConvs = this.conversationManager.getActiveConversations();

    if (activeConvs.length === 0) {
      logger.info('No incomplete conversations to resume');
      return;
    }

    logger.info(`Found ${activeConvs.length} incomplete conversation(s) to resume`);

    for (const conv of activeConvs) {
      // Check time since last activity (updatedAt), not creation time
      const lastActivityMs = Date.now() - new Date(conv.updatedAt).getTime();
      const lastActivityMinutes = Math.round(lastActivityMs / 60000);

      // Test accounts are exempt from the 10-minute timeout
      const isTestSeller = this.testPhoneIds.has(conv.sellerId);

      // If no activity for 10 minutes, consider deal dead (unless test account)
      if (!isTestSeller && lastActivityMs > 10 * 60 * 1000) {
        logger.info(`No activity for ${lastActivityMinutes} mins, marking as failed`, {
          id: conv.id,
          seller: conv.sellerName
        });
        conv.state = 'FAILED' as any;
        conv.failureReason = 'No response for 10+ minutes';
        continue;
      }

      logger.info(`Resuming conversation with ${conv.sellerName}`, {
        id: conv.id,
        state: conv.state,
        lastActivity: `${lastActivityMinutes} mins ago`
      });

      this.activeSellerIds.add(conv.sellerId);
      await this.conversationManager.resumeConversation(conv);
    }

    this.dmHandler.setActiveSellerIds(this.activeSellerIds);
    this.saveCurrentState();
  }

  private async handleSellMessage(sellMessage: SellMessage): Promise<void> {
    logger.info('Processing sell message', {
      seller: sellMessage.senderName,
      couponType: sellMessage.couponType,
      group: sellMessage.groupName,
      rawMessage: sellMessage.rawMessage.substring(0, 50)
    });

    // Clean up old skipped messages (older than 20 minutes)
    this.cleanupOldSkippedMessages();

    // Check mess preference (only in real mode)
    // If mess is mentioned and doesn't match any preference, skip but store for later
    // If mess is NOT mentioned, allow through (state machine will ask seller)
    if (this.mode === 'real') {
      const preferences = this.dailyTracker.getPreference(sellMessage.couponType);

      if (preferences !== null && preferences.length > 0) {
        // User has specific mess preferences
        const messInMessage = detectMessNameInMessage(sellMessage.rawMessage);

        if (messInMessage) {
          // Mess IS mentioned - check if it matches any of the preferences
          const matches = preferences.some(pref =>
            messInMessage.toLowerCase() === pref.toLowerCase()
          );
          if (!matches) {
            logger.info('Sell message has different mess, storing for later', {
              preferences,
              messInMessage,
              message: sellMessage.rawMessage.substring(0, 50)
            });
            // Store for later in case preference changes
            this.skippedSellMessages.set(sellMessage.messageId, sellMessage);
            return;
          }
          logger.info('Sell message matches mess preference!', { preferences, messInMessage });
        } else {
          // Mess NOT mentioned - allow through, state machine will ask seller
          logger.info('Mess not mentioned in sell message, will ask seller', { preferences });
        }
      }
    }

    // Remove from skipped if it was there (preference may have changed)
    this.skippedSellMessages.delete(sellMessage.messageId);

    const conversation = await this.conversationManager.startOrResumeConversation(sellMessage);

    if (!conversation) {
      logger.info('No action needed for this seller');
      return;
    }

    this.activeSellerIds.add(sellMessage.senderId);
    this.dmHandler.setActiveSellerIds(this.activeSellerIds);
    this.saveCurrentState();

    logger.info('Conversation active', { conversationId: conversation.id, state: conversation.state });
  }

  // Clean up skipped messages older than 20 minutes
  private cleanupOldSkippedMessages(): void {
    const cutoffTime = Date.now() - (20 * 60 * 1000);
    for (const [messageId, sellMessage] of this.skippedSellMessages.entries()) {
      if (sellMessage.timestamp.getTime() < cutoffTime) {
        this.skippedSellMessages.delete(messageId);
      }
    }
  }

  // Re-process skipped messages when preference changes (newest first)
  private async reprocessSkippedMessages(couponType: CouponType): Promise<void> {
    this.cleanupOldSkippedMessages();

    // Get messages of the relevant coupon type, sorted by timestamp (newest first)
    const relevantMessages = Array.from(this.skippedSellMessages.values())
      .filter(msg => msg.couponType === couponType)
      .sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime());

    if (relevantMessages.length === 0) {
      logger.info('No skipped messages to re-process');
      return;
    }

    logger.info(`Re-processing ${relevantMessages.length} skipped ${couponType} messages (newest first)`);

    for (const sellMessage of relevantMessages) {
      // Check if we already have an active conversation or don't need this coupon anymore
      if (!this.dailyTracker.canBuyCoupon(couponType)) {
        logger.info('No longer need this coupon type, stopping re-process');
        break;
      }

      if (this.conversationManager.hasActiveConversationInProgress()) {
        logger.info('Already have an active conversation, stopping re-process');
        break;
      }

      logger.info(`Re-processing skipped message from ${sellMessage.senderName}`, {
        timestamp: sellMessage.timestamp.toISOString(),
        message: sellMessage.rawMessage.substring(0, 50)
      });

      await this.handleSellMessage(sellMessage);
    }
  }

  private waitForUserConfirmation(conversationId: string): Promise<boolean> {
    return new Promise((resolve) => {
      this.pendingConfirmationConvId = conversationId;
      this.userConfirmationResolvers.set(conversationId, resolve);

      // Broadcast status to show confirmation prompt on dashboard
      this.broadcastWebStatus();

      // Call user after 25 seconds if no response
      const callTimeout = setTimeout(async () => {
        if (this.userConfirmationResolvers.has(conversationId)) {
          logger.info('No response after 25 seconds, calling user...');
          try {
            const called = await makeCall(this.myWhatsAppId);
            if (called) {
              logger.info('Call initiated to notify user');
            } else {
              logger.warn('Could not initiate call, waiting for manual response');
            }
          } catch (error) {
            logger.error('Failed to call user', error);
          }
        }
      }, 25 * 1000);

      // Timeout after 2 minutes - if no response, decline the deal
      setTimeout(() => {
        clearTimeout(callTimeout); // Clear the call timeout if still pending
        if (this.userConfirmationResolvers.has(conversationId)) {
          logger.warn('User confirmation timed out after 2 minutes');
          this.userConfirmationResolvers.delete(conversationId);
          if (this.pendingConfirmationConvId === conversationId) {
            this.pendingConfirmationConvId = null;
          }
          resolve(false);
        }
      }, 2 * 60 * 1000);
    });
  }

  private waitForPaymentConfirmation(conversationId: string): Promise<boolean> {
    return new Promise((resolve) => {
      this.pendingPaymentConvId = conversationId;
      this.paymentConfirmationResolvers.set(conversationId, resolve);

      // Broadcast status to show payment prompt on dashboard
      this.broadcastWebStatus();

      // Also accept terminal input
      console.log('\n' + '='.repeat(50));
      console.log('Waiting for payment...');
      console.log('Type "paid" when done, or reply "paid" on WhatsApp');
      console.log('='.repeat(50) + '\n');

      // Timeout after 10 minutes
      setTimeout(() => {
        if (this.paymentConfirmationResolvers.has(conversationId)) {
          logger.warn('Payment confirmation timed out');
          this.paymentConfirmationResolvers.delete(conversationId);
          if (this.pendingPaymentConvId === conversationId) {
            this.pendingPaymentConvId = null;
          }
          resolve(false);
        }
      }, 10 * 60 * 1000);
    });
  }

  private startTerminalInput(): void {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout
    });

    rl.on('line', (input) => {
      const trimmed = input.trim().toLowerCase();

      // Handle "ok" for user confirmation
      if (trimmed === 'ok' || trimmed === 'okay' || trimmed === 'yes' || trimmed === 'y') {
        if (this.pendingConfirmationConvId) {
          const resolver = this.userConfirmationResolvers.get(this.pendingConfirmationConvId);
          const conv = this.conversations.get(this.pendingConfirmationConvId);
          if (resolver && conv) {
            logger.info('User confirmed via terminal, sending wait message to seller');

            // Send "wait, paying" message to seller
            generateWaitPayingMessage().then(async (waitMsg) => {
              await sendMessage(conv.sellerId, waitMsg);
            }).catch(err => logger.error('Failed to send wait message', err));

            resolver(true);
            this.userConfirmationResolvers.delete(this.pendingConfirmationConvId);
            this.pendingConfirmationConvId = null;
          }
        }
      }

      // Handle "no" for user confirmation
      if (trimmed === 'no' || trimmed === 'n') {
        if (this.pendingConfirmationConvId) {
          const resolver = this.userConfirmationResolvers.get(this.pendingConfirmationConvId);
          const conv = this.conversations.get(this.pendingConfirmationConvId);
          if (resolver) {
            logger.info('User declined via terminal');

            // Send cancellation message to seller
            if (conv) {
              generateUserDeclinedMessage().then(async (cancelMsg) => {
                await sendMessage(conv.sellerId, cancelMsg);
                logger.info('Sent cancellation message to seller', { sellerId: conv.sellerId });
              }).catch(err => logger.error('Failed to send cancel message', err));
            }

            resolver(false);
            this.userConfirmationResolvers.delete(this.pendingConfirmationConvId);
            this.pendingConfirmationConvId = null;
          }
        }
      }

      // Handle payment confirmation
      if (trimmed === 'paid' || trimmed === 'p' || trimmed === 'done') {
        if (this.pendingPaymentConvId) {
          const resolver = this.paymentConfirmationResolvers.get(this.pendingPaymentConvId);
          if (resolver) {
            logger.info('Payment confirmed via terminal');
            resolver(true);
            this.paymentConfirmationResolvers.delete(this.pendingPaymentConvId);
            this.pendingPaymentConvId = null;
          }
        } else {
          console.log('No pending payment to confirm');
        }
      }

      if (trimmed === 'cancel' || trimmed === 'c') {
        // Cancel user confirmation
        if (this.pendingConfirmationConvId) {
          const resolver = this.userConfirmationResolvers.get(this.pendingConfirmationConvId);
          const conv = this.conversations.get(this.pendingConfirmationConvId);
          if (resolver) {
            // Send cancellation message to seller
            if (conv) {
              generateUserDeclinedMessage().then(async (cancelMsg) => {
                await sendMessage(conv.sellerId, cancelMsg);
                logger.info('Sent cancellation message to seller', { sellerId: conv.sellerId });
              }).catch(err => logger.error('Failed to send cancel message', err));
            }

            resolver(false);
            this.userConfirmationResolvers.delete(this.pendingConfirmationConvId);
            this.pendingConfirmationConvId = null;
          }
        }
        // Cancel payment confirmation
        if (this.pendingPaymentConvId) {
          const resolver = this.paymentConfirmationResolvers.get(this.pendingPaymentConvId);
          if (resolver) {
            resolver(false);
            this.paymentConfirmationResolvers.delete(this.pendingPaymentConvId);
            this.pendingPaymentConvId = null;
          }
        }
      }

      if (trimmed === 'stop') {
        const { stoppedSession, nextSession } = this.dailyTracker.stopCurrentSession();
        if (!stoppedSession) {
          console.log('No active session to stop.');
        } else {
          console.log(`\n⏹️  ${stoppedSession.toUpperCase()} session STOPPED.`);
          if (nextSession) {
            console.log(`Now looking for ${nextSession.toUpperCase()} coupons.`);
          } else {
            console.log('No more sessions for today.');
          }
          this.printStatus();
        }
      }

      if (trimmed === 'start') {
        const { startedSession } = this.dailyTracker.startSession();
        if (!startedSession) {
          console.log('No session to start. All sessions are either completed or past their cutoff time.');
        } else {
          console.log(`\n▶️  ${startedSession.toUpperCase()} session STARTED.`);
          console.log(`Now looking for ${startedSession} coupons.`);
          this.printStatus();
        }
      }

      if (trimmed === 'status' || trimmed === 's') {
        this.printStatus();
      }

      if (trimmed === 'help' || trimmed === 'h') {
        this.printHelp();
      }

      if (trimmed === 'quit' || trimmed === 'q') {
        logger.info('Shutting down...');
        this.saveCurrentState();
        process.exit(0);
      }
    });
  }

  private printStatus(): void {
    console.log('\n' + '─'.repeat(50));
    console.log(`MESS COUPON BOT STATUS [${this.mode.toUpperCase()} MODE]`);
    console.log('─'.repeat(50));
    console.log(this.dailyTracker.getStatus());

    const activeConvs = this.conversationManager.getActiveConversations();
    if (activeConvs.length > 0) {
      console.log(`\nActive Conversations: ${activeConvs.length}`);
      for (const conv of activeConvs) {
        console.log(`  - ${conv.sellerName} (${conv.couponType}): ${conv.state}`);
      }
    } else {
      console.log('\nNo active conversations');
    }

    if (this.conversationManager.hasActiveConversationInProgress()) {
      console.log('\n⏸️  New chats paused - waiting for current seller');
    }

    if (this.pendingConfirmationConvId) {
      console.log('\n⏳ Waiting for your confirmation (reply "ok" or "no")');
    }

    if (this.pendingPaymentConvId) {
      console.log('\n💰 Waiting for payment confirmation (reply "paid")');
    }

    const neededType = this.dailyTracker.getNeededCouponType();
    if (neededType) {
      console.log(`\nLooking for: ${neededType.toUpperCase()} coupon`);
    } else {
      console.log('\nAll coupons bought for today!');
    }
    console.log('─'.repeat(50) + '\n');
  }

  private printHelp(): void {
    console.log('\n' + '─'.repeat(50));
    console.log('COMMANDS');
    console.log('─'.repeat(50));
    console.log('  ok / yes     - Confirm purchase');
    console.log('  no           - Decline purchase');
    console.log('  paid / p     - Confirm payment was made');
    console.log('  cancel / c   - Cancel current action');
    console.log('  stop         - Stop current session (lunch/dinner)');
    console.log('  start        - Resume paused session');
    console.log('  status / s   - Show current status');
    console.log('  help / h     - Show this help');
    console.log('  quit / q     - Save and exit');
    console.log('─'.repeat(50) + '\n');
  }

  private startWebServer(): void {
    const port = parseInt(process.env.WEB_PORT || '3000', 10);

    this.webServer = new WebServer(port, {
      onStartSession: () => {
        const result = this.dailyTracker.startSession();
        this.saveCurrentState();
        if (result.startedSession) {
          this.webServer?.broadcastNotification('success', 'Session Started', `Now looking for ${result.startedSession} coupons`);
        }
        return result;
      },

      onStopSession: () => {
        const result = this.dailyTracker.stopCurrentSession();
        this.saveCurrentState();
        if (result.stoppedSession) {
          this.webServer?.broadcastNotification('info', 'Session Stopped', `${result.stoppedSession} session stopped`);
        }
        return result;
      },

      onSetPreference: (type: CouponType, messNames: string[] | null) => {
        if (type === 'lunch') {
          this.dailyTracker.setLunchPreference(messNames);
        } else {
          this.dailyTracker.setDinnerPreference(messNames);
        }
        this.saveCurrentState();
        // Re-process skipped messages with new preference (newest first)
        this.reprocessSkippedMessages(type).catch(err =>
          logger.error('Failed to reprocess skipped messages', err)
        );
      },

      onConfirmPurchase: () => {
        if (this.pendingConfirmationConvId) {
          const resolver = this.userConfirmationResolvers.get(this.pendingConfirmationConvId);
          const conv = this.conversations.get(this.pendingConfirmationConvId);
          if (resolver && conv) {
            logger.info('User confirmed via web dashboard');
            generateWaitPayingMessage().then(async (waitMsg) => {
              await sendMessage(conv.sellerId, waitMsg);
            }).catch(err => logger.error('Failed to send wait message', err));
            resolver(true);
            this.userConfirmationResolvers.delete(this.pendingConfirmationConvId);
            this.pendingConfirmationConvId = null;
          }
        }
      },

      onDeclinePurchase: () => {
        if (this.pendingConfirmationConvId) {
          const resolver = this.userConfirmationResolvers.get(this.pendingConfirmationConvId);
          const conv = this.conversations.get(this.pendingConfirmationConvId);
          if (resolver) {
            logger.info('User declined via web dashboard');
            if (conv) {
              generateUserDeclinedMessage().then(async (cancelMsg) => {
                await sendMessage(conv.sellerId, cancelMsg);
              }).catch(err => logger.error('Failed to send cancel message', err));
            }
            resolver(false);
            this.userConfirmationResolvers.delete(this.pendingConfirmationConvId);
            this.pendingConfirmationConvId = null;
          }
        }
      },

      onConfirmPayment: () => {
        if (this.pendingPaymentConvId) {
          const resolver = this.paymentConfirmationResolvers.get(this.pendingPaymentConvId);
          if (resolver) {
            logger.info('Payment confirmed via web dashboard');
            resolver(true);
            this.paymentConfirmationResolvers.delete(this.pendingPaymentConvId);
            this.pendingPaymentConvId = null;
          }
        }
      },

      onToggleSessionStatus: (type: CouponType) => {
        const result = this.dailyTracker.toggleSessionStatus(type);
        const typeCap = type.charAt(0).toUpperCase() + type.slice(1);
        if (result.newStatus === 'needed') {
          this.webServer?.broadcastNotification('info', 'Session Reset', `${typeCap} reset to needed - searching again`);
        } else {
          this.webServer?.broadcastNotification('success', 'Session Marked', `${typeCap} marked as bought`);
        }
        logger.info('Toggle session status via web dashboard', { type, newStatus: result.newStatus });
        this.saveCurrentState();
        return result;
      },

      onLogout: async () => {
        logger.info('Logout requested');
        await logout();

        // Clear current account from persistence
        clearCurrentAccount();

        // Clear all in-memory state for privacy
        this.conversations.clear();
        this.processedMessageIds.clear();
        this.activeSellerIds.clear();
        this.skippedSellMessages.clear();
        this.userConfirmationResolvers.clear();
        this.paymentConfirmationResolvers.clear();
        this.pendingConfirmationConvId = null;
        this.pendingPaymentConvId = null;
        this.pendingPreferenceType = null;
        this.pendingPreferenceUpdate = false;

        // Reset daily tracker to empty state (not for any specific user)
        this.dailyTracker.reset();

        logger.info('Session cleared, reinitializing for new login...');

        // Reinitialize WhatsApp client for new session
        try {
          await reinitializeClient(async () => {
            // Called when new client is ready (after QR scan)
            const newId = getMyWhatsAppId();
            if (newId) {
              this.myWhatsAppId = newId;
              logger.info('Updated WhatsApp ID for new session', { id: this.myWhatsAppId });

              // Extract phone number and load account-specific state
              const phoneNumber = newId.replace(/@c\.us$/, '').replace(/@s\.whatsapp\.net$/, '');
              await this.loadAccountState(phoneNumber);
            }
          });
          logger.info('WhatsApp client reinitialized - waiting for new QR scan');
        } catch (error) {
          logger.error('Failed to reinitialize WhatsApp client', error);
        }
      },

      onRestart: async () => {
        logger.info('Restart requested');
        process.exit(0);
      },

      getStatus: () => ({
        mode: this.mode,
        dailyStatus: this.dailyTracker.getStatus(),
        lunchPreference: this.dailyTracker.getLunchPreference(),
        dinnerPreference: this.dailyTracker.getDinnerPreference(),
        currentSession: this.dailyTracker.getCurrentSession(),
        lunchPaused: this.dailyTracker.isSessionPaused('lunch'),
        dinnerPaused: this.dailyTracker.isSessionPaused('dinner'),
        lunchBought: this.dailyTracker.isSessionBought('lunch'),
        dinnerBought: this.dailyTracker.isSessionBought('dinner')
      }),

      getActiveConversations: () => {
        return this.conversationManager.getActiveConversations();
      },

      getPendingConfirmation: () => ({
        convId: this.pendingConfirmationConvId,
        conversation: this.pendingConfirmationConvId
          ? this.conversations.get(this.pendingConfirmationConvId) || null
          : null
      }),

      getPendingPayment: () => ({
        convId: this.pendingPaymentConvId,
        conversation: this.pendingPaymentConvId
          ? this.conversations.get(this.pendingPaymentConvId) || null
          : null
      }),

      getConversationMessages: (conversationId: string) => {
        return this.conversationManager.getConversationMessages(conversationId);
      },

      onManualComplete: async (conversationId: string) => {
        return this.conversationManager.manuallyCompleteConversation(conversationId);
      },

      onManualFail: async (conversationId: string, reason?: string) => {
        return this.conversationManager.manuallyFailConversation(conversationId, reason);
      }
    });

    this.webServer.start();
    this.webServer.setupWhatsAppCallbacks();
  }

  // Broadcast status update to web clients
  private broadcastWebStatus(): void {
    if (this.webServer) {
      this.webServer.broadcastStatus();
    }
  }

  // Load state for a specific account (called after WhatsApp login)
  private async loadAccountState(phoneNumber: string): Promise<void> {
    logger.info('Loading account-specific state', { phone: '••••••' + phoneNumber.slice(-4) });

    // Load state for this account
    const state = loadStateForAccount(phoneNumber);

    // Check if this is a returning user (has existing data)
    const isReturningUser = state.conversations.size > 0 ||
                            state.processedMessageIds.size > 0 ||
                            state.dailyState.lunchBought ||
                            state.dailyState.dinnerBought ||
                            state.dailyState.lunchMessPreference !== undefined ||
                            state.dailyState.dinnerMessPreference !== undefined;

    if (isReturningUser) {
      logger.info('Returning user detected - loading saved data', {
        phone: '••••••' + phoneNumber.slice(-4),
        conversations: state.conversations.size,
        lunchStatus: state.dailyState.lunchBought ? 'BOUGHT' : 'NEEDED',
        dinnerStatus: state.dailyState.dinnerBought ? 'BOUGHT' : 'NEEDED',
        lunchPreference: state.dailyState.lunchMessPreference || 'Any',
        dinnerPreference: state.dailyState.dinnerMessPreference || 'Any'
      });
    } else {
      logger.info('New user detected - starting fresh', {
        phone: '••••••' + phoneNumber.slice(-4)
      });
    }

    // Clear existing in-memory state (but keep the same Map/Set references!)
    this.conversations.clear();
    this.processedMessageIds.clear();
    this.activeSellerIds.clear();
    this.skippedSellMessages.clear();

    // Copy loaded state INTO existing maps (don't reassign - ConversationManager has reference to these!)
    for (const [id, conv] of state.conversations) {
      this.conversations.set(id, conv);
    }
    for (const msgId of state.processedMessageIds) {
      this.processedMessageIds.add(msgId);
    }

    // Rebuild active seller IDs from conversations
    for (const conv of this.conversations.values()) {
      if (conv.state !== 'COMPLETED' && conv.state !== 'FAILED') {
        this.activeSellerIds.add(conv.sellerId);
      }
    }

    // Update daily tracker with account's state
    this.dailyTracker = new DailyTracker(state.dailyState, () => this.saveCurrentState(), this.mode === 'test');

    // Update DM handler with new active sellers
    this.dmHandler.setActiveSellerIds(this.activeSellerIds);

    logger.info('Account state loaded successfully', {
      isReturningUser,
      conversations: this.conversations.size,
      processedMessages: this.processedMessageIds.size,
      dailyStatus: this.dailyTracker.getStatus()
    });

    // Notify web dashboard
    if (this.webServer) {
      if (isReturningUser) {
        this.webServer.broadcastNotification('success', 'Welcome Back!', 'Your saved data has been loaded');
      } else {
        this.webServer.broadcastNotification('info', 'Welcome!', 'New account - starting fresh');
      }
    }

    // Broadcast updated status to web clients
    this.broadcastWebStatus();
  }

  private saveCurrentState(): void {
    saveState(
      this.dailyTracker.getState(),
      this.conversations,
      this.processedMessageIds
    );
    // Broadcast status update to web clients
    this.broadcastWebStatus();
  }

  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  // Send message to self with error handling
  private async sendToSelf(message: string): Promise<void> {
    try {
      await sendMessage(this.myWhatsAppId, message);
    } catch (error) {
      logger.warn('Failed to send WhatsApp message to self', { error });
      console.log('\n' + '='.repeat(50));
      console.log(message);
      console.log('='.repeat(50) + '\n');
    }
  }

  // Ask for mess preference
  private async askForPreference(type: CouponType): Promise<void> {
    this.pendingPreferenceType = type;
    const message = DailyTracker.generatePreferenceMessage(type);
    await this.sendToSelf(message);
    logger.info(`Asked for ${type} preference`);
  }

  // Check and send morning preference messages (only in real mode)
  private async checkMorningPreferences(): Promise<void> {
    // Only check in real mode and during morning (12am-12pm)
    if (this.mode !== 'real') return;
    if (!this.dailyTracker.isMorning()) return;
    if (this.preferenceCheckDone) return;

    // Check if we need to ask for lunch preference
    if (this.dailyTracker.needsLunchPreference()) {
      logger.info('Morning preference check - asking for lunch preference');
      await this.askForPreference('lunch');
      this.preferenceCheckDone = true;
      return;
    }

    // If lunch is already set but dinner isn't asked yet
    if (this.dailyTracker.needsDinnerPreference()) {
      logger.info('Morning preference check - asking for dinner preference');
      await this.askForPreference('dinner');
      this.preferenceCheckDone = true;
      return;
    }

    this.preferenceCheckDone = true;
  }

  // Reset preference check flag at midnight
  private startMidnightReset(): void {
    const checkReset = () => {
      const now = new Date();
      if (now.getHours() === 0 && now.getMinutes() === 0) {
        this.preferenceCheckDone = false;
        logger.info('Midnight - reset preference check flag');
      }
    };

    // Check every minute
    setInterval(checkReset, 60 * 1000);
  }
}

// Parse command line argument for mode
const args = process.argv.slice(2);
let mode: BotMode = 'real';

if (args.includes('test') || args.includes('--test') || args.includes('-t')) {
  mode = 'test';
} else if (args.includes('real') || args.includes('--real') || args.includes('-r')) {
  mode = 'real';
} else if (args.length > 0) {
  console.log('Usage: npm start -- [test|real]');
  console.log('  test  - Test mode: only test account, no group scanning');
  console.log('  real  - Real mode: full operation (default)');
  process.exit(1);
}

const bot = new MessCouponBot();
bot.start(mode).catch((error) => {
  logger.error('Fatal error', error);
  process.exit(1);
});

process.on('SIGINT', () => {
  logger.info('Received SIGINT, shutting down...');
  stopImageCleanupJob();
  process.exit(0);
});

process.on('SIGTERM', () => {
  logger.info('Received SIGTERM, shutting down...');
  stopImageCleanupJob();
  process.exit(0);
});
