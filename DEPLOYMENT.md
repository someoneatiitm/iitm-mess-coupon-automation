# Deploying Mess Coupon Bot - Free 24/7 Server

This guide will help you deploy the bot on **Oracle Cloud Free Tier** - a completely free VM that runs forever.

## Why Oracle Cloud Free Tier?

- **Always Free**: Not a trial - it's free forever
- **1 GB RAM**: Enough for WhatsApp bot with Puppeteer
- **Reliable**: 99.9% uptime
- **Good for India**: Has a Mumbai data center

---

## Step 1: Create Oracle Cloud Account

1. Go to [Oracle Cloud Free Tier](https://www.oracle.com/cloud/free/)
2. Click "Start for free"
3. Fill in your details (requires credit card for verification, but won't charge)
4. Select **India South (Hyderabad)** or **India West (Mumbai)** as your home region

---

## Step 2: Create a Free VM

1. Log into Oracle Cloud Console
2. Click **☰ Menu** → **Compute** → **Instances**
3. Click **Create Instance**
4. Configure:
   - **Name**: `mess-coupon-bot`
   - **Image**: Ubuntu 22.04 (or latest)
   - **Shape**: Click "Change Shape" → **Ampere** → **VM.Standard.A1.Flex**
     - OCPUs: 1
     - Memory: 6 GB (free tier allows up to 24 GB total)
   - **Networking**: Keep defaults (creates public IP)
   - **SSH Keys**: Click "Generate key pair" and **download both keys**
5. Click **Create**
6. Wait for the instance to be "Running"
7. Note down the **Public IP Address**

---

## Step 3: Configure Firewall (Allow Port 3000)

1. In your instance details, click the **Subnet** link
2. Click the **Security List** (default)
3. Click **Add Ingress Rules**
4. Add rule:
   - **Source CIDR**: `0.0.0.0/0`
   - **Destination Port Range**: `3000`
   - **Description**: Web Dashboard
5. Click **Add Ingress Rules**

Also open the firewall on the VM itself (do this after SSH in Step 4):
```bash
sudo iptables -I INPUT -p tcp --dport 3000 -j ACCEPT
sudo netfilter-persistent save
```

---

## Step 4: Connect to Your VM

### On Mac/Linux:
```bash
# Set correct permissions for the key
chmod 400 ~/Downloads/ssh-key-*.key

# Connect
ssh -i ~/Downloads/ssh-key-*.key ubuntu@<YOUR_VM_IP>
```

### On Windows:
Use PuTTY or Windows Terminal with the downloaded key.

---

## Step 5: Install Docker on VM

Run these commands on your VM:

```bash
# Update system
sudo apt-get update && sudo apt-get upgrade -y

# Install Docker
curl -fsSL https://get.docker.com -o get-docker.sh
sudo sh get-docker.sh
sudo usermod -aG docker $USER

# Install Docker Compose
sudo apt-get install -y docker-compose-plugin

# Log out and back in for docker permissions
exit
```

SSH back in after logging out.

---

## Step 6: Upload Bot Files

### Option A: Using the deploy script (from your Mac)

```bash
cd "/Users/chirag/IITM Mess Coupon Automation"
chmod +x deploy/deploy.sh
./deploy/deploy.sh ubuntu@<YOUR_VM_IP>
```

### Option B: Manual upload with scp

```bash
# On your Mac
cd "/Users/chirag/IITM Mess Coupon Automation"
npm run build

# Upload files
scp -i ~/Downloads/ssh-key-*.key -r dist/ ubuntu@<YOUR_VM_IP>:~/mess-coupon-bot/
scp -i ~/Downloads/ssh-key-*.key -r config/ ubuntu@<YOUR_VM_IP>:~/mess-coupon-bot/
scp -i ~/Downloads/ssh-key-*.key package*.json ubuntu@<YOUR_VM_IP>:~/mess-coupon-bot/
scp -i ~/Downloads/ssh-key-*.key Dockerfile ubuntu@<YOUR_VM_IP>:~/mess-coupon-bot/
scp -i ~/Downloads/ssh-key-*.key docker-compose.yml ubuntu@<YOUR_VM_IP>:~/mess-coupon-bot/
scp -i ~/Downloads/ssh-key-*.key .env ubuntu@<YOUR_VM_IP>:~/mess-coupon-bot/
```

---

## Step 7: Create .env File on Server

SSH into your VM and create the .env file:

```bash
cd ~/mess-coupon-bot
nano .env
```

Add your Groq API key:
```
GROQ_API_KEY=your_actual_groq_api_key_here
WEB_PORT=3000
```

Save with `Ctrl+X`, then `Y`, then `Enter`.

---

## Step 8: Start the Bot

```bash
cd ~/mess-coupon-bot

# Build and start
docker compose up -d --build

# View logs (Ctrl+C to exit)
docker compose logs -f
```

---

## Step 9: Scan QR Code

1. Watch the logs: `docker compose logs -f`
2. When you see the QR code, scan it with WhatsApp
3. The bot will save the session and auto-reconnect

---

## Step 10: Access Dashboard

Open in your browser:
```
http://<YOUR_VM_IP>:3000
```

---

## Useful Commands

```bash
# View logs
docker compose logs -f

# Restart bot
docker compose restart

# Stop bot
docker compose down

# Start bot
docker compose up -d

# Rebuild after code changes
docker compose up -d --build

# Check container status
docker compose ps
```

---

## Keeping Bot Running

The bot is configured with `restart: always` in docker-compose.yml, so it will:
- Auto-restart if it crashes
- Auto-start when the VM reboots

---

## Updating the Bot

When you make changes locally:

```bash
# On your Mac
npm run build
./deploy/deploy.sh ubuntu@<YOUR_VM_IP>

# On the server
cd ~/mess-coupon-bot
docker compose up -d --build
```

---

## Troubleshooting

### Can't connect to port 3000?
1. Check Oracle Cloud security list has port 3000 open
2. Run on VM: `sudo iptables -I INPUT -p tcp --dport 3000 -j ACCEPT`

### Bot keeps disconnecting?
- Check logs: `docker compose logs -f`
- WhatsApp session may have expired - restart and scan QR again

### Out of memory?
- The free tier VM has limited memory
- Check with: `free -h`
- Restart docker: `sudo systemctl restart docker`

---

## Alternative Free Options

If Oracle Cloud doesn't work for you:

1. **Google Cloud Free Tier**: e2-micro instance (less powerful)
2. **Railway.app**: $5 free credit/month
3. **Render.com**: Free tier (spins down after inactivity)
4. **Fly.io**: Free tier with 3 shared VMs

Oracle Cloud is recommended as it's the most generous free tier for this use case.
