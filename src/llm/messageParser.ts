import { chatWithRetry } from './groqClient.js';
import { CouponType } from '../conversation/types.js';
import { logger } from '../utils/logger.js';

const SELL_DETECTION_PROMPT = `You are a message classifier for a mess coupon exchange system.
Analyze the WhatsApp message and determine if the SENDER THEMSELVES is OFFERING TO SELL a mess coupon (lunch or dinner).

CRITICAL DISTINCTION - READ CAREFULLY:
- "selling lunch coupon" / "I have a coupon for sale" / "extra coupon available" = SELLING (isSelling: true)
- "is anyone selling?" / "anyone selling coupon?" / "who's selling?" / "koi bech raha hai?" = NOT SELLING (isSelling: false) - this person WANTS TO BUY
- "need a coupon" / "looking for coupon" / "want to buy" = NOT SELLING (isSelling: false)

The message is ONLY considered "selling" if the sender is OFFERING their own coupon for sale.
If the sender is ASKING whether others are selling, they are a BUYER, not a seller.

EXAMPLES:
- "lunch coupon selling 50rs" → isSelling: true (offering to sell)
- "anyone selling dinner coupon?" → isSelling: false (asking to buy)
- "is someone selling lunch?" → isSelling: false (asking to buy)
- "extra dinner coupon available" → isSelling: true (offering to sell)
- "koi lunch coupon bech raha?" → isSelling: false (asking if anyone is selling = wants to buy)
- "selling dinner coupon dm" → isSelling: true (offering to sell)
- "need lunch coupon" → isSelling: false (wants to buy)

Determine if it's for lunch or dinner based on context.

Respond ONLY with a JSON object in this exact format:
{"isSelling": true/false, "couponType": "lunch"/"dinner"/null, "confidence": 0.0-1.0}

If the person is asking if others are selling (buyer), or unclear, respond: {"isSelling": false, "couponType": null, "confidence": 0.0}`;

const CANCELLATION_DETECTION_PROMPT = `You are detecting if a buyer is cancelling a coupon deal.
Analyze the message and determine if they are saying they no longer want to buy.

Examples of cancellation:
- "sorry I already got one from my friend"
- "nvm, got it from someone else"
- "cancel, dont need anymore"
- "sorry bro, already arranged"
- "thanks but I found another seller"

Respond ONLY with a JSON object:
{"isCancelling": true/false, "confidence": 0.0-1.0}`;

const RESPONSE_ANALYSIS_PROMPT = `You are analyzing a seller's response in a WhatsApp conversation about buying a mess coupon at IIT Madras.

CONTEXT: A buyer has contacted a seller about buying a mess coupon. The seller is now responding.

CRITICAL RULES:
1. "same no", "same number", "this number", "my number" = seller is providing their phone number for UPI payment. This means coupon IS available.
2. Simple "yes", "ok", "haan", "ha" = seller is agreeing, coupon IS available
3. "no" by itself could mean different things - check context. If discussing payment method, "no" might just mean "use this number instead"
4. Only mark available=false if seller EXPLICITLY says coupon is sold/not available/already gone
5. When in doubt, set needsClarification=true instead of assuming unavailable

Analyze for:
1. Is the coupon still available? (Only false if EXPLICITLY unavailable)
2. Price (ONLY if explicitly mentioned with a number)
3. UPI ID or phone number for payment
4. Is seller agreeing to the sale?

Respond ONLY with JSON:
{
  "available": true/false/null,
  "price": number/null,
  "upiId": "string"/null,
  "phoneNumber": "string"/null,
  "agreesToSale": true/false/null,
  "hasCoupon": true/false,
  "needsClarification": true/false,
  "clarificationQuestion": "string"/null
}`;

const CLARIFICATION_PROMPT = `You are a college student at IIT Madras trying to buy a mess coupon via WhatsApp.
The seller's message was unclear and you need to ask a clarifying question.

RULES:
- Keep it SHORT (under 15 words)
- Use casual English (no Hindi)
- Be polite but direct
- Ask ONE specific question to clarify

Seller's unclear message: "{message}"
Context: {context}

Write ONLY the clarifying question, nothing else:`;

export interface SellDetectionResult {
  isSelling: boolean;
  couponType: CouponType | null;
  confidence: number;
}

export interface ResponseAnalysis {
  available: boolean | null;
  price: number | null;
  upiId: string | null;
  phoneNumber: string | null;
  agreesToSale: boolean | null;
  hasCoupon: boolean;
  needsMoreInfo: boolean;
  suggestedResponse: string;
  useSameNumber: boolean;
  needsClarification: boolean;
  clarificationQuestion: string | null;
}

// Patterns that indicate seller is providing payment info (coupon IS available)
const SAME_NUMBER_PATTERNS = [
  'same number', 'same no', 'same num', 'same nmbr', 'same nmber',
  'this number', 'this no', 'my number', 'my no',
  'isi number', 'is number', 'issi number', 'yahi number',
  'gpay same', 'phonepe same', 'paytm same', 'upi same',
  'whatsapp number', 'whatsapp no', 'wp number', 'wp no'
];

// Patterns that indicate coupon is NOT available
const NOT_AVAILABLE_PATTERNS = [
  'sold', 'not available', 'already sold', 'nahi hai', 'nhi hai',
  'khatam', 'finished', 'gone', 'someone else took', 'already gone',
  'sold out', 'no more', 'dont have', "don't have", 'out of stock'
];

// Patterns that indicate seller is trying to cancel the deal
const SELLER_CANCEL_PATTERNS = [
  'sorry', 'cant sell', "can't sell", 'cannot sell', 'wont be able',
  "won't be able", 'not selling', 'changed my mind', 'cancel',
  'need it myself', 'keeping it', 'decided to keep', 'using it myself',
  'friend wants', 'someone else', 'gave it to', 'already gave',
  'nahi dunga', 'nahi de sakta', 'nahi dena', 'mat lo', 'rehne do',
  'dont want to sell', "don't want to sell", 'backing out'
];

// Patterns that indicate seller has refunded
const REFUND_CONFIRMATION_PATTERNS = [
  'paid back', 'refunded', 'sent back', 'returned', 'refund done',
  'money sent', 'payment sent', 'sent the money', 'transferred back',
  'bhej diya', 'wapas bhej diya', 'refund kar diya', 'paisa bhej diya',
  'done refund', 'refund ho gaya', 'sent it back', 'returned the money'
];

// Patterns that indicate agreement/availability
const AGREEMENT_PATTERNS = [
  'yes', 'yeah', 'yep', 'yup', 'ok', 'okay', 'sure', 'done',
  'haan', 'ha', 'theek', 'thik', 'available', 'hai', 'yes available'
];

export async function detectSellMessage(message: string): Promise<SellDetectionResult> {
  try {
    const response = await chatWithRetry(SELL_DETECTION_PROMPT, message);

    const jsonMatch = response.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      logger.warn('Could not parse sell detection response', { response });
      return { isSelling: false, couponType: null, confidence: 0 };
    }

    const result = JSON.parse(jsonMatch[0]) as SellDetectionResult;
    logger.debug('Sell detection result', { message: message.substring(0, 50), result });
    return result;
  } catch (error) {
    logger.error('Failed to detect sell message', error);
    return { isSelling: false, couponType: null, confidence: 0 };
  }
}

export async function detectUserCancellation(message: string): Promise<boolean> {
  const lowerMessage = message.toLowerCase();
  const cancellationKeywords = [
    'already got', 'got it from', 'found another', 'someone else',
    'cancel', 'nvm', 'nevermind', 'never mind', 'dont need', "don't need",
    'no need', 'already arranged', 'already have', 'got one',
    'mil gaya', 'ho gaya', 'kisi aur se', 'friend se', 'dost se'
  ];

  if (cancellationKeywords.some(keyword => lowerMessage.includes(keyword))) {
    logger.info('User cancellation detected via keywords', { message: message.substring(0, 50) });
    return true;
  }

  try {
    const response = await chatWithRetry(CANCELLATION_DETECTION_PROMPT, message);
    const jsonMatch = response.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const result = JSON.parse(jsonMatch[0]);
      if (result.isCancelling && result.confidence > 0.6) {
        logger.info('User cancellation detected via LLM', { message: message.substring(0, 50) });
        return true;
      }
    }
  } catch (error) {
    logger.error('Failed to detect cancellation', error);
  }

  return false;
}

export async function analyzeSellerResponse(message: string): Promise<ResponseAnalysis> {
  const lowerMessage = message.toLowerCase().trim();

  // Pre-analysis: Check for clear patterns before LLM
  const useSameNumber = SAME_NUMBER_PATTERNS.some(p => lowerMessage.includes(p));
  const isNotAvailable = NOT_AVAILABLE_PATTERNS.some(p => lowerMessage.includes(p));
  const isAgreement = AGREEMENT_PATTERNS.some(p => lowerMessage === p || lowerMessage.startsWith(p + ' ') || lowerMessage.endsWith(' ' + p));

  // If seller says "same number" variants, coupon is available and they're providing payment info
  if (useSameNumber) {
    logger.info('Detected "same number" pattern - coupon is available, using seller number for payment');
    return {
      available: true,
      price: null,
      upiId: null,
      phoneNumber: null,
      agreesToSale: true,
      hasCoupon: false,
      needsMoreInfo: false,
      suggestedResponse: '',
      useSameNumber: true,
      needsClarification: false,
      clarificationQuestion: null
    };
  }

  // If clearly not available
  if (isNotAvailable) {
    logger.info('Detected coupon not available pattern');
    return {
      available: false,
      price: null,
      upiId: null,
      phoneNumber: null,
      agreesToSale: false,
      hasCoupon: false,
      needsMoreInfo: false,
      suggestedResponse: '',
      useSameNumber: false,
      needsClarification: false,
      clarificationQuestion: null
    };
  }

  // If simple agreement without other info, coupon is available
  if (isAgreement && lowerMessage.length < 20) {
    logger.info('Detected simple agreement - coupon is available');
    return {
      available: true,
      price: null,
      upiId: null,
      phoneNumber: null,
      agreesToSale: true,
      hasCoupon: false,
      needsMoreInfo: true, // Need UPI info
      suggestedResponse: '',
      useSameNumber: false,
      needsClarification: false,
      clarificationQuestion: null
    };
  }

  // Try to extract UPI ID directly
  const upiMatch = message.match(/[a-zA-Z0-9._-]+@[a-zA-Z]+/);
  const upiId = upiMatch ? upiMatch[0] : null;

  // Try to extract phone number directly
  const phoneMatch = message.match(/\b[6-9]\d{9}\b/);
  const phoneNumber = phoneMatch ? phoneMatch[0] : null;

  // If we found payment info, coupon is available
  if (upiId || phoneNumber) {
    logger.info('Detected payment info - coupon is available', { upiId, phoneNumber });
    return {
      available: true,
      price: null,
      upiId,
      phoneNumber,
      agreesToSale: true,
      hasCoupon: false,
      needsMoreInfo: false,
      suggestedResponse: '',
      useSameNumber: false,
      needsClarification: false,
      clarificationQuestion: null
    };
  }

  // For complex messages, use LLM
  try {
    const response = await chatWithRetry(RESPONSE_ANALYSIS_PROMPT, message);

    const jsonMatch = response.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      logger.warn('Could not parse response analysis', { response });
      return createClarificationResponse(message, 'Could not understand');
    }

    const result = JSON.parse(jsonMatch[0]);

    // Validate price
    if (result.price !== null && (result.price < 20 || result.price > 150)) {
      logger.warn('Ignoring unreasonable price from LLM', { extractedPrice: result.price });
      result.price = null;
    }

    // If LLM says needsClarification, generate a clarifying question
    if (result.needsClarification) {
      const clarificationQ = await generateClarificationQuestion(message, 'buyer asked about coupon, seller response unclear');
      return {
        available: null,
        price: result.price || null,
        upiId: result.upiId || null,
        phoneNumber: result.phoneNumber || null,
        agreesToSale: null,
        hasCoupon: result.hasCoupon || false,
        needsMoreInfo: true,
        suggestedResponse: clarificationQ,
        useSameNumber: false,
        needsClarification: true,
        clarificationQuestion: clarificationQ
      };
    }

    // If LLM returns available=false but message is short/ambiguous, ask for clarification instead
    if (result.available === false && lowerMessage.length < 30 && !isNotAvailable) {
      logger.info('LLM said unavailable but message is short/ambiguous - asking for clarification');
      const clarificationQ = await generateClarificationQuestion(message, 'checking if coupon is available');
      return {
        available: null,
        price: null,
        upiId: null,
        phoneNumber: null,
        agreesToSale: null,
        hasCoupon: false,
        needsMoreInfo: true,
        suggestedResponse: clarificationQ,
        useSameNumber: false,
        needsClarification: true,
        clarificationQuestion: clarificationQ
      };
    }

    logger.debug('Response analysis result', { message: message.substring(0, 50), result });

    return {
      available: result.available ?? null,
      price: result.price ?? null,
      upiId: result.upiId ?? null,
      phoneNumber: result.phoneNumber ?? null,
      agreesToSale: result.agreesToSale ?? null,
      hasCoupon: result.hasCoupon ?? false,
      needsMoreInfo: !result.upiId && !result.phoneNumber,
      suggestedResponse: '',
      useSameNumber: false,
      needsClarification: false,
      clarificationQuestion: null
    };
  } catch (error) {
    logger.error('Failed to analyze seller response', error);
    return createClarificationResponse(message, 'error analyzing');
  }
}

async function generateClarificationQuestion(sellerMessage: string, context: string): Promise<string> {
  try {
    const prompt = CLARIFICATION_PROMPT
      .replace('{message}', sellerMessage)
      .replace('{context}', context);

    const response = await chatWithRetry(prompt, 'Generate clarification question', 2);
    const cleaned = response.replace(/^["']|["']$/g, '').trim();

    if (cleaned.length > 5 && cleaned.length < 100) {
      return cleaned;
    }
  } catch (error) {
    logger.error('Failed to generate clarification question', error);
  }

  // Fallback clarification
  return "Sorry, didn't get that. Is the coupon still available?";
}

function createClarificationResponse(message: string, reason: string): ResponseAnalysis {
  logger.info('Creating clarification response', { message: message.substring(0, 30), reason });
  return {
    available: null,
    price: null,
    upiId: null,
    phoneNumber: null,
    agreesToSale: null,
    hasCoupon: false,
    needsMoreInfo: true,
    suggestedResponse: "Sorry, didn't get that. Is the coupon still available?",
    useSameNumber: false,
    needsClarification: true,
    clarificationQuestion: "Sorry, didn't get that. Is the coupon still available?"
  };
}

// Detect if seller is trying to cancel the deal
export function detectSellerCancellation(message: string): { isCancelling: boolean; confidence: number } {
  const lowerMessage = message.toLowerCase().trim();

  // Check for cancel patterns
  const matchedPatterns = SELLER_CANCEL_PATTERNS.filter(p => lowerMessage.includes(p));

  if (matchedPatterns.length > 0) {
    // Higher confidence if multiple patterns match or message is longer with context
    const confidence = Math.min(0.5 + (matchedPatterns.length * 0.2), 1.0);
    logger.info('Detected potential seller cancellation', { message: lowerMessage.substring(0, 50), matchedPatterns, confidence });
    return { isCancelling: true, confidence };
  }

  return { isCancelling: false, confidence: 0 };
}

// Detect if seller confirms refund
export function detectRefundConfirmation(message: string): { isRefundConfirmed: boolean; confidence: number } {
  const lowerMessage = message.toLowerCase().trim();

  // Check for refund confirmation patterns
  const matchedPatterns = REFUND_CONFIRMATION_PATTERNS.filter(p => lowerMessage.includes(p));

  // Also check for simple confirmations like "sent", "done", "yes" in context of refund
  const simpleConfirmations = ['sent', 'done', 'yes', 'haan', 'ha', 'ok'];
  const isSimpleConfirm = simpleConfirmations.some(p => lowerMessage === p || lowerMessage === p + ' ');

  if (matchedPatterns.length > 0) {
    const confidence = Math.min(0.6 + (matchedPatterns.length * 0.2), 1.0);
    logger.info('Detected refund confirmation', { message: lowerMessage.substring(0, 50), matchedPatterns, confidence });
    return { isRefundConfirmed: true, confidence };
  }

  if (isSimpleConfirm) {
    logger.info('Detected simple refund confirmation', { message: lowerMessage });
    return { isRefundConfirmed: true, confidence: 0.6 };
  }

  return { isRefundConfirmed: false, confidence: 0 };
}
