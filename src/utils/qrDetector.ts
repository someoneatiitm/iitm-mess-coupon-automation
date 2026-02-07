import { Jimp } from 'jimp';
import * as jsQRModule from 'jsqr';
import { logger } from './logger.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const jsQR = (jsQRModule as any).default || jsQRModule;

export interface QRDetectionResult {
  hasQR: boolean;
  data: string | null;
}

export async function detectQRCode(imageBuffer: Buffer): Promise<QRDetectionResult> {
  try {
    const image = await Jimp.read(imageBuffer);
    const width = image.width;
    const height = image.height;

    // Get raw pixel data using the bitmap
    const bitmap = image.bitmap;
    const imageData = new Uint8ClampedArray(bitmap.data);

    // jsQR expects RGBA data
    const code = jsQR(imageData, width, height);

    if (code) {
      logger.info('QR code detected', { data: code.data.substring(0, 50) });
      return { hasQR: true, data: code.data };
    }

    return { hasQR: false, data: null };
  } catch (error) {
    logger.error('Failed to detect QR code', error);
    return { hasQR: false, data: null };
  }
}

export async function isLikelyCouponImage(imageBuffer: Buffer): Promise<boolean> {
  // Check if image contains a QR code (likely a coupon)
  const result = await detectQRCode(imageBuffer);
  return result.hasQR;
}
