# IITM Mess Coupon Automation - Architecture & Reference

## Overview
A WhatsApp bot that automates purchasing mess coupons at IIT Madras. It monitors group chats for sellers, initiates conversations, handles negotiations, and manages payments.

---

## Project Structure

```
src/
├── index.ts                 # Main entry point, orchestrates all components
├── conversation/
│   ├── stateMachine.ts      # ConversationManager - handles conversation flow & state transitions
│   └── types.ts             # TypeScript interfaces (Conversation, CouponType, etc.)
├── whatsapp/
│   ├── client.ts            # WhatsApp Web.js client initialization & messaging
│   ├── groupMonitor.ts      # Monitors groups for sell messages
│   └── dmHandler.ts         # Handles direct messages from sellers
├── llm/
│   ├── messageParser.ts     # AI-powered message analysis (seller responses, cancellations)
│   └── conversationAI.ts    # Generates contextual messages for conversations
├── state/
│   ├── persistence.ts       # Per-account state storage (state_{hash}.json)
│   ├── history.ts           # Deal history storage (history_{hash}.json)
│   └── dailyTracker.ts      # Tracks daily lunch/dinner status & preferences
├── web/
│   ├── server.ts            # Express + Socket.IO web server
│   └── public/
│       └── index.html       # Dashboard UI (single-page app)
├── payment/
│   └── notifier.ts          # Payment notifications to self
└── utils/
    ├── logger.ts            # Winston logger
    └── qrDetector.ts        # Detects if image is a coupon QR code
```

---

## Key Components

### 1. Main App (`src/index.ts`)
- `MessCouponBot` class orchestrates everything
- Initializes WhatsApp client, web server, conversation manager
- Handles incoming messages and routes them appropriately
- **Key callbacks passed to ConversationManager:**
  - `onCouponPurchased` - emits `conversationEnd` event with `result: 'success'`
  - `onConversationFailed` - emits `conversationEnd` event with `result: 'failed'`

### 2. Conversation Manager (`src/conversation/stateMachine.ts`)
- Manages conversation state machine
- States: `IDLE` → `INITIATING_CONTACT` → `NEGOTIATING` → `PAYMENT_PENDING` → `AWAITING_COUPON` → `COMPLETED/FAILED`
- **Important methods:**
  - `startConversation()` - initiates contact with seller
  - `handleSellerMessage()` - processes seller responses
  - `getActiveConversations()` - returns conversations for dashboard (includes recently completed for 15s)
  - `completeConversation()` - marks deal as successful, sets `completedAt`
  - `failConversation()` - marks deal as failed, sets `completedAt`

### 3. Web Dashboard (`src/web/server.ts` + `public/index.html`)
- Real-time updates via Socket.IO
- **Socket Events:**
  - `status` - full status update (conversations, pending actions, etc.)
  - `conversationEnd` - triggered when deal completes/fails
  - `auth` - authentication state changes
  - `qr` - QR code for login
  - `notification` - toast notifications

### 4. Per-Account Data Storage
- Phone number is hashed for privacy
- Files: `data/state_{hash}.json`, `data/history_{hash}.json`
- Coupon images: `data/coupons/{hash}_date_type_seller_time.jpg`

---

## Conversation States

```
IDLE
  ↓ (sell message detected)
INITIATING_CONTACT
  ↓ (seller responds)
AWAITING_MESS_INFO (if mess preference set)
  ↓
NEGOTIATING
  ↓ (price agreed)
AWAITING_PAYMENT_INFO
  ↓ (UPI ID received)
PAYMENT_PENDING (user confirmation required)
  ↓ (user confirms payment)
AWAITING_COUPON
  ↓ (coupon image received)
COMPLETED ✓

Any state can → FAILED (timeout, seller cancels, wrong mess, etc.)
```

---

## Dashboard UI Features

### Active Conversations Section
- Shows ongoing deals with expandable chat preview
- Auto-opens chat dropdown for new conversations
- **Animation on completion:**
  - Dropdown closes smoothly
  - Shows checkmark (success) or X (failure) with animation
  - Success includes confetti effect
  - Element fades out after 10 seconds

### Key Frontend Functions (`index.html`)
- `updateConversations(conversations)` - renders conversation list, detects state changes
- `createConversationHTML(c)` - generates HTML for a conversation (different for active vs finished)
- `toggleChat(convId, btn)` - opens/closes chat preview dropdown
- `loadChatMessages(convId)` - fetches and displays chat history

### Animation CSS Classes
- `.chat-result` - container for success/failure animation
- `.chat-result.success` - green glow, confetti
- `.chat-result.failed` - red styling, shake animation
- `.checkmark-circle`, `.checkmark-check` - SVG stroke animations
- `.cross-circle`, `.cross-line` - SVG stroke animations for X
- `.fading-out` - fade animation before element removal

---

## Recent Changes (Feb 2025)

### Per-Account Data Isolation
- Each WhatsApp account has separate state/history files
- Phone number hashed for privacy in filenames
- `loadStateForAccount()` called when client becomes ready

### Animation System for Deal Completion
- **Problem solved:** Conversations were removed from list before animation could play
- **Solution:**
  - Added `completedAt` timestamp to `Conversation` interface
  - `getActiveConversations()` includes conversations for 15 seconds after completion
  - Frontend detects COMPLETED/FAILED state and renders animation directly
  - Toast notifications on state transition

### Logout Flow
- Server no longer shuts down on logout
- `reinitializeClient()` creates new WhatsApp client for fresh QR scan
- Web server stays running throughout

---

## API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/status` | GET | Full status (conversations, pending actions, preferences) |
| `/api/start` | POST | Start looking for coupons |
| `/api/stop` | POST | Stop current session |
| `/api/preference` | POST | Set mess preference `{type, messName}` |
| `/api/confirm` | POST | Confirm purchase |
| `/api/decline` | POST | Decline purchase |
| `/api/paid` | POST | Confirm payment made |
| `/api/toggle/:type` | POST | Toggle lunch/dinner bought status |
| `/api/history` | GET | Get deal history `?days=30` |
| `/api/history/today` | GET | Today's deals |
| `/api/history/stats` | GET | Statistics `?days=30` |
| `/api/conversation/:id/messages` | GET | Chat messages for a conversation |
| `/api/auth/status` | GET | Auth state |
| `/api/auth/qr` | GET | Current QR code |
| `/api/auth/logout` | POST | Logout |

---

## Configuration (`src/config.ts`)

```typescript
{
  mode: 'real' | 'test',
  groups: ['Group Name 1', 'Group Name 2'],  // Groups to monitor
  messageDelayMs: 1500,                       // Delay between messages
  couponWaitTimeoutMs: 5 * 60 * 1000,        // Wait for coupon timeout
  webPort: 3847
}
```

---

## Common Tasks

### Adding a new conversation state
1. Add to `ConversationState` enum in `types.ts`
2. Handle in `handleSellerMessage()` in `stateMachine.ts`
3. Update state badge styling in `index.html` if needed

### Adding a new API endpoint
1. Add route in `setupRoutes()` in `server.ts`
2. Add callback to `WebServerCallbacks` interface if needed
3. Implement callback in `index.ts`

### Modifying dashboard UI
1. Edit `src/web/public/index.html`
2. CSS is in `<style>` tag at top
3. JavaScript is in `<script>` tag at bottom
4. Build copies to `dist/web/public/`

### Testing locally
```bash
npm run build && npm start
# Dashboard at http://localhost:3847
```

---

## Debugging Tips

- Check browser console for `🎬` prefixed logs (animation events)
- Server logs via Winston (check terminal output)
- State files in `data/` directory show persisted state
- Socket.IO events can be monitored in browser Network tab (WS)
