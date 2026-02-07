-- IITM Mess Coupon Automation Database Schema
-- SQLite database for persistent storage

-- Users table: Account information (phone number hashes for privacy)
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id TEXT UNIQUE NOT NULL,  -- Hashed phone number
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_login_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Daily state table: Daily preferences and purchase status
CREATE TABLE IF NOT EXISTS daily_state (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id TEXT NOT NULL,
  date TEXT NOT NULL,  -- YYYY-MM-DD
  lunch_bought INTEGER NOT NULL DEFAULT 0,
  dinner_bought INTEGER NOT NULL DEFAULT 0,
  lunch_conversation_id TEXT,
  dinner_conversation_id TEXT,
  lunch_mess_preference TEXT,  -- JSON array or null for 'any'
  dinner_mess_preference TEXT,  -- JSON array or null for 'any'
  lunch_preference_asked INTEGER NOT NULL DEFAULT 0,
  dinner_preference_asked INTEGER NOT NULL DEFAULT 0,
  lunch_paused INTEGER NOT NULL DEFAULT 0,
  dinner_paused INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(account_id, date),
  FOREIGN KEY (account_id) REFERENCES users(account_id)
);

-- Conversations table: All conversation data with messages
CREATE TABLE IF NOT EXISTS conversations (
  id TEXT PRIMARY KEY,  -- Conversation ID
  account_id TEXT NOT NULL,
  seller_id TEXT NOT NULL,
  seller_name TEXT NOT NULL,
  coupon_type TEXT NOT NULL,  -- 'lunch' or 'dinner'
  state TEXT NOT NULL,
  price REAL NOT NULL DEFAULT 0,
  upi_id TEXT,
  group_id TEXT NOT NULL,
  group_name TEXT NOT NULL,
  original_message_id TEXT NOT NULL,
  mess_name TEXT,
  failure_reason TEXT,
  coupon_follow_up_count INTEGER DEFAULT 0,
  last_coupon_request_time TEXT,
  refund_requested INTEGER DEFAULT 0,
  refund_received INTEGER DEFAULT 0,
  refund_screenshot_received INTEGER DEFAULT 0,
  messages TEXT,  -- JSON array of ChatMessage objects
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT,
  FOREIGN KEY (account_id) REFERENCES users(account_id)
);

-- Deals table: Permanent purchase history
CREATE TABLE IF NOT EXISTS deals (
  id TEXT PRIMARY KEY,  -- Same as conversation ID
  account_id TEXT NOT NULL,
  date TEXT NOT NULL,  -- YYYY-MM-DD
  timestamp TEXT NOT NULL,  -- ISO string
  coupon_type TEXT NOT NULL,  -- 'lunch' or 'dinner'
  seller_name TEXT NOT NULL,
  seller_id TEXT NOT NULL,
  price REAL NOT NULL,
  mess_name TEXT,
  status TEXT NOT NULL,  -- 'success' or 'failed'
  failure_reason TEXT,
  coupon_image_path TEXT,
  refund_received INTEGER DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (account_id) REFERENCES users(account_id)
);

-- Coupon images table: Image metadata with expiry for auto-cleanup
CREATE TABLE IF NOT EXISTS coupon_images (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id TEXT NOT NULL,
  filename TEXT UNIQUE NOT NULL,
  deal_id TEXT,
  coupon_type TEXT NOT NULL,
  seller_name TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL,  -- For 2-day retention cleanup
  FOREIGN KEY (account_id) REFERENCES users(account_id),
  FOREIGN KEY (deal_id) REFERENCES deals(id)
);

-- Processed messages table: Prevent duplicate message handling
CREATE TABLE IF NOT EXISTS processed_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  processed_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(account_id, message_id),
  FOREIGN KEY (account_id) REFERENCES users(account_id)
);

-- Indexes for performance
CREATE INDEX IF NOT EXISTS idx_daily_state_account_date ON daily_state(account_id, date);
CREATE INDEX IF NOT EXISTS idx_conversations_account ON conversations(account_id);
CREATE INDEX IF NOT EXISTS idx_conversations_state ON conversations(state);
CREATE INDEX IF NOT EXISTS idx_deals_account ON deals(account_id);
CREATE INDEX IF NOT EXISTS idx_deals_date ON deals(date);
CREATE INDEX IF NOT EXISTS idx_deals_timestamp ON deals(timestamp);
CREATE INDEX IF NOT EXISTS idx_coupon_images_expires ON coupon_images(expires_at);
CREATE INDEX IF NOT EXISTS idx_coupon_images_account ON coupon_images(account_id);
CREATE INDEX IF NOT EXISTS idx_processed_messages_account ON processed_messages(account_id);
