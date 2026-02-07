import { logger } from '../utils/logger.js';

export interface UPIPaymentDetails {
  upiId: string;
  name: string;
  amount: number;
  note?: string;
}

export function generateUPIDeepLink(details: UPIPaymentDetails): string {
  const params = new URLSearchParams({
    pa: details.upiId,
    pn: details.name,
    am: details.amount.toString(),
    cu: 'INR'
  });

  if (details.note) {
    params.set('tn', details.note);
  }

  const link = `upi://pay?${params.toString()}`;
  logger.debug('Generated UPI link', { link });
  return link;
}

export function generateGPayLink(details: UPIPaymentDetails): string {
  const params = new URLSearchParams({
    pa: details.upiId,
    pn: details.name,
    am: details.amount.toString(),
    cu: 'INR'
  });

  if (details.note) {
    params.set('tn', details.note);
  }

  return `gpay://upi/pay?${params.toString()}`;
}

export function generatePhonePeLink(details: UPIPaymentDetails): string {
  const params = new URLSearchParams({
    pa: details.upiId,
    pn: details.name,
    am: details.amount.toString(),
    cu: 'INR'
  });

  if (details.note) {
    params.set('tn', details.note);
  }

  return `phonepe://pay?${params.toString()}`;
}

export function validateUPIId(upiId: string): boolean {
  // Basic UPI ID validation: handle@provider format
  const upiRegex = /^[a-zA-Z0-9._-]+@[a-zA-Z]+$/;
  return upiRegex.test(upiId);
}

export function formatPaymentInstructions(details: UPIPaymentDetails): string {
  const upiLink = generateUPIDeepLink(details);

  return `
Payment Details:
----------------
Amount: Rs.${details.amount}
UPI ID: ${details.upiId}
Name: ${details.name}

Quick Pay Links:
- GPay/PhonePe/Paytm: ${upiLink}

Manual Steps:
1. Open your UPI app (GPay/PhonePe/Paytm)
2. Go to "Pay to UPI ID"
3. Enter: ${details.upiId}
4. Amount: Rs.${details.amount}
5. Complete payment
`;
}
