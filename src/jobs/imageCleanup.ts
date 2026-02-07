/**
 * Image Cleanup Job
 *
 * Automatically cleans up expired coupon images based on the 2-day retention policy.
 * Runs hourly to remove old files and database records.
 */

import { existsSync, unlinkSync, readdirSync } from 'fs';
import { join } from 'path';
import { getExpiredImages, deleteCouponImageById, getImageStats, getCouponImage } from '../database/index.js';
import { getDataDir } from '../database/connection.js';
import { logger } from '../utils/logger.js';

const COUPONS_DIR = join(getDataDir(), 'coupons');
const CLEANUP_INTERVAL_MS = 60 * 60 * 1000; // 1 hour

let cleanupIntervalId: NodeJS.Timeout | null = null;

/**
 * Run the image cleanup process
 * - Queries for expired images in the database
 * - Deletes the actual files from disk
 * - Removes the database records
 */
export function runImageCleanup(): { filesDeleted: number; recordsDeleted: number; errors: string[] } {
  const errors: string[] = [];
  let filesDeleted = 0;
  let recordsDeleted = 0;

  try {
    // Get expired images from database
    const expiredImages = getExpiredImages();

    if (expiredImages.length === 0) {
      logger.debug('Image cleanup: No expired images found');
      return { filesDeleted: 0, recordsDeleted: 0, errors: [] };
    }

    logger.info('Image cleanup: Found expired images', { count: expiredImages.length });

    for (const image of expiredImages) {
      try {
        // Delete file from disk
        const filePath = join(COUPONS_DIR, image.filename);
        if (existsSync(filePath)) {
          unlinkSync(filePath);
          filesDeleted++;
          logger.debug('Deleted expired coupon image file', { filename: image.filename });
        }

        // Delete database record
        const deleted = deleteCouponImageById(image.id);
        if (deleted) {
          recordsDeleted++;
        }
      } catch (error: any) {
        const errorMsg = `Failed to cleanup image ${image.filename}: ${error.message}`;
        errors.push(errorMsg);
        logger.error(errorMsg, error);
      }
    }

    logger.info('Image cleanup completed', { filesDeleted, recordsDeleted, errors: errors.length });

  } catch (error: any) {
    const errorMsg = `Image cleanup job failed: ${error.message}`;
    errors.push(errorMsg);
    logger.error(errorMsg, error);
  }

  return { filesDeleted, recordsDeleted, errors };
}

/**
 * Clean up orphaned files (files on disk without database records)
 * This handles files that may have been created before the database system
 */
export function cleanupOrphanedFiles(): { orphansDeleted: number; errors: string[] } {
  const errors: string[] = [];
  let orphansDeleted = 0;

  try {
    if (!existsSync(COUPONS_DIR)) {
      return { orphansDeleted: 0, errors: [] };
    }

    const files = readdirSync(COUPONS_DIR);

    for (const filename of files) {
      // Skip non-image files
      if (!filename.endsWith('.jpg') && !filename.endsWith('.jpeg') && !filename.endsWith('.png')) {
        continue;
      }

      // Check if file has a database record
      const record = getCouponImage(filename);

      if (!record) {
        // Check file age by parsing the filename (format: accountId_YYYY-MM-DD_type_seller_HH-MM-SS.jpg)
        const match = filename.match(/(\d{4}-\d{2}-\d{2})/);
        if (match) {
          const fileDate = new Date(match[1]);
          const now = new Date();
          const ageInDays = (now.getTime() - fileDate.getTime()) / (1000 * 60 * 60 * 24);

          // Delete orphaned files older than 2 days
          if (ageInDays > 2) {
            try {
              const filePath = join(COUPONS_DIR, filename);
              unlinkSync(filePath);
              orphansDeleted++;
              logger.debug('Deleted orphaned coupon image', { filename, ageInDays: Math.round(ageInDays) });
            } catch (error: any) {
              errors.push(`Failed to delete orphan ${filename}: ${error.message}`);
            }
          }
        }
      }
    }

    if (orphansDeleted > 0) {
      logger.info('Orphaned files cleanup completed', { orphansDeleted });
    }

  } catch (error: any) {
    errors.push(`Orphan cleanup failed: ${error.message}`);
    logger.error('Orphan cleanup failed', error);
  }

  return { orphansDeleted, errors };
}

/**
 * Start the periodic image cleanup job
 */
export function startImageCleanupJob(): void {
  if (cleanupIntervalId) {
    logger.warn('Image cleanup job already running');
    return;
  }

  logger.info('Starting image cleanup job', { intervalMs: CLEANUP_INTERVAL_MS });

  // Run immediately on startup
  setTimeout(() => {
    runImageCleanup();
    cleanupOrphanedFiles();
  }, 5000); // Wait 5 seconds after startup

  // Then run hourly
  cleanupIntervalId = setInterval(() => {
    runImageCleanup();
    cleanupOrphanedFiles();
  }, CLEANUP_INTERVAL_MS);

  logger.info('Image cleanup job scheduled', { intervalHours: CLEANUP_INTERVAL_MS / (60 * 60 * 1000) });
}

/**
 * Stop the periodic image cleanup job
 */
export function stopImageCleanupJob(): void {
  if (cleanupIntervalId) {
    clearInterval(cleanupIntervalId);
    cleanupIntervalId = null;
    logger.info('Image cleanup job stopped');
  }
}

/**
 * Get image cleanup statistics
 */
export function getCleanupStats(): {
  totalImages: number;
  expiredImages: number;
  imagesByAccount: Record<string, number>;
} {
  const stats = getImageStats();
  return {
    totalImages: stats.total,
    expiredImages: stats.expired,
    imagesByAccount: stats.byAccount
  };
}
