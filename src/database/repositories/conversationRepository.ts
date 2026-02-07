import { getDatabase } from '../connection.js';
import { Conversation, ConversationState, CouponType, ChatMessage } from '../../conversation/types.js';

interface ConversationRow {
  id: string;
  account_id: string;
  seller_id: string;
  seller_name: string;
  coupon_type: string;
  state: string;
  price: number;
  upi_id: string | null;
  group_id: string;
  group_name: string;
  original_message_id: string;
  mess_name: string | null;
  failure_reason: string | null;
  coupon_follow_up_count: number | null;
  last_coupon_request_time: string | null;
  refund_requested: number;
  refund_received: number;
  refund_screenshot_received: number;
  messages: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

function rowToConversation(row: ConversationRow): Conversation {
  return {
    id: row.id,
    sellerId: row.seller_id,
    sellerName: row.seller_name,
    couponType: row.coupon_type as CouponType,
    state: row.state as ConversationState,
    price: row.price,
    upiId: row.upi_id,
    groupId: row.group_id,
    groupName: row.group_name,
    originalMessageId: row.original_message_id,
    messName: row.mess_name || undefined,
    failureReason: row.failure_reason || undefined,
    couponFollowUpCount: row.coupon_follow_up_count || undefined,
    lastCouponRequestTime: row.last_coupon_request_time ? new Date(row.last_coupon_request_time) : undefined,
    refundRequested: row.refund_requested === 1,
    refundReceived: row.refund_received === 1,
    refundScreenshotReceived: row.refund_screenshot_received === 1,
    messages: row.messages ? JSON.parse(row.messages).map((m: any) => ({
      ...m,
      timestamp: new Date(m.timestamp)
    })) : undefined,
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at),
    completedAt: row.completed_at ? new Date(row.completed_at) : undefined
  };
}

/**
 * Save or update a conversation
 */
export function saveConversation(accountId: string, conversation: Conversation): void {
  const db = getDatabase();

  const stmt = db.prepare(`
    INSERT INTO conversations (
      id, account_id, seller_id, seller_name, coupon_type, state, price, upi_id,
      group_id, group_name, original_message_id, mess_name, failure_reason,
      coupon_follow_up_count, last_coupon_request_time,
      refund_requested, refund_received, refund_screenshot_received,
      messages, created_at, updated_at, completed_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      state = excluded.state,
      price = excluded.price,
      upi_id = excluded.upi_id,
      mess_name = excluded.mess_name,
      failure_reason = excluded.failure_reason,
      coupon_follow_up_count = excluded.coupon_follow_up_count,
      last_coupon_request_time = excluded.last_coupon_request_time,
      refund_requested = excluded.refund_requested,
      refund_received = excluded.refund_received,
      refund_screenshot_received = excluded.refund_screenshot_received,
      messages = excluded.messages,
      updated_at = excluded.updated_at,
      completed_at = excluded.completed_at
  `);

  stmt.run(
    conversation.id,
    accountId,
    conversation.sellerId,
    conversation.sellerName,
    conversation.couponType,
    conversation.state,
    conversation.price,
    conversation.upiId,
    conversation.groupId,
    conversation.groupName,
    conversation.originalMessageId,
    conversation.messName || null,
    conversation.failureReason || null,
    conversation.couponFollowUpCount || null,
    conversation.lastCouponRequestTime?.toISOString() || null,
    conversation.refundRequested ? 1 : 0,
    conversation.refundReceived ? 1 : 0,
    conversation.refundScreenshotReceived ? 1 : 0,
    conversation.messages ? JSON.stringify(conversation.messages) : null,
    conversation.createdAt.toISOString(),
    conversation.updatedAt.toISOString(),
    conversation.completedAt?.toISOString() || null
  );
}

/**
 * Save multiple conversations in a transaction
 */
export function saveConversations(accountId: string, conversations: Map<string, Conversation>): void {
  const db = getDatabase();

  const saveMany = db.transaction((convMap: Map<string, Conversation>) => {
    for (const conversation of convMap.values()) {
      saveConversation(accountId, conversation);
    }
  });

  saveMany(conversations);
}

/**
 * Get a conversation by ID
 */
export function getConversation(conversationId: string): Conversation | null {
  const db = getDatabase();

  const stmt = db.prepare('SELECT * FROM conversations WHERE id = ?');
  const row = stmt.get(conversationId) as ConversationRow | undefined;

  if (!row) return null;

  return rowToConversation(row);
}

/**
 * Get all conversations for an account
 */
export function getConversations(accountId: string): Map<string, Conversation> {
  const db = getDatabase();

  const stmt = db.prepare('SELECT * FROM conversations WHERE account_id = ?');
  const rows = stmt.all(accountId) as ConversationRow[];

  const conversations = new Map<string, Conversation>();
  for (const row of rows) {
    conversations.set(row.id, rowToConversation(row));
  }

  return conversations;
}

/**
 * Get active (non-completed, non-failed) conversations for an account
 */
export function getActiveConversations(accountId: string): Conversation[] {
  const db = getDatabase();

  const stmt = db.prepare(`
    SELECT * FROM conversations
    WHERE account_id = ? AND state NOT IN ('COMPLETED', 'FAILED')
  `);

  const rows = stmt.all(accountId) as ConversationRow[];

  return rows.map(rowToConversation);
}

/**
 * Delete a conversation
 */
export function deleteConversation(conversationId: string): boolean {
  const db = getDatabase();

  const stmt = db.prepare('DELETE FROM conversations WHERE id = ?');
  const result = stmt.run(conversationId);

  return result.changes > 0;
}

/**
 * Delete all conversations for an account
 */
export function deleteAllConversations(accountId: string): number {
  const db = getDatabase();

  const stmt = db.prepare('DELETE FROM conversations WHERE account_id = ?');
  const result = stmt.run(accountId);

  return result.changes;
}

/**
 * Clean up old completed/failed conversations (keep last N days)
 */
export function cleanupOldConversations(accountId: string, daysToKeep: number = 90): number {
  const db = getDatabase();

  const stmt = db.prepare(`
    DELETE FROM conversations
    WHERE account_id = ?
      AND state IN ('COMPLETED', 'FAILED')
      AND updated_at < datetime('now', '-' || ? || ' days')
  `);

  const result = stmt.run(accountId, daysToKeep);
  return result.changes;
}
