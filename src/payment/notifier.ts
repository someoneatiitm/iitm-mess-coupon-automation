import notifier from 'node-notifier';
import { logger } from '../utils/logger.js';
import { getConfig } from '../utils/config.js';

export interface PaymentRequest {
  sellerName: string;
  upiId: string;
  amount: number;
  couponType: 'lunch' | 'dinner';
  conversationId: string;
}

export function sendPaymentNotification(request: PaymentRequest): void {
  const config = getConfig();
  const title = `Payment Required - ${request.couponType.toUpperCase()} Coupon`;
  const message = `Pay Rs.${request.amount} to ${request.sellerName}\nUPI: ${request.upiId}`;

  logger.info('Sending payment notification', request);

  // Try to send desktop notification (may fail on some systems)
  try {
    notifier.notify({
      title,
      message,
      sound: config.notificationSound,
      wait: false,
      timeout: 30
    });
  } catch (error) {
    logger.warn('Desktop notification failed', { error });
  }

  // Always log to console prominently (main fallback)
  console.log('\n' + '='.repeat(60));
  console.log('PAYMENT REQUIRED');
  console.log('='.repeat(60));
  console.log(`Coupon Type: ${request.couponType.toUpperCase()}`);
  console.log(`Seller: ${request.sellerName}`);
  console.log(`Amount: Rs.${request.amount}`);
  console.log(`UPI ID: ${request.upiId}`);
  console.log('='.repeat(60));
  console.log('Type "ok" to approve, then "paid" after payment');
  console.log('='.repeat(60) + '\n');
}

export function sendSuccessNotification(couponType: 'lunch' | 'dinner'): void {
  const config = getConfig();

  try {
    notifier.notify({
      title: 'Coupon Received!',
      message: `${couponType.toUpperCase()} coupon successfully purchased!`,
      sound: config.notificationSound
    });
  } catch (error) {
    logger.warn('Desktop notification failed', { error });
  }

  logger.info(`${couponType} coupon purchase completed!`);
  console.log('\n' + '='.repeat(60));
  console.log(`✅ ${couponType.toUpperCase()} COUPON PURCHASED!`);
  console.log('='.repeat(60) + '\n');
}

export function sendErrorNotification(message: string): void {
  try {
    notifier.notify({
      title: 'Coupon Bot Error',
      message,
      sound: true
    });
  } catch (error) {
    // Ignore notification errors
  }

  logger.error('Error notification', { message });
}
