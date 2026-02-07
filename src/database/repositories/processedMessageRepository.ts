import { getDatabase } from '../connection.js';

/**
 * Add a processed message ID
 */
export function addProcessedMessage(accountId: string, messageId: string): boolean {
  const db = getDatabase();

  try {
    const stmt = db.prepare(`
      INSERT INTO processed_messages (account_id, message_id)
      VALUES (?, ?)
    `);
    stmt.run(accountId, messageId);
    return true;
  } catch (error: any) {
    // Unique constraint violation = message already processed
    if (error.code === 'SQLITE_CONSTRAINT_UNIQUE') {
      return false;
    }
    throw error;
  }
}

/**
 * Check if a message has been processed
 */
export function isMessageProcessed(accountId: string, messageId: string): boolean {
  const db = getDatabase();

  const stmt = db.prepare(`
    SELECT 1 FROM processed_messages
    WHERE account_id = ? AND message_id = ?
  `);

  return stmt.get(accountId, messageId) !== undefined;
}

/**
 * Get all processed message IDs for an account
 */
export function getProcessedMessages(accountId: string): Set<string> {
  const db = getDatabase();

  const stmt = db.prepare(`
    SELECT message_id FROM processed_messages
    WHERE account_id = ?
  `);

  const rows = stmt.all(accountId) as { message_id: string }[];

  return new Set(rows.map(r => r.message_id));
}

/**
 * Add multiple processed message IDs (for migration)
 */
export function addProcessedMessages(accountId: string, messageIds: string[]): number {
  const db = getDatabase();

  const addMany = db.transaction((ids: string[]) => {
    let count = 0;
    const stmt = db.prepare(`
      INSERT OR IGNORE INTO processed_messages (account_id, message_id)
      VALUES (?, ?)
    `);

    for (const messageId of ids) {
      const result = stmt.run(accountId, messageId);
      if (result.changes > 0) count++;
    }

    return count;
  });

  return addMany(messageIds);
}

/**
 * Delete a processed message record
 */
export function deleteProcessedMessage(accountId: string, messageId: string): boolean {
  const db = getDatabase();

  const stmt = db.prepare(`
    DELETE FROM processed_messages
    WHERE account_id = ? AND message_id = ?
  `);

  const result = stmt.run(accountId, messageId);
  return result.changes > 0;
}

/**
 * Clean up old processed message records (older than N days)
 */
export function cleanupOldProcessedMessages(accountId: string, daysToKeep: number = 7): number {
  const db = getDatabase();

  const stmt = db.prepare(`
    DELETE FROM processed_messages
    WHERE account_id = ? AND processed_at < datetime('now', '-' || ? || ' days')
  `);

  const result = stmt.run(accountId, daysToKeep);
  return result.changes;
}

/**
 * Get count of processed messages for an account
 */
export function getProcessedMessageCount(accountId: string): number {
  const db = getDatabase();

  const stmt = db.prepare(`
    SELECT COUNT(*) as count FROM processed_messages
    WHERE account_id = ?
  `);

  const row = stmt.get(accountId) as { count: number };
  return row.count;
}
