import { writeFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { CouponType } from '../conversation/types.js';
import { logger } from '../utils/logger.js';
import { getCurrentAccountId } from './persistence.js';
import {
  saveDeal,
  getDeals as dbGetDeals,
  getTodayDeals as dbGetTodayDeals,
  getDealStats as dbGetDealStats
} from '../database/repositories/dealRepository.js';
import {
  saveCouponImage as dbSaveCouponImage,
  linkImageToDeal
} from '../database/repositories/couponImageRepository.js';
import { getDataDir } from '../database/connection.js';

const COUPONS_DIR = join(getDataDir(), 'coupons');

// Ensure directories exist
if (!existsSync(COUPONS_DIR)) mkdirSync(COUPONS_DIR, { recursive: true });

export interface DealRecord {
  id: string;
  date: string;  // YYYY-MM-DD
  timestamp: string;  // ISO string
  couponType: CouponType;
  sellerName: string;
  sellerId: string;
  price: number;
  messName?: string;
  status: 'success' | 'failed';
  failureReason?: string;
  couponImagePath?: string;  // Relative path to coupon image
  refundReceived?: boolean;
}

export function saveCouponImage(
  couponType: CouponType,
  imageBuffer: Buffer,
  sellerName: string,
  dealId?: string
): string | null {
  try {
    const accountId = getCurrentAccountId();
    const now = new Date();
    const dateStr = now.toISOString().split('T')[0];
    const timeStr = now.toTimeString().split(' ')[0].replace(/:/g, '-');
    const safeSeller = sellerName.replace(/[^a-zA-Z0-9]/g, '_').substring(0, 20);

    // Include account ID prefix for privacy/isolation
    const accountPrefix = accountId ? `${accountId.substring(0, 6)}_` : '';
    const filename = `${accountPrefix}${dateStr}_${couponType}_${safeSeller}_${timeStr}.jpg`;
    const filepath = join(COUPONS_DIR, filename);

    // Write file to disk
    writeFileSync(filepath, imageBuffer);
    logger.info('Coupon image saved', { filename });

    // Create database record with 2-day expiry
    if (accountId) {
      try {
        dbSaveCouponImage(accountId, filename, couponType, sellerName, dealId, 2);
        logger.debug('Coupon image record created', { filename, expiresInDays: 2 });
      } catch (error: any) {
        // Log but don't fail if DB record creation fails
        logger.warn('Failed to create image database record', { filename, error: error.message });
      }
    }

    return filename;
  } catch (error) {
    logger.error('Failed to save coupon image', error);
    return null;
  }
}

export function recordSuccessfulDeal(
  conversationId: string,
  couponType: CouponType,
  sellerName: string,
  sellerId: string,
  price: number,
  messName?: string,
  couponImageFilename?: string
): DealRecord {
  const accountId = getCurrentAccountId();

  const now = new Date();
  const record: DealRecord = {
    id: conversationId,
    date: now.toISOString().split('T')[0],
    timestamp: now.toISOString(),
    couponType,
    sellerName,
    sellerId,
    price,
    messName,
    status: 'success',
    couponImagePath: couponImageFilename
  };

  // Save to database
  if (accountId) {
    saveDeal(accountId, record);

    // Link image to deal if exists
    if (couponImageFilename) {
      try {
        linkImageToDeal(couponImageFilename, conversationId);
      } catch (error: any) {
        logger.warn('Failed to link image to deal', { filename: couponImageFilename, error: error.message });
      }
    }
  }

  logger.info('Recorded successful deal', { id: conversationId, couponType });

  return record;
}

export function recordFailedDeal(
  conversationId: string,
  couponType: CouponType,
  sellerName: string,
  sellerId: string,
  price: number,
  failureReason: string,
  messName?: string,
  refundReceived?: boolean
): DealRecord {
  const accountId = getCurrentAccountId();

  const now = new Date();
  const record: DealRecord = {
    id: conversationId,
    date: now.toISOString().split('T')[0],
    timestamp: now.toISOString(),
    couponType,
    sellerName,
    sellerId,
    price,
    messName,
    status: 'failed',
    failureReason,
    refundReceived
  };

  // Save to database
  if (accountId) {
    saveDeal(accountId, record);
  }

  logger.info('Recorded failed deal', { id: conversationId, reason: failureReason });

  return record;
}

export function getHistory(days: number = 30): DealRecord[] {
  const accountId = getCurrentAccountId();

  if (!accountId) {
    return [];
  }

  return dbGetDeals(accountId, days);
}

export function getTodayDeals(): DealRecord[] {
  const accountId = getCurrentAccountId();

  if (!accountId) {
    return [];
  }

  return dbGetTodayDeals(accountId);
}

export function getStats(days: number = 30): {
  totalDeals: number;
  successfulDeals: number;
  failedDeals: number;
  totalSpent: number;
  lunchCount: number;
  dinnerCount: number;
} {
  const accountId = getCurrentAccountId();

  if (!accountId) {
    return {
      totalDeals: 0,
      successfulDeals: 0,
      failedDeals: 0,
      totalSpent: 0,
      lunchCount: 0,
      dinnerCount: 0
    };
  }

  return dbGetDealStats(accountId, days);
}

export function getCouponImagePath(filename: string): string | null {
  const filepath = join(COUPONS_DIR, filename);
  if (existsSync(filepath)) {
    return filepath;
  }
  return null;
}

export const COUPONS_DIRECTORY = COUPONS_DIR;
