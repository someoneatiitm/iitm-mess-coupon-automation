import { getDatabase } from '../connection.js';
import { CouponType } from '../../conversation/types.js';
import { DealRecord } from '../../state/history.js';

interface DealRow {
  id: string;
  account_id: string;
  date: string;
  timestamp: string;
  coupon_type: string;
  seller_name: string;
  seller_id: string;
  price: number;
  mess_name: string | null;
  status: string;
  failure_reason: string | null;
  coupon_image_path: string | null;
  refund_received: number;
  created_at: string;
}

function rowToDealRecord(row: DealRow): DealRecord {
  return {
    id: row.id,
    date: row.date,
    timestamp: row.timestamp,
    couponType: row.coupon_type as CouponType,
    sellerName: row.seller_name,
    sellerId: row.seller_id,
    price: row.price,
    messName: row.mess_name || undefined,
    status: row.status as 'success' | 'failed',
    failureReason: row.failure_reason || undefined,
    couponImagePath: row.coupon_image_path || undefined,
    refundReceived: row.refund_received === 1
  };
}

/**
 * Save a deal record
 */
export function saveDeal(accountId: string, deal: DealRecord): void {
  const db = getDatabase();

  const stmt = db.prepare(`
    INSERT INTO deals (
      id, account_id, date, timestamp, coupon_type, seller_name, seller_id,
      price, mess_name, status, failure_reason, coupon_image_path, refund_received
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      status = excluded.status,
      failure_reason = excluded.failure_reason,
      coupon_image_path = excluded.coupon_image_path,
      refund_received = excluded.refund_received
  `);

  stmt.run(
    deal.id,
    accountId,
    deal.date,
    deal.timestamp,
    deal.couponType,
    deal.sellerName,
    deal.sellerId,
    deal.price,
    deal.messName || null,
    deal.status,
    deal.failureReason || null,
    deal.couponImagePath || null,
    deal.refundReceived ? 1 : 0
  );
}

/**
 * Get a deal by ID
 */
export function getDeal(dealId: string): DealRecord | null {
  const db = getDatabase();

  const stmt = db.prepare('SELECT * FROM deals WHERE id = ?');
  const row = stmt.get(dealId) as DealRow | undefined;

  if (!row) return null;

  return rowToDealRecord(row);
}

/**
 * Get deals for an account within the last N days
 */
export function getDeals(accountId: string, days: number = 90): DealRecord[] {
  const db = getDatabase();

  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - days);

  const stmt = db.prepare(`
    SELECT * FROM deals
    WHERE account_id = ? AND timestamp > ?
    ORDER BY timestamp DESC
  `);

  const rows = stmt.all(accountId, cutoffDate.toISOString()) as DealRow[];

  return rows.map(rowToDealRecord);
}

/**
 * Get deals for a specific date
 */
export function getDealsByDate(accountId: string, date: string): DealRecord[] {
  const db = getDatabase();

  const stmt = db.prepare(`
    SELECT * FROM deals
    WHERE account_id = ? AND date = ?
    ORDER BY timestamp DESC
  `);

  const rows = stmt.all(accountId, date) as DealRow[];

  return rows.map(rowToDealRecord);
}

/**
 * Get today's deals for an account
 */
export function getTodayDeals(accountId: string): DealRecord[] {
  const today = new Date().toISOString().split('T')[0];
  return getDealsByDate(accountId, today);
}

/**
 * Get deal statistics for an account
 */
export function getDealStats(accountId: string, days: number = 30): {
  totalDeals: number;
  successfulDeals: number;
  failedDeals: number;
  totalSpent: number;
  lunchCount: number;
  dinnerCount: number;
} {
  const db = getDatabase();

  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - days);

  const stmt = db.prepare(`
    SELECT
      COUNT(*) as total,
      SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) as successful,
      SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as failed,
      SUM(CASE WHEN status = 'success' THEN price ELSE 0 END) as total_spent,
      SUM(CASE WHEN status = 'success' AND coupon_type = 'lunch' THEN 1 ELSE 0 END) as lunch_count,
      SUM(CASE WHEN status = 'success' AND coupon_type = 'dinner' THEN 1 ELSE 0 END) as dinner_count
    FROM deals
    WHERE account_id = ? AND timestamp > ?
  `);

  const row = stmt.get(accountId, cutoffDate.toISOString()) as any;

  return {
    totalDeals: row.total || 0,
    successfulDeals: row.successful || 0,
    failedDeals: row.failed || 0,
    totalSpent: row.total_spent || 0,
    lunchCount: row.lunch_count || 0,
    dinnerCount: row.dinner_count || 0
  };
}

/**
 * Clean up deals older than N days
 */
export function cleanupOldDeals(accountId: string, daysToKeep: number = 90): number {
  const db = getDatabase();

  const stmt = db.prepare(`
    DELETE FROM deals
    WHERE account_id = ? AND timestamp < datetime('now', '-' || ? || ' days')
  `);

  const result = stmt.run(accountId, daysToKeep);
  return result.changes;
}

/**
 * Import multiple deals (for migration)
 */
export function importDeals(accountId: string, deals: DealRecord[]): number {
  const db = getDatabase();

  const importMany = db.transaction((dealList: DealRecord[]) => {
    let count = 0;
    for (const deal of dealList) {
      saveDeal(accountId, deal);
      count++;
    }
    return count;
  });

  return importMany(deals);
}
