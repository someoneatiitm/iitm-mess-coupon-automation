/**
 * JSON to SQLite Migration
 *
 * Migrates existing JSON file storage to SQLite database.
 * Run automatically on first startup if JSON files exist.
 */

import { existsSync, readFileSync, renameSync, readdirSync } from 'fs';
import { join } from 'path';
import { getDataDir, databaseExists } from './connection.js';
import { upsertUser } from './repositories/userRepository.js';
import { saveDailyState } from './repositories/dailyStateRepository.js';
import { saveConversation } from './repositories/conversationRepository.js';
import { importDeals } from './repositories/dealRepository.js';
import { addProcessedMessages } from './repositories/processedMessageRepository.js';
import { saveCouponImage } from './repositories/couponImageRepository.js';
import { logger } from '../utils/logger.js';
import { DailyState, Conversation, CouponType } from '../conversation/types.js';

interface OldPersistedState {
  accountId: string;
  dailyState: DailyState;
  conversations: Record<string, any>;
  processedMessageIds: string[];
}

interface OldDealRecord {
  id: string;
  date: string;
  timestamp: string;
  couponType: CouponType;
  sellerName: string;
  sellerId: string;
  price: number;
  messName?: string;
  status: 'success' | 'failed';
  failureReason?: string;
  couponImagePath?: string;
  refundReceived?: boolean;
}

interface OldHistoryData {
  accountId?: string;
  deals: OldDealRecord[];
}

interface MigrationResult {
  success: boolean;
  stateFilesMigrated: number;
  historyFilesMigrated: number;
  conversationsMigrated: number;
  dealsMigrated: number;
  processedMessagesMigrated: number;
  couponImagesMigrated: number;
  errors: string[];
}

/**
 * Check if migration is needed
 */
export function needsMigration(): boolean {
  const dataDir = getDataDir();

  if (!existsSync(dataDir)) {
    return false;
  }

  // Check for state_*.json or history_*.json files
  const files = readdirSync(dataDir);
  const hasJsonFiles = files.some(f =>
    (f.startsWith('state_') && f.endsWith('.json')) ||
    (f.startsWith('history_') && f.endsWith('.json'))
  );

  return hasJsonFiles;
}

/**
 * Migrate a single state JSON file to the database
 */
function migrateStateFile(filePath: string, accountId: string): {
  conversations: number;
  processedMessages: number;
  errors: string[];
} {
  const errors: string[] = [];
  let conversationsCount = 0;
  let processedMessagesCount = 0;

  try {
    const data = readFileSync(filePath, 'utf-8');
    const state: OldPersistedState = JSON.parse(data);

    // Ensure user exists
    upsertUser(accountId);

    // Migrate daily state
    if (state.dailyState) {
      saveDailyState(accountId, state.dailyState);
    }

    // Migrate conversations
    if (state.conversations) {
      for (const [id, convData] of Object.entries(state.conversations)) {
        try {
          const conversation: Conversation = {
            ...convData,
            createdAt: new Date(convData.createdAt),
            updatedAt: new Date(convData.updatedAt),
            lastCouponRequestTime: convData.lastCouponRequestTime
              ? new Date(convData.lastCouponRequestTime)
              : undefined,
            completedAt: convData.completedAt
              ? new Date(convData.completedAt)
              : undefined,
            messages: convData.messages?.map((m: any) => ({
              ...m,
              timestamp: new Date(m.timestamp)
            }))
          };
          saveConversation(accountId, conversation);
          conversationsCount++;
        } catch (error: any) {
          errors.push(`Failed to migrate conversation ${id}: ${error.message}`);
        }
      }
    }

    // Migrate processed message IDs
    if (state.processedMessageIds && state.processedMessageIds.length > 0) {
      processedMessagesCount = addProcessedMessages(accountId, state.processedMessageIds);
    }

  } catch (error: any) {
    errors.push(`Failed to read/parse state file: ${error.message}`);
  }

  return { conversations: conversationsCount, processedMessages: processedMessagesCount, errors };
}

/**
 * Migrate a single history JSON file to the database
 */
function migrateHistoryFile(filePath: string, accountId: string): {
  deals: number;
  images: number;
  errors: string[];
} {
  const errors: string[] = [];
  let dealsCount = 0;
  let imagesCount = 0;

  try {
    const data = readFileSync(filePath, 'utf-8');
    const history: OldHistoryData = JSON.parse(data);

    // Ensure user exists
    upsertUser(accountId);

    // Migrate deals
    if (history.deals && history.deals.length > 0) {
      dealsCount = importDeals(accountId, history.deals);

      // Create coupon image records for deals with images
      for (const deal of history.deals) {
        if (deal.couponImagePath) {
          try {
            // Set expiry to 2 days from deal timestamp (or 2 days from now for old deals)
            saveCouponImage(
              accountId,
              deal.couponImagePath,
              deal.couponType,
              deal.sellerName,
              deal.id,
              2 // 2 days retention
            );
            imagesCount++;
          } catch (error: any) {
            // Ignore duplicate image errors
            if (!error.message?.includes('UNIQUE constraint')) {
              errors.push(`Failed to create image record for ${deal.couponImagePath}: ${error.message}`);
            }
          }
        }
      }
    }

  } catch (error: any) {
    errors.push(`Failed to read/parse history file: ${error.message}`);
  }

  return { deals: dealsCount, images: imagesCount, errors };
}

/**
 * Run the full migration process
 */
export function runMigration(): MigrationResult {
  const result: MigrationResult = {
    success: true,
    stateFilesMigrated: 0,
    historyFilesMigrated: 0,
    conversationsMigrated: 0,
    dealsMigrated: 0,
    processedMessagesMigrated: 0,
    couponImagesMigrated: 0,
    errors: []
  };

  const dataDir = getDataDir();

  if (!existsSync(dataDir)) {
    logger.info('No data directory found, skipping migration');
    return result;
  }

  const files = readdirSync(dataDir);

  // Find state files
  const stateFiles = files.filter(f => f.startsWith('state_') && f.endsWith('.json'));
  const historyFiles = files.filter(f => f.startsWith('history_') && f.endsWith('.json'));

  if (stateFiles.length === 0 && historyFiles.length === 0) {
    logger.info('No JSON files to migrate');
    return result;
  }

  logger.info('Starting JSON to SQLite migration', {
    stateFiles: stateFiles.length,
    historyFiles: historyFiles.length
  });

  // Migrate state files
  for (const filename of stateFiles) {
    const filePath = join(dataDir, filename);

    // Extract account ID from filename (state_{accountId}.json)
    const accountId = filename.replace('state_', '').replace('.json', '');

    logger.info(`Migrating state file for account ${accountId.substring(0, 4)}...`);

    const { conversations, processedMessages, errors } = migrateStateFile(filePath, accountId);

    result.conversationsMigrated += conversations;
    result.processedMessagesMigrated += processedMessages;
    result.errors.push(...errors);

    // Rename file to .migrated
    try {
      renameSync(filePath, `${filePath}.migrated`);
      result.stateFilesMigrated++;
      logger.info(`State file migrated and renamed`, {
        accountId: accountId.substring(0, 4),
        conversations,
        processedMessages
      });
    } catch (error: any) {
      result.errors.push(`Failed to rename ${filename}: ${error.message}`);
    }
  }

  // Migrate history files
  for (const filename of historyFiles) {
    const filePath = join(dataDir, filename);

    // Extract account ID from filename (history_{accountId}.json)
    const accountId = filename.replace('history_', '').replace('.json', '');

    logger.info(`Migrating history file for account ${accountId.substring(0, 4)}...`);

    const { deals, images, errors } = migrateHistoryFile(filePath, accountId);

    result.dealsMigrated += deals;
    result.couponImagesMigrated += images;
    result.errors.push(...errors);

    // Rename file to .migrated
    try {
      renameSync(filePath, `${filePath}.migrated`);
      result.historyFilesMigrated++;
      logger.info(`History file migrated and renamed`, {
        accountId: accountId.substring(0, 4),
        deals,
        images
      });
    } catch (error: any) {
      result.errors.push(`Failed to rename ${filename}: ${error.message}`);
    }
  }

  // Log final results
  if (result.errors.length > 0) {
    result.success = false;
    logger.warn('Migration completed with errors', {
      ...result,
      errors: result.errors.slice(0, 5) // Log first 5 errors
    });
  } else {
    logger.info('Migration completed successfully', {
      stateFilesMigrated: result.stateFilesMigrated,
      historyFilesMigrated: result.historyFilesMigrated,
      conversationsMigrated: result.conversationsMigrated,
      dealsMigrated: result.dealsMigrated,
      processedMessagesMigrated: result.processedMessagesMigrated,
      couponImagesMigrated: result.couponImagesMigrated
    });
  }

  return result;
}
