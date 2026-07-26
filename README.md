# SpotifyP2P

Listen to Spotify together with friends in real-time using P2P WebRTC.

## Features

- **P2P Connection** — Direct peer-to-peer, no server required
- **Playback Sync** — Play, pause, skip, and seek in sync
- **Shared Queue** — Everyone sees the same queue
- **User Profiles** — Shows Spotify profile pictures
- **Auto-Drift Correction** — Fixes audio drift automatically
- **Manual Sync** — Resync whenever you want

## Prerequisites

- [Spicetify](https://spicetify.app/) installed
- Spotify desktop app

## Installation

### Option A: Manual Install

1. Download `extension.js` from this repo
2. Copy the file to your Spicetify Extensions folder:
   - **Windows:** `%appdata%\spicetify\Extensions\`
   - **macOS:** `~/.config/spicetify/Extensions/`
   - **Linux:** `~/.config/spicetify/Extensions/`

3. Run:
   ```bash
   spicetify config extensions extension.js
   spicetify apply
   ```

### Option B: Via Marketplace

1. Open Spotify
2. Click the Marketplace icon (puzzle piece)
3. Search for "SpotifyP2P"
4. Click Install

## Usage

### Host a Session

1. Click the SpotifyP2P icon (bottom-right)
2. Click **Host Session**
3. Share the 6-character room code with friends
4. Music syncs automatically

### Join a Session

1. Click the SpotifyP2P icon
2. Click **Join Session**
3. Enter the 6-character code
4. Click **Connect**

### Controls

| Action | What Happens |
|--------|--------------|
| Host plays/pauses | Everyone follows |
| Host skips | Everyone skips |
| Host seeks | Everyone seeks |
| Guest controls | Sent to host, executed for all |
| Sync Now | Manually resync position |

## How It Works

1. **WebRTC P2P** — Direct connection between users via STUN servers
2. **NAT Traversal** — Uses public STUN servers to connect through firewalls
3. **Heartbeat Sync** — Host broadcasts position every 1 second
4. **Drift Correction** — Auto-syncs every 5 seconds if drift > 500ms

## Troubleshooting

**Connection fails:**
- Check firewall settings (WebRTC needs UDP)
- Try a different network
- Restart Spotify

**Audio out of sync:**
- Click **Sync Now** to manually resync
- Check internet connection stability

**Extension not showing:**
- Restart Spotify after install
- Run `spicetify apply` again

## Technical Details

- Built with vanilla JavaScript + Spicetify API
- WebRTC for P2P connections
- Public STUN servers for NAT traversal
- No external dependencies

## License

MIT