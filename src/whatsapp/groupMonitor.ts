import pkg from 'whatsapp-web.js';
import { detectSellMessage } from '../llm/messageParser.js';
import { SellMessage, CouponType } from '../conversation/types.js';
import { getConfig } from '../utils/config.js';
import { logger } from '../utils/logger.js';

export type SellMessageHandler = (sellMessage: SellMessage) => Promise<void>;

// How many recent messages to scan per group
const MESSAGES_TO_SCAN = 30;
// Only consider messages from the last N minutes as "recent"
const MAX_MESSAGE_AGE_MINUTES = 20;

export class GroupMonitor {
  private monitoredGroupIds: Set<string> = new Set();
  private monitoredGroups: pkg.Chat[] = [];
  private processedMessageIds: Set<string>;
  private onSellMessage: SellMessageHandler;
  private canProcessCoupon: (type: CouponType) => boolean;

  constructor(
    processedMessageIds: Set<string>,
    onSellMessage: SellMessageHandler,
    canProcessCoupon: (type: CouponType) => boolean
  ) {
    this.processedMessageIds = processedMessageIds;
    this.onSellMessage = onSellMessage;
    this.canProcessCoupon = canProcessCoupon;
  }

  setMonitoredGroups(groups: pkg.Chat[]): void {
    this.monitoredGroups = groups;
    this.monitoredGroupIds = new Set(groups.map(g => g.id._serialized));
    logger.info('Monitoring groups', { count: groups.length, names: groups.map(g => g.name) });
  }

  async scanExistingMessages(): Promise<void> {
    logger.info(`Scanning messages from the last ${MAX_MESSAGE_AGE_MINUTES} minutes...`);

    const cutoffTime = Date.now() - (MAX_MESSAGE_AGE_MINUTES * 60 * 1000);

    for (const group of this.monitoredGroups) {
      try {
        logger.info(`Scanning group: ${group.name}`);
        const messages = await group.fetchMessages({ limit: MESSAGES_TO_SCAN });

        // Process messages from oldest to newest
        const sortedMessages = messages.reverse();

        for (const message of sortedMessages) {
          // Skip if already processed
          if (this.processedMessageIds.has(message.id._serialized)) {
            continue;
          }

          // Skip old messages
          const messageTime = message.timestamp * 1000;
          if (messageTime < cutoffTime) {
            continue;
          }

          // Skip our own messages
          if (message.fromMe) {
            continue;
          }

          // Skip media-only messages
          if (!message.body || message.body.trim() === '') {
            continue;
          }

          // Process the message
          await this.processMessage(message, group);
        }
      } catch (error) {
        logger.error(`Failed to scan group: ${group.name}`, error);
      }
    }

    logger.info('Finished scanning existing messages');
  }

  async pollLatestMessages(): Promise<void> {
    logger.info(`Polling messages from the last ${MAX_MESSAGE_AGE_MINUTES} minutes...`);

    const cutoffTime = Date.now() - (MAX_MESSAGE_AGE_MINUTES * 60 * 1000);

    for (const group of this.monitoredGroups) {
      try {
        // Fetch recent messages
        const messages = await group.fetchMessages({ limit: MESSAGES_TO_SCAN });

        // Process messages from oldest to newest
        const sortedMessages = messages.reverse();
        let processedCount = 0;

        for (const message of sortedMessages) {
          // Skip if already processed
          if (this.processedMessageIds.has(message.id._serialized)) {
            continue;
          }

          // Skip old messages
          const messageTime = message.timestamp * 1000;
          if (messageTime < cutoffTime) {
            continue;
          }

          // Skip our own messages
          if (message.fromMe) {
            continue;
          }

          // Skip media-only messages
          if (!message.body || message.body.trim() === '') {
            continue;
          }

          // Process the message
          await this.processMessage(message, group);
          processedCount++;
        }

        if (processedCount > 0) {
          logger.info(`Processed ${processedCount} new messages from ${group.name}`);
        }
      } catch (error) {
        logger.error(`Failed to poll group: ${group.name}`, error);
      }
    }
  }

  private async processMessage(message: pkg.Message, chat: pkg.Chat): Promise<void> {
    // Skip our own messages
    if (message.fromMe) {
      return;
    }

    // Skip media-only messages
    if (!message.body || message.body.trim() === '') {
      return;
    }

    logger.debug('Processing group message', {
      group: chat.name,
      from: message.author,
      preview: message.body.substring(0, 50)
    });

    // Mark as processed
    this.processedMessageIds.add(message.id._serialized);

    // Detect if this is a sell message
    const detection = await detectSellMessage(message.body);

    if (detection.isSelling && detection.couponType && detection.confidence > 0.6) {
      logger.info('Sell message detected!', {
        group: chat.name,
        couponType: detection.couponType,
        confidence: detection.confidence,
        message: message.body.substring(0, 100)
      });

      // Check if we need this type of coupon
      if (!this.canProcessCoupon(detection.couponType)) {
        logger.info('Already have this coupon type, skipping', { couponType: detection.couponType });
        return;
      }

      // Get sender info
      const contact = await message.getContact();

      const sellMessage: SellMessage = {
        messageId: message.id._serialized,
        senderId: message.author || message.from,
        senderName: contact.pushname || contact.name || 'Unknown',
        groupId: chat.id._serialized,
        groupName: chat.name,
        couponType: detection.couponType,
        rawMessage: message.body,
        timestamp: new Date(message.timestamp * 1000)
      };

      await this.onSellMessage(sellMessage);
    }
  }

  async handleMessage(message: pkg.Message): Promise<void> {
    // Only process group messages
    const chat = await message.getChat();
    if (!chat.isGroup) {
      return;
    }

    // Check if we're monitoring this group
    if (!this.monitoredGroupIds.has(chat.id._serialized)) {
      return;
    }

    // Skip already processed messages
    if (this.processedMessageIds.has(message.id._serialized)) {
      return;
    }

    await this.processMessage(message, chat);
  }

  getProcessedMessageIds(): Set<string> {
    return this.processedMessageIds;
  }
}
