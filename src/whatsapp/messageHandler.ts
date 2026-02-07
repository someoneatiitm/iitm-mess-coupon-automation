import pkg from 'whatsapp-web.js';
import { logger } from '../utils/logger.js';

export type DMMessageHandler = (senderId: string, message: string, mediaBuffer?: Buffer) => Promise<void>;
export type UserCancellationHandler = (sellerId: string, message: string) => Promise<void>;

export class DirectMessageHandler {
  private onDMMessage: DMMessageHandler;
  private onUserCancellation: UserCancellationHandler | null = null;
  private activeSellerIds: Set<string>;

  constructor(onDMMessage: DMMessageHandler, activeSellerIds: Set<string>) {
    this.onDMMessage = onDMMessage;
    this.activeSellerIds = activeSellerIds;
  }

  setUserCancellationHandler(handler: UserCancellationHandler): void {
    this.onUserCancellation = handler;
  }

  setActiveSellerIds(sellerIds: Set<string>): void {
    this.activeSellerIds = sellerIds;
  }

  addActiveSeller(sellerId: string): void {
    this.activeSellerIds.add(sellerId);
  }

  removeActiveSeller(sellerId: string): void {
    this.activeSellerIds.delete(sellerId);
  }

  async handleMessage(message: pkg.Message): Promise<void> {
    // Only process direct messages (not from groups)
    const chat = await message.getChat();
    if (chat.isGroup) {
      return;
    }

    // Check if this is our own message to a seller (for cancellation detection)
    if (message.fromMe) {
      const sellerId = message.to;
      if (this.activeSellerIds.has(sellerId) && this.onUserCancellation && message.body) {
        logger.debug('Checking user message for cancellation', { to: sellerId.substring(0, 15) });
        await this.onUserCancellation(sellerId, message.body);
      }
      return;
    }

    const senderId = message.from;

    // Only process messages from active sellers
    if (!this.activeSellerIds.has(senderId)) {
      return;
    }

    logger.debug('Processing DM from seller', {
      senderId: senderId.substring(0, 15),
      hasMedia: message.hasMedia
    });

    let mediaBuffer: Buffer | undefined;

    // Download media if present
    if (message.hasMedia) {
      try {
        const media = await message.downloadMedia();
        if (media && media.data) {
          mediaBuffer = Buffer.from(media.data, 'base64');
          logger.debug('Downloaded media', { mimetype: media.mimetype });
        }
      } catch (error) {
        logger.error('Failed to download media', error);
      }
    }

    await this.onDMMessage(senderId, message.body || '', mediaBuffer);
  }
}
