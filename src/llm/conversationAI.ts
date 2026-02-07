import { chatWithRetry } from './groqClient.js';
import { CouponType, IITM_MESSES } from '../conversation/types.js';
import { logger } from '../utils/logger.js';
import { fuzzyMatchMessName, FuzzyMatchResult } from '../utils/fuzzyMatch.js';

// Fixed price - no negotiation
const FIXED_PRICE = 70;

// Cache for gender detection to avoid repeated LLM calls for same name
const genderCache: Map<string, 'male' | 'female' | 'neutral'> = new Map();

// Store current seller context for message generation
let currentSellerContext: { name: string; gender: 'male' | 'female' | 'neutral' } | null = null;

// Detect gender from name using LLM
async function detectGenderFromName(name: string): Promise<'male' | 'female' | 'neutral'> {
  if (!name || name === 'Unknown') return 'neutral';

  // Check cache first
  const cached = genderCache.get(name.toLowerCase());
  if (cached) return cached;

  try {
    const prompt = `Based on this Indian name, determine the likely gender. Name: "${name}"

Reply with ONLY one word: "male", "female", or "neutral" (if unsure or unisex name).`;

    const response = await chatWithRetry(prompt, 'Classify gender', 2);
    const gender = response.toLowerCase().trim();

    let result: 'male' | 'female' | 'neutral' = 'neutral';
    if (gender.includes('male') && !gender.includes('female')) {
      result = 'male';
    } else if (gender.includes('female')) {
      result = 'female';
    }

    genderCache.set(name.toLowerCase(), result);
    logger.debug('Gender detection result', { name, gender: result });
    return result;
  } catch (error) {
    logger.error('Gender detection failed', error);
    return 'neutral';
  }
}

// Get appropriate address instruction based on gender and name
function getAddressInstruction(): string {
  if (!currentSellerContext) {
    return 'Do not use any specific address term.';
  }

  const { name, gender } = currentSellerContext;
  const firstName = name && name !== 'Unknown' ? name.split(' ')[0] : null;

  switch (gender) {
    case 'male':
      return 'Address them casually as "bro" if it fits naturally.';
    case 'female':
      return firstName ? `Address them by their name "${firstName}" if needed.` : 'Be polite, no specific address term needed.';
    default:
      return firstName ? `Address them by their name "${firstName}" if needed.` : 'Be polite, no specific address term needed.';
  }
}

export async function setSellerContext(sellerName: string): Promise<void> {
  const gender = await detectGenderFromName(sellerName);
  currentSellerContext = { name: sellerName, gender };
  logger.info('Seller context set', { name: sellerName, gender });
}

export function clearSellerContext(): void {
  currentSellerContext = null;
}

// Generate message using LLM with robust error handling
async function generateMessage(task: string, maxLength: number = 80): Promise<string> {
  const addressInstruction = getAddressInstruction();

  const prompt = `You are a real college student at IIT Madras texting on WhatsApp to buy a mess coupon.

CRITICAL RULES:
- Sound 100% HUMAN, never robotic or formulaic
- Keep it SHORT (5-20 words max)
- Use ENGLISH only (no Hindi words)
- NO greetings like "Hey there!" or "Hello!" at the start
- NO phrases like "I hope this message finds you well"
- NO emojis
- Each message should feel unique, not template-like
- Be conversational like you're texting a classmate
- ${addressInstruction}

Task: ${task}

Write ONLY the message text, nothing else. No quotes around it.`;

  const response = await chatWithRetry(prompt, 'Generate natural message', 3);

  // Clean up the response
  let cleaned = response
    .replace(/^["']|["']$/g, '')  // Remove surrounding quotes
    .replace(/^\*+|\*+$/g, '')    // Remove markdown asterisks
    .trim();

  // Validate length
  if (cleaned.length < 3 || cleaned.length > maxLength * 1.5) {
    logger.warn('Generated message length unusual, regenerating', { length: cleaned.length, message: cleaned });
    // Try one more time
    const retry = await chatWithRetry(prompt, 'Generate natural message', 2);
    cleaned = retry.replace(/^["']|["']$/g, '').replace(/^\*+|\*+$/g, '').trim();
  }

  logger.debug('Generated message', { task: task.substring(0, 50), response: cleaned });
  return cleaned;
}

export async function generateInitialMessage(couponType: CouponType, groupName: string, messName?: string): Promise<string> {
  let task: string;
  if (messName) {
    // When mess name is known, mention it so buyer knows which mess
    task = `First message to someone selling a ${couponType} mess coupon for "${messName}" mess at IIT Madras. You saw their message in "${groupName}" group. Reference that you saw their message about ${messName} ${couponType} coupon and ask if it's still available. Something like "saw your message about ${messName} ${couponType} coupon, still available?" - DON'T mention any price or money yet. Keep it very short and natural.`;
  } else {
    // When mess name is not known
    task = `First message to someone selling a ${couponType} mess coupon at IIT Madras. You saw their message in "${groupName}" group. Express interest casually - DON'T mention any price or money yet. DON'T ask obvious questions like "are you selling a coupon?" or "is this for IIT Madras?" - it's already clear from context. Just say you're interested or ask if it's still available. Keep it very short and natural.`;
  }
  return generateMessage(task, 100);
}

export async function generateAskUpiMessage(): Promise<string> {
  const task = 'Seller agreed to sell the coupon. Now ask for their UPI ID to send payment. Keep it natural and brief.';
  return generateMessage(task, 60);
}

export async function generateDeclineMessage(reason?: string): Promise<string> {
  const task = `Politely decline because ${reason || 'price is more than Rs.70'}. Keep it brief and not rude. Just say you can only do 70 max.`;
  return generateMessage(task, 60);
}

export async function generatePaymentConfirmation(upiId: string, amount: number): Promise<string> {
  const task = `You just sent Rs.${amount} payment. Tell them to check and share the coupon screenshot. Sound natural.`;
  return generateMessage(task, 80);
}

export async function generatePaymentDoneWithThanks(): Promise<string> {
  const task = 'You just sent the payment and you already received the coupon screenshot. Say payment done and thanks for the coupon in a brief, natural way. Keep it short.';
  return generateMessage(task, 50);
}

export async function generatePayingNowMessage(): Promise<string> {
  const task = 'Seller is asking if you paid or are paying. Tell them you are paying right now / just a moment / hold on. Keep it very short and casual.';
  return generateMessage(task, 40);
}

export async function generateThankYouMessage(): Promise<string> {
  const task = 'You received the coupon. Say thanks briefly. Dont be over the top, just a simple thanks.';
  return generateMessage(task, 30);
}

export async function generateNotAvailableResponse(): Promise<string> {
  const task = 'Seller said coupon is not available or already sold. Acknowledge briefly and politely.';
  return generateMessage(task, 40);
}

export async function generateFollowUpMessage(context: string): Promise<string> {
  const task = `Continue the conversation naturally. Context: ${context}`;
  return generateMessage(task, 60);
}

export async function generateCouponRequestMessage(followUpCount: number): Promise<string> {
  let task = '';
  if (followUpCount === 0) {
    task = 'You just paid for the coupon. Politely ask them to send the coupon image/screenshot now.';
  } else if (followUpCount === 1) {
    task = 'You paid but haven\'t received coupon yet. Gently remind them to send the coupon. Don\'t sound impatient.';
  } else if (followUpCount === 2) {
    task = 'Still waiting for coupon after payment. Ask again politely but show you are waiting.';
  } else {
    task = 'Been waiting for coupon for a while now. Ask again, stay polite but be firm. Mention you already paid.';
  }
  return generateMessage(task, 70);
}

export async function generateWaitPayingMessage(): Promise<string> {
  const task = 'Tell the seller you are about to pay them right now. Keep it brief and natural, like "one sec, paying".';
  return generateMessage(task, 40);
}

export async function generateCancelMessageToSeller(): Promise<string> {
  const task = 'Apologize to the seller because your friend just got you a coupon, so you don\'t need it anymore. Be polite and brief.';
  return generateMessage(task, 70);
}

// Generate message when user decides not to proceed with the deal
export async function generateUserDeclinedMessage(): Promise<string> {
  const task = 'You were about to buy a coupon but just found out your friend already bought one for you. Apologize briefly to the seller. Something like "sorry bro, my friend just told me he got one for me" or "ah sorry, just got a message - friend bought me one already". Keep it casual and apologetic.';
  return generateMessage(task, 60);
}

// Generate friendly response when seller says "hold on", "sending", "wait", etc.
export async function generateWaitingAcknowledgment(): Promise<string> {
  const task = 'Seller said they will send the coupon soon (like "hold on", "sending", "wait"). Acknowledge it in a friendly, patient way. Something like "sure, no rush" or "okay, take your time". Keep it very short and casual.';
  return generateMessage(task, 30);
}

// Generate question when received image is not a coupon
export async function generateWrongImageQuestion(): Promise<string> {
  const task = 'You received an image from the seller but it doesn\'t look like the mess coupon you\'re waiting for. Ask them about it briefly - could be something like "is this the coupon?" or "wrong image?" or just "?" or "bro this doesn\'t look like the coupon". Keep it very short and casual.';
  return generateMessage(task, 25);
}

// Generate response to ask for missing details (like mess name)
export async function generateAskMessName(): Promise<string> {
  const task = 'Ask the seller which mess the coupon is for (there are multiple messes like Himalaya, Cauvery, etc. at IIT Madras). Keep it casual and brief.';
  return generateMessage(task, 40);
}

// Generate a friendly conversational response based on what seller said
export async function generateConversationalResponse(sellerMessage: string, context: string): Promise<string> {
  const task = `Respond naturally to the seller's message. Seller said: "${sellerMessage}". Context: ${context}. Be friendly and conversational, keep it short.`;
  return generateMessage(task, 50);
}

// Generate follow-up when seller suddenly tries to cancel (before payment)
export async function generateSellerCancelFollowUp(sellerMessage: string): Promise<string> {
  const task = `The seller suddenly seems to be backing out or cancelling the deal. They said: "${sellerMessage}". Ask them what happened in a friendly way, try to understand the situation. Maybe something like "oh what happened?" or "everything okay?". Keep it casual and short.`;
  return generateMessage(task, 30);
}

// Generate message to convince seller to continue the deal
export async function generateConvinceSeller(): Promise<string> {
  const task = 'Try to gently convince the seller to continue with the coupon sale. Be understanding but express that you really need it. Something like "come on, I really need it" or "please, already counting on it". Keep it casual and not pushy.';
  return generateMessage(task, 35);
}

// Generate polite refund request (when seller cancels after payment)
export async function generateRefundRequest(amount: number): Promise<string> {
  const task = `The seller is cancelling the deal AFTER you already paid Rs.${amount}. Politely ask them to refund the money. Be understanding but firm. Something like "okay no problem, but please refund the ${amount} I sent" or "that's fine, just send back the money please". Keep it polite but clear.`;
  return generateMessage(task, 50);
}

// Generate message when seller confirms they won't sell after trying to convince
export async function generateAcceptCancellation(paymentMade: boolean): Promise<string> {
  if (paymentMade) {
    const task = 'The seller has decided not to sell even after you paid. Accept it gracefully but remind them about the refund. Something like "alright, just send back the money then" or "okay, waiting for the refund".';
    return generateMessage(task, 40);
  } else {
    const task = 'The seller has decided not to sell. Accept it gracefully. Something like "okay no worries" or "alright, thanks anyway".';
    return generateMessage(task, 25);
  }
}

// Generate follow-up asking about refund status
export async function generateRefundFollowUp(): Promise<string> {
  const task = 'You\'re waiting for the seller to refund your money. Ask them about it politely. Something like "did you send it?" or "refund done?" or "waiting for the refund". Keep it short.';
  return generateMessage(task, 25);
}

// Generate request for refund screenshot
export async function generateAskRefundScreenshot(): Promise<string> {
  const task = 'Seller says they refunded the money. Ask them to send a screenshot of the payment as confirmation. Something like "can you send the screenshot?" or "share the payment screenshot please". Keep it casual and short.';
  return generateMessage(task, 30);
}

// Generate thank you after refund screenshot received
export async function generateRefundThanks(): Promise<string> {
  const task = 'Seller sent the refund payment screenshot. Thank them briefly. Something like "got it, thanks" or "okay thanks". Keep it very short.';
  return generateMessage(task, 20);
}

// Generate conversational response during refund discussion
export async function generateRefundConversation(sellerMessage: string): Promise<string> {
  const task = `You're waiting for the seller to refund Rs.70 after they cancelled the deal. They said: "${sellerMessage}". Respond naturally, stay polite but keep reminding about the refund if needed. Keep it short.`;
  return generateMessage(task, 40);
}

/**
 * Detect which mess name is mentioned in a message
 * Uses fuzzy matching to handle common spelling mistakes
 * Returns the corrected/canonical mess name
 */
export function detectMessNameInMessage(message: string): string | null {
  const result = fuzzyMatchMessName(message);

  if (result.matched && result.correctedName) {
    // Log if a spelling correction was made
    if (result.distance > 0) {
      logger.debug('Mess name auto-corrected', {
        original: result.originalWord,
        corrected: result.correctedName,
        distance: result.distance,
        confidence: Math.round(result.confidence * 100) + '%'
      });
    }
    return result.correctedName;
  }

  return null;
}

/**
 * Detect mess name with full match details (for debugging/logging)
 */
export function detectMessNameWithDetails(message: string): FuzzyMatchResult {
  return fuzzyMatchMessName(message);
}

// Generate message asking which mess the coupon is for
export async function generateAskMessNameMessage(): Promise<string> {
  const task = 'Ask the seller which mess the coupon is for. There are multiple messes at IIT Madras (like Himalaya, Cauvery, SGR, etc.). Keep it casual and brief, something like "which mess is this for?" or "btw which mess?". Keep it short.';
  return generateMessage(task, 30);
}

// Generate polite decline when mess doesn't match preference
export async function generateMessMismatchDecline(preferredMess: string, actualMess: string): Promise<string> {
  const task = `Politely decline the coupon because you specifically need a ${preferredMess} mess coupon, but the seller has ${actualMess}. Apologize briefly. Something like "ah sorry, I was actually looking for ${preferredMess}" or "oh, I need ${preferredMess} specifically, sorry". Keep it polite and short.`;
  return generateMessage(task, 50);
}
