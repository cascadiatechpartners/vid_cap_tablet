#!/bin/bash

# Video Capture Tablet - Management Script
# Start, stop, restart, and monitor the application

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Script directory
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_NAME="vid_cap_tablet"
SERVICE_NAME="vid-cap-tablet"
PID_FILE="$SCRIPT_DIR/.app.pid"
LOG_FILE="$SCRIPT_DIR/logs/app.log"

# Check if running as root for systemd commands
check_systemd() {
    if systemctl list-units --type=service --all | grep -q "$SERVICE_NAME"; then
        return 0
    else
        return 1
    fi
}

# Print usage
usage() {
    echo -e "${BLUE}========================================${NC}"
    echo -e "${BLUE}Video Capture Tablet - Manager${NC}"
    echo -e "${BLUE}========================================${NC}"
    echo -e ""
    echo -e "Usage: $0 {start|stop|restart|status|logs|install}"
    echo -e ""
    echo -e "Commands:"
    echo -e "  ${GREEN}start${NC}      - Start the application"
    echo -e "  ${GREEN}stop${NC}       - Stop the application"
    echo -e "  ${GREEN}restart${NC}    - Restart the application"
    echo -e "  ${GREEN}status${NC}     - Show application status"
    echo -e "  ${GREEN}logs${NC}       - View application logs (follow mode)"
    echo -e "  ${GREEN}install${NC}    - Run installation script"
    echo -e ""
    echo -e "Examples:"
    echo -e "  $0 start"
    echo -e "  $0 logs"
    echo -e "  sudo $0 install"
    echo -e ""
}

# Start the application
start_app() {
    echo -e "${YELLOW}Starting $APP_NAME...${NC}"
    
    # Check if already running
    if [ -f "$PID_FILE" ]; then
        PID=$(cat "$PID_FILE")
        if ps -p "$PID" > /dev/null 2>&1; then
            echo -e "${GREEN}✓${NC} Application is already running (PID: $PID)"
            return 0
        else
            rm -f "$PID_FILE"
        fi
    fi
    
    # Try systemd first
    if check_systemd && [ "$EUID" -eq 0 ]; then
        systemctl start $SERVICE_NAME
        sleep 2
        if systemctl is-active --quiet $SERVICE_NAME; then
            echo -e "${GREEN}✓${NC} Application started (via systemd)"
            return 0
        fi
    fi
    
    # Fallback to direct start
    if [ "$EUID" -eq 0 ]; then
        echo -e "${RED}✗${NC} Running as root. Use a regular user account or systemd."
        exit 1
    fi
    
    # Check dependencies
    if ! command -v node >/dev/null 2>&1; then
        echo -e "${RED}✗${NC} Node.js not found"
        exit 1
    fi
    
    if ! command -v ffmpeg >/dev/null 2>&1; then
        echo -e "${RED}✗${NC} FFmpeg not found"
        exit 1
    fi
    
    # Check MongoDB
    if ! docker ps --format '{{.Names}}' | grep -q "vid_cap_mongodb"; then
        echo -e "${YELLOW}!${NC} MongoDB not running. Starting..."
        cd "$SCRIPT_DIR"
        docker compose -f docker-compose.mongodb.yml up -d
        sleep 3
    fi
    
    # Start application
    cd "$SCRIPT_DIR"
    nohup node server/main.js > /dev/null 2>&1 &
    PID=$!
    echo $PID > "$PID_FILE"
    
    sleep 2
    
    if ps -p "$PID" > /dev/null 2>&1; then
        echo -e "${GREEN}✓${NC} Application started (PID: $PID)"
        echo -e "    Access at: ${BLUE}http://localhost:3000${NC}"
    else
        echo -e "${RED}✗${NC} Failed to start application"
        rm -f "$PID_FILE"
        exit 1
    fi
}

# Stop the application
stop_app() {
    echo -e "${YELLOW}Stopping $APP_NAME...${NC}"
    
    # Try systemd first
    if check_systemd && [ "$EUID" -eq 0 ]; then
        systemctl stop $SERVICE_NAME
        echo -e "${GREEN}✓${NC} Application stopped (via systemd)"
        return 0
    fi
    
    # Stop via PID file
    if [ -f "$PID_FILE" ]; then
        PID=$(cat "$PID_FILE")
        if ps -p "$PID" > /dev/null 2>&1; then
            kill "$PID" 2>/dev/null || true
            sleep 2
            
            # Force kill if still running
            if ps -p "$PID" > /dev/null 2>&1; then
                kill -9 "$PID" 2>/dev/null || true
            fi
            
            echo -e "${GREEN}✓${NC} Application stopped"
        else
            echo -e "${YELLOW}!${NC} Application was not running"
        fi
        rm -f "$PID_FILE"
    else
        # Try to find by process name
        PIDS=$(pgrep -f "node.*server/main.js" || true)
        if [ -n "$PIDS" ]; then
            echo "$PIDS" | xargs kill 2>/dev/null || true
            sleep 2
            echo "$PIDS" | xargs kill -9 2>/dev/null || true
            echo -e "${GREEN}✓${NC} Application stopped"
        else
            echo -e "${YELLOW}!${NC} Application is not running"
        fi
    fi
}

# Restart the application
restart_app() {
    echo -e "${YELLOW}Restarting $APP_NAME...${NC}"
    stop_app
    sleep 1
    start_app
}

# Show application status
show_status() {
    echo -e "${BLUE}========================================${NC}"
    echo -e "${BLUE}$APP_NAME - Status${NC}"
    echo -e "${BLUE}========================================${NC}"
    echo -e ""
    
    # Check if running
    if [ -f "$PID_FILE" ]; then
        PID=$(cat "$PID_FILE")
        if ps -p "$PID" > /dev/null 2>&1; then
            echo -e "Application: ${GREEN}Running${NC} (PID: $PID)"
            
            # Show uptime
            START_TIME=$(ps -o lstart= -p "$PID" 2>/dev/null || echo "unknown")
            echo -e "Started: $START_TIME"
        else
            echo -e "Application: ${RED}Not Running${NC} (stale PID file)"
            rm -f "$PID_FILE"
        fi
    else
        PIDS=$(pgrep -f "node.*server/main.js" || true)
        if [ -n "$PIDS" ]; then
            echo -e "Application: ${GREEN}Running${NC} (PIDs: $PIDS)"
        else
            echo -e "Application: ${YELLOW}Not Running${NC}"
        fi
    fi
    
    echo -e ""
    
    # Check MongoDB
    if docker ps --format '{{.Names}}' | grep -q "vid_cap_mongodb"; then
        echo -e "MongoDB: ${GREEN}Running${NC}"
    else
        echo -e "MongoDB: ${YELLOW}Not Running${NC}"
    fi
    
    echo -e ""
    
    # Check systemd service
    if check_systemd; then
        if systemctl is-active --quiet $SERVICE_NAME; then
            echo -e "Systemd Service: ${GREEN}Active${NC}"
        else
            echo -e "Systemd Service: ${YELLOW}Inactive${NC}"
        fi
    else
        echo -e "Systemd Service: ${YELLOW}Not Installed${NC}"
    fi
    
    echo -e ""
    
    # Check video device
    if [ -e "/dev/video2" ]; then
        echo -e "Video Device: ${GREEN}/dev/video2${NC}"
    else
        echo -e "Video Device: ${RED}Not Found${NC}"
    fi
    
    echo -e ""
    
    # Show recent log entries
    if [ -f "$LOG_FILE" ]; then
        echo -e "Recent Logs:"
        tail -5 "$LOG_FILE" | sed 's/^/    /'
    fi
    
    echo -e ""
}

# View logs
view_logs() {
    if [ -f "$LOG_FILE" ]; then
        echo -e "${YELLOW}Following logs... (Ctrl+C to stop)${NC}"
        tail -f "$LOG_FILE"
    elif check_systemd && [ "$EUID" -eq 0 ]; then
        echo -e "${YELLOW}Following systemd logs... (Ctrl+C to stop)${NC}"
        journalctl -u $SERVICE_NAME -f
    else
        echo -e "${RED}✗${NC} No logs found"
        exit 1
    fi
}

# Run installation
run_install() {
    if [ -f "$SCRIPT_DIR/install.sh" ]; then
        bash "$SCRIPT_DIR/install.sh"
    else
        echo -e "${RED}✗${NC} install.sh not found"
        exit 1
    fi
}

# Main command handler
case "${1:-}" in
    start)
        start_app
        ;;
    stop)
        stop_app
        ;;
    restart)
        restart_app
        ;;
    status)
        show_status
        ;;
    logs)
        view_logs
        ;;
    install)
        run_install
        ;;
    *)
        usage
        exit 1
        ;;
esac
