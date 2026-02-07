# IITM Mess Coupon Bot - User Guide

A comprehensive guide to using the IITM Mess Coupon Automation bot.

## Table of Contents

1. [Getting Started](#getting-started)
2. [First-Time Setup](#first-time-setup)
3. [Daily Usage](#daily-usage)
4. [Web Dashboard](#web-dashboard)
5. [WhatsApp Controls](#whatsapp-controls)
6. [Understanding the Bot](#understanding-the-bot)
7. [Advanced Features](#advanced-features)
8. [Troubleshooting](#troubleshooting)

---

## Getting Started

### What You Need

1. **Docker** - To run the bot in a container
2. **Groq API Key** - Free from [console.groq.com](https://console.groq.com/keys)
3. **WhatsApp Account** - Must be a member of the IIT Madras buy/sell group(s)

### Quick Installation

```bash
# 1. Clone the repository
git clone https://github.com/YOUR_USERNAME/iitm-mess-coupon-automation.git
cd iitm-mess-coupon-automation

# 2. Create configuration files
cp .env.example .env
cp config/config.example.json config/config.json

# 3. Edit .env with your Groq API key
# Edit config/config.json with your phone number

# 4. Start the bot
docker compose up -d --build

# 5. Open http://localhost:3000 and scan QR code
```

---

## First-Time Setup

### Step 1: Get a Groq API Key

1. Go to [console.groq.com](https://console.groq.com)
2. Sign up or log in
3. Navigate to "API Keys"
4. Create a new key
5. Copy the key (starts with `gsk_...`)

### Step 2: Configure the Environment

Edit `.env`:
```
GROQ_API_KEY=gsk_your_actual_key_here
WEB_PORT=3000
```

### Step 3: Configure the Bot

Edit `config/config.json`:

```json
{
  "groups": [
    "Buy & Sell @ IIT Madras - 1"
  ],
  "testPhoneNumbers": [],
  "myPhoneNumber": "919876543210",
  "maxPrice": 70,
  "messageDelayMs": 2000,
  "notificationSound": true
}
```

**Important fields:**

| Field | Description | Example |
|-------|-------------|---------|
| `groups` | Exact WhatsApp group names to monitor | `["Buy & Sell @ IIT Madras - 1"]` |
| `myPhoneNumber` | Your phone with country code (no +) | `919876543210` |
| `maxPrice` | Max price you're willing to pay | `70` |

### Step 4: Start and Authenticate

```bash
# Start the bot
docker compose up -d --build

# View startup logs
docker compose logs -f
```

Open `http://localhost:3000` in your browser. You'll see a QR code - scan it with WhatsApp to authenticate.

---

## Daily Usage

### Morning Routine

1. **Bot asks for preferences** - Around 12:00 AM to 12:00 PM, the bot will ask:
   ```
   🍽️ LUNCH PREFERENCE

   Select your mess preference for today:
   0. Any (no preference)
   1. SGR
   2. SRR
   3. Firstman
   ...

   Reply with the number.
   ```

2. **Set your preference** - Reply with the number (e.g., `3` for Firstman, `0` for any)

3. **Bot starts searching** - Once preferences are set, the bot monitors groups for matching sell messages

### When a Deal is Found

1. **Bot contacts seller** - Sends a DM asking if coupon is available

2. **You get notified** - Via WhatsApp and dashboard:
   ```
   🎫 DEAL FOUND!

   Seller: Rahul
   Type: Lunch
   Price: ₹70
   Mess: Himalaya

   Reply "ok" to confirm or "no" to decline
   ```

3. **Confirm the purchase** - Reply `ok` or click confirm in dashboard

4. **Make payment** - Bot shows UPI details, you pay manually

5. **Confirm payment** - Reply `paid` after sending money

6. **Receive coupon** - Seller sends QR code image, bot validates and saves it

### Checking Status

**Via WhatsApp:**
```
You: status

Bot: 📊 TODAY'S STATUS (2024-02-07)

     🍽️ Lunch: NEEDED
        Preference: Himalaya

     🌙 Dinner: BOUGHT
        Preference: Any

     Currently looking for: LUNCH
```

**Via Dashboard:**
- Open `http://localhost:3000`
- Status shows at top of page

---

## Web Dashboard

### Main Interface

The dashboard at `http://localhost:3000` provides:

#### Status Panel
- Current lunch/dinner status (Needed/Bought/Paused)
- Active preferences
- Time until cutoff

#### Control Buttons

| Button | Function |
|--------|----------|
| ▶️ Start | Resume searching for coupons |
| ⏹️ Stop | Pause searching |
| 🔄 Reset | Reset both sessions to "needed" |
| 🚪 Logout | Sign out of WhatsApp |

#### Preference Selector

Click to change mess preference:
- Any (accept any mess)
- SGR
- SRR
- Firstman
- Prism
- Neelkesh
- Food Sutra
- Vindhya

#### Active Conversations

Shows real-time conversation progress:
```
┌────────────────────────────────────────┐
│ 💬 Rahul - Lunch - ₹70                 │
│ State: AWAITING_COUPON                 │
│ Started: 2 minutes ago                 │
└────────────────────────────────────────┘
```

#### Pending Actions

When confirmation is needed:
```
┌────────────────────────────────────────┐
│ ⏳ Confirm Purchase?                    │
│                                        │
│ Seller: Rahul                          │
│ Type: Lunch                            │
│ Price: ₹70                             │
│ Mess: Himalaya                         │
│                                        │
│ [✓ Confirm]  [✗ Decline]               │
└────────────────────────────────────────┘
```

#### History

View past transactions with filters:
- Success/Failed
- Lunch/Dinner
- Date range

---

## WhatsApp Controls

Send messages to yourself (Saved Messages) to control the bot:

### Quick Reference

| Command | Action |
|---------|--------|
| `status` | Show current status |
| `hi` | Change preference for current session |
| `stop` | Stop current session |
| `start` | Resume searching |
| `reset` | Reset both sessions |
| `ok` / `yes` | Confirm purchase |
| `no` / `cancel` | Decline purchase |
| `paid` | Confirm payment made |

### Detailed Commands

#### Setting Preferences

```
You: hi

Bot: 🍽️ LUNCH PREFERENCE UPDATE

     Current preference: Himalaya

     Select new preference:

     0. Any (no preference)
     1. SGR
     2. SRR
     3. Firstman
     4. Prism
     5. Neelkesh
     6. Food Sutra
     7. Vindhya

     Reply with the number to update.

You: 0

Bot: ✅ LUNCH preference updated to: Any
```

#### Stopping a Session

```
You: stop

Bot: ⏹️ LUNCH session STOPPED.

     Now looking for DINNER coupons.
```

#### Resetting Sessions

```
You: reset

Bot: 🔄 SESSIONS RESET

     Both lunch and dinner sessions have been reset.
     Now searching for coupons again.
```

---

## Understanding the Bot

### How Detection Works

1. Bot monitors configured WhatsApp groups
2. AI analyzes each message looking for sell indicators:
   - "selling lunch/dinner"
   - "coupon available"
   - Price mentions
   - Mess names

3. If detected, bot checks:
   - Do you need this coupon type?
   - Is price ≤ maxPrice?
   - Does mess match your preference?

### Conversation Flow

```
YOU (via bot)                    SELLER
─────────────────────────────────────────
"Hi, is it available?"    →
                          ←    "Yes"
"Which mess?"             →
                          ←    "Himalaya"
"I'll take it at ₹70"     →
                          ←    "Ok, send to 9876543210@upi"

[You confirm & pay via UPI]

"Done, sent"              →
                          ←    [QR code image]

[Bot validates QR, marks complete]
```

### Time Cutoffs

| Meal | Cutoff Time | What Happens |
|------|-------------|--------------|
| Lunch | 2:10 PM | Bot stops searching for lunch |
| Dinner | 9:10 PM | Bot stops searching for dinner |
| Midnight | 12:00 AM | Daily state resets |

In test mode, cutoffs are bypassed.

### Data Storage

All data stored in `data/mess_coupon.db`:

- **Users** - Your account (phone hash)
- **Daily State** - Today's preferences/status
- **Conversations** - Chat history with sellers
- **Deals** - Purchase history
- **Coupon Images** - QR code metadata

Images auto-delete after 2 days.

---

## Advanced Features

### Test Mode

Run with a test account to debug without affecting real groups:

```bash
# Start in test mode
npm run test-mode
# or
docker compose run bot node dist/index.js test
```

In test mode:
- Group scanning is disabled
- Only messages from `testPhoneNumbers` are processed
- Time cutoffs are bypassed

### Multi-Account Support

Each WhatsApp account has isolated:
- Preferences
- Conversation history
- Deal records

Logout and scan a different QR to switch accounts.

### Database Access

```bash
# Enter database shell
docker compose exec bot sqlite3 /app/data/mess_coupon.db

# List tables
.tables

# View recent deals
SELECT * FROM deals ORDER BY timestamp DESC LIMIT 10;

# Check daily state
SELECT * FROM daily_state ORDER BY date DESC LIMIT 5;

# Exit
.quit
```

### Manual Cleanup

```bash
# Delete expired images manually
docker compose exec bot node -e "
  import('./dist/jobs/imageCleanup.js').then(m => {
    console.log(m.runImageCleanup());
  });
"
```

---

## Troubleshooting

### Common Issues

#### Bot not finding messages

**Problem:** Bot is running but not detecting sell messages

**Solutions:**
1. Verify group names in config match exactly (case-sensitive)
2. Check you're a member of the groups
3. Ensure `maxPrice` isn't too low
4. Check logs: `docker compose logs -f`

#### QR code not appearing

**Problem:** Dashboard shows blank instead of QR

**Solutions:**
1. Check container is running: `docker compose ps`
2. View logs for errors: `docker compose logs -f`
3. Restart: `docker compose restart`

#### WhatsApp disconnected

**Problem:** Bot was working but stopped responding

**Solutions:**
1. Check dashboard for QR code
2. Re-scan if needed
3. Session data persists in `.wwebjs_auth/` volume

#### "Preference not set" messages

**Problem:** Bot keeps asking for preferences

**Solutions:**
1. Reply with a valid number (0-7)
2. Check you're replying to yourself, not the bot
3. Try through dashboard instead

### Viewing Logs

```bash
# All logs
docker compose logs -f

# Last 100 lines
docker compose logs --tail=100

# Filter by time
docker compose logs --since="2024-02-07T10:00:00"
```

### Resetting Everything

```bash
# Stop and remove containers
docker compose down

# Remove all data (WARNING: deletes history!)
rm -rf data/

# Remove WhatsApp session
rm -rf .wwebjs_auth/

# Start fresh
docker compose up -d --build
```

### Getting Help

1. Check [README.md](README.md) for setup instructions
2. View logs for error details
3. Open an issue on GitHub with:
   - Error messages
   - Steps to reproduce
   - Logs (remove personal info)

---

## Tips & Best Practices

1. **Set preferences early** - Do it in the morning before lunch time
2. **Keep dashboard open** - Faster to confirm than WhatsApp
3. **Check status regularly** - Use `status` command or dashboard
4. **Don't close terminal** - Keep Docker running
5. **Monitor logs initially** - Watch for issues first few days

---

## Quick Command Cheat Sheet

```
┌─────────────────────────────────────────────────────────┐
│                 WHATSAPP COMMANDS                        │
├─────────────────────────────────────────────────────────┤
│  status     → Show current status                       │
│  hi         → Change mess preference                    │
│  stop       → Stop searching                            │
│  start      → Resume searching                          │
│  reset      → Reset both sessions                       │
│  ok / yes   → Confirm purchase                          │
│  no         → Decline purchase                          │
│  paid       → Confirm payment                           │
└─────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────┐
│                 DOCKER COMMANDS                          │
├─────────────────────────────────────────────────────────┤
│  docker compose up -d --build    → Start/rebuild        │
│  docker compose logs -f          → View logs            │
│  docker compose down             → Stop                 │
│  docker compose restart          → Restart              │
└─────────────────────────────────────────────────────────┘
```
