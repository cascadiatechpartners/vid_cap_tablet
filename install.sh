#!/bin/bash

# Video Capture Tablet - Installation Script
# For Ubuntu 24.04 with Magewell USB Capture Device

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Script directory
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_NAME="vid_cap_tablet"
SERVICE_NAME="vid-cap-tablet"

echo -e "${GREEN}========================================${NC}"
echo -e "${GREEN}Video Capture Tablet - Installer${NC}"
echo -e "${GREEN}========================================${NC}"
echo ""

# Check if running as root
if [ "$EUID" -ne 0 ]; then 
    echo -e "${RED}Error: Please run as root (use sudo)${NC}"
    exit 1
fi

# Function to check if a command exists
command_exists() {
    command -v "$1" >/dev/null 2>&1
}

# Function to check if a package is installed
package_installed() {
    dpkg -l "$1" >/dev/null 2>&1
}

echo -e "${YELLOW}Checking system requirements...${NC}"
echo ""

# Update package list
echo -e "[1/10] Updating package list..."
apt-get update -qq

# Install Node.js if not installed
echo -e "[2/10] Checking Node.js..."
if command_exists node; then
    NODE_VERSION=$(node -v)
    echo -e "    ${GREEN}✓${NC} Node.js is installed ($NODE_VERSION)"
else
    echo -e "    ${YELLOW}!${NC} Node.js not found. Installing..."
    curl -fsSL https://deb.nodesource.com/setup_20.x | bash - >/dev/null 2>&1
    apt-get install -y -qq nodejs
    echo -e "    ${GREEN}✓${NC} Node.js installed"
fi

# Install npm if not installed
echo -e "[3/10] Checking npm..."
if command_exists npm; then
    NPM_VERSION=$(npm -v)
    echo -e "    ${GREEN}✓${NC} npm is installed ($NPM_VERSION)"
else
    echo -e "    ${YELLOW}!${NC} npm not found. Installing..."
    apt-get install -y -qq npm
    echo -e "    ${GREEN}✓${NC} npm installed"
fi

# Install FFmpeg if not installed
echo -e "[4/10] Checking FFmpeg..."
if command_exists ffmpeg; then
    FFMPEG_VERSION=$(ffmpeg -version | head -1)
    echo -e "    ${GREEN}✓${NC} FFmpeg is installed ($FFMPEG_VERSION)"
else
    echo -e "    ${YELLOW}!${NC} FFmpeg not found. Installing..."
    apt-get install -y -qq ffmpeg
    echo -e "    ${GREEN}✓${NC} FFmpeg installed"
fi

# Install Docker if not installed
echo -e "[5/10] Checking Docker..."
if command_exists docker; then
    DOCKER_VERSION=$(docker --version)
    echo -e "    ${GREEN}✓${NC} Docker is installed ($DOCKER_VERSION)"
else
    echo -e "    ${YELLOW}!${NC} Docker not found. Installing..."
    apt-get install -y -qq docker.io
    systemctl enable docker
    systemctl start docker
    echo -e "    ${GREEN}✓${NC} Docker installed and started"
fi

# Install Docker Compose if not installed
echo -e "[6/10] Checking Docker Compose..."
if command_exists docker-compose || command_exists "docker compose"; then
    echo -e "    ${GREEN}✓${NC} Docker Compose is installed"
else
    echo -e "    ${YELLOW}!${NC} Docker Compose not found. Installing..."
    apt-get install -y -qq docker-compose-v2
    echo -e "    ${GREEN}✓${NC} Docker Compose installed"
fi

# Install MongoDB (via Docker)
echo -e "[7/10] Checking MongoDB..."
if docker ps -a --format '{{.Names}}' | grep -q "vid_cap_mongodb"; then
    echo -e "    ${GREEN}✓${NC} MongoDB container exists"
else
    echo -e "    ${YELLOW}!${NC} MongoDB not found. Setting up..."
    cd "$SCRIPT_DIR"
    docker compose -f docker-compose.mongodb.yml up -d
    echo -e "    ${GREEN}✓${NC} MongoDB container started"
fi

# Check video device
echo -e "[8/10] Checking video capture device..."
if [ -e "/dev/video2" ]; then
    echo -e "    ${GREEN}✓${NC} Video device found at /dev/video2"
    
    # Set up video group permissions
    if ! getent group video >/dev/null 2>&1; then
        groupadd video
    fi
    
    # Create udev rule for persistent permissions
    if [ ! -f "/etc/udev/rules.d/99-video.rules" ]; then
        echo 'KERNEL=="video[0-9]*", GROUP="video", MODE="0660"' > /etc/udev/rules.d/99-video.rules
        udevadm control --reload-rules
        udevadm trigger
        echo -e "    ${GREEN}✓${NC} Video device permissions configured"
    else
        echo -e "    ${GREEN}✓${NC} Video device permissions already configured"
    fi
else
    echo -e "    ${RED}✗${NC} Video device not found at /dev/video2"
    echo -e "    ${YELLOW}!${NC} Please connect your Magewell capture device"
fi

# Install Node.js dependencies
echo -e "[9/10] Installing Node.js dependencies..."
cd "$SCRIPT_DIR"
npm install --production
echo -e "    ${GREEN}✓${NC} Dependencies installed"

# Create logs directory
echo -e "[10/10] Setting up directories..."
mkdir -p "$SCRIPT_DIR/logs"
mkdir -p "$SCRIPT_DIR/uploads"
mkdir -p "$SCRIPT_DIR/config"
chown -R $SUDO_USER:$SUDO_USER "$SCRIPT_DIR/logs"
chown -R $SUDO_USER:$SUDO_USER "$SCRIPT_DIR/uploads"
echo -e "    ${GREEN}✓${NC} Directories created"

# Create environment file if it doesn't exist
if [ ! -f "$SCRIPT_DIR/config/.env" ]; then
    echo -e ""
    echo -e "${YELLOW}Creating configuration file...${NC}"
    cp "$SCRIPT_DIR/config/.env.example" "$SCRIPT_DIR/config/.env"
    chown $SUDO_USER:$SUDO_USER "$SCRIPT_DIR/config/.env"
    chmod 600 "$SCRIPT_DIR/config/.env"
    echo -e "    ${GREEN}✓${NC} Configuration file created at config/.env"
    echo -e "    ${YELLOW}!${NC} Please edit config/.env and set your SFTP password"
fi

# Add user to docker and video groups
echo -e ""
echo -e "${YELLOW}Configuring user permissions...${NC}"
usermod -aG docker $SUDO_USER 2>/dev/null || true
usermod -aG video $SUDO_USER 2>/dev/null || true
echo -e "    ${GREEN}✓${NC} User added to docker and video groups"

# Create systemd service
echo -e ""
echo -e "${YELLOW}Creating systemd service...${NC}"
cat > /etc/systemd/system/$SERVICE_NAME.service << EOF
[Unit]
Description=Video Capture Tablet Application
After=network.target docker.service
Requires=docker.service

[Service]
Type=simple
User=$SUDO_USER
Group=$SUDO_USER
WorkingDirectory=$SCRIPT_DIR
ExecStart=/usr/bin/node $SCRIPT_DIR/server/main.js
Restart=on-failure
RestartSec=10
Environment=NODE_ENV=production

# Logging
StandardOutput=journal
StandardError=journal
SyslogIdentifier=$SERVICE_NAME

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
echo -e "    ${GREEN}✓${NC} Systemd service created"

# Enable service (but don't start yet)
systemctl enable $SERVICE_NAME 2>/dev/null || true
echo -e "    ${GREEN}✓${NC} Service enabled"

echo -e ""
echo -e "${GREEN}========================================${NC}"
echo -e "${GREEN}Installation Complete!${NC}"
echo -e "${GREEN}========================================${NC}"
echo -e ""
echo -e "${YELLOW}Next Steps:${NC}"
echo -e ""
echo -e "1. Edit configuration:"
echo -e "   ${YELLOW}nano $SCRIPT_DIR/config/.env${NC}"
echo -e "   - Set SFTP_PASSWORD to your password"
echo -e "   - Adjust other settings as needed"
echo -e ""
echo -e "2. Start the application:"
echo -e "   ${YELLOW}sudo systemctl start $SERVICE_NAME${NC}"
echo -e "   or use: ${YELLOW}./manage.sh start${NC}"
echo -e ""
echo -e "3. Open in browser:"
echo -e "   ${YELLOW}http://localhost:3000${NC}"
echo -e ""
echo -e "4. View logs:"
echo -e "   ${YELLOW}sudo journalctl -u $SERVICE_NAME -f${NC}"
echo -e "   or: ${YELLOW}./manage.sh logs${NC}"
echo -e ""
echo -e "${YELLOW}Note:${NC} You may need to log out and back in for group permissions to take effect."
echo -e ""
