#!/bin/bash

# Oracle Cloud Free Tier Setup Script
# Run this on your Oracle Cloud VM (Ubuntu)

set -e

echo "=========================================="
echo "  Mess Coupon Bot - Oracle Cloud Setup"
echo "=========================================="

# Update system
echo "Updating system..."
sudo apt-get update && sudo apt-get upgrade -y

# Install Docker
echo "Installing Docker..."
sudo apt-get install -y apt-transport-https ca-certificates curl software-properties-common
curl -fsSL https://download.docker.com/linux/ubuntu/gpg | sudo gpg --dearmor -o /usr/share/keyrings/docker-archive-keyring.gpg
echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/docker-archive-keyring.gpg] https://download.docker.com/linux/ubuntu $(lsb_release -cs) stable" | sudo tee /etc/apt/sources.list.d/docker.list > /dev/null
sudo apt-get update
sudo apt-get install -y docker-ce docker-ce-cli containerd.io docker-compose-plugin

# Add current user to docker group
sudo usermod -aG docker $USER

# Install Docker Compose
echo "Installing Docker Compose..."
sudo curl -L "https://github.com/docker/compose/releases/latest/download/docker-compose-$(uname -s)-$(uname -m)" -o /usr/local/bin/docker-compose
sudo chmod +x /usr/local/bin/docker-compose

# Create app directory
echo "Creating app directory..."
mkdir -p ~/mess-coupon-bot
cd ~/mess-coupon-bot

echo ""
echo "=========================================="
echo "  Setup Complete!"
echo "=========================================="
echo ""
echo "Next steps:"
echo "1. Upload your bot files to ~/mess-coupon-bot"
echo "2. Create .env file with your GROQ_API_KEY"
echo "3. Run: docker-compose up -d"
echo "4. View logs: docker-compose logs -f"
echo "5. Access dashboard: http://<your-vm-ip>:3000"
echo ""
echo "NOTE: You need to log out and back in for docker permissions to take effect"
echo ""
