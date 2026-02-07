import { DailyState, Conversation } from '../conversation/types.js';
import { logger } from '../utils/logger.js';
import {
  upsertUser,
  saveDailyState as dbSaveDailyState,
  getLatestDailyState,
  saveConversations as dbSaveConversations,
  getConversations as dbGetConversations,
  addProcessedMessages,
  getProcessedMessages as dbGetProcessedMessages
} from '../database/index.js';

// Current account identifier (phone number hash for privacy)
let currentAccountId: string | null = null;

function getDefaultDailyState(): DailyState {
  const today = new Date().toISOString().split('T')[0];
  return {
    date: today,
    lunchBought: false,
    dinnerBought: false
  };
}

// Hash phone number for privacy (don't store raw phone in filename)
function hashPhone(phone: string): string {
  let hash = 0;
  for (let i = 0; i < phone.length; i++) {
    const char = phone.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash; // Convert to 32bit integer
  }
  return Math.abs(hash).toString(36);
}

// Set the current account (call this when WhatsApp client is ready)
export function setCurrentAccount(phoneNumber: string): void {
  const newAccountId = hashPhone(phoneNumber);

  if (currentAccountId && currentAccountId !== newAccountId) {
    logger.info('Account changed, will load new account data', {
      oldAccount: currentAccountId.substring(0, 4) + '...',
      newAccount: newAccountId.substring(0, 4) + '...'
    });
  }

  currentAccountId = newAccountId;

  // Create/update user record in database
  upsertUser(currentAccountId);

  logger.info('Current account set', { accountId: currentAccountId.substring(0, 4) + '...' });
}

// Get current account ID
export function getCurrentAccountId(): string | null {
  return currentAccountId;
}

// Clear current account (on logout)
export function clearCurrentAccount(): void {
  currentAccountId = null;
  logger.info('Current account cleared');
}

export function loadState(accountId?: string): { dailyState: DailyState; conversations: Map<string, Conversation>; processedMessageIds: Set<string> } {
  const targetAccountId = accountId || currentAccountId;

  // If no account is set, return empty state
  if (!targetAccountId) {
    logger.info('No account set, starting with empty state');
    return {
      dailyState: getDefaultDailyState(),
      conversations: new Map(),
      processedMessageIds: new Set()
    };
  }

  try {
    // Load daily state from database
    const storedState = getLatestDailyState(targetAccountId);
    let dailyState: DailyState;

    if (!storedState) {
      logger.info('No state found for account, starting fresh');
      dailyState = getDefaultDailyState();
    } else {
      // Check if it's a new day
      const today = new Date().toISOString().split('T')[0];
      if (storedState.date !== today) {
        logger.info('New day detected, resetting daily state');
        dailyState = getDefaultDailyState();
      } else {
        dailyState = storedState;
      }
    }

    // Load conversations from database
    const conversations = dbGetConversations(targetAccountId);

    // Load processed message IDs from database
    const processedMessageIds = dbGetProcessedMessages(targetAccountId);

    logger.info('State loaded for account', {
      accountId: targetAccountId.substring(0, 4) + '...',
      conversations: conversations.size,
      processedMessages: processedMessageIds.size
    });

    return {
      dailyState,
      conversations,
      processedMessageIds
    };
  } catch (error) {
    logger.error('Failed to load state, starting fresh', error);
    return {
      dailyState: getDefaultDailyState(),
      conversations: new Map(),
      processedMessageIds: new Set()
    };
  }
}

export function saveState(
  dailyState: DailyState,
  conversations: Map<string, Conversation>,
  processedMessageIds: Set<string>
): void {
  // Don't save if no account is set
  if (!currentAccountId) {
    logger.debug('No account set, skipping state save');
    return;
  }

  try {
    // Save daily state to database
    dbSaveDailyState(currentAccountId, dailyState);

    // Save conversations to database
    dbSaveConversations(currentAccountId, conversations);

    // Save new processed message IDs (addProcessedMessages handles duplicates)
    const messageIdArray = Array.from(processedMessageIds);
    if (messageIdArray.length > 0) {
      addProcessedMessages(currentAccountId, messageIdArray);
    }

    logger.debug('State saved for account', { accountId: currentAccountId.substring(0, 4) + '...' });
  } catch (error) {
    logger.error('Failed to save state', error);
  }
}

// Load state for a specific account (used when client becomes ready)
export function loadStateForAccount(phoneNumber: string): { dailyState: DailyState; conversations: Map<string, Conversation>; processedMessageIds: Set<string> } {
  setCurrentAccount(phoneNumber);
  return loadState(currentAccountId!);
}
