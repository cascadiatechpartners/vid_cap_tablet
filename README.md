# Video Capture Tablet Application

A web-based video capture application designed for the Dell 7350 Detachable tablet with Ubuntu 24.04, using a Magewell USB capture device.

## Features

- **Web-based UI** accessible at `localhost:3000` via Google Chrome
- **Start/Stop video capture** with real-time status updates
- **Low-resolution preview** of the video stream during capture
- **Notes field** for adding metadata to recordings
- **MongoDB database** (runs in Docker) for storing recording information
- **AWS S3 upload** for cloud storage of completed videos
- **Real-time updates** via Socket.io

## Architecture

```
┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐
│   Chrome UI     │────▶│  Node.js Server │────▶│   MongoDB       │
│  localhost:3000 │     │  (Express +     │     │   (Docker)      │
│                 │◀────│   Socket.io)    │◀────│                 │
└─────────────────┘     └────────┬────────┘     └─────────────────┘
                                 │
                                 ▼
                        ┌─────────────────┐
                        │  Magewell USB   │
                        │  Capture Device │
                        └────────┬────────┘
                                 │
                                 ▼
                        ┌─────────────────┐
                        │   FFmpeg        │
                        │   (Recording)   │
                        └────────┬────────┘
                                 │
                    ┌────────────┴────────────┐
                    ▼                         ▼
           ┌─────────────────┐       ┌─────────────────┐
           │   SFTP Server   │       │   AWS S3        │
           │   (tomlaptop)   │       │   (Cloud Store) │
           └─────────────────┘       └─────────────────┘
```

## Prerequisites

- Ubuntu 24.04
- Docker and Docker Compose
- Node.js 18+ 
- Magewell USB Capture device
- FFmpeg
- AWS S3 credentials (for cloud upload)

## Installation

### Quick Install (Recommended)

Run the automated installation script:

```bash
cd /path/to/vid_cap_tablet
sudo ./install.sh
```

This script will:
- Check and install all dependencies (Node.js, FFmpeg, Docker, MongoDB)
- Configure video device permissions
- Install Node.js packages
- Create systemd service
- Set up configuration file

### Manual Installation

If you prefer to install manually:

```bash
# Update package list
sudo apt update

# Install dependencies
sudo apt install -y nodejs npm ffmpeg docker.io docker-compose-v2

# Add user to docker and video groups
sudo usermod -aG docker $USER
sudo usermod -aG video $USER

# Start MongoDB
docker compose -f docker-compose.mongodb.yml up -d

# Install Node.js dependencies
npm install --production

# Configure environment
cp config/.env.example config/.env
nano config/.env  # Edit with your settings
```

**Required Configuration:**

| Variable | Description |
|----------|-------------|
| `MONGODB_URI` | MongoDB connection string |
| `UPLOAD_METHOD` | Upload destination: `sftp`, `s3`, or `local` |
| `SFTP_HOST` | SFTP server hostname (e.g., tomlaptop) |
| `SFTP_PORT` | SFTP port (default: 22) |
| `SFTP_USERNAME` | SFTP username (e.g., tom) |
| `SFTP_PASSWORD` | SFTP password |
| `SFTP_UPLOAD_DIR` | Remote directory for videos |
| `AWS_ACCESS_KEY_ID` | AWS access key for S3 (if using S3) |
| `AWS_SECRET_ACCESS_KEY` | AWS secret key for S3 (if using S3) |
| `AWS_REGION` | AWS region (e.g., us-east-1) |
| `AWS_S3_BUCKET` | S3 bucket name (if using S3) |
| `AWS_S3_FOLDER` | Folder path within the bucket |
| `VIDEO_CAPTURE_DEVICE` | Video device path (default: /dev/video2 for Magewell) |

### 4. Identify Magewell Device

```bash
# List video devices
v4l2-ctl --list-devices

# Test the capture device
ffplay /dev/video0
```

Update `VIDEO_CAPTURE_DEVICE` in `config/.env` if your device is not `/dev/video0`.

## Running the Application

### Using the Management Script (Recommended)

```bash
# Start the application
./manage.sh start

# Stop the application
./manage.sh stop

# Restart the application
./manage.sh restart

# Check status
./manage.sh status

# View logs (follow mode)
./manage.sh logs
```

### Using systemd (if installed via install.sh)

```bash
# Start
sudo systemctl start vid-cap-tablet

# Stop
sudo systemctl stop vid-cap-tablet

# Enable auto-start on boot
sudo systemctl enable vid-cap-tablet

# View logs
sudo journalctl -u vid-cap-tablet -f
```

### Manual Start

```bash
# Start MongoDB (if not running)
docker compose -f docker-compose.mongodb.yml up -d

# Start the application
npm start
```

## Usage

1. **Open Chrome** and navigate to `http://localhost:3000`

2. **Enter Notes** (optional) in the "Recording Notes" field

3. **Click "Start Capture"** to begin recording
   - The status indicator will turn red and pulse
   - The timer will start counting
   - A low-resolution preview will appear

4. **Click "Stop Capture"** to end recording
   - The video will be saved locally
   - Upload to S3 will begin automatically
   - Recording will appear in the "Recent Recordings" list

5. **View Recordings** in the list below the controls
   - Status shows: Recording, Completed, Uploaded, or Error
   - Click "View in S3" to access the cloud-stored video

## API Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/capture/start` | Start video capture |
| POST | `/api/capture/stop` | Stop video capture |
| POST | `/api/capture/:id/notes` | Update notes for a recording |
| GET | `/api/recordings` | List all recordings |
| GET | `/api/recordings/:id` | Get single recording details |
| GET | `/api/preview/:id` | Get HLS preview playlist |

## Database Schema

### Videos Collection

```json
{
  "_id": ObjectId,
  "recordingId": "uuid-string",
  "filename": "recording-id.mp4",
  "filepath": "/path/to/file.mp4",
  "status": "recording|completed|error",
  "startTime": ISODate,
  "endTime": ISODate,
  "duration": 123.45,
  "notes": "User entered notes",
  "previewPlaylist": "playlist.m3u8",
  "previewDir": "/path/to/preview",
  "uploadedToRemote": true,
  "sftpLocation": "sftp://tom@tomlaptop/home/tom/videos/...",
  "s3Location": "https://s3.amazonaws.com/...",
  "createdAt": ISODate,
  "updatedAt": ISODate
}
```

## Troubleshooting

### Application Won't Start

```bash
# Check status
./manage.sh status

# View logs
./manage.sh logs

# Restart
./manage.sh restart
```

### Video Device Not Found

```bash
# List video devices
v4l2-ctl --list-devices

# Check device permissions
ls -la /dev/video2

# Add user to video group (then log out and back in)
sudo usermod -aG video $USER
```

### MongoDB Connection Issues

```bash
# Check if MongoDB container is running
docker ps | grep mongodb

# View MongoDB logs
docker logs vid_cap_mongodb

# Restart MongoDB
docker compose -f docker-compose.mongodb.yml restart
```

### Permission Denied Errors

```bash
# Fix ownership
sudo chown -R $USER:$USER /path/to/vid_cap_tablet

# Fix video device permissions
sudo chmod 660 /dev/video2
sudo chown root:video /dev/video2
```

### Preview Not Working

1. Ensure no other application is using the capture device
2. Check that FFmpeg can access the device:
   ```bash
   timeout 2 ffmpeg -f video4linux2 -i /dev/video2 -f null /dev/null
   ```

### SFTP Upload Fails

1. Verify SFTP credentials in `config/.env`
2. Test connection manually:
   ```bash
   ssh tom@tomlaptop
   ```
3. Ensure remote directory exists:
   ```bash
   ssh tom@tomlaptop "mkdir -p /home/tom/videos"
   ```

## File Structure

```
vid_cap_tablet/
├── client/
│   ├── css/
│   │   └── styles.css
│   ├── js/
│   │   └── app.js
│   └── index.html
├── server/
│   └── main.js
├── config/
│   └── .env
├── uploads/
├── docker-compose.yml
├── docker-compose.mongodb.yml
├── Dockerfile
├── package.json
└── README.md
```

## Security Considerations

- This application is designed for **local-only** access (`localhost:3000`)
- AWS credentials are stored in `config/.env` - ensure proper file permissions
- Consider enabling S3 bucket encryption for sensitive recordings
- Regularly rotate AWS access keys

## License

MIT
