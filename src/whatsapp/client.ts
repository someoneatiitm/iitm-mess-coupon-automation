import pkg from 'whatsapp-web.js';
const { Client, LocalAuth, MessageMedia } = pkg;
import qrcode from 'qrcode-terminal';
import { rmSync, existsSync } from 'fs';
import { logger } from '../utils/logger.js';

let whatsappClient: pkg.Client | null = null;
let isAuthenticated = false;
let isReady = false;
let currentQR: string | null = null;
let currentUserPhone: string | null = null;
let storedMessageHandler: MessageHandler | null = null;

// Event callbacks for web integration
let onQRCallback: ((qr: string) => void) | null = null;
let onAuthenticatedCallback: (() => void) | null = null;
let onReadyCallback: ((userPhone: string) => void) | null = null;
let onDisconnectedCallback: ((reason: string) => void) | null = null;
let onAuthFailureCallback: ((msg: string) => void) | null = null;

export type MessageHandler = (message: pkg.Message) => Promise<void>;

// Set event callbacks
export function setEventCallbacks(callbacks: {
  onQR?: (qr: string) => void;
  onAuthenticated?: () => void;
  onReady?: (userPhone: string) => void;
  onDisconnected?: (reason: string) => void;
  onAuthFailure?: (msg: string) => void;
}): void {
  onQRCallback = callbacks.onQR || null;
  onAuthenticatedCallback = callbacks.onAuthenticated || null;
  onReadyCallback = callbacks.onReady || null;
  onDisconnectedCallback = callbacks.onDisconnected || null;
  onAuthFailureCallback = callbacks.onAuthFailure || null;
}

// Get current auth state
export function getAuthState(): {
  isAuthenticated: boolean;
  isReady: boolean;
  currentQR: string | null;
  userPhone: string | null;
} {
  return {
    isAuthenticated,
    isReady,
    currentQR: isReady ? null : currentQR,  // Don't expose QR if already logged in
    userPhone: currentUserPhone
  };
}

export async function initWhatsAppClient(onMessage: MessageHandler): Promise<pkg.Client> {
  if (whatsappClient) {
    return whatsappClient;
  }

  logger.info('Initializing WhatsApp client...');

  // Store the message handler for potential reinitialization
  storedMessageHandler = onMessage;

  // Reset state
  isAuthenticated = false;
  isReady = false;
  currentQR = null;
  currentUserPhone = null;

  whatsappClient = new Client({
    authStrategy: new LocalAuth({
      dataPath: '.wwebjs_auth'
    }),
    puppeteer: {
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-accelerated-2d-canvas',
        '--no-first-run',
        '--no-zygote',
        '--disable-gpu'
      ]
    }
  });

  whatsappClient.on('qr', (qr) => {
    logger.info('QR Code received - scan with WhatsApp');
    currentQR = qr;
    console.log('\n');
    qrcode.generate(qr, { small: true });
    console.log('\nScan this QR code with WhatsApp to login\n');

    // Notify web frontend
    if (onQRCallback) onQRCallback(qr);
  });

  whatsappClient.on('authenticated', () => {
    logger.info('WhatsApp authenticated successfully');
    isAuthenticated = true;
    currentQR = null;

    if (onAuthenticatedCallback) onAuthenticatedCallback();
  });

  whatsappClient.on('auth_failure', (msg) => {
    logger.error('WhatsApp authentication failed', { message: msg });
    isAuthenticated = false;
    isReady = false;

    if (onAuthFailureCallback) onAuthFailureCallback(msg);
  });

  whatsappClient.on('ready', () => {
    logger.info('WhatsApp client is ready!');
    isReady = true;
    currentQR = null;

    // Get the phone number
    if (whatsappClient?.info?.wid) {
      currentUserPhone = whatsappClient.info.wid.user;
      logger.info('Logged in as', { phone: currentUserPhone });
    }

    if (onReadyCallback && currentUserPhone) onReadyCallback(currentUserPhone);
  });

  whatsappClient.on('disconnected', (reason) => {
    logger.warn('WhatsApp disconnected', { reason });
    isAuthenticated = false;
    isReady = false;
    currentUserPhone = null;
    whatsappClient = null;

    if (onDisconnectedCallback) onDisconnectedCallback(reason);
  });

  // Handle incoming messages from others
  whatsappClient.on('message', async (message) => {
    try {
      await onMessage(message);
    } catch (error) {
      logger.error('Error handling message', error);
    }
  });

  // Handle messages created by user (including self-messages for confirmations)
  whatsappClient.on('message_create', async (message) => {
    try {
      // Only process messages sent by us (fromMe = true)
      if (message.fromMe) {
        await onMessage(message);
      }
    } catch (error) {
      logger.error('Error handling message_create', error);
    }
  });

  await whatsappClient.initialize();

  return whatsappClient;
}

// Logout and destroy session
export async function logout(): Promise<void> {
  logger.info('Logging out WhatsApp...');

  if (whatsappClient) {
    try {
      await whatsappClient.logout();
    } catch (error) {
      logger.warn('Error during logout, destroying client anyway', error);
    }

    try {
      await whatsappClient.destroy();
    } catch (error) {
      logger.warn('Error destroying client', error);
    }
  }

  // Clear session files
  const authPath = '.wwebjs_auth';
  if (existsSync(authPath)) {
    try {
      rmSync(authPath, { recursive: true, force: true });
      logger.info('Session files cleared');
    } catch (error) {
      logger.error('Failed to clear session files', error);
    }
  }

  // Reset state
  whatsappClient = null;
  isAuthenticated = false;
  isReady = false;
  currentQR = null;
  currentUserPhone = null;

  logger.info('Logout complete');
}

// Reinitialize the WhatsApp client (for new login after logout)
// Returns a promise that resolves when the client is ready (after QR scan)
export async function reinitializeClient(onReady?: () => void): Promise<pkg.Client | null> {
  if (!storedMessageHandler) {
    logger.error('Cannot reinitialize - no message handler stored');
    return null;
  }

  logger.info('Reinitializing WhatsApp client for new session...');

  // Make sure old client is cleaned up
  whatsappClient = null;

  // Store the onReady callback to be called when client is ready
  if (onReady) {
    const existingReadyCallback = onReadyCallback;
    onReadyCallback = (userPhone: string) => {
      // Call both the web callback and the bot callback
      if (existingReadyCallback) existingReadyCallback(userPhone);
      onReady();
    };
  }

  // Reinitialize with stored handler
  return await initWhatsAppClient(storedMessageHandler);
}

// Check if client is ready
export function isClientReady(): boolean {
  return isReady && whatsappClient !== null;
}

export function getClient(): pkg.Client | null {
  return whatsappClient;
}

// Get the correct WhatsApp ID for sending messages to yourself
export function getMyWhatsAppId(): string | null {
  if (!whatsappClient || !whatsappClient.info) {
    return null;
  }
  // Use the client's own wid for self-messaging
  return whatsappClient.info.wid._serialized;
}

export async function sendMessage(chatId: string, message: string): Promise<void> {
  if (!whatsappClient) {
    throw new Error('WhatsApp client not initialized');
  }

  try {
    await whatsappClient.sendMessage(chatId, message);
    logger.debug('Message sent', { chatId: chatId.substring(0, 15), messagePreview: message.substring(0, 30) });
  } catch (error) {
    logger.error('Failed to send message', { chatId, error });
    throw error;
  }
}

export async function sendMediaMessage(chatId: string, mediaBuffer: Buffer, caption: string, mimetype: string = 'image/jpeg'): Promise<void> {
  if (!whatsappClient) {
    throw new Error('WhatsApp client not initialized');
  }

  try {
    const base64Data = mediaBuffer.toString('base64');
    const media = new MessageMedia(mimetype, base64Data);
    await whatsappClient.sendMessage(chatId, media, { caption });
    logger.debug('Media message sent', { chatId: chatId.substring(0, 15), captionPreview: caption.substring(0, 30) });
  } catch (error) {
    logger.error('Failed to send media message', { chatId, error });
    throw error;
  }
}

export async function getChats(): Promise<pkg.Chat[]> {
  if (!whatsappClient) {
    throw new Error('WhatsApp client not initialized');
  }
  return whatsappClient.getChats();
}

export async function getGroupChats(groupNames: string[]): Promise<pkg.Chat[]> {
  const chats = await getChats();
  const groups = chats.filter(chat =>
    chat.isGroup && groupNames.some(name =>
      chat.name.toLowerCase().includes(name.toLowerCase())
    )
  );

  logger.info('Found monitored groups', { count: groups.length, names: groups.map(g => g.name) });
  return groups;
}

// Fetch recent messages from a chat and return any media buffers (images)
// Returns images with most recent first
// afterTimestamp: Only include messages sent after this time (for scoping to current conversation)
export async function fetchChatMediaMessages(chatId: string, limit: number = 50, afterTimestamp?: Date): Promise<Buffer[]> {
  if (!whatsappClient) {
    logger.warn('WhatsApp client not initialized for chat media fetch');
    return [];
  }

  try {
    logger.info('Fetching chat messages to scan for images', {
      chatId: chatId.substring(0, 15),
      limit,
      afterTimestamp: afterTimestamp?.toISOString()
    });

    const chat = await whatsappClient.getChatById(chatId);
    if (!chat) {
      logger.warn('Chat not found', { chatId: chatId.substring(0, 15) });
      return [];
    }

    const messages = await chat.fetchMessages({ limit });
    logger.info('Fetched messages from chat', {
      chatId: chatId.substring(0, 15),
      totalMessages: messages.length
    });

    const mediaBuffers: Buffer[] = [];
    let mediaMessagesFound = 0;
    let skippedOldMessages = 0;

    // Process messages in reverse order (newest first)
    const reversedMessages = [...messages].reverse();

    // Convert afterTimestamp to Unix timestamp in seconds (WhatsApp uses seconds)
    const afterTimestampSeconds = afterTimestamp ? Math.floor(afterTimestamp.getTime() / 1000) : 0;

    for (const msg of reversedMessages) {
      // Skip messages sent before the conversation started (if afterTimestamp is provided)
      if (afterTimestamp && msg.timestamp < afterTimestampSeconds) {
        skippedOldMessages++;
        continue;
      }

      // Only check messages from the other person (not from us)
      if (!msg.fromMe && msg.hasMedia) {
        mediaMessagesFound++;
        logger.debug('Found media message from seller', {
          messageId: msg.id._serialized,
          timestamp: msg.timestamp,
          messageDate: new Date(msg.timestamp * 1000).toISOString()
        });

        try {
          const media = await msg.downloadMedia();
          if (media && media.data && media.mimetype?.startsWith('image/')) {
            const buffer = Buffer.from(media.data, 'base64');
            mediaBuffers.push(buffer);
            logger.info('Successfully downloaded image from chat', {
              mimetype: media.mimetype,
              imageIndex: mediaBuffers.length
            });
          }
        } catch (mediaError) {
          logger.warn('Failed to download media from message', {
            messageId: msg.id._serialized,
            error: mediaError
          });
        }
      }
    }

    logger.info('Chat scan complete', {
      chatId: chatId.substring(0, 15),
      mediaMessagesFound,
      imagesDownloaded: mediaBuffers.length,
      skippedOldMessages
    });

    return mediaBuffers; // Most recent images first
  } catch (error) {
    logger.error('Failed to fetch chat messages', { chatId: chatId.substring(0, 15), error });
    return [];
  }
}

// Make a voice call to a WhatsApp number
export async function makeCall(chatId: string): Promise<boolean> {
  if (!whatsappClient) {
    throw new Error('WhatsApp client not initialized');
  }

  try {
    logger.info('Attempting to make call', { chatId: chatId.substring(0, 15) });

    // Get the puppeteer page from the client
    const page = (whatsappClient as any).pupPage;
    if (!page) {
      logger.error('Could not access puppeteer page');
      return false;
    }

    // Use WhatsApp's internal API to make a call
    // Note: This code runs in the browser context via puppeteer
    const result = await page.evaluate(async (targetId: string) => {
      try {
        // Access WhatsApp's internal store (window.Store is injected by whatsapp-web.js)
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const win = globalThis as any;
        const store = win.Store;
        if (!store) {
          console.error('Store not available');
          return { success: false, error: 'Store not available' };
        }

        // Get the contact/chat
        const wid = store.WidFactory.createWid(targetId);
        if (!wid) {
          return { success: false, error: 'Could not create WID' };
        }

        // Check if CallStore and call methods exist
        if (store.Call && store.Call.callStart) {
          await store.Call.callStart(wid, { isVideo: false });
          return { success: true };
        }

        // Alternative method using Cmd
        if (store.Cmd && store.Cmd.call) {
          await store.Cmd.call(wid, false); // false = voice call
          return { success: true };
        }

        // Try using the modern call API
        if (store.VoipStore && store.VoipStore.startCall) {
          await store.VoipStore.startCall([wid], false);
          return { success: true };
        }

        return { success: false, error: 'No call method available' };
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        return { success: false, error: errorMsg };
      }
    }, chatId);

    if (result.success) {
      logger.info('Call initiated successfully', { chatId: chatId.substring(0, 15) });
      return true;
    } else {
      logger.warn('Call failed', { error: result.error });
      return false;
    }
  } catch (error) {
    logger.error('Failed to make call', { chatId, error });
    return false;
  }
}
