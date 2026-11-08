# SpotifyP2P

[![Tests](https://github.com/Sarge58/spotify-p2p/actions/workflows/test.yml/badge.svg)](https://github.com/Sarge58/spotify-p2p/actions/workflows/test.yml)

Listen to Spotify with a friend in sync, directly from the Spotify desktop app.

SpotifyP2P is a [Spicetify](https://spicetify.app/) extension that uses WebRTC to create a direct peer-to-peer connection. The host controls playback and broadcasts playback state so guests stay aligned.

![SpotifyP2P host and guest connected through direct WebRTC](assets/preview.png)

## What it does

- Adds a native SpotifyP2P button to Spotify's top bar.
- Connects two Spotify desktop clients with WebRTC and public STUN servers.
- Synchronizes play, pause, track changes, seek position, and periodic host-state heartbeats.
- Lets an approved guest control the host through Spotify's native track, play/pause, and seek controls.
- Provides manual re-sync and automatic correction when playback drifts.
- Keeps session signaling manual: exchange the generated offer and answer codes with your friend.
- Binds signaling and data messages to a random session identifier and protocol version.

## Install

### Spicetify Marketplace

Once Marketplace has indexed this repository, search for **SpotifyP2P** and install it from the Extensions tab.

### Manual install or update

The commands below download the newest `extension.js` from this repository, install it as `spotify-p2p.js`, enable it in Spicetify, and reapply Spicetify. They work for both a first installation and later updates.

Use the copy button in the upper-right corner of the code block for your operating system, paste the command into the named terminal, and press Enter.

#### Linux

Open a terminal and run:

```bash
config_dir="$(dirname "$(spicetify -c)")" && \
temp_file="$(mktemp)" && \
mkdir -p "$config_dir/Extensions" && \
curl -fL --retry 3 "https://raw.githubusercontent.com/Sarge58/spotify-p2p/main/extension.js" -o "$temp_file" && \
install -m 644 "$temp_file" "$config_dir/Extensions/spotify-p2p.js" && \
rm -f "$temp_file" && \
spicetify config extensions spotify-p2p.js && \
spicetify apply
```

#### Windows

Open **PowerShell** and run:

```powershell
$ErrorActionPreference = "Stop"
$configDir = Split-Path -Parent (spicetify -c)
$extensionsDir = Join-Path $configDir "Extensions"
$destination = Join-Path $extensionsDir "spotify-p2p.js"
$tempFile = New-TemporaryFile
New-Item -ItemType Directory -Force -Path $extensionsDir | Out-Null
try {
    Invoke-WebRequest "https://raw.githubusercontent.com/Sarge58/spotify-p2p/main/extension.js" -OutFile $tempFile.FullName
    Move-Item -Force $tempFile.FullName $destination
    spicetify config extensions spotify-p2p.js
    spicetify apply
} finally {
    Remove-Item $tempFile.FullName -Force -ErrorAction SilentlyContinue
}
```

The download comes from the `main` branch, so it installs the latest version published there rather than unpublished local changes.

## Start a session

1. Click the SpotifyP2P button in Spotify's top bar.
2. One person selects **Host Session**, then copies the generated offer code.
3. The guest pastes that offer into **Join Session**, generates a response, and sends the response back.
4. The host pastes the response and accepts it. The session starts when the connection status becomes connected.
5. The host reviews the join request and clicks **Approve Guest** before playback state or the guest's native Spotify controls are shared.

## Notes and limitations

- Each person needs Spotify desktop with Spicetify and access to the same music in their own Spotify account.
- Spotify local files are intentionally not synchronized because the other peer cannot be assumed to have the same file.
- SpotifyP2P uses direct WebRTC data channels. It has no relay server, so restrictive firewalls or symmetric NATs can prevent a connection.
- Sessions currently support one host and one guest. Adding more guests requires a separate peer connection per guest or a relay architecture.
- Google public STUN servers help peers find each other. The extension does not host or proxy your Spotify credentials or audio.
- Direct WebRTC connections reveal connection metadata, which can include network IP addresses, to the invited peer. Only exchange codes with someone you trust.
- Peer labels are generic and are not proof of identity. Only approve the person with whom you exchanged the current session code.
- This is playback synchronization, not shared audio streaming.
- Treat an offer/answer code as a one-time invite. The host must explicitly approve each connected guest before sharing playback state.
- Connection codes are version-specific. Clients running incompatible SpotifyP2P protocol versions will need to update before connecting.

## Development

Run the protocol regression tests with Node.js 18 or newer:

```bash
npm test
```

The test suite includes protocol unit tests and an in-memory two-peer integration flow covering signaling, approval, synchronization, controls, stale sessions, and incompatible versions. It does not replace testing against two current Spotify desktop clients with Spicetify installed.

GitHub Actions runs the same suite automatically for pushes to `main` and for pull requests.

## Troubleshooting

If the button is missing, run `spicetify apply` and restart Spotify. If a peer connection fails, try a different network or check that the firewall permits WebRTC/UDP traffic.

## License

[MIT](LICENSE)
