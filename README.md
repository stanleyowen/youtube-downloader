# YouTube Downloader

A simple, fast YouTube downloader with React frontend and Node.js backend.

## Features

- Download single videos in multiple qualities (360p to 1080p+)
- Download playlists with batch selection
- MP3 audio extraction
- Dark/light mode
- Clean, minimal UI

## Prerequisites

- Node.js (v18+)
- yt-dlp installed on your system

### Install yt-dlp

```bash
# macOS
brew install yt-dlp

# Linux
sudo curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp
sudo chmod a+rx /usr/local/bin/yt-dlp

# Windows
winget install yt-dlp
```

## Setup

### Backend

```bash
cd backend
npm install
npm start
```

Server runs on http://localhost:3001

### Frontend

```bash
cd frontend
npm install
npm run dev
```

App runs on http://localhost:5173

## Usage

1. Start both backend and frontend servers
2. Open http://localhost:5173 in your browser
3. Paste a YouTube video or playlist URL
4. Select quality and click Download

## Disclaimer

For personal use only. Respect YouTube's Terms of Service and copyright laws.
