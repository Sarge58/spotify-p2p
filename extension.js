// SpotifyP2P - Listen Together Extension
// P2P WebRTC-based real-time sync for Spicetify

(function() {
    'use strict';

    const EXTENSION_KEY = '__spotifyP2P';
    window[EXTENSION_KEY]?.dispose?.();

    const STUN_SERVERS = {
        iceServers: [
            { urls: 'stun:stun.l.google.com:19302' },
            { urls: 'stun:stun1.l.google.com:19302' }
        ]
    };
    const DRIFT_THRESHOLD = 500;
    const HEARTBEAT_INTERVAL = 1000;
    const RECONNECT_INTERVAL = 3000;
    const TOAST_DURATION = 3000;

    let isHost = false;
    let isGuest = false;
    let hostPC = null;
    let guestPC = null;
    let dataChannel = null;
    let remoteProfile = null;
    let heartbeatInterval = null;
    let reconnectTimer = null;
    let connectionState = 'disconnected';
    let topbarObserver = null;

    // ── Helpers ──

    function getProfile() {
        try {
            const user = Spicetify.Platform?.User || Spicetify.User;
            if (user) {
                return {
                    name: user.displayName || user.name || 'Unknown',
                    image: user.image || null,
                    uri: user.uri || null
                };
            }
        } catch(e) {}
        return { name: 'Unknown', image: null, uri: null };
    }

    function encode(obj) {
        const bytes = new TextEncoder().encode(JSON.stringify(obj));
        let binary = '';
        const chunkSize = 0x8000;
        for (let start = 0; start < bytes.length; start += chunkSize) {
            binary += String.fromCharCode(...bytes.subarray(start, start + chunkSize));
        }
        return btoa(binary);
    }

    function decode(str) {
        const binary = atob(str);
        const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
        return JSON.parse(new TextDecoder().decode(bytes));
    }

    function getPlayerState() {
        const p = Spicetify.Player;
        if (!p) return null;
        const track = p.data?.item;
        return {
            playing: p.isPlaying(),
            pos: p.getPosition(),
            uri: track?.uri || null,
            name: track?.name || null,
            artist: track?.artists?.map(a => a.name).join(', ') || null,
            image: track?.album?.uri || null,
            ts: Date.now()
        };
    }

    async function applyState(state) {
        const p = Spicetify.Player;
        if (!p || !state) return;

        if (state.uri && p.data?.item?.uri !== state.uri) {
            await Spicetify.Player.playUri(state.uri);
            await new Promise(r => setTimeout(r, 300));
        }

        if (Math.abs(p.getPosition() - state.pos) > DRIFT_THRESHOLD) {
            p.seek(state.pos);
        }

        if (state.playing && !p.isPlaying()) p.play();
        else if (!state.playing && p.isPlaying()) p.pause();

        updateNowPlaying(state);
    }

    function sendData(data) {
        if (dataChannel && dataChannel.readyState === 'open') {
            dataChannel.send(JSON.stringify(data));
        }
    }

    function broadcastState() {
        const state = getPlayerState();
        if (state) sendData({ type: 'sync', state });
    }

    function startHeartbeat() {
        stopHeartbeat();
        heartbeatInterval = setInterval(() => {
            if (isHost) broadcastState();
        }, HEARTBEAT_INTERVAL);
    }

    function stopHeartbeat() {
        if (heartbeatInterval) {
            clearInterval(heartbeatInterval);
            heartbeatInterval = null;
        }
    }

    // ── Toast Notifications ──

    function showToast(message, type = 'info') {
        const existing = document.getElementById('p2p-toast');
        if (existing) existing.remove();

        const toast = document.createElement('div');
        toast.id = 'p2p-toast';
        toast.className = `p2p-toast p2p-toast-${type}`;
        toast.textContent = message;
        document.body.appendChild(toast);

        requestAnimationFrame(() => toast.classList.add('p2p-toast-show'));
        setTimeout(() => {
            toast.classList.remove('p2p-toast-show');
            setTimeout(() => toast.remove(), 300);
        }, TOAST_DURATION);
    }

    // ── Connection State ──

    function setConnectionState(state) {
        connectionState = state;
        const el = document.getElementById('p2p-connection-dot');
        const label = document.getElementById('p2p-connection-label');
        if (!el || !label) return;

        el.className = 'p2p-dot';
        switch (state) {
            case 'connected':
                el.classList.add('p2p-dot-connected');
                label.textContent = 'Connected';
                break;
            case 'connecting':
                el.classList.add('p2p-dot-connecting');
                label.textContent = 'Connecting...';
                break;
            case 'reconnecting':
                el.classList.add('p2p-dot-connecting');
                label.textContent = 'Reconnecting...';
                break;
            case 'disconnected':
                el.classList.add('p2p-dot-disconnected');
                label.textContent = 'Disconnected';
                break;
        }
    }

    // ── Now Playing ──

    function updateNowPlaying(state) {
        const el = document.getElementById('p2p-now-playing');
        if (!el || !state) return;

        if (state.name) {
            el.innerHTML = `
                <div class="p2p-track">
                    <div class="p2p-track-info">
                        <div class="p2p-track-name">${escapeHtml(state.name)}</div>
                        <div class="p2p-track-artist">${escapeHtml(state.artist || 'Unknown')}</div>
                    </div>
                </div>
            `;
            el.classList.remove('hidden');
        } else {
            el.classList.add('hidden');
        }
    }

    function escapeHtml(str) {
        const div = document.createElement('div');
        div.textContent = str;
        return div.innerHTML;
    }

    // ── Styles ──

    function loadStyles() {
        document.getElementById('spotify-p2p-styles')?.remove();
        const style = document.createElement('style');
        style.id = 'spotify-p2p-styles';
        style.textContent = `
            #spotify-p2p-container {
                position: fixed; top: 0; right: 0; z-index: 9999;
                font-family: 'Circular', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            }

            #spotify-p2p-container svg { display: block; }

            #spotify-p2p-panel {
                position: fixed; top: 0; right: 0;
                width: 360px; height: 100vh;
                background: #121212; color: white;
                padding: 0; box-sizing: border-box;
                overflow-y: auto;
                box-shadow: -4px 0 20px rgba(0,0,0,0.5);
                transform: translateX(100%);
                transition: transform 0.3s cubic-bezier(0.4, 0, 0.2, 1);
            }
            #spotify-p2p-panel.open { transform: translateX(0); }

            .p2p-panel-inner { padding: 20px; }

            .p2p-header {
                display: flex; justify-content: space-between; align-items: center;
                padding: 16px 20px; border-bottom: 1px solid #282828;
            }
            .p2p-title { font-size: 18px; font-weight: bold; }

            .p2p-btn-icon {
                background: none; border: none; color: #b3b3b3;
                font-size: 20px; cursor: pointer; padding: 4px 8px;
                border-radius: 50%; transition: color 0.2s, background 0.2s;
            }
            .p2p-btn-icon:hover { color: white; background: rgba(255,255,255,0.1); }

            .p2p-subtitle {
                font-size: 13px; color: #b3b3b3;
                margin-bottom: 12px; text-align: center;
                text-transform: uppercase; letter-spacing: 1px;
            }

            .p2p-btn {
                display: block; width: 100%;
                padding: 14px 24px; margin: 8px 0;
                border: none; border-radius: 500px;
                background: #282828; color: white;
                font-size: 14px; font-weight: bold;
                cursor: pointer; text-align: center;
                transition: background 0.2s, transform 0.1s;
            }
            .p2p-btn:hover { background: #3e3e3e; }
            .p2p-btn:active { transform: scale(0.98); }
            .p2p-btn.primary { background: #1DB954; color: #000; }
            .p2p-btn.primary:hover { background: #1ed760; }
            .p2p-btn.danger { background: transparent; border: 1px solid #e74c3c; color: #e74c3c; }
            .p2p-btn.danger:hover { background: #e74c3c; color: white; }
            .p2p-btn:disabled { opacity: 0.5; cursor: not-allowed; }

            .p2p-code {
                font-size: 14px; font-weight: 500; text-align: center;
                padding: 16px; background: #1a1a1a; border: 1px solid #333;
                border-radius: 8px; margin-bottom: 12px;
                font-family: monospace; word-break: break-all;
                line-height: 1.6; color: #e0e0e0; max-height: 120px;
                overflow-y: auto; user-select: all; cursor: text;
            }

            .p2p-status { text-align: center; font-size: 13px; margin: 12px 0; }
            .p2p-status.ok { color: #1DB954; }
            .p2p-status.error { color: #e74c3c; }
            .p2p-status.waiting { color: #f39c12; }

            .p2p-input {
                display: block; width: 100%;
                padding: 12px 14px; margin: 8px 0;
                border: 2px solid #333; border-radius: 8px;
                background: #1a1a1a; color: white;
                font-size: 13px; font-family: monospace;
                box-sizing: border-box; resize: vertical;
                min-height: 80px; transition: border-color 0.2s;
            }
            .p2p-input:focus { outline: none; border-color: #1DB954; }
            .p2p-input::placeholder { color: #555; }
            .p2p-input.error { border-color: #e74c3c; }

            .p2p-peer {
                display: flex; align-items: center; gap: 12px;
                padding: 10px 12px; background: #1a1a1a;
                border-radius: 8px; margin-bottom: 6px;
                border: 1px solid #282828;
            }
            .p2p-avatar {
                width: 36px; height: 36px; border-radius: 50%;
                object-fit: cover; background: #404040; flex-shrink: 0;
            }
            .p2p-peer-name { font-size: 14px; font-weight: 500; }

            .p2p-divider { border: none; border-top: 1px solid #282828; margin: 16px 0; }

            .p2p-track {
                display: flex; align-items: center; gap: 12px;
                padding: 12px; background: #1a1a1a;
                border-radius: 8px; margin-bottom: 8px;
                border: 1px solid #1DB954;
            }
            .p2p-track-info { flex: 1; min-width: 0; }
            .p2p-track-name {
                font-size: 14px; font-weight: 600; color: white;
                white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
            }
            .p2p-track-artist {
                font-size: 12px; color: #b3b3b3;
                white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
            }

            .p2p-step {
                display: flex; align-items: center; gap: 10px;
                margin-bottom: 16px;
            }
            .p2p-step-num {
                width: 28px; height: 28px; border-radius: 50%;
                background: #1DB954; color: #000; font-weight: bold;
                display: flex; align-items: center; justify-content: center;
                font-size: 13px; flex-shrink: 0;
            }
            .p2p-step-text { font-size: 14px; color: #e0e0e0; }

            .p2p-connection {
                display: flex; align-items: center; gap: 8px;
                justify-content: center; margin: 8px 0 16px;
            }
            .p2p-dot {
                width: 8px; height: 8px; border-radius: 50%;
                transition: background 0.3s;
            }
            .p2p-dot-connected { background: #1DB954; }
            .p2p-dot-connecting { background: #f39c12; animation: p2p-blink 1s infinite; }
            .p2p-dot-disconnected { background: #666; }
            @keyframes p2p-blink { 0%, 100% { opacity: 1; } 50% { opacity: 0.3; } }
            .p2p-connection-label { font-size: 12px; color: #b3b3b3; }

            .hidden { display: none !important; }

            .p2p-toast {
                position: fixed; bottom: 90px; right: 24px;
                padding: 12px 20px; border-radius: 8px;
                background: #282828; color: white;
                font-size: 13px; font-weight: 500;
                box-shadow: 0 4px 16px rgba(0,0,0,0.4);
                transform: translateY(10px); opacity: 0;
                transition: transform 0.3s, opacity 0.3s;
                z-index: 10000; max-width: 300px;
                border-left: 3px solid #1DB954;
            }
            .p2p-toast-show { transform: translateY(0); opacity: 1; }
            .p2p-toast-error { border-left-color: #e74c3c; }
            .p2p-toast-warning { border-left-color: #f39c12; }
        `;
        document.head.appendChild(style);
    }

    // ── UI ──

    function createUI() {
        document.getElementById('spotify-p2p-container')?.remove();
        const c = document.createElement('div');
        c.id = 'spotify-p2p-container';
        c.innerHTML = `
            <div id="spotify-p2p-panel">
                <div class="p2p-header">
                    <span class="p2p-title">SpotifyP2P</span>
                    <button id="p2p-close" class="p2p-btn-icon">✕</button>
                </div>
                <div class="p2p-panel-inner">
                    <div id="p2p-home">
                        <p class="p2p-subtitle">Listen together with friends</p>
                        <p style="text-align:center;color:#666;font-size:12px;margin-bottom:20px;">Peer-to-peer · No server required</p>
                        <button id="p2p-host-btn" class="p2p-btn primary">Host Session</button>
                        <button id="p2p-join-btn" class="p2p-btn">Join Session</button>
                    </div>

                    <div id="p2p-host" class="hidden">
                        <div id="p2p-connection" class="p2p-connection">
                            <div id="p2p-connection-dot" class="p2p-dot p2p-dot-connecting"></div>
                            <span id="p2p-connection-label" class="p2p-connection-label">Waiting for guest...</span>
                        </div>

                        <div class="p2p-step">
                            <div class="p2p-step-num">1</div>
                            <div class="p2p-step-text">Copy this code and send it to your friend</div>
                        </div>
                        <div id="p2p-host-offer" class="p2p-code">Generating...</div>
                        <button id="p2p-host-copy" class="p2p-btn">Copy Code</button>

                        <hr class="p2p-divider">

                        <div class="p2p-step">
                            <div class="p2p-step-num">2</div>
                            <div class="p2p-step-text">Paste their response code below</div>
                        </div>
                        <textarea id="p2p-host-answer" class="p2p-input" placeholder="Paste guest's response code here..." rows="3"></textarea>
                        <button id="p2p-host-accept" class="p2p-btn primary">Accept Answer</button>

                        <div id="p2p-host-session" class="hidden">
                            <hr class="p2p-divider">
                            <div id="p2p-host-now-playing" class="p2p-now-playing-host"></div>
                            <div id="p2p-host-guests"></div>
                            <button id="p2p-host-sync" class="p2p-btn">Sync Now</button>
                        </div>

                        <hr class="p2p-divider">
                        <button id="p2p-host-leave" class="p2p-btn danger">Leave Session</button>
                    </div>

                    <div id="p2p-join" class="hidden">
                        <div class="p2p-step">
                            <div class="p2p-step-num">1</div>
                            <div class="p2p-step-text">Paste the host's code below</div>
                        </div>
                        <textarea id="p2p-join-offer" class="p2p-input" placeholder="Paste host's code here..." rows="3"></textarea>
                        <button id="p2p-join-connect" class="p2p-btn primary">Generate Response</button>

                        <hr class="p2p-divider">

                        <div class="p2p-step">
                            <div class="p2p-step-num">2</div>
                            <div class="p2p-step-text">Copy this response and send it to the host</div>
                        </div>
                        <div id="p2p-join-answer" class="p2p-code hidden"></div>
                        <button id="p2p-join-copy" class="p2p-btn hidden">Copy Response</button>

                        <div id="p2p-join-error" class="hidden" style="margin-top:12px;">
                            <p class="p2p-status error" id="p2p-join-error-text"></p>
                        </div>

                        <hr class="p2p-divider">
                        <button id="p2p-join-back" class="p2p-btn danger">Back</button>
                    </div>

                    <div id="p2p-session" class="hidden">
                        <div id="p2p-connection2" class="p2p-connection">
                            <div id="p2p-connection-dot2" class="p2p-dot p2p-dot-connected"></div>
                            <span id="p2p-connection-label2" class="p2p-connection-label">Connected to host</span>
                        </div>

                        <div id="p2p-now-playing" class="hidden"></div>

                        <div id="p2p-peer-info"></div>

                        <hr class="p2p-divider">
                        <button id="p2p-sync-btn" class="p2p-btn">Sync Now</button>
                        <button id="p2p-session-leave" class="p2p-btn danger">Leave Session</button>
                    </div>
                </div>
            </div>

        `;
        document.body.appendChild(c);

        document.getElementById('p2p-close').onclick = togglePanel;
        document.getElementById('p2p-host-btn').onclick = startHost;
        document.getElementById('p2p-join-btn').onclick = showJoinView;
        document.getElementById('p2p-host-copy').onclick = copyHostOffer;
        document.getElementById('p2p-host-accept').onclick = acceptAnswer;
        document.getElementById('p2p-host-leave').onclick = leave;
        document.getElementById('p2p-host-sync').onclick = manualSync;
        document.getElementById('p2p-join-connect').onclick = generateAnswer;
        document.getElementById('p2p-join-copy').onclick = copyJoinAnswer;
        document.getElementById('p2p-join-back').onclick = showHome;
        document.getElementById('p2p-sync-btn').onclick = manualSync;
        document.getElementById('p2p-session-leave').onclick = leave;
    }

    function togglePanel() {
        document.getElementById('spotify-p2p-panel').classList.toggle('open');
    }

    function showHome() {
        document.getElementById('p2p-home').classList.remove('hidden');
        document.getElementById('p2p-host').classList.add('hidden');
        document.getElementById('p2p-join').classList.add('hidden');
        document.getElementById('p2p-session').classList.add('hidden');
    }

    function showHostView() {
        document.getElementById('p2p-home').classList.add('hidden');
        document.getElementById('p2p-host').classList.remove('hidden');
        document.getElementById('p2p-join').classList.add('hidden');
        document.getElementById('p2p-session').classList.add('hidden');
    }

    function showJoinView() {
        document.getElementById('p2p-home').classList.add('hidden');
        document.getElementById('p2p-host').classList.add('hidden');
        document.getElementById('p2p-join').classList.remove('hidden');
        document.getElementById('p2p-session').classList.add('hidden');
    }

    function showSessionView() {
        document.getElementById('p2p-home').classList.add('hidden');
        document.getElementById('p2p-host').classList.add('hidden');
        document.getElementById('p2p-join').classList.add('hidden');
        document.getElementById('p2p-session').classList.remove('hidden');
    }

    // ── Host ──

    async function startHost() {
        isHost = true;
        isGuest = false;

        hostPC = new RTCPeerConnection(STUN_SERVERS);

        hostPC.onicecandidate = () => {};

        hostPC.onicegatheringstatechange = () => {
            if (hostPC.iceGatheringState === 'complete') {
                updateHostOffer();
            }
        };

        hostPC.onconnectionstatechange = () => {
            const state = hostPC.connectionState;
            if (state === 'connected') {
                setConnectionState('connected');
                document.getElementById('p2p-host-session').classList.remove('hidden');
                showToast('Guest connected!', 'info');
            } else if (state === 'disconnected' || state === 'failed') {
                setConnectionState('disconnected');
                document.getElementById('p2p-host-session').classList.add('hidden');
                showToast('Guest disconnected', 'error');
                scheduleReconnect();
            } else if (state === 'connecting') {
                setConnectionState('connecting');
            }
        };

        hostPC.ondatachannel = (e) => {
            setupDataChannel(e.channel, true);
        };

        const offer = await hostPC.createOffer();
        await hostPC.setLocalDescription(offer);

        showHostView();
        setConnectionState('connecting');
    }

    function updateHostOffer() {
        if (!hostPC || !hostPC.localDescription) return;
        const encoded = encode(hostPC.localDescription);
        const el = document.getElementById('p2p-host-offer');
        el.textContent = encoded;
        el.title = 'Click to select all';
        el.onclick = () => {
            const range = document.createRange();
            range.selectNodeContents(el);
            window.getSelection().removeAllRanges();
            window.getSelection().addRange(range);
        };
    }

    function copyHostOffer() {
        const text = document.getElementById('p2p-host-offer').textContent;
        navigator.clipboard.writeText(text).then(() => {
            const btn = document.getElementById('p2p-host-copy');
            btn.textContent = 'Copied!';
            setTimeout(() => btn.textContent = 'Copy Code', 2000);
        }).catch(() => {
            showToast('Failed to copy — try selecting manually', 'error');
        });
    }

    async function acceptAnswer() {
        const input = document.getElementById('p2p-host-answer');
        const text = input.value.trim();
        if (!text) {
            input.classList.add('error');
            setTimeout(() => input.classList.remove('error'), 1500);
            return;
        }

        try {
            const answer = decode(text);
            await hostPC.setRemoteDescription(answer);
            setConnectionState('connecting');
            input.value = '';
            input.classList.remove('error');
        } catch (err) {
            console.error('SpotifyP2P:', err);
            input.classList.add('error');
            setTimeout(() => input.classList.remove('error'), 1500);
            showToast('Invalid response code', 'error');
        }
    }

    // ── Guest ──

    async function generateAnswer() {
        const input = document.getElementById('p2p-join-offer');
        const text = input.value.trim();
        if (!text) {
            input.classList.add('error');
            setTimeout(() => input.classList.remove('error'), 1500);
            return;
        }

        const errorEl = document.getElementById('p2p-join-error');
        const errorText = document.getElementById('p2p-join-error-text');
        errorEl.classList.add('hidden');

        try {
            isGuest = true;
            isHost = false;

            guestPC = new RTCPeerConnection(STUN_SERVERS);

            guestPC.onconnectionstatechange = () => {
                const state = guestPC.connectionState;
                if (state === 'disconnected' || state === 'failed') {
                    showToast('Disconnected from host', 'error');
                    showHome();
                }
            };

            guestPC.ondatachannel = (e) => {
                setupDataChannel(e.channel, false);
            };

            const offer = decode(text);
            await guestPC.setRemoteDescription(offer);

            const answer = await guestPC.createAnswer();
            await guestPC.setLocalDescription(answer);

            await new Promise((resolve) => {
                if (guestPC.iceGatheringState === 'complete') { resolve(); return; }
                const check = () => {
                    if (guestPC.iceGatheringState === 'complete') { resolve(); return; }
                    setTimeout(check, 100);
                };
                check();
            });

            const encoded = encode(guestPC.localDescription);
            document.getElementById('p2p-join-answer').textContent = encoded;
            document.getElementById('p2p-join-answer').classList.remove('hidden');
            document.getElementById('p2p-join-copy').classList.remove('hidden');
            input.classList.remove('error');

            document.getElementById('p2p-join-copy').onclick = copyJoinAnswer;

        } catch (err) {
            console.error('SpotifyP2P:', err);
            input.classList.add('error');
            setTimeout(() => input.classList.remove('error'), 1500);
            errorText.textContent = 'Invalid host code. Make sure you copied the entire code.';
            errorEl.classList.remove('hidden');
        }
    }

    function copyJoinAnswer() {
        const text = document.getElementById('p2p-join-answer').textContent;
        navigator.clipboard.writeText(text).then(() => {
            const btn = document.getElementById('p2p-join-copy');
            btn.textContent = 'Copied!';
            setTimeout(() => btn.textContent = 'Copy Response', 2000);
        }).catch(() => {
            showToast('Failed to copy — try selecting manually', 'error');
        });
    }

    // ── Data Channel ──

    function setupDataChannel(channel, hostSide) {
        dataChannel = channel;

        channel.onopen = () => {
            console.log('SpotifyP2P: Channel open');
            sendData({ type: 'profile', profile: getProfile() });

            if (isHost) {
                setConnectionState('connected');
                startHeartbeat();
                broadcastState();
            } else {
                setConnectionState('connected');
                showSessionView();
            }
        };

        channel.onmessage = (e) => {
            try {
                const data = JSON.parse(e.data);
                if (isHost) handleHostMessage(data);
                else handleGuestMessage(data);
            } catch(err) {
                console.error('SpotifyP2P: Bad message', err);
            }
        };

        channel.onclose = () => {
            console.log('SpotifyP2P: Channel closed');
            stopHeartbeat();
            setConnectionState('disconnected');
            if (!isHost) {
                showToast('Disconnected from host', 'error');
                showHome();
            } else {
                showToast('Guest disconnected', 'error');
                document.getElementById('p2p-host-session').classList.add('hidden');
            }
        };

        channel.onerror = (e) => {
            console.error('SpotifyP2P: Channel error', e);
        };
    }

    function handleHostMessage(data) {
        switch (data.type) {
            case 'profile':
                remoteProfile = data.profile;
                updateGuestDisplay();
                showToast(`${data.profile.name} joined`, 'info');
                break;
            case 'control':
                if (data.action === 'play') Spicetify.Player.play();
                else if (data.action === 'pause') Spicetify.Player.pause();
                else if (data.action === 'next') Spicetify.Player.next();
                else if (data.action === 'prev') Spicetify.Player.back();
                else if (data.action === 'seek') Spicetify.Player.seek(data.pos);
                setTimeout(broadcastState, 100);
                break;
            case 'request-sync':
                broadcastState();
                break;
        }
    }

    function handleGuestMessage(data) {
        switch (data.type) {
            case 'sync':
                applyState(data.state);
                break;
            case 'profile':
                remoteProfile = data.profile;
                updateGuestDisplay();
                break;
        }
    }

    function updateGuestDisplay() {
        const el = document.getElementById('p2p-peer-info');
        if (!el || !remoteProfile) return;
        el.innerHTML = `
            <div class="p2p-peer">
                ${remoteProfile.image ? `<img src="${remoteProfile.image}" class="p2p-avatar">` : '<div class="p2p-avatar"></div>'}
                <span class="p2p-peer-name">${escapeHtml(remoteProfile.name)}</span>
            </div>
        `;
    }

    // ── Reconnection ──

    function scheduleReconnect() {
        if (reconnectTimer) return;
        setConnectionState('reconnecting');
        reconnectTimer = setTimeout(() => {
            reconnectTimer = null;
            if (isHost && hostPC) {
                showToast('Attempting to reconnect...', 'warning');
            }
        }, RECONNECT_INTERVAL);
    }

    // ── Sync ──

    function manualSync() {
        if (isHost) {
            broadcastState();
            showToast('Synced all listeners', 'info');
        } else {
            sendData({ type: 'request-sync' });
            showToast('Sync requested', 'info');
        }
    }

    // ── Leave ──

    function leave() {
        stopHeartbeat();
        if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
        if (dataChannel) { try { dataChannel.close(); } catch(e) {} }
        if (hostPC) { try { hostPC.close(); } catch(e) {} }
        if (guestPC) { try { guestPC.close(); } catch(e) {} }
        dataChannel = null;
        hostPC = null;
        guestPC = null;
        remoteProfile = null;
        isHost = false;
        isGuest = false;
        setConnectionState('disconnected');
        if (!document.getElementById('spotify-p2p-container')) return;
        showHome();

        document.getElementById('p2p-host-session')?.classList.add('hidden');
        document.getElementById('p2p-host-offer').textContent = 'Generating...';
        document.getElementById('p2p-host-answer').value = '';
        document.getElementById('p2p-join-offer').value = '';
        document.getElementById('p2p-join-answer').textContent = '';
        document.getElementById('p2p-join-answer').classList.add('hidden');
        document.getElementById('p2p-join-copy').classList.add('hidden');
        document.getElementById('p2p-join-error').classList.add('hidden');
        document.getElementById('p2p-now-playing').classList.add('hidden');
        document.getElementById('p2p-peer-info').innerHTML = '';
    }

    // ── Init ──

    function findWhatsNewButton() {
        return [...document.querySelectorAll('button')].find((button) => {
            const accessibleName = [
                button.getAttribute('aria-label'),
                button.getAttribute('data-testid'),
                button.textContent
            ].filter(Boolean).join(' ').toLowerCase();
            return /what'?s\s+new|whats\s+new/.test(accessibleName);
        }) || null;
    }

    function createTopbarButton(whatsNew) {
        const button = whatsNew.cloneNode(true);
        button.id = 'spotify-p2p-topbar-toggle';
        button.removeAttribute('data-testid');
        button.removeAttribute('title');
        button.setAttribute('aria-label', 'SpotifyP2P');
        button.setAttribute('data-tooltip', 'SpotifyP2P');
        button.disabled = false;
        button.querySelectorAll('[id]').forEach((element) => element.removeAttribute('id'));
        button.innerHTML = '<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden="true"><path d="M12 3v10.55c-.59-.34-1.27-.55-2-.55-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4V7h4V3h-6z"/></svg>';
        button.addEventListener('click', togglePanel);
        return button;
    }

    function placeBeforeWhatsNew() {
        const whatsNew = findWhatsNewButton();
        if (!whatsNew) return false;

        const parent = whatsNew.parentElement;
        if (!parent) return false;

        const button = document.getElementById('spotify-p2p-topbar-toggle') || createTopbarButton(whatsNew);
        if (button.parentElement === parent && button.nextElementSibling === whatsNew) return true;
        parent.insertBefore(button, whatsNew);
        return true;
    }

    function keepButtonBesideWhatsNew() {
        placeBeforeWhatsNew();
        topbarObserver?.disconnect();
        topbarObserver = new MutationObserver(() => placeBeforeWhatsNew());
        topbarObserver.observe(document.body, { childList: true, subtree: true });
    }

    function dispose() {
        leave();
        topbarObserver?.disconnect();
        topbarObserver = null;
        document.getElementById('spotify-p2p-topbar-toggle')?.remove();
        document.getElementById('spotify-p2p-container')?.remove();
        document.getElementById('spotify-p2p-styles')?.remove();
        document.getElementById('spotify-p2p-fallback-toggle')?.remove();
        document.getElementById('p2p-toast')?.remove();
    }

    function waitForSpicetify() {
        return new Promise((resolve) => {
            const check = () => {
                if (Spicetify?.Player && Spicetify?.Platform) resolve();
                else setTimeout(check, 100);
            };
            check();
        });
    }

    async function init() {
        await waitForSpicetify();
        loadStyles();
        createUI();

        keepButtonBesideWhatsNew();
        console.log('SpotifyP2P: native What\'s New-adjacent button added');

        console.log('SpotifyP2P: Extension loaded');
    }

    window[EXTENSION_KEY] = { dispose };
    init();
})();
