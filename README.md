# IITM Mess Coupon Automation

A WhatsApp automation bot that monitors IIT Madras buy/sell groups for mess coupon listings, automatically negotiates with sellers, and completes purchases - saving you time and ensuring you never miss a deal.

## What It Does

### The Problem

At IIT Madras, students often sell their unused mess coupons in WhatsApp groups like "Buy & Sell @ IIT Madras". If you want to buy a coupon:

- You have to **constantly monitor** these groups (100+ messages/day)
- When someone posts "selling lunch coupon", you have to **reply fast** before others grab it
- You need to **negotiate** - ask which mess, confirm price, get UPI details
- If you're in class or busy, you **miss the deal**

### The Solution

This bot does all of that **automatically**:

```
┌─────────────────────────────────────────────────────────────────┐
│                        BOT WORKFLOW                              │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  1. DETECT     📱 Monitor WhatsApp groups for "selling lunch"   │
│                   messages using AI-powered parsing              │
│                                                                  │
│  2. CONTACT    💬 Auto-DM seller: "Hi, is it available?"        │
│                                                                  │
│  3. NEGOTIATE  🤝 Ask about mess type, confirm price ≤ ₹70      │
│                                                                  │
│  4. CONFIRM    ✅ Notify you via WhatsApp & dashboard           │
│                   → You confirm with "ok"                        │
│                                                                  │
│  5. PAY        💰 You make UPI payment manually                 │
│                   → Reply "paid" when done                       │
│                                                                  │
│  6. RECEIVE    📷 Bot waits for coupon QR code image            │
│                   → Validates QR code automatically              │
│                                                                  │
│  7. DONE       🎉 Coupon saved, deal recorded in history        │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

### Step-by-Step Example

**Morning Setup:**
```
Bot: 🍽️ LUNCH MESS PREFERENCE
     Which mess do you prefer for lunch today?
     0. Any (no preference)
     1. SGR
     2. SRR
     3. Firstman
     ...

You: 3

Bot: ✅ Preferences saved! Lunch: Firstman
     Now looking for matching coupons...
```

**When Someone Posts in the Group:**
```
Group Message: "selling lunch firstman 70"
                         ↓
        Bot detects: lunch coupon, Firstman mess, ₹70
                         ↓
        Bot auto-DMs seller: "saw your message about Firstman
                              lunch coupon, still available?"
                         ↓
        Seller replies: "yes"
                         ↓
        Bot asks: "UPI ID?"
                         ↓
        Seller: "9876543210@paytm"
                         ↓
        Bot notifies YOU via WhatsApp + Web Dashboard
```

**You Get Notified:**
```
Bot: 🎫 DEAL READY!

     Seller: Rahul
     Type: Lunch
     Mess: Firstman ✓ (matches your preference)
     Price: ₹70
     UPI: 9876543210@paytm

     Reply "ok" to confirm or "no" to decline
```

**You Confirm & Pay:**
```
You: ok

Bot → Seller: "hold on, paying"

[You open GPay/PhonePe, send ₹70 to the UPI ID]

You: paid

Bot → Seller: "done, sent ₹70"

Seller: [sends coupon QR code image]

Bot: [validates QR code, saves image]
     ✅ Coupon received and verified!

     Saved to: data/coupons/2024-02-07_lunch_Rahul.jpg
```

### What Makes It Smart

| Feature | How It Works |
|---------|--------------|
| **AI Message Parsing** | Uses Groq LLM to understand natural language like "selling lunch tmrw firstman mess 70rs" |
| **Fuzzy Matching** | Handles typos like "neelksh" → "Neelkesh", "fristman" → "Firstman" |
| **Mess Preferences** | Only responds to sellers with your preferred mess (SGR, SRR, Firstman, etc.) |
| **Price Filtering** | Ignores overpriced coupons (configurable max price) |
| **Time Awareness** | Stops looking for lunch after 2:10 PM, dinner after 9:10 PM |
| **QR Validation** | Verifies the received image is actually a valid QR code |
| **Conversation Memory** | Handles multi-message conversations naturally |

### What You Still Do Manually

The bot handles negotiation, but **you stay in control** for:

1. **Confirming the deal** - Bot asks before committing
2. **Making payment** - You send money via UPI (bot never touches money)
3. **Final decision** - You can decline any deal with "no"

This keeps you safe while saving hours of group monitoring.

## Features

- **AI-Powered Message Parsing** - Uses Groq LLM to intelligently detect and parse coupon sell messages
- **Automated Negotiation** - Initiates contact and handles conversation flow with sellers
- **Real-Time Dashboard** - Web interface to monitor conversations, confirm payments, and track history
- **QR Code Validation** - Validates received coupon images using computer vision
- **Mess Preference System** - Set daily preferences for specific messes (SGR, SRR, Himalaya, etc.)
- **SQLite Database** - Reliable persistent storage with automatic migration from JSON
- **Auto Image Cleanup** - Coupon images automatically deleted after 2 days to save storage
- **Multi-Account Support** - Each WhatsApp account has separate state and history
- **Session Control** - Pause/resume buying, mark coupons as bought, reset sessions

## Quick Start with Docker

### Prerequisites

- [Docker](https://docs.docker.com/get-docker/) installed on your system
- [Docker Compose](https://docs.docker.com/compose/install/) (usually included with Docker Desktop)
- A [Groq API key](https://console.groq.com/keys) (free tier available)

### Setup

1. **Clone the repository**
   ```bash
   git clone https://github.com/YOUR_USERNAME/iitm-mess-coupon-automation.git
   cd iitm-mess-coupon-automation
   ```

2. **Create environment file**
   ```bash
   cp .env.example .env
   ```
   Edit `.env` and add your Groq API key:
   ```
   GROQ_API_KEY=your_actual_groq_api_key_here
   ```

3. **Create configuration file**
   ```bash
   cp config/config.example.json config/config.json
   ```
   Edit `config/config.json`:
   ```json
   {
     "groups": ["Buy & Sell @ IIT Madras - 1"],
     "testPhoneNumbers": [],
     "myPhoneNumber": "919876543210",
     "maxPrice": 70,
     "messageDelayMs": 2000,
     "notificationSound": true
   }
   ```

4. **Start the bot**
   ```bash
   docker compose up -d --build
   ```

5. **Scan QR code**
   - Open the dashboard at `http://localhost:3000`
   - Scan the QR code with your WhatsApp app to authenticate

### Docker Commands

```bash
# Start the bot
docker compose up -d --build

# View logs
docker compose logs -f

# Stop the bot
docker compose down

# Restart the bot
docker compose restart

# View database stats
docker compose exec bot sqlite3 /app/data/mess_coupon.db ".tables"
```

## Local Development

### Prerequisites

- Node.js 20+
- npm

### Setup

1. **Install dependencies**
   ```bash
   npm install
   ```

2. **Create environment and config files** (same as Docker setup steps 2-3)

3. **Run in development mode**
   ```bash
   npm run dev
   ```

### Available Scripts

| Script | Description |
|--------|-------------|
| `npm run dev` | Development mode with hot reload |
| `npm run test-mode` | Test mode (only test accounts, no group scanning) |
| `npm run real-mode` | Full operation mode |
| `npm start` | Same as real-mode |
| `npm run build` | Build TypeScript for production |
| `npm run prod` | Build and run production version |

## Configuration

### Environment Variables (`.env`)

| Variable | Required | Description |
|----------|----------|-------------|
| `GROQ_API_KEY` | Yes | API key from [Groq Console](https://console.groq.com/keys) |
| `WEB_PORT` | No | Dashboard port (default: 3000) |

### Config File (`config/config.json`)

| Field | Type | Description |
|-------|------|-------------|
| `groups` | string[] | WhatsApp group names to monitor |
| `testPhoneNumbers` | string[] | Phone numbers for testing (bypasses time restrictions) |
| `myPhoneNumber` | string | Your WhatsApp phone number (with country code, no +) |
| `maxPrice` | number | Maximum price willing to pay per coupon (in Rs) |
| `messageDelayMs` | number | Delay between bot messages (ms) - prevents rate limiting |
| `notificationSound` | boolean | Enable desktop notification sounds |

## Web Dashboard

Access the dashboard at `http://localhost:3000` to:

- **QR Code** - Scan to authenticate WhatsApp
- **Status** - View current lunch/dinner status and preferences
- **Conversations** - See active negotiations in real-time
- **Confirmations** - Approve purchases and mark payments
- **History** - View past deals and statistics
- **Controls** - Start/stop sessions, set preferences, logout

### Dashboard Controls

| Action | Description |
|--------|-------------|
| Start/Stop Session | Pause or resume coupon searching |
| Set Preference | Choose specific mess (SGR, SRR, etc.) or "Any" |
| Confirm Purchase | Approve a deal (sends "wait, paying" to seller) |
| Mark Paid | Confirm payment was made |
| Toggle Status | Mark lunch/dinner as bought or reset to needed |

## WhatsApp Commands

Reply to your own chat (Saved Messages) to control the bot:

| Command | Description |
|---------|-------------|
| `status` | Show current status |
| `hi` | Update mess preference for current session |
| `stop` | Stop current session (lunch/dinner) |
| `start` | Resume paused session |
| `reset` | Reset both sessions to "needed" |
| `ok` / `yes` | Confirm a pending purchase |
| `no` / `cancel` | Decline a pending purchase |
| `paid` | Confirm payment was made |

## How It Works

### State Machine

Each conversation goes through these states:

```
INITIATING_CONTACT → AWAITING_MESS_INFO → NEGOTIATING
                                              ↓
              COMPLETED ← AWAITING_COUPON ← PAYMENT_PENDING
                  ↑                              ↓
               FAILED ←──────────────────────────┘
```

### Daily Schedule

- **Lunch cutoff**: 2:10 PM - Stop searching for lunch coupons
- **Dinner cutoff**: 9:10 PM - Stop searching for dinner coupons
- **Midnight reset**: Daily state resets automatically

### Data Storage

The bot uses SQLite for persistent storage:

| Table | Purpose |
|-------|---------|
| `users` | Account information (hashed phone numbers) |
| `daily_state` | Daily preferences and purchase status |
| `conversations` | Active and historical conversation data |
| `deals` | Permanent purchase history |
| `coupon_images` | Image metadata with auto-expiry |
| `processed_messages` | Prevents duplicate message handling |

### Image Cleanup

Coupon images are automatically deleted after 2 days to save storage. The cleanup job runs hourly.

## Project Structure

```
├── src/
│   ├── index.ts              # Main bot orchestration
│   ├── database/             # SQLite storage layer
│   │   ├── connection.ts     # Database connection
│   │   ├── schema.sql        # Database schema
│   │   ├── migrate.ts        # JSON → SQLite migration
│   │   └── repositories/     # Data access layer
│   ├── jobs/
│   │   └── imageCleanup.ts   # Automatic image cleanup
│   ├── conversation/         # Conversation state machine
│   ├── whatsapp/             # WhatsApp client & message handling
│   ├── llm/                  # Groq AI integration
│   ├── state/                # State management
│   ├── payment/              # Payment notifications
│   ├── web/                  # Express dashboard & Socket.IO
│   └── utils/                # Logging, config, QR detection
├── config/                   # Configuration files
├── data/                     # Runtime data (gitignored)
│   ├── mess_coupon.db        # SQLite database
│   └── coupons/              # Coupon images
├── Dockerfile
├── docker-compose.yml
└── package.json
```

## Troubleshooting

### QR Code not appearing
- Check if the container is running: `docker compose ps`
- View logs: `docker compose logs -f`
- Ensure port 3000 is not in use

### WhatsApp disconnected
- Re-scan the QR code from the dashboard
- Session data is persisted in `.wwebjs_auth/` volume
- Try: `docker compose restart`

### Bot not detecting messages
- Ensure you're a member of the configured groups
- Check group names match exactly in `config/config.json`
- Verify `maxPrice` is set correctly

### Database issues
```bash
# Check database tables
docker compose exec bot sqlite3 /app/data/mess_coupon.db ".tables"

# View recent deals
docker compose exec bot sqlite3 /app/data/mess_coupon.db "SELECT * FROM deals ORDER BY timestamp DESC LIMIT 5;"
```

### Migration from JSON
If you have existing JSON files (`state_*.json`, `history_*.json`), they will be automatically migrated to SQLite on first startup. The original files are renamed to `.json.migrated`.

## Security Notes

- Phone numbers are stored as hashes, not plain text
- WhatsApp session tokens are stored locally (`.wwebjs_auth/`)
- No data is sent to external servers except Groq API for message parsing
- UPI payments are made manually - bot never handles money directly

## Contributing

1. Fork the repository
2. Create a feature branch: `git checkout -b feature/amazing-feature`
3. Commit your changes: `git commit -m 'Add amazing feature'`
4. Push to the branch: `git push origin feature/amazing-feature`
5. Open a Pull Request

## License

ISC

## Acknowledgments

- [whatsapp-web.js](https://github.com/pedroslopez/whatsapp-web.js) - WhatsApp Web API
- [Groq](https://groq.com) - Fast LLM inference
- [better-sqlite3](https://github.com/WiseLibs/better-sqlite3) - SQLite bindings for Node.js
