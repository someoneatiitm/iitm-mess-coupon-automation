# IITM Mess Coupon Automation - Development Context

## Project Overview
A WhatsApp automation bot that monitors "Buy & Sell @ IIT Madras" groups for mess coupon sellers, initiates conversations, handles semi-automated UPI payments, and completes purchases.

## Tech Stack
- **Runtime**: Node.js with TypeScript (ESM modules)
- **WhatsApp**: whatsapp-web.js
- **LLM**: Groq API (llama-3.1-8b-instant) - free tier
- **QR Detection**: jimp + jsqr

## Project Structure
```
/Users/chirag/IITM Mess Coupon Automation/
├── src/
│   ├── index.ts                 # Main entry point, bot orchestration
│   ├── whatsapp/
│   │   ├── client.ts            # WhatsApp connection, send messages/media
│   │   ├── groupMonitor.ts      # Monitor groups for sell messages
│   │   └── messageHandler.ts    # Handle DMs, detect user cancellation
│   ├── llm/
│   │   ├── groqClient.ts        # Groq API client with retry
│   │   ├── messageParser.ts     # Detect sell intent, analyze responses, detect cancellation
│   │   └── conversationAI.ts    # Generate human-like messages
│   ├── conversation/
│   │   ├── stateMachine.ts      # Conversation state management
│   │   └── types.ts             # TypeScript types
│   ├── payment/
│   │   └── notifier.ts          # Desktop notifications (with fallback)
│   ├── state/
│   │   ├── dailyTracker.ts      # Track lunch/dinner purchases per day
│   │   └── persistence.ts       # Save/load state to JSON
│   └── utils/
│       ├── qrDetector.ts        # Detect QR codes in images
│       ├── logger.ts            # Winston logger
│       └── config.ts            # Load config.json
├── config/
│   └── config.json              # Groups, phone numbers, settings
├── data/
│   └── state.json               # Persistent state (auto-generated)
├── .env                         # GROQ_API_KEY
└── package.json
```

## Configuration (config/config.json)
```json
{
  "groups": [
    "Buy & Sell @ IIT Madras - 1",
    "Buy & Sell @ IIT Madras - 2",
    ... (up to 10)
  ],
  "testPhoneNumbers": ["9449950934"],
  "myPhoneNumber": "9449959934",
  "maxPrice": 70,
  "messageDelayMs": 2000,
  "notificationSound": true
}
```

## Running the Bot

### Two Modes:
1. **Test Mode** - Only test account, no group scanning:
   ```bash
   npm run test-mode
   ```

2. **Real Mode** - Full operation (groups + test account):
   ```bash
   npm run real-mode
   # or just: npm start
   ```

### Clear state and restart:
```bash
rm -f data/state.json && npm run test-mode
```

## Complete Conversation Flow

### 1. Detection
- Bot monitors configured WhatsApp groups for sell messages
- Uses Groq LLM to detect if someone is SELLING a lunch/dinner coupon
- Checks if we already have that coupon type today
- Test accounts bypass all restrictions

### 2. Initial Contact
- Sends message: "Hey! Saw your msg in {group name} about {lunch/dinner} coupon. Still available?"
- Does NOT mention price upfront
- Human-like, varied responses using LLM with Hindi-English mix

### 3. Negotiation
- Waits for seller response
- Detects UPI ID, phone number, or "same number" responses
- Fixed price: Rs.70 (no negotiation)
- If price > 70, politely declines

### 4. Payment Confirmation Flow (via WhatsApp self-chat)
```
Bot sends payment details to YOUR WhatsApp (self-chat)
    ↓
You reply "Ok" within 2 minutes
    ↓
Bot sends "Ek sec, paying now" to seller
    ↓
You make UPI payment manually
    ↓
You reply "Paid"
    ↓
Bot sends payment confirmation to seller
    ↓
Bot waits for coupon image
```

### 5. If User Declines or Timeout
- If you reply "No" OR don't reply within 2 minutes
- Bot sends to seller: "Sorry bhai, mere friend ne abhi coupon de diya. Thanks anyway!"
- Deal cancelled, bot looks for other sellers

### 6. Coupon Receipt
- Bot waits for seller to send coupon IMAGE (mandatory)
- Follows up every 1 minute if no image (up to 5 times)
- Follow-up messages: "Bhai coupon?", "Coupon bhej do yaar", etc.
- When image received → Thanks seller, forwards image to you with details
- Deal complete!

### 7. User Cancellation Detection
- If you manually message seller with cancellation intent
- Keywords detected: "already got", "found another", "cancel", "nvm", "mil gaya", "kisi aur se"
- Bot marks conversation as failed and moves on

## Key Features

### ONE Seller at a Time
- Only talks to one seller at a time
- Must complete/fail before contacting next seller
- Prevents confusion and multiple payments

### 10-Minute Inactivity Timeout
- Conversations with no activity for 10+ minutes are auto-failed
- Bot moves on to find other sellers
- Test accounts are EXEMPT from this rule

### 2-Minute Confirmation Timeout
- After sending payment request to you, waits 2 minutes for "Ok"
- If no response, sends cancellation to seller and moves on

### Daily Blocking
- If deal fails with a seller, they're blocked for the rest of the day
- Prevents repeated failed attempts
- Test accounts are EXEMPT from this rule

### Lunch Cutoff
- Lunch coupons only available before 2:30 PM
- After that, only dinner coupons are sought

### State Persistence
- All conversations saved to `data/state.json`
- Survives bot restarts
- Resumes incomplete conversations (if within 10 mins)

### Test Account Exemptions
Test phone numbers bypass:
- 10-minute timeout
- Daily blocking rules
- Can test anytime without restrictions

## Conversation States
```
INITIATING_CONTACT → AWAITING_PAYMENT_INFO → PAYMENT_PENDING → AWAITING_COUPON → COMPLETED
                                                     ↓                              ↓
                                              (timeout/decline)                  FAILED
                                                     ↓
                                          Send cancellation to seller
```

## Human-Like Response Generation
Messages are generated with varied styles:
- "casual and chill, like texting a friend"
- "polite but brief, straight to the point"
- "casual with some Hindi words mixed in"
- Mix of Hindi-English: "bhai", "yaar", "theek hai", "ruk"

### Message Examples:
- Initial: "Hey! Saw your msg in Buy & Sell @ IIT Madras - 1 about dinner coupon. Still available?"
- Wait paying: "Ek sec, paying now" / "Haan ruk, payment kar raha"
- Payment done: "Done bhai, 70 bhej diya. Check karo aur coupon share kardo"
- Coupon follow-up: "Bhai coupon?" / "Coupon bhej do yaar"
- Cancellation: "Sorry bhai, mere friend ne abhi coupon de diya. Thanks anyway!"
- Thanks: "Got it, thanks!" / "Mil gaya, thanks yaar"

## Important Implementation Details

### WhatsApp Event Handling
Two events are listened to in `client.ts`:
- `message` - for incoming messages from others
- `message_create` - for messages YOU send (including self-chat confirmations)

This is critical because when you type "Ok" in your self-chat, it's an outgoing message that triggers `message_create`, not `message`.

### Self-Messaging
- WhatsApp Web doesn't easily allow messaging yourself
- Bot uses `sendToSelf()` helper with error fallback to terminal
- User confirmation via WhatsApp chat with self
- `message_create` event captures user's responses in self-chat

### Media Handling
- `sendMediaMessage()` for forwarding coupon images
- QR detection using jimp + jsqr to verify coupon images
- Images converted to base64 for WhatsApp API

### Error Handling
- Desktop notifications wrapped in try-catch (may fail on some systems)
- Terminal output as fallback for all notifications
- Graceful handling of WhatsApp connection issues

## Terminal Commands
When bot is running:
- `ok` / `yes` - Approve payment (also works via WhatsApp self-chat)
- `no` - Decline payment
- `paid` / `done` - Confirm payment made
- `cancel` / `c` - Cancel current action
- `status` / `s` - Show status
- `help` / `h` - Show help
- `quit` / `q` - Save and exit

## Environment Variables (.env)
```
GROQ_API_KEY=your_groq_api_key_here
```

## Dependencies
```json
{
  "whatsapp-web.js": "^1.26.0",  // WhatsApp Web automation
  "groq-sdk": "^0.8.0",          // LLM for message generation
  "jimp": "^1.1.4",              // Image processing
  "jsqr": "^1.4.0",              // QR code detection
  "node-notifier": "^10.0.1",    // Desktop notifications
  "qrcode-terminal": "^0.12.0",  // QR display for login
  "dotenv": "^16.4.5",           // Environment variables
  "tsx": "^4.7.0"                // TypeScript execution
}
```

## NPM Scripts
```json
{
  "start": "tsx src/index.ts",           // Default (real mode)
  "test-mode": "tsx src/index.ts test",  // Test mode only
  "real-mode": "tsx src/index.ts real",  // Real mode explicit
  "build": "tsc",                         // Compile TypeScript
  "dev": "tsx watch src/index.ts"        // Watch mode
}
```

## Last Updated
January 31, 2026

## Session Changes Summary (Jan 31, 2026)

### Core Features Implemented:
1. Two modes: `test-mode` and `real-mode`
2. Test accounts exempt from timeout and blocking rules
3. Initial message doesn't mention price, includes group name
4. User cancellation detection from messages to seller
5. Full WhatsApp self-chat confirmation flow
6. 2-minute timeout for user confirmation
7. Cancellation message sent to seller on timeout/decline
8. 10-minute inactivity timeout (configurable)
9. Coupon image is mandatory - follows up if not received
10. Forwards coupon image to user with full details (date, time, amount, seller)

### Key Bug Fixes:
1. **Self-message detection**: Added `message_create` event listener to capture messages user sends (including "Ok" and "Paid" in self-chat)
2. **WhatsApp self-messaging**: Added fallback to terminal when WhatsApp can't send to self
3. **Desktop notifications**: Wrapped in try-catch to prevent crashes
4. **Conversation timeout**: Changed from 1 hour to 10 minutes based on `updatedAt`

### Flow When User Types "Ok":
1. `message_create` event fires (not `message`)
2. `handleIncomingMessage` detects `fromMe: true`
3. Routes to `handleMyMessage`
4. Detects "ok" text
5. Looks up `pendingConfirmationConvId`
6. Finds conversation in `this.conversations`
7. Sends "paying wait" message to seller via `generateWaitPayingMessage()`
8. Resolves the confirmation promise

### Files Modified This Session:
- `src/index.ts` - Mode selection, message handling, debug logging
- `src/whatsapp/client.ts` - Added `message_create` event listener
- `src/whatsapp/messageHandler.ts` - User cancellation detection
- `src/conversation/stateMachine.ts` - Payment flow, cancellation to seller
- `src/conversation/types.ts` - Added coupon follow-up fields
- `src/llm/conversationAI.ts` - New message generators
- `src/llm/messageParser.ts` - Cancellation detection
- `src/payment/notifier.ts` - Error handling
- `config/config.json` - Phone numbers and groups
- `package.json` - NPM scripts for modes

## Debugging Tips

### If "Ok" message not detected:
1. Check logs for `Incoming message` - shows raw message details
2. Look for `Detected self-message` - confirms routing works
3. Check `pendingConfirmationConvId` is set
4. Verify conversation exists in map

### If bot crashes on startup:
1. Clear state: `rm -f data/state.json`
2. Check `.env` has valid `GROQ_API_KEY`
3. Delete `.wwebjs_auth` folder to re-authenticate WhatsApp

### Common Issues:
- **No response to "Ok"**: Make sure `message_create` event is being listened to
- **Self-messaging fails**: Falls back to terminal output automatically
- **Old conversations resuming**: Clear `data/state.json`
