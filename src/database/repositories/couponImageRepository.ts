import { getDatabase } from '../connection.js';
import { CouponType } from '../../conversation/types.js';

export interface CouponImage {
  id: number;
  accountId: string;
  filename: string;
  dealId: string | null;
  couponType: CouponType;
  sellerName: string | null;
  createdAt: string;
  expiresAt: string;
}

interface CouponImageRow {
  id: number;
  account_id: string;
  filename: string;
  deal_id: string | null;
  coupon_type: string;
  seller_name: string | null;
  created_at: string;
  expires_at: string;
}

function rowToImage(row: CouponImageRow): CouponImage {
  return {
    id: row.id,
    accountId: row.account_id,
    filename: row.filename,
    dealId: row.deal_id,
    couponType: row.coupon_type as CouponType,
    sellerName: row.seller_name,
    createdAt: row.created_at,
    expiresAt: row.expires_at
  };
}

/**
 * Save a coupon image record with 2-day expiry
 */
export function saveCouponImage(
  accountId: string,
  filename: string,
  couponType: CouponType,
  sellerName?: string,
  dealId?: string,
  retentionDays: number = 2
): CouponImage {
  const db = getDatabase();

  const stmt = db.prepare(`
    INSERT INTO coupon_images (account_id, filename, deal_id, coupon_type, seller_name, expires_at)
    VALUES (?, ?, ?, ?, ?, datetime('now', '+' || ? || ' days'))
    RETURNING *
  `);

  const row = stmt.get(
    accountId,
    filename,
    dealId || null,
    couponType,
    sellerName || null,
    retentionDays
  ) as CouponImageRow;

  return rowToImage(row);
}

/**
 * Get a coupon image by filename
 */
export function getCouponImage(filename: string): CouponImage | null {
  const db = getDatabase();

  const stmt = db.prepare('SELECT * FROM coupon_images WHERE filename = ?');
  const row = stmt.get(filename) as CouponImageRow | undefined;

  if (!row) return null;

  return rowToImage(row);
}

/**
 * Get all coupon images for an account
 */
export function getCouponImages(accountId: string): CouponImage[] {
  const db = getDatabase();

  const stmt = db.prepare(`
    SELECT * FROM coupon_images
    WHERE account_id = ?
    ORDER BY created_at DESC
  `);

  const rows = stmt.all(accountId) as CouponImageRow[];

  return rows.map(rowToImage);
}

/**
 * Get expired coupon images (for cleanup)
 */
export function getExpiredImages(): CouponImage[] {
  const db = getDatabase();

  const stmt = db.prepare(`
    SELECT * FROM coupon_images
    WHERE expires_at < datetime('now')
  `);

  const rows = stmt.all() as CouponImageRow[];

  return rows.map(rowToImage);
}

/**
 * Delete a coupon image record by filename
 */
export function deleteCouponImage(filename: string): boolean {
  const db = getDatabase();

  const stmt = db.prepare('DELETE FROM coupon_images WHERE filename = ?');
  const result = stmt.run(filename);

  return result.changes > 0;
}

/**
 * Delete a coupon image record by ID
 */
export function deleteCouponImageById(id: number): boolean {
  const db = getDatabase();

  const stmt = db.prepare('DELETE FROM coupon_images WHERE id = ?');
  const result = stmt.run(id);

  return result.changes > 0;
}

/**
 * Delete expired coupon image records
 */
export function deleteExpiredImageRecords(): number {
  const db = getDatabase();

  const stmt = db.prepare(`
    DELETE FROM coupon_images
    WHERE expires_at < datetime('now')
  `);

  const result = stmt.run();
  return result.changes;
}

/**
 * Update deal ID for a coupon image
 */
export function linkImageToDeal(filename: string, dealId: string): boolean {
  const db = getDatabase();

  const stmt = db.prepare(`
    UPDATE coupon_images
    SET deal_id = ?
    WHERE filename = ?
  `);

  const result = stmt.run(dealId, filename);
  return result.changes > 0;
}

/**
 * Extend expiry for an image (e.g., if user wants to keep it longer)
 */
export function extendImageExpiry(filename: string, additionalDays: number): boolean {
  const db = getDatabase();

  const stmt = db.prepare(`
    UPDATE coupon_images
    SET expires_at = datetime(expires_at, '+' || ? || ' days')
    WHERE filename = ?
  `);

  const result = stmt.run(additionalDays, filename);
  return result.changes > 0;
}

/**
 * Get statistics about coupon images
 */
export function getImageStats(): {
  total: number;
  expired: number;
  byAccount: Record<string, number>;
} {
  const db = getDatabase();

  const totalStmt = db.prepare('SELECT COUNT(*) as count FROM coupon_images');
  const total = (totalStmt.get() as any).count;

  const expiredStmt = db.prepare(`
    SELECT COUNT(*) as count FROM coupon_images
    WHERE expires_at < datetime('now')
  `);
  const expired = (expiredStmt.get() as any).count;

  const byAccountStmt = db.prepare(`
    SELECT account_id, COUNT(*) as count FROM coupon_images
    GROUP BY account_id
  `);
  const byAccountRows = byAccountStmt.all() as any[];
  const byAccount: Record<string, number> = {};
  for (const row of byAccountRows) {
    byAccount[row.account_id] = row.count;
  }

  return { total, expired, byAccount };
}
