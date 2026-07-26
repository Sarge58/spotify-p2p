# SpotifyP2P

Listen to Spotify with a friend in sync, directly from the Spotify desktop app.

SpotifyP2P is a [Spicetify](https://spicetify.app/) extension that uses WebRTC to create a direct peer-to-peer connection. The host controls playback and broadcasts playback state so guests stay aligned.

![SpotifyP2P preview](assets/preview.svg)

## What it does

- Adds a native-looking P2P button immediately to the left of Spotify's **What's New** button.
- Connects two Spotify desktop clients with WebRTC and public STUN servers.
- Synchronizes play, pause, track changes, seek position, and periodic host-state heartbeats.
- Provides manual re-sync and automatic correction when playback drifts.
- Keeps session signaling manual: exchange the generated offer and answer codes with your friend.

## Install

### Spicetify Marketplace

Once Marketplace has indexed this repository, search for **SpotifyP2P** and install it from the Extensions tab.

### Manual installation

1. Download [extension.js](extension.js).
2. Copy it into your Spicetify Extensions folder:

   ```text
   ~/.config/spicetify/Extensions/
   ```

3. Apply it:

   ```bash
   spicetify config extensions extension.js
   spicetify apply
   ```

## Start a session

1. Click the SpotifyP2P button beside **What's New**.
2. One person selects **Host Session**, then copies the generated offer code.
3. The guest pastes that offer into **Join Session**, generates a response, and sends the response back.
4. The host pastes the response and accepts it. The session starts when the connection status becomes connected.

## Notes and limitations

- Each person needs Spotify desktop with Spicetify and access to the same music in their own Spotify account.
- SpotifyP2P uses direct WebRTC data channels. It has no relay server, so restrictive firewalls or symmetric NATs can prevent a connection.
- Google public STUN servers help peers find each other. The extension does not host or proxy your Spotify credentials or audio.
- This is playback synchronization, not shared audio streaming.

## Troubleshooting

If the button is missing, run `spicetify apply` and restart Spotify. If a peer connection fails, try a different network or check that the firewall permits WebRTC/UDP traffic.

## License

[MIT](LICENSE)
