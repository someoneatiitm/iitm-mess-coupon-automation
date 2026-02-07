export type CouponType = 'lunch' | 'dinner';

export enum ConversationState {
  IDLE = 'IDLE',
  INITIATING_CONTACT = 'INITIATING_CONTACT',
  AWAITING_MESS_INFO = 'AWAITING_MESS_INFO',
  NEGOTIATING = 'NEGOTIATING',
  AWAITING_PAYMENT_INFO = 'AWAITING_PAYMENT_INFO',
  PAYMENT_PENDING = 'PAYMENT_PENDING',
  AWAITING_COUPON = 'AWAITING_COUPON',
  AWAITING_REFUND = 'AWAITING_REFUND',
  AWAITING_REFUND_SCREENSHOT = 'AWAITING_REFUND_SCREENSHOT',
  COMPLETED = 'COMPLETED',
  FAILED = 'FAILED'
}

export interface ChatMessage {
  id: string;
  sender: 'bot' | 'seller';
  text: string;
  timestamp: Date;
  hasMedia?: boolean;
}

export interface Conversation {
  id: string;
  sellerId: string;
  sellerName: string;
  couponType: CouponType;
  state: ConversationState;
  price: number;
  upiId: string | null;
  groupId: string;
  groupName: string;
  originalMessageId: string;
  createdAt: Date;
  updatedAt: Date;
  failureReason?: string;
  couponFollowUpCount?: number;
  lastCouponRequestTime?: Date;
  // Mess name tracking
  messName?: string; // The mess name (e.g., "Himalaya", "Cauvery")
  // Refund tracking
  refundRequested?: boolean;
  refundReceived?: boolean;
  refundScreenshotReceived?: boolean;
  // Chat messages for this conversation
  messages?: ChatMessage[];
  // Completion tracking (for animation purposes)
  completedAt?: Date;
}

export interface SellMessage {
  messageId: string;
  senderId: string;
  senderName: string;
  groupId: string;
  groupName: string;
  couponType: CouponType;
  rawMessage: string;
  timestamp: Date;
}

export interface DailyState {
  date: string; // YYYY-MM-DD
  lunchBought: boolean;
  dinnerBought: boolean;
  lunchConversationId?: string;
  dinnerConversationId?: string;
  // Mess preferences for the day (array for multiple preferences, null = any)
  lunchMessPreference?: string[] | null;
  dinnerMessPreference?: string[] | null;
  lunchPreferenceAsked?: boolean;
  dinnerPreferenceAsked?: boolean;
  // Session pause state
  lunchPaused?: boolean;  // true = skip lunch for today
  dinnerPaused?: boolean; // true = skip dinner for today
}

// List of messes at IIT Madras
export const IITM_MESSES = [
  'SGR',
  'SRR',
  'Firstman',
  'Prism',
  'Neelkesh',
  'Food Sutra',
  'Vindhya'
] as const;

export type MessName = typeof IITM_MESSES[number] | 'any';

export interface AppState {
  dailyState: DailyState;
  activeConversations: Map<string, Conversation>;
  processedMessageIds: Set<string>;
}
