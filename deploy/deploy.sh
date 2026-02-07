#!/bin/bash

# Deploy to Oracle Cloud VM
# Usage: ./deploy/deploy.sh <ssh-user>@<vm-ip>

set -e

if [ -z "$1" ]; then
    echo "Usage: ./deploy/deploy.sh <ssh-user>@<vm-ip>"
    echo "Example: ./deploy/deploy.sh ubuntu@129.153.xx.xx"
    exit 1
fi

SERVER=$1
REMOTE_DIR="~/mess-coupon-bot"

echo "=========================================="
echo "  Deploying to $SERVER"
echo "=========================================="

# Build the project first
echo "Building project..."
npm run build

# Create remote directory
echo "Creating remote directory..."
ssh $SERVER "mkdir -p $REMOTE_DIR"

# Upload files
echo "Uploading files..."
scp -r dist/ $SERVER:$REMOTE_DIR/
scp -r config/ $SERVER:$REMOTE_DIR/
scp package*.json $SERVER:$REMOTE_DIR/
scp Dockerfile $SERVER:$REMOTE_DIR/
scp docker-compose.yml $SERVER:$REMOTE_DIR/
scp .env $SERVER:$REMOTE_DIR/ 2>/dev/null || echo "No .env file found, skipping..."

# Upload existing session data if exists
if [ -d ".wwebjs_auth" ]; then
    echo "Uploading WhatsApp session..."
    scp -r .wwebjs_auth/ $SERVER:$REMOTE_DIR/
fi

if [ -d "data" ]; then
    echo "Uploading bot data..."
    scp -r data/ $SERVER:$REMOTE_DIR/
fi

echo ""
echo "=========================================="
echo "  Files uploaded!"
echo "=========================================="
echo ""
echo "Now SSH into your server and run:"
echo "  cd $REMOTE_DIR"
echo "  docker-compose up -d --build"
echo ""
echo "To view logs:"
echo "  docker-compose logs -f"
echo ""
