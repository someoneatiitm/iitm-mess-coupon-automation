import { Conversation, ConversationState, CouponType, SellMessage, ChatMessage } from './types.js';
import { randomUUID } from 'crypto';
import { analyzeSellerResponse, detectSellerCancellation, detectRefundConfirmation } from '../llm/messageParser.js';
import { generateInitialMessage, generateAskUpiMessage, generateDeclineMessage, generatePaymentConfirmation, generatePaymentDoneWithThanks, generatePayingNowMessage, generateThankYouMessage, generateNotAvailableResponse, generateCouponRequestMessage, generateCancelMessageToSeller, setSellerContext, clearSellerContext, generateWaitingAcknowledgment, generateConversationalResponse, generateWrongImageQuestion, generateSellerCancelFollowUp, generateConvinceSeller, generateRefundRequest, generateAcceptCancellation, generateAskRefundScreenshot, generateRefundThanks, generateRefundConversation, generateRefundFollowUp, detectMessNameInMessage, generateAskMessNameMessage, generateMessMismatchDecline } from '../llm/conversationAI.js';
import { saveCouponImage, recordSuccessfulDeal, recordFailedDeal } from '../state/history.js';
import { sendPaymentNotification, sendSuccessNotification } from '../payment/notifier.js';
import { isLikelyCouponImage } from '../utils/qrDetector.js';
import { logger } from '../utils/logger.js';

// Patterns where seller is asking us to wait - we should respond friendly
const WAIT_PATTERNS = [
  'hold on', 'holdon', 'wait', 'one sec', '1 sec', 'one min', '1 min',
  'sending', 'will send', 'sending now', 'ruk', 'ruko', 'ek min', 'ek sec',
  'abhi bhejta', 'abhi bhej raha', 'bhej raha', 'just a moment', 'moment',
  'give me a sec', 'give me a min', 'coming', 'on the way'
];

// Patterns for acknowledgment messages that don't need a response
const ACKNOWLEDGMENT_PATTERNS = [
  'ok', 'okay', 'k', 'done', 'sure', 'alright', 'fine', 'haan', 'ha', 'theek'
];

// Track seller cancellation follow-up state per conversation
// 0 = no cancellation detected, 1 = asked what happened, 2 = tried to convince, 3 = accepted cancellation
const sellerCancelFollowUpState: Map<string, number> = new Map();

// Store early coupon images (received before AWAITING_COUPON state)
// This handles cases where seller sends coupon before payment is confirmed
const earlyCouponImages: Map<string, Buffer> = new Map();

// Store ALL images received from seller during conversation
// This is a backup in case real-time handlers or chat scanning miss images
const receivedImagesPerConversation: Map<string, Buffer[]> = new Map();

type SendMessageFn = (chatId: string, message: string) => Promise<void>;
type SendMediaFn = (chatId: string, mediaBuffer: Buffer, caption: string) => Promise<void>;
type WaitForConfirmationFn = (conversationId: string) => Promise<boolean>;
type GetMyIdFn = () => string;
type IsTestAccountFn = (sellerId: string) => boolean;
type GetMessPreferenceFn = (couponType: CouponType) => string[] | null;
type FetchChatMediaFn = (chatId: string, limit?: number, afterTimestamp?: Date) => Promise<Buffer[]>;

// Fixed price - no negotiation
const FIXED_PRICE = 70;

// Time window to check for recent conversations (10 minutes)
const RECENT_CONVERSATION_WINDOW_MS = 10 * 60 * 1000;

// Extract phone number from WhatsApp ID (e.g., "919876543210@c.us" -> "9876543210")
function extractPhoneFromWhatsAppId(whatsappId: string): string | null {
  const cleaned = whatsappId.replace(/@c\.us$/, '').replace(/@s\.whatsapp\.net$/, '');

  if (cleaned.startsWith('91') && cleaned.length === 12) {
    return cleaned.substring(2);
  }

  if (/^\d{10}$/.test(cleaned)) {
    return cleaned;
  }

  return cleaned;
}

export class ConversationManager {
  private conversations: Map<string, Conversation>;
  private sendMessage: SendMessageFn;
  private sendMediaMessage: SendMediaFn;
  private getMyWhatsAppId: GetMyIdFn;
  private isTestAccount: IsTestAccountFn;
  private waitForUserConfirmation: WaitForConfirmationFn;
  private waitForPaymentConfirmation: WaitForConfirmationFn;
  private onConversationUpdate: () => void;
  private onCouponPurchased: (type: CouponType, conversationId: string) => void;
  private getMessPreference: GetMessPreferenceFn;
  private onConversationFailed: (conversationId: string, reason: string) => void;
  private fetchChatMedia: FetchChatMediaFn;

  // Track current active conversation (only ONE at a time)
  private currentConversationId: string | null = null;

  constructor(
    conversations: Map<string, Conversation>,
    sendMessage: SendMessageFn,
    sendMediaMessage: SendMediaFn,
    getMyWhatsAppId: GetMyIdFn,
    isTestAccount: IsTestAccountFn,
    waitForUserConfirmation: WaitForConfirmationFn,
    waitForPaymentConfirmation: WaitForConfirmationFn,
    onConversationUpdate: () => void,
    onCouponPurchased: (type: CouponType, conversationId: string) => void,
    getMessPreference: GetMessPreferenceFn,
    onConversationFailed: (conversationId: string, reason: string) => void = () => {},
    fetchChatMedia: FetchChatMediaFn = async () => []
  ) {
    this.conversations = conversations;
    this.sendMessage = sendMessage;
    this.sendMediaMessage = sendMediaMessage;
    this.getMyWhatsAppId = getMyWhatsAppId;
    this.isTestAccount = isTestAccount;
    this.waitForUserConfirmation = waitForUserConfirmation;
    this.waitForPaymentConfirmation = waitForPaymentConfirmation;
    this.onConversationUpdate = onConversationUpdate;
    this.onCouponPurchased = onCouponPurchased;
    this.getMessPreference = getMessPreference;
    this.onConversationFailed = onConversationFailed;
    this.fetchChatMedia = fetchChatMedia;
  }

  // Check if we have an active conversation (only ONE seller at a time)
  hasActiveConversationInProgress(): boolean {
    return this.currentConversationId !== null;
  }

  // Scan for any existing images from the seller
  // First checks in-memory storage, then falls back to fetching from chat
  // In AWAITING_COUPON state, ANY image from the seller is likely the coupon
  // IMPORTANT: Only considers images sent AFTER the conversation started (to avoid old coupon images from previous deals)
  private async scanChatForCouponImage(conversation: Conversation): Promise<Buffer | null> {
    try {
      // FIRST: Check images we've already received and stored in memory
      // This is the most reliable source since we captured these in real-time
      const storedImages = receivedImagesPerConversation.get(conversation.id);
      if (storedImages && storedImages.length > 0) {
        logger.info('Found stored image(s) from seller in memory!', {
          conversationId: conversation.id,
          imageCount: storedImages.length
        });
        // Return the most recent stored image
        return storedImages[storedImages.length - 1];
      }

      // SECOND: Fetch from chat as fallback
      // Only look for images sent AFTER this conversation started
      const conversationStartTime = new Date(conversation.createdAt);
      logger.info('No stored images, scanning chat for images from seller (after conversation start)', {
        conversationId: conversation.id,
        sellerId: conversation.sellerId.substring(0, 15),
        conversationStartTime: conversationStartTime.toISOString()
      });

      // Fetch recent media messages from the chat (last 50 messages to be thorough)
      // Pass conversation start time to filter out old images from previous deals
      const mediaBuffers = await this.fetchChatMedia(conversation.sellerId, 50, conversationStartTime);

      if (mediaBuffers.length === 0) {
        logger.debug('No media found in chat after conversation start', { conversationId: conversation.id });
        return null;
      }

      // Return the most recent image - in AWAITING_COUPON state, any image is likely the coupon
      // The mediaBuffers are returned with most recent first
      logger.info('Found image(s) in chat from seller (after conversation start)!', {
        conversationId: conversation.id,
        imageCount: mediaBuffers.length
      });
      return mediaBuffers[0]; // Return the most recent image
    } catch (error) {
      logger.error('Failed to scan for images', { conversationId: conversation.id, error });
      return null;
    }
  }

  // Send message to self with error handling (WhatsApp self-messaging can be tricky)
  private async sendToSelf(message: string): Promise<void> {
    try {
      const myWhatsAppId = this.getMyWhatsAppId();
      await this.sendMessage(myWhatsAppId, message);
    } catch (error) {
      // Self-messaging failed, log and continue (user can use terminal)
      logger.warn('Failed to send WhatsApp message to self, use terminal instead', { error });
      console.log('\n' + '='.repeat(50));
      console.log(message);
      console.log('='.repeat(50) + '\n');
    }
  }

  // Send media to self with error handling
  private async sendMediaToSelf(mediaBuffer: Buffer, caption: string): Promise<void> {
    try {
      const myWhatsAppId = this.getMyWhatsAppId();
      await this.sendMediaMessage(myWhatsAppId, mediaBuffer, caption);
    } catch (error) {
      logger.warn('Failed to send WhatsApp media to self', { error });
      console.log('\n' + '='.repeat(50));
      console.log(caption);
      console.log('(Media saved but could not be sent via WhatsApp)');
      console.log('='.repeat(50) + '\n');
    }
  }

  getCurrentConversationId(): string | null {
    return this.currentConversationId;
  }

  // Add a message to conversation history
  private addMessage(conv: Conversation, sender: 'bot' | 'seller', text: string, hasMedia: boolean = false): void {
    if (!conv.messages) {
      conv.messages = [];
    }
    conv.messages.push({
      id: randomUUID(),
      sender,
      text,
      timestamp: new Date(),
      hasMedia
    });
    // Keep only last 50 messages to avoid memory issues
    if (conv.messages.length > 50) {
      conv.messages = conv.messages.slice(-50);
    }
  }

  // Send message to seller and track it
  private async sendToSeller(conv: Conversation, message: string): Promise<void> {
    await this.sendMessage(conv.sellerId, message);
    this.addMessage(conv, 'bot', message);
  }

  // Get messages for a conversation
  getConversationMessages(conversationId: string): ChatMessage[] {
    const conv = this.conversations.get(conversationId);
    return conv?.messages || [];
  }

  // Check if seller had a failed conversation today (blocked for the day)
  // Test accounts are never blocked
  isSellerBlockedToday(sellerId: string): boolean {
    // Test accounts are exempt from blocking
    if (this.isTestAccount(sellerId)) {
      return false;
    }

    const today = new Date();
    today.setHours(0, 0, 0, 0);

    return Array.from(this.conversations.values()).some(c =>
      c.sellerId === sellerId &&
      c.state === ConversationState.FAILED &&
      new Date(c.createdAt).getTime() >= today.getTime()
    );
  }

  // Find recent conversation with this seller (within 1 hour)
  findRecentConversation(sellerId: string, couponType: CouponType): Conversation | null {
    const cutoffTime = Date.now() - RECENT_CONVERSATION_WINDOW_MS;

    const recentConversations = Array.from(this.conversations.values())
      .filter(c =>
        c.sellerId === sellerId &&
        c.couponType === couponType &&
        new Date(c.createdAt).getTime() > cutoffTime
      )
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

    return recentConversations.length > 0 ? recentConversations[0] : null;
  }

  // Check if we should contact this seller or resume existing conversation
  async startOrResumeConversation(sellMessage: SellMessage): Promise<Conversation | null> {
    // Check if this seller is blocked for today (had a failed/cancelled deal)
    if (this.isSellerBlockedToday(sellMessage.senderId)) {
      logger.info('Seller blocked for today (previous deal failed/cancelled), skipping', {
        seller: sellMessage.senderName
      });
      return null;
    }

    // Only ONE seller at a time - check if we already have an active conversation
    if (this.currentConversationId) {
      const currentConv = this.conversations.get(this.currentConversationId);
      if (currentConv && currentConv.state !== ConversationState.COMPLETED && currentConv.state !== ConversationState.FAILED) {
        // Already talking to someone else - don't start new chat
        if (currentConv.sellerId !== sellMessage.senderId) {
          logger.info('Already in conversation with another seller, skipping new seller', {
            currentSeller: currentConv.sellerName,
            newSeller: sellMessage.senderName
          });
          return null;
        }
      }
    }

    // Check for recent conversation with this seller
    const recentConv = this.findRecentConversation(sellMessage.senderId, sellMessage.couponType);

    if (recentConv) {
      logger.info('Found recent conversation with this seller', {
        conversationId: recentConv.id,
        state: recentConv.state,
        age: Math.round((Date.now() - new Date(recentConv.createdAt).getTime()) / 60000) + ' mins'
      });

      if (recentConv.state === ConversationState.COMPLETED) {
        // Test accounts can start new conversations even after completing a deal
        if (this.isTestAccount(sellMessage.senderId)) {
          logger.info('Test account - allowing new conversation despite recent completed deal');
        } else {
          logger.info('Already completed a deal with this seller recently, skipping');
          return null;
        }
      } else if (recentConv.state !== ConversationState.FAILED) {
        logger.info('Conversation still active, resuming...', { state: recentConv.state });
        return await this.resumeConversation(recentConv);
      }

      // Failed conversation handled by isSellerBlockedToday check above
    }

    return await this.startConversation(sellMessage);
  }

  // Resume an incomplete conversation
  async resumeConversation(conversation: Conversation): Promise<Conversation> {
    this.currentConversationId = conversation.id;

    logger.info('Resuming conversation', {
      id: conversation.id,
      state: conversation.state,
      seller: conversation.sellerName
    });

    // Set seller context for gender-aware messaging
    await setSellerContext(conversation.sellerName);

    switch (conversation.state) {
      case ConversationState.INITIATING_CONTACT:
      case ConversationState.AWAITING_PAYMENT_INFO:
        const askUpi = await generateAskUpiMessage();
        await this.sendToSeller(conversation, askUpi);
        conversation.state = ConversationState.AWAITING_PAYMENT_INFO;
        break;

      case ConversationState.PAYMENT_PENDING:
        if (conversation.upiId) {
          logger.info('Resuming payment pending state');
          await this.requestUserConfirmationAndPay(conversation);
        } else {
          const msg = await generateAskUpiMessage();
          await this.sendToSeller(conversation, msg);
          conversation.state = ConversationState.AWAITING_PAYMENT_INFO;
        }
        break;

      case ConversationState.AWAITING_COUPON:
        logger.info('Resuming - waiting for coupon from seller');
        break;
    }

    conversation.updatedAt = new Date();
    this.onConversationUpdate();
    return conversation;
  }

  async startConversation(sellMessage: SellMessage): Promise<Conversation> {
    const id = `conv_${Date.now()}_${Math.random().toString(36).substring(7)}`;

    // Check if mess name is mentioned in the sell message
    const messNameInMessage = detectMessNameInMessage(sellMessage.rawMessage);

    const conversation: Conversation = {
      id,
      sellerId: sellMessage.senderId,
      sellerName: sellMessage.senderName,
      couponType: sellMessage.couponType,
      state: ConversationState.INITIATING_CONTACT,
      price: FIXED_PRICE,
      upiId: null,
      groupId: sellMessage.groupId,
      groupName: sellMessage.groupName,
      originalMessageId: sellMessage.messageId,
      createdAt: new Date(),
      updatedAt: new Date(),
      messName: messNameInMessage || undefined
    };

    this.conversations.set(id, conversation);
    this.currentConversationId = id;
    logger.info('Starting new conversation', {
      id,
      seller: sellMessage.senderName,
      couponType: sellMessage.couponType,
      messNameDetected: messNameInMessage || 'none'
    });

    // Set seller context for gender-aware messaging
    await setSellerContext(sellMessage.senderName);

    // Check if user has a mess preference (can be multiple)
    const userPreferences = this.getMessPreference(sellMessage.couponType);
    const hasSpecificPreference = userPreferences !== null && userPreferences.length > 0;

    // If mess name is in the message, check against preferences (if any)
    if (messNameInMessage) {
      if (hasSpecificPreference) {
        const matches = userPreferences.some(pref =>
          messNameInMessage.toLowerCase() === pref.toLowerCase()
        );
        if (!matches) {
          logger.info('Mess name mismatch with preferences, declining', {
            messInMessage: messNameInMessage,
            userPreferences
          });
          const preferenceDisplay = userPreferences.join(' or ');
          const declineMsg = await generateMessMismatchDecline(preferenceDisplay, messNameInMessage);
          await this.sendMessage(sellMessage.senderId, declineMsg);
          await this.failConversation(conversation, `Mess mismatch: wanted ${preferenceDisplay}, got ${messNameInMessage}`);
          return conversation;
        }
        logger.info('Mess name matches one of the preferences!', { mess: messNameInMessage, userPreferences });
      } else {
        // No preference but mess name is known - store it
        logger.info('Mess name detected in sell message', { mess: messNameInMessage });
      }

      // Mess name is known - include it in the initial message so buyer knows which mess
      const initialMessage = await generateInitialMessage(sellMessage.couponType, sellMessage.groupName, messNameInMessage);
      await this.sendMessage(sellMessage.senderId, initialMessage);

      conversation.state = ConversationState.AWAITING_PAYMENT_INFO;
      conversation.updatedAt = new Date();
      this.onConversationUpdate();

      return conversation;
    }

    // Mess name NOT mentioned - ALWAYS ask for it regardless of preference
    // This ensures we always know which mess the coupon is for
    logger.info('Mess name not mentioned in sell message, will ask seller', {
      hasPreference: hasSpecificPreference,
      preferences: userPreferences
    });

    const initialMessage = await generateInitialMessage(sellMessage.couponType, sellMessage.groupName);
    await this.sendMessage(sellMessage.senderId, initialMessage);

    // Ask for mess name
    const askMessMsg = await generateAskMessNameMessage();
    await this.sendMessage(sellMessage.senderId, askMessMsg);

    conversation.state = ConversationState.AWAITING_MESS_INFO;
    conversation.updatedAt = new Date();
    this.onConversationUpdate();
    return conversation;
  }

  async handleSellerMessage(sellerId: string, message: string, mediaBuffer?: Buffer): Promise<void> {
    const conversation = Array.from(this.conversations.values()).find(
      c => c.sellerId === sellerId &&
        c.state !== ConversationState.COMPLETED &&
        c.state !== ConversationState.FAILED
    );

    if (!conversation) {
      logger.debug('No active conversation for seller', { sellerId });
      return;
    }

    // Track incoming message
    this.addMessage(conversation, 'seller', message || (mediaBuffer ? '[Image]' : ''), !!mediaBuffer);

    logger.info('Processing seller message', {
      conversationId: conversation.id,
      state: conversation.state,
      hasMedia: !!mediaBuffer,
      message: message.substring(0, 100)
    });

    // Store ALL images received from seller during this conversation
    // This ensures we never miss a coupon image
    if (mediaBuffer) {
      logger.info('Image received from seller, storing in conversation history', {
        conversationId: conversation.id,
        currentState: conversation.state
      });

      // Store in received images map
      const existingImages = receivedImagesPerConversation.get(conversation.id) || [];
      existingImages.push(mediaBuffer);
      receivedImagesPerConversation.set(conversation.id, existingImages);

      // If not in AWAITING_COUPON state yet, also store as early coupon
      if (conversation.state !== ConversationState.AWAITING_COUPON) {
        logger.info('Early image received (before AWAITING_COUPON state), storing for later', {
          conversationId: conversation.id,
          currentState: conversation.state
        });
        earlyCouponImages.set(conversation.id, mediaBuffer);
        // Acknowledge receipt so seller doesn't resend
        await this.sendToSeller(conversation, 'Got it, thanks! Just confirming payment.');
      }
    }

    switch (conversation.state) {
      case ConversationState.AWAITING_MESS_INFO:
        await this.handleAwaitingMessInfo(conversation, message);
        break;

      case ConversationState.AWAITING_PAYMENT_INFO:
        await this.handleAwaitingPaymentInfo(conversation, message);
        break;

      case ConversationState.PAYMENT_PENDING:
        await this.handlePaymentPending(conversation, message, mediaBuffer);
        break;

      case ConversationState.AWAITING_COUPON:
        await this.handleAwaitingCoupon(conversation, message, mediaBuffer);
        break;

      case ConversationState.AWAITING_REFUND:
        await this.handleAwaitingRefund(conversation, message);
        break;

      case ConversationState.AWAITING_REFUND_SCREENSHOT:
        await this.handleAwaitingRefundScreenshot(conversation, message, mediaBuffer);
        break;
    }
  }

  private async handleAwaitingMessInfo(conversation: Conversation, message: string): Promise<void> {
    const lowerMessage = message.toLowerCase().trim();

    // Ignore very short acknowledgments like "ok", "k", "hm" - don't respond, wait for actual answer
    const isShortAck = lowerMessage.length <= 2 || ['ok', 'okay', 'k', 'hm', 'hmm', 'yes', 'ya', 'ha', 'haan'].includes(lowerMessage);
    if (isShortAck) {
      logger.debug('Short acknowledgment received, waiting for mess name', { message: lowerMessage });
      return; // Just wait, don't spam them
    }

    // Check if seller is asking to wait
    const isWaitMessage = WAIT_PATTERNS.some(p => lowerMessage.includes(p));
    if (isWaitMessage) {
      logger.info('Seller asking to wait, responding friendly', { message: lowerMessage });
      const ackResponse = await generateWaitingAcknowledgment();
      await this.sendToSeller(conversation, ackResponse);
      return;
    }

    // Try to detect mess name in the response
    const messName = detectMessNameInMessage(message);

    if (messName) {
      logger.info('Mess name detected in seller response', { messName });
      conversation.messName = messName;

      // Check against user's preferences (can be multiple)
      const userPreferences = this.getMessPreference(conversation.couponType);

      if (userPreferences !== null && userPreferences.length > 0) {
        const matches = userPreferences.some(pref =>
          messName.toLowerCase() === pref.toLowerCase()
        );
        if (!matches) {
          logger.info('Mess name mismatch with preferences, declining', {
            messFromSeller: messName,
            userPreferences
          });
          const preferenceDisplay = userPreferences.join(' or ');
          const declineMsg = await generateMessMismatchDecline(preferenceDisplay, messName);
          await this.sendToSeller(conversation, declineMsg);
          await this.failConversation(conversation, `Mess mismatch: wanted ${preferenceDisplay}, got ${messName}`);
          return;
        }
        logger.info('Mess name matches one of the preferences!', { mess: messName, userPreferences });
      }

      // Mess matches or no preference - continue to normal flow
      conversation.state = ConversationState.AWAITING_PAYMENT_INFO;
      conversation.updatedAt = new Date();
      this.onConversationUpdate();

      // Ask for UPI
      const askUpi = await generateAskUpiMessage();
      await this.sendToSeller(conversation, askUpi);
      return;
    }

    // Check for not available
    const analysis = await analyzeSellerResponse(message);
    if (analysis.available === false) {
      const response = await generateNotAvailableResponse();
      await this.sendToSeller(conversation, response);
      await this.failConversation(conversation, 'Coupon not available');
      return;
    }

    // Mess name NOT detected - respond conversationally and ask again
    // This ensures we ALWAYS get the mess name before proceeding
    logger.info('Mess name not detected in response, asking again', { message: message.substring(0, 50) });

    const response = await generateConversationalResponse(message, 'asking which mess the coupon is for');
    await this.sendToSeller(conversation, response);

    // Ask again for mess name
    const askMessMsg = await generateAskMessNameMessage();
    await this.sendToSeller(conversation, askMessMsg);
  }

  private async handleAwaitingPaymentInfo(conversation: Conversation, message: string): Promise<void> {
    const lowerMessage = message.toLowerCase().trim();

    // Check if seller is just asking us to wait - respond friendly
    const isWaitMessage = WAIT_PATTERNS.some(p => lowerMessage.includes(p));
    if (isWaitMessage) {
      logger.info('Seller asking to wait, responding friendly', { message: lowerMessage });
      const ackResponse = await generateWaitingAcknowledgment();
      await this.sendToSeller(conversation, ackResponse);
      return;
    }

    // Check if seller is trying to cancel the deal
    const cancelState = sellerCancelFollowUpState.get(conversation.id) || 0;
    const cancellation = detectSellerCancellation(message);

    if (cancellation.isCancelling && cancellation.confidence > 0.5) {
      logger.info('Seller trying to cancel deal (before payment)', { state: cancelState, message: lowerMessage });

      if (cancelState === 0) {
        // First time - ask what happened
        const followUp = await generateSellerCancelFollowUp(message);
        await this.sendToSeller(conversation, followUp);
        sellerCancelFollowUpState.set(conversation.id, 1);
        return;
      } else if (cancelState === 1) {
        // Second time - try to convince
        const convince = await generateConvinceSeller();
        await this.sendToSeller(conversation, convince);
        sellerCancelFollowUpState.set(conversation.id, 2);
        return;
      } else {
        // Third time - accept cancellation
        const accept = await generateAcceptCancellation(false);
        await this.sendToSeller(conversation, accept);
        sellerCancelFollowUpState.delete(conversation.id);
        await this.failConversation(conversation, 'Seller cancelled the deal');
        return;
      }
    }

    // If seller responds positively after cancellation attempt, reset state
    if (cancelState > 0) {
      const analysis = await analyzeSellerResponse(message);
      if (analysis.agreesToSale === true || analysis.available === true) {
        logger.info('Seller changed mind, continuing deal');
        sellerCancelFollowUpState.delete(conversation.id);
      }
    }

    const analysis = await analyzeSellerResponse(message);

    // If clarification is needed, ask a clarifying question instead of assuming
    if (analysis.needsClarification && analysis.clarificationQuestion) {
      logger.info('Asking clarification question', { question: analysis.clarificationQuestion });
      await this.sendToSeller(conversation, analysis.clarificationQuestion);
      this.onConversationUpdate();
      return;
    }

    // Only fail if EXPLICITLY not available (not just unclear)
    if (analysis.available === false) {
      const response = await generateNotAvailableResponse();
      await this.sendToSeller(conversation, response);
      await this.failConversation(conversation, 'Coupon not available');
      return;
    }

    if (analysis.price !== null && analysis.price > FIXED_PRICE) {
      const declineMsg = await generateDeclineMessage();
      await this.sendToSeller(conversation, declineMsg);
      await this.failConversation(conversation, `Price ${analysis.price} > ${FIXED_PRICE}`);
      return;
    }

    // Determine UPI ID
    let upiId: string | null = null;

    if (analysis.useSameNumber) {
      const sellerPhone = extractPhoneFromWhatsAppId(conversation.sellerId);
      if (sellerPhone) {
        upiId = `${sellerPhone}@upi`;
        logger.info('Using seller WhatsApp number for payment', { phone: sellerPhone });
      }
    } else if (analysis.upiId) {
      upiId = analysis.upiId;
    } else if (analysis.phoneNumber) {
      upiId = `${analysis.phoneNumber}@upi`;
    }

    if (upiId) {
      // Seller gave payment details - set as current active conversation
      this.currentConversationId = conversation.id;

      conversation.upiId = upiId;
      conversation.state = ConversationState.PAYMENT_PENDING;
      conversation.updatedAt = new Date();

      logger.info('Payment details received, requesting user confirmation', {
        seller: conversation.sellerName,
        upiId: upiId
      });

      await this.requestUserConfirmationAndPay(conversation);
      return;
    }

    // If seller said something conversational (agreeing, etc.) but no UPI, respond and ask for UPI
    if (analysis.agreesToSale === true || analysis.available === true) {
      logger.info('Seller agrees but no UPI provided, asking for UPI');
      const askUpi = await generateAskUpiMessage();
      await this.sendToSeller(conversation, askUpi);
      this.onConversationUpdate();
      return;
    }

    // If message is conversational, respond naturally then ask for UPI
    if (message.length > 5 && !analysis.needsMoreInfo) {
      const response = await generateConversationalResponse(message, 'negotiating coupon purchase, need UPI details');
      await this.sendToSeller(conversation, response);
      return;
    }

    // No UPI yet - ask again
    const askUpi = await generateAskUpiMessage();
    await this.sendToSeller(conversation, askUpi);
    this.onConversationUpdate();
  }

  // Handle messages while waiting for user to confirm payment
  private async handlePaymentPending(conversation: Conversation, message: string, mediaBuffer?: Buffer): Promise<void> {
    const lowerMessage = message.toLowerCase().trim();

    // If seller sends an image while we're pending payment, store it as early coupon
    if (mediaBuffer) {
      logger.info('Image received while payment pending, storing as early coupon', { conversationId: conversation.id });
      earlyCouponImages.set(conversation.id, mediaBuffer);
      const existingImages = receivedImagesPerConversation.get(conversation.id) || [];
      existingImages.push(mediaBuffer);
      receivedImagesPerConversation.set(conversation.id, existingImages);
      // Acknowledge receipt
      await this.sendToSeller(conversation, 'Got it, thanks! Just completing payment.');
      return;
    }

    // Ignore very short acknowledgments
    const isShortAck = lowerMessage.length <= 2 || ['ok', 'okay', 'k', 'hm', 'hmm', 'yes', 'ya', 'ha', 'haan'].includes(lowerMessage);
    if (isShortAck) {
      logger.debug('Short acknowledgment during payment pending, ignoring', { message: lowerMessage });
      return;
    }

    // Check if seller is asking about payment status (e.g., "paid?", "done?", "payment?", "bheji?", "bheja?")
    const paymentQueryPatterns = [
      'paid', 'pay', 'payment', 'done', 'sent', 'send', 'kiya', 'kia', 'bheja', 'bheji',
      'bhej', 'kar', 'diya', 'dia', 'ho gaya', 'hogaya', 'hua', 'money', 'paisa', 'paise',
      '?', 'bro', 'bhai', 'dude', 'yaar', 'waiting', 'wait'
    ];

    const isPaymentQuery = paymentQueryPatterns.some(p => lowerMessage.includes(p));

    if (isPaymentQuery || message.length > 3) {
      // Seller is likely asking about payment - tell them we're paying now
      logger.info('Seller asking about payment status, responding with "paying now"', { message: lowerMessage });
      const payingMsg = await generatePayingNowMessage();
      await this.sendToSeller(conversation, payingMsg);
      return;
    }
  }

  private async requestUserConfirmationAndPay(conversation: Conversation): Promise<void> {
    // Send confirmation request to user
    const confirmationMsg = `🔔 COUPON PURCHASE CONFIRMATION

Seller: ${conversation.sellerName}
Type: ${conversation.couponType.toUpperCase()}
Amount: Rs.${FIXED_PRICE}
UPI: ${conversation.upiId}

Reply "Ok" to proceed with payment.`;

    await this.sendToSelf(confirmationMsg);

    // Also show desktop notification
    sendPaymentNotification({
      sellerName: conversation.sellerName,
      upiId: conversation.upiId!,
      amount: FIXED_PRICE,
      couponType: conversation.couponType,
      conversationId: conversation.id
    });

    logger.info('Waiting for user confirmation via WhatsApp...');

    // Wait for user to confirm via WhatsApp or terminal
    const confirmed = await this.waitForUserConfirmation(conversation.id);

    if (confirmed) {
      // Now wait for payment confirmation
      logger.info('User approved, waiting for payment confirmation...');

      const paymentDone = await this.waitForPaymentConfirmation(conversation.id);

      if (paymentDone && conversation.upiId) {
        // Check for existing coupon FIRST before sending any message
        // This way we can send the appropriate message based on whether coupon exists

        // Check if we already received a coupon image earlier (stored in memory)
        let couponImage: Buffer | null = earlyCouponImages.get(conversation.id) || null;
        if (couponImage) {
          logger.info('Found early coupon image in memory', { conversationId: conversation.id });
          earlyCouponImages.delete(conversation.id); // Clean up
        }

        // If not in memory, scan the chat history
        if (!couponImage) {
          couponImage = await this.scanChatForCouponImage(conversation);
          if (couponImage) {
            logger.info('Found existing coupon image in chat history', { conversationId: conversation.id });
          }
        }

        // Send appropriate message based on whether coupon already exists
        if (couponImage) {
          // Coupon already received - send payment done + thanks message
          const thankWithPaymentMsg = await generatePaymentDoneWithThanks();
          await this.sendToSeller(conversation, thankWithPaymentMsg);

          // Complete the conversation immediately
          conversation.state = ConversationState.COMPLETED;
          conversation.updatedAt = new Date();
          conversation.completedAt = new Date();

          sellerCancelFollowUpState.delete(conversation.id);
          this.currentConversationId = null;
          clearSellerContext();

          // Record successful deal
          saveCouponImage(conversation.couponType, couponImage, conversation.sellerName);
          recordSuccessfulDeal(
            conversation.id,
            conversation.couponType,
            conversation.sellerName,
            conversation.sellerId,
            FIXED_PRICE,
            conversation.messName,
            undefined
          );

          // Notify user
          const now = new Date();
          const dateStr = now.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
          const timeStr = now.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: true });
          const caption = `✅ COUPON PURCHASED!\n\n📋 Type: ${conversation.couponType.toUpperCase()}\n👤 Seller: ${conversation.sellerName}\n💰 Amount: Rs.${FIXED_PRICE}\n📅 Date: ${dateStr}\n🕐 Time: ${timeStr}`;
          await this.sendMediaToSelf(couponImage, caption);

          sendSuccessNotification(conversation.couponType);
          this.onCouponPurchased(conversation.couponType, conversation.id);
          this.onConversationUpdate();

          logger.info('Payment confirmed and coupon already received - deal complete!', { conversationId: conversation.id });
          return;
        }

        // No coupon yet - send regular payment confirmation asking for coupon
        const confirmMsg = await generatePaymentConfirmation(conversation.upiId, FIXED_PRICE);
        await this.sendToSeller(conversation, confirmMsg);

        conversation.state = ConversationState.AWAITING_COUPON;
        conversation.couponFollowUpCount = 0;
        conversation.lastCouponRequestTime = new Date();
        conversation.updatedAt = new Date();

        this.onConversationUpdate();
        logger.info('Payment confirmed, waiting for coupon image', { conversationId: conversation.id });

        // Start the coupon follow-up timer
        this.startCouponFollowUpTimer(conversation);
      } else {
        await this.handlePaymentFailure(conversation, 'Payment not completed');
      }
    } else {
      await this.handlePaymentFailure(conversation, 'User declined');
    }
  }

  private async handlePaymentFailure(conversation: Conversation, reason: string): Promise<void> {
    // Send cancellation message to seller
    const cancelMsg = await generateCancelMessageToSeller();
    await this.sendToSeller(conversation, cancelMsg);
    logger.info('Sent cancellation message to seller', { seller: conversation.sellerName });

    // Notify user about failure
    const failureMsg = `❌ DEAL CANCELLED

Seller: ${conversation.sellerName}
Type: ${conversation.couponType}
Reason: ${reason}

Looking for other sellers...`;

    await this.sendToSelf(failureMsg);

    // Clear current conversation to allow talking to new sellers
    this.currentConversationId = null;

    await this.failConversation(conversation, reason);
  }

  private async handleAwaitingCoupon(conversation: Conversation, message: string, mediaBuffer?: Buffer): Promise<void> {
    // First, check if we have an early coupon image stored from before AWAITING_COUPON state
    const earlyCoupon = earlyCouponImages.get(conversation.id);
    if (earlyCoupon) {
      logger.info('Processing stored early coupon image', { conversationId: conversation.id });
      earlyCouponImages.delete(conversation.id); // Clean up
      sellerCancelFollowUpState.delete(conversation.id); // Clean up
      await this.completeConversation(conversation, earlyCoupon);
      return;
    }

    // Scan chat for any coupon images that may have been sent but missed
    // This is a fallback in case the real-time message handler missed an image
    const existingCoupon = await this.scanChatForCouponImage(conversation);
    if (existingCoupon) {
      logger.info('Found existing coupon image in chat (fallback scan)', { conversationId: conversation.id });
      sellerCancelFollowUpState.delete(conversation.id); // Clean up
      await this.completeConversation(conversation, existingCoupon);
      return;
    }

    // When we receive ANY image in AWAITING_COUPON state, accept it as the coupon
    // Sellers only send images when sharing the coupon - no need for strict QR detection
    if (mediaBuffer) {
      logger.info('Image received from seller in AWAITING_COUPON state - accepting as coupon', { conversationId: conversation.id });
      sellerCancelFollowUpState.delete(conversation.id); // Clean up
      await this.completeConversation(conversation, mediaBuffer);
      return;
    }

    const lowerMessage = message.toLowerCase().trim();

    // Check if seller is trying to cancel AFTER payment - this is serious
    const cancelState = sellerCancelFollowUpState.get(conversation.id) || 0;
    const cancellation = detectSellerCancellation(message);

    if (cancellation.isCancelling && cancellation.confidence > 0.5) {
      logger.warn('Seller trying to cancel deal AFTER payment!', { state: cancelState, message: lowerMessage });

      if (cancelState === 0) {
        // First time - ask what happened
        const followUp = await generateSellerCancelFollowUp(message);
        await this.sendToSeller(conversation, followUp);
        sellerCancelFollowUpState.set(conversation.id, 1);
        return;
      } else if (cancelState === 1) {
        // Second time - try to convince, mention payment was made
        const convince = await generateConvinceSeller();
        await this.sendToSeller(conversation, convince);
        sellerCancelFollowUpState.set(conversation.id, 2);
        return;
      } else {
        // Third time - accept but ask for refund and track it
        const refundRequest = await generateRefundRequest(FIXED_PRICE);
        await this.sendToSeller(conversation, refundRequest);
        sellerCancelFollowUpState.delete(conversation.id);

        // Transition to refund tracking state
        conversation.state = ConversationState.AWAITING_REFUND;
        conversation.refundRequested = true;
        conversation.updatedAt = new Date();
        this.onConversationUpdate();

        // Notify user about this situation
        await this.sendToSelf(`⚠️ SELLER CANCELLED AFTER PAYMENT!\n\nSeller: ${conversation.sellerName}\nAmount: Rs.${FIXED_PRICE}\n\nAsked seller for refund. Tracking refund status...`);

        logger.info('Transitioned to AWAITING_REFUND state', { conversationId: conversation.id });
        return;
      }
    }

    // If seller responds positively after cancellation attempt, reset state
    if (cancelState > 0) {
      const analysis = await analyzeSellerResponse(message);
      if (analysis.agreesToSale === true || analysis.hasCoupon) {
        logger.info('Seller changed mind after cancellation attempt, continuing');
        sellerCancelFollowUpState.delete(conversation.id);
      }
    }

    // Check if seller is saying "hold on", "sending", etc. - respond friendly
    const isWaitMessage = WAIT_PATTERNS.some(p => lowerMessage.includes(p));
    if (isWaitMessage) {
      logger.info('Seller asking to wait, responding friendly', { message: lowerMessage });
      const ackResponse = await generateWaitingAcknowledgment();
      await this.sendToSeller(conversation, ackResponse);
      return;
    }

    // Check if it's just an acknowledgment - no response needed
    const isAck = ACKNOWLEDGMENT_PATTERNS.some(p => lowerMessage === p);
    if (isAck) {
      logger.debug('Seller sent acknowledgment, no response needed', { message: lowerMessage });
      return;
    }

    // Text message received - check if seller is saying they sent it or will send
    const analysis = await analyzeSellerResponse(message);
    if (analysis.hasCoupon) {
      // Seller claims to have sent coupon but we need the actual image
      logger.info('Seller says coupon sent, but waiting for actual image', { conversationId: conversation.id });
    }

    // If seller says something else, respond conversationally
    if (message.length > 3 && !analysis.hasCoupon) {
      logger.info('Generating conversational response to seller', { message: message.substring(0, 30) });
      const response = await generateConversationalResponse(message, 'waiting for coupon after payment');
      await this.sendToSeller(conversation, response);
    }

    logger.debug('Still waiting for coupon image', { conversationId: conversation.id });
  }

  private async handleAwaitingRefund(conversation: Conversation, message: string): Promise<void> {
    const lowerMessage = message.toLowerCase().trim();

    // Check if seller confirms refund
    const refundConfirm = detectRefundConfirmation(message);

    if (refundConfirm.isRefundConfirmed && refundConfirm.confidence > 0.5) {
      logger.info('Seller confirms refund, asking for screenshot', { conversationId: conversation.id });

      // Ask for screenshot
      const askScreenshot = await generateAskRefundScreenshot();
      await this.sendToSeller(conversation, askScreenshot);

      // Transition to waiting for screenshot
      conversation.state = ConversationState.AWAITING_REFUND_SCREENSHOT;
      conversation.updatedAt = new Date();
      this.onConversationUpdate();
      return;
    }

    // Check if seller is saying wait/hold on
    const isWaitMessage = WAIT_PATTERNS.some(p => lowerMessage.includes(p));
    if (isWaitMessage) {
      logger.info('Seller asking to wait (refund context), responding friendly');
      const ackResponse = await generateWaitingAcknowledgment();
      await this.sendToSeller(conversation, ackResponse);
      return;
    }

    // For other messages, respond conversationally while waiting for refund
    if (message.length > 2) {
      logger.info('Responding to seller during refund wait', { message: message.substring(0, 30) });
      const response = await generateRefundConversation(message);
      await this.sendToSeller(conversation, response);
    }
  }

  private async handleAwaitingRefundScreenshot(conversation: Conversation, message: string, mediaBuffer?: Buffer): Promise<void> {
    // Check if we received an image (refund screenshot)
    if (mediaBuffer) {
      logger.info('Received refund screenshot', { conversationId: conversation.id });

      // Thank the seller
      const thanks = await generateRefundThanks();
      await this.sendToSeller(conversation, thanks);

      // Mark refund as received
      conversation.refundReceived = true;
      conversation.refundScreenshotReceived = true;

      // Notify user
      await this.sendToSelf(`✅ REFUND RECEIVED!\n\nSeller: ${conversation.sellerName}\nAmount: Rs.${FIXED_PRICE}\n\nRefund screenshot received. Deal closed.`);

      // Clear current conversation
      this.currentConversationId = null;
      clearSellerContext();

      // Fail the conversation with refund confirmed
      await this.failConversation(conversation, 'Seller cancelled after payment - REFUND RECEIVED');
      return;
    }

    const lowerMessage = message.toLowerCase().trim();

    // Check if they say they sent it (without image)
    const refundConfirm = detectRefundConfirmation(message);
    if (refundConfirm.isRefundConfirmed) {
      // They say sent but no image, ask again
      const askAgain = await generateAskRefundScreenshot();
      await this.sendToSeller(conversation, askAgain);
      return;
    }

    // For other messages, respond and remind about screenshot
    if (message.length > 2) {
      const response = await generateRefundConversation(message);
      await this.sendToSeller(conversation, response);
    }
  }

  private startCouponFollowUpTimer(conversation: Conversation): void {
    const FOLLOW_UP_INTERVAL_MS = 30 * 1000; // 30 seconds - check frequently for coupon
    const MAX_FOLLOW_UPS = 8; // Max 8 follow-ups (4 minutes total) before giving up

    const checkAndFollowUp = async () => {
      // Re-fetch conversation state (might have changed)
      const currentConv = this.conversations.get(conversation.id);
      if (!currentConv) return;

      // If completed or failed, stop following up
      if (currentConv.state === ConversationState.COMPLETED || currentConv.state === ConversationState.FAILED) {
        logger.debug('Conversation ended, stopping follow-up timer', { conversationId: conversation.id });
        return;
      }

      // If not in AWAITING_COUPON state anymore, stop
      if (currentConv.state !== ConversationState.AWAITING_COUPON) {
        return;
      }

      // Check if we received an early coupon image that hasn't been processed yet (in memory)
      const earlyCoupon = earlyCouponImages.get(conversation.id);
      if (earlyCoupon) {
        logger.info('Found early coupon image in memory during follow-up check, processing now', { conversationId: conversation.id });
        earlyCouponImages.delete(conversation.id); // Clean up
        sellerCancelFollowUpState.delete(conversation.id); // Clean up
        await this.completeConversation(currentConv, earlyCoupon);
        return;
      }

      // Scan the chat history for any coupon images before sending follow-up
      const existingCoupon = await this.scanChatForCouponImage(currentConv);
      if (existingCoupon) {
        logger.info('Found existing coupon image in chat during follow-up check, processing now', { conversationId: conversation.id });
        sellerCancelFollowUpState.delete(conversation.id); // Clean up
        await this.completeConversation(currentConv, existingCoupon);
        return;
      }

      const followUpCount = currentConv.couponFollowUpCount || 0;

      // Check if max follow-ups reached
      if (followUpCount >= MAX_FOLLOW_UPS) {
        logger.warn('Max follow-ups reached, seller not sending coupon', { conversationId: conversation.id });
        await this.handleCouponNotReceived(currentConv);
        return;
      }

      // Send follow-up message
      const followUpMsg = await generateCouponRequestMessage(followUpCount);
      await this.sendToSeller(currentConv, followUpMsg);

      currentConv.couponFollowUpCount = followUpCount + 1;
      currentConv.lastCouponRequestTime = new Date();
      currentConv.updatedAt = new Date();
      this.onConversationUpdate();

      logger.info('Sent coupon follow-up', {
        conversationId: conversation.id,
        followUpCount: currentConv.couponFollowUpCount
      });

      // Schedule next follow-up
      setTimeout(checkAndFollowUp, FOLLOW_UP_INTERVAL_MS);
    };

    // Schedule first follow-up after 1 minute
    setTimeout(checkAndFollowUp, FOLLOW_UP_INTERVAL_MS);
  }

  private async handleCouponNotReceived(conversation: Conversation): Promise<void> {
    // Notify user that seller isn't sending coupon
    const alertMsg = `⚠️ COUPON NOT RECEIVED

Seller: ${conversation.sellerName}
Type: ${conversation.couponType.toUpperCase()}
Amount: Rs.${FIXED_PRICE} (already paid)

Seller hasn't sent the coupon after multiple requests.
Please check the chat and handle manually.`;

    await this.sendToSelf(alertMsg);

    // Don't mark as failed yet - let user handle it
    // But clear current conversation to allow other deals
    this.currentConversationId = null;

    logger.warn('Coupon not received after max follow-ups', {
      conversationId: conversation.id,
      seller: conversation.sellerName
    });
  }

  private async completeConversation(conversation: Conversation, couponImage: Buffer): Promise<void> {
    conversation.state = ConversationState.COMPLETED;
    conversation.updatedAt = new Date();
    conversation.completedAt = new Date(); // Track completion time for animation

    // Clean up any stored images
    earlyCouponImages.delete(conversation.id);
    receivedImagesPerConversation.delete(conversation.id);

    // Clear current conversation to allow talking to new sellers
    this.currentConversationId = null;
    clearSellerContext();

    const thankYou = await generateThankYouMessage();
    await this.sendToSeller(conversation, thankYou);

    // Save coupon image to disk
    const imageFilename = saveCouponImage(
      conversation.couponType,
      couponImage,
      conversation.sellerName
    );

    // Record successful deal in history
    recordSuccessfulDeal(
      conversation.id,
      conversation.couponType,
      conversation.sellerName,
      conversation.sellerId,
      FIXED_PRICE,
      conversation.messName,
      imageFilename || undefined
    );

    // Format date and time
    const now = new Date();
    const dateStr = now.toLocaleDateString('en-IN', {
      day: '2-digit',
      month: 'short',
      year: 'numeric'
    });
    const timeStr = now.toLocaleTimeString('en-IN', {
      hour: '2-digit',
      minute: '2-digit',
      hour12: true
    });

    // Forward coupon image to user with details
    const caption = `✅ COUPON PURCHASED!

📋 Type: ${conversation.couponType.toUpperCase()}
👤 Seller: ${conversation.sellerName}
💰 Amount: Rs.${FIXED_PRICE}
📅 Date: ${dateStr}
🕐 Time: ${timeStr}`;

    await this.sendMediaToSelf(couponImage, caption);

    sendSuccessNotification(conversation.couponType);
    this.onCouponPurchased(conversation.couponType, conversation.id);
    this.onConversationUpdate();

    logger.info('Conversation completed successfully!', {
      conversationId: conversation.id,
      couponType: conversation.couponType
    });
  }

  private async failConversation(conversation: Conversation, reason: string): Promise<void> {
    conversation.state = ConversationState.FAILED;
    conversation.failureReason = reason;
    conversation.updatedAt = new Date();
    conversation.completedAt = new Date(); // Track completion time for animation

    // Clean up any stored images
    earlyCouponImages.delete(conversation.id);
    receivedImagesPerConversation.delete(conversation.id);

    // Clear current conversation to allow talking to new sellers
    if (this.currentConversationId === conversation.id) {
      this.currentConversationId = null;
      clearSellerContext();
    }

    // Record failed deal in history
    recordFailedDeal(
      conversation.id,
      conversation.couponType,
      conversation.sellerName,
      conversation.sellerId,
      FIXED_PRICE,
      reason,
      conversation.messName,
      conversation.refundReceived
    );

    this.onConversationUpdate();

    // Send detailed failure summary to user
    const now = new Date();
    const dateStr = now.toLocaleDateString('en-IN', {
      day: '2-digit',
      month: 'short',
      year: 'numeric'
    });
    const timeStr = now.toLocaleTimeString('en-IN', {
      hour: '2-digit',
      minute: '2-digit',
      hour12: true
    });

    // Build detailed failure summary
    let summary = `❌ DEAL FAILED\n\n`;
    summary += `📋 Type: ${conversation.couponType.toUpperCase()}\n`;
    summary += `👤 Seller: ${conversation.sellerName}\n`;
    summary += `📅 Date: ${dateStr}\n`;
    summary += `🕐 Time: ${timeStr}\n\n`;
    summary += `📝 Reason: ${reason}\n`;

    // Add refund status if payment was made
    if (conversation.refundRequested) {
      summary += `\n💰 Payment Status:\n`;
      summary += `   • Payment Made: Yes (Rs.${FIXED_PRICE})\n`;
      if (conversation.refundReceived) {
        summary += `   • Refund: ✅ RECEIVED\n`;
        if (conversation.refundScreenshotReceived) {
          summary += `   • Screenshot: Received\n`;
        }
      } else {
        summary += `   • Refund: ⚠️ NOT CONFIRMED\n`;
        summary += `   • Please follow up manually if needed\n`;
      }
    }

    await this.sendToSelf(summary);

    // Notify about failure
    this.onConversationFailed(conversation.id, reason);

    logger.warn('Conversation failed', {
      conversationId: conversation.id,
      reason,
      refundRequested: conversation.refundRequested,
      refundReceived: conversation.refundReceived
    });
  }

  getActiveConversations(): Conversation[] {
    const now = Date.now();
    const ANIMATION_WINDOW_MS = 15000; // Keep completed conversations visible for 15 seconds for animation

    return Array.from(this.conversations.values()).filter(c => {
      // Active conversations always included
      if (c.state !== ConversationState.COMPLETED && c.state !== ConversationState.FAILED) {
        return true;
      }
      // Include recently completed/failed conversations for animation
      if (c.completedAt) {
        const completedMs = new Date(c.completedAt).getTime();
        return (now - completedMs) < ANIMATION_WINDOW_MS;
      }
      return false;
    });
  }

  hasActiveConversation(sellerId: string): boolean {
    return Array.from(this.conversations.values()).some(
      c => c.sellerId === sellerId &&
        c.state !== ConversationState.COMPLETED &&
        c.state !== ConversationState.FAILED
    );
  }

  // Manually mark a conversation as completed (successful deal without coupon image)
  async manuallyCompleteConversation(conversationId: string): Promise<{ success: boolean; error?: string }> {
    const conversation = this.conversations.get(conversationId);

    if (!conversation) {
      return { success: false, error: 'Conversation not found' };
    }

    if (conversation.state === ConversationState.COMPLETED) {
      return { success: false, error: 'Conversation already completed' };
    }

    if (conversation.state === ConversationState.FAILED) {
      return { success: false, error: 'Conversation already failed' };
    }

    logger.info('Manually completing conversation', {
      conversationId,
      sellerName: conversation.sellerName,
      previousState: conversation.state
    });

    conversation.state = ConversationState.COMPLETED;
    conversation.updatedAt = new Date();
    conversation.completedAt = new Date();

    // Clean up any stored images
    earlyCouponImages.delete(conversationId);
    receivedImagesPerConversation.delete(conversationId);
    sellerCancelFollowUpState.delete(conversationId);

    // Clear current conversation to allow talking to new sellers
    if (this.currentConversationId === conversationId) {
      this.currentConversationId = null;
      clearSellerContext();
    }

    // Send thank you message to seller
    const thankYou = await generateThankYouMessage();
    await this.sendToSeller(conversation, thankYou);

    // Record as successful deal (without coupon image)
    recordSuccessfulDeal(
      conversation.id,
      conversation.couponType,
      conversation.sellerName,
      conversation.sellerId,
      FIXED_PRICE,
      conversation.messName,
      undefined // No coupon image
    );

    // Notify user
    const now = new Date();
    const dateStr = now.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
    const timeStr = now.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: true });

    await this.sendToSelf(`✅ DEAL MANUALLY COMPLETED\n\n📋 Type: ${conversation.couponType.toUpperCase()}\n👤 Seller: ${conversation.sellerName}\n💰 Amount: Rs.${FIXED_PRICE}\n📅 Date: ${dateStr}\n🕐 Time: ${timeStr}`);

    sendSuccessNotification(conversation.couponType);
    this.onCouponPurchased(conversation.couponType, conversationId);
    this.onConversationUpdate();

    return { success: true };
  }

  // Manually mark a conversation as failed
  async manuallyFailConversation(conversationId: string, reason: string = 'Manually cancelled'): Promise<{ success: boolean; error?: string }> {
    const conversation = this.conversations.get(conversationId);

    if (!conversation) {
      return { success: false, error: 'Conversation not found' };
    }

    if (conversation.state === ConversationState.COMPLETED) {
      return { success: false, error: 'Conversation already completed' };
    }

    if (conversation.state === ConversationState.FAILED) {
      return { success: false, error: 'Conversation already failed' };
    }

    logger.info('Manually failing conversation', {
      conversationId,
      sellerName: conversation.sellerName,
      previousState: conversation.state,
      reason
    });

    // Send cancellation message to seller
    const cancelMsg = await generateCancelMessageToSeller();
    await this.sendToSeller(conversation, cancelMsg);

    // Clean up
    earlyCouponImages.delete(conversationId);
    receivedImagesPerConversation.delete(conversationId);
    sellerCancelFollowUpState.delete(conversationId);

    // Mark as failed
    await this.failConversation(conversation, reason);

    return { success: true };
  }
}
