# Video Capture Tablet - Quick Reference

## Installation (One-Time)

```bash
cd /path/to/vid_cap_tablet
sudo ./install.sh
```

## Daily Operations

```bash
# Start the app
./manage.sh start

# Stop the app
./manage.sh stop

# View logs
./manage.sh logs

# Check status
./manage.sh status
```

## Configuration

Edit settings:
```bash
nano config/.env
```

Key settings:
- `SFTP_PASSWORD` - Your tomlaptop password
- `SFTP_HOST` - Default: tomlaptop
- `SFTP_UPLOAD_DIR` - Default: /home/tom/videos
- `VIDEO_CAPTURE_DEVICE` - Default: /dev/video2

## Access

- **Web UI**: http://localhost:3000
- **Logs**: ./manage.sh logs
- **Recordings**: ./server/uploads/

## Workflow

1. Open Chrome → http://localhost:3000
2. Click "Enable Preview" to see video feed
3. Enter notes (optional)
4. Click "Start Capture" to begin recording
5. Click "Stop Capture" when done
6. Video uploads to tomlaptop automatically

## Common Issues

**"Device or resource busy"**
- Close other apps using the capture card
- Run: `sudo lsof /dev/video2`

**Preview not showing**
- Click "Enable Preview" button
- Check logs: `./manage.sh logs`

**Upload fails**
- Verify password in config/.env
- Test: `ssh tom@tomlaptop`

## Systemd Service (Auto-start)

```bash
# Enable auto-start on boot
sudo systemctl enable vid-cap-tablet

# Start/Stop
sudo systemctl start vid-cap-tablet
sudo systemctl stop vid-cap-tablet

# View logs
sudo journalctl -u vid-cap-tablet -f
```
