// SpotifyP2P - Listen Together Extension
// P2P WebRTC-based real-time sync for Spicetify

(function() {
    'use strict';

    const STUN_SERVERS = {
        iceServers: [
            { urls: 'stun:stun.l.google.com:19302' },
            { urls: 'stun:stun1.l.google.com:19302' }
        ]
    };

    const DRIFT_THRESHOLD = 500;
    const HEARTBEAT_INTERVAL = 1000;

    let isHost = false;
    let isGuest = false;
    let hostPC = null;
    let guestPC = null;
    let dataChannel = null;
    let remoteProfile = null;
    let heartbeatInterval = null;
    let pendingGuests = new Map();

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
        return btoa(JSON.stringify(obj));
    }

    function decode(str) {
        return JSON.parse(atob(str));
    }

    function getPlayerState() {
        const p = Spicetify.Player;
        if (!p) return null;
        return {
            playing: p.isPlaying(),
            pos: p.getPosition(),
            uri: p.data?.item?.uri || null,
            ts: Date.now()
        };
    }

    function applyState(state) {
        const p = Spicetify.Player;
        if (!p || !state) return;

        if (state.uri && p.data?.item?.uri !== state.uri) {
            Spicetify.Player.playUri(state.uri);
        }

        if (Math.abs(p.getPosition() - state.pos) > DRIFT_THRESHOLD) {
            p.seek(state.pos);
        }

        if (state.playing && !p.isPlaying()) p.play();
        else if (!state.playing && p.isPlaying()) p.pause();
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

    function loadStyles() {
        const style = document.createElement('style');
        style.textContent = `
            #spotify-p2p-container { position: fixed; top: 0; right: 0; z-index: 9999; font-family: 'Circular', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; }
            #spotify-p2p-toggle { position: fixed; bottom: 24px; right: 24px; width: 56px; height: 56px; border-radius: 50%; background: #1DB954; border: none; color: white; cursor: pointer; display: flex; align-items: center; justify-content: center; box-shadow: 0 4px 12px rgba(0,0,0,0.3); transition: transform 0.2s, background 0.2s; }
            #spotify-p2p-toggle:hover { transform: scale(1.1); background: #1ed760; }
            #spotify-p2p-panel { position: fixed; top: 0; right: 0; width: 360px; height: 100vh; background: #121212; color: white; padding: 20px; box-sizing: border-box; overflow-y: auto; box-shadow: -4px 0 20px rgba(0,0,0,0.5); transition: transform 0.3s ease; }
            #spotify-p2p-panel.hidden { transform: translateX(100%); }
            .p2p-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 24px; }
            .p2p-title { font-size: 20px; font-weight: bold; }
            .p2p-btn-icon { background: none; border: none; color: #b3b3b3; font-size: 20px; cursor: pointer; padding: 4px 8px; }
            .p2p-btn-icon:hover { color: white; }
            .p2p-subtitle { font-size: 14px; color: #b3b3b3; margin-bottom: 16px; text-align: center; }
            .p2p-btn { display: block; width: 100%; padding: 14px 24px; margin: 8px 0; border: none; border-radius: 500px; background: #282828; color: white; font-size: 14px; font-weight: bold; cursor: pointer; transition: background 0.2s, transform 0.1s; }
            .p2p-btn:hover { background: #333; }
            .p2p-btn:active { transform: scale(0.98); }
            .p2p-btn.primary { background: #1DB954; }
            .p2p-btn.primary:hover { background: #1ed760; }
            .p2p-btn.danger { background: #e74c3c; }
            .p2p-btn.danger:hover { background: #c0392b; }
            .p2p-btn:disabled { opacity: 0.5; cursor: not-allowed; }
            .p2p-code { font-size: 28px; font-weight: bold; text-align: center; padding: 20px; background: #282828; border-radius: 12px; margin-bottom: 16px; letter-spacing: 4px; font-family: monospace; word-break: break-all; line-height: 1.4; }
            .p2p-status { text-align: center; color: #1DB954; font-size: 14px; margin-bottom: 16px; }
            .p2p-status.error { color: #e74c3c; }
            .p2p-status.waiting { color: #f39c12; }
            .p2p-input { display: block; width: 100%; padding: 14px 16px; margin: 8px 0; border: 2px solid #282828; border-radius: 8px; background: #282828; color: white; font-size: 14px; font-family: monospace; box-sizing: border-box; resize: vertical; min-height: 60px; }
            .p2p-input:focus { outline: none; border-color: #1DB954; }
            .p2p-input::placeholder { color: #666; }
            .p2p-peer { display: flex; align-items: center; gap: 12px; padding: 12px; background: #282828; border-radius: 8px; margin-bottom: 8px; }
            .p2p-avatar { width: 40px; height: 40px; border-radius: 50%; object-fit: cover; background: #404040; }
            .p2p-step { background: #1a1a1a; border-radius: 8px; padding: 12px; margin: 12px 0; border-left: 3px solid #1DB954; }
            .p2p-step-title { font-weight: bold; margin-bottom: 8px; color: #1DB954; }
            .p2p-step-text { font-size: 13px; color: #b3b3b3; }
            .hidden { display: none !important; }
            .p2p-divider { border: none; border-top: 1px solid #333; margin: 16px 0; }
        `;
        document.head.appendChild(style);
    }

    function createUI() {
        const c = document.createElement('div');
        c.id = 'spotify-p2p-container';
        c.innerHTML = `
            <div id="spotify-p2p-panel" class="hidden">
                <div class="p2p-header">
                    <span class="p2p-title">SpotifyP2P</span>
                    <button id="p2p-close" class="p2p-btn-icon">✕</button>
                </div>
                <div id="p2p-content">
                    <div id="p2p-home">
                        <p class="p2p-subtitle">Listen together with friends (P2P)</p>
                        <button id="p2p-host-btn" class="p2p-btn primary">Host Session</button>
                        <button id="p2p-join-btn" class="p2p-btn">Join Session</button>
                    </div>

                    <div id="p2p-host" class="hidden">
                        <p class="p2p-subtitle">Step 1: Share this code</p>
                        <div id="p2p-host-offer" class="p2p-code">Generating...</div>
                        <button id="p2p-host-copy" class="p2p-btn">Copy Code</button>
                        <hr class="p2p-divider">
                        <p class="p2p-subtitle">Step 2: Paste guest's response</p>
                        <textarea id="p2p-host-answer" class="p2p-input" placeholder="Paste guest's answer code here..." rows="3"></textarea>
                        <button id="p2p-host-accept" class="p2p-btn primary">Accept Answer</button>
                        <hr class="p2p-divider">
                        <p id="p2p-host-status" class="p2p-status waiting">Waiting for guest...</p>
                        <div id="p2p-host-session" class="hidden">
                            <div id="p2p-host-peers"></div>
                            <button id="p2p-host-sync" class="p2p-btn">Sync Now</button>
                        </div>
                        <button id="p2p-host-leave" class="p2p-btn danger">Leave</button>
                    </div>

                    <div id="p2p-join" class="hidden">
                        <p class="p2p-subtitle">Step 1: Paste host's code</p>
                        <textarea id="p2p-join-offer" class="p2p-input" placeholder="Paste host's code here..." rows="3"></textarea>
                        <button id="p2p-join-connect" class="p2p-btn primary">Generate Response</button>
                        <hr class="p2p-divider">
                        <p class="p2p-subtitle">Step 2: Send this to host</p>
                        <div id="p2p-join-answer" class="p2p-code hidden"></div>
                        <button id="p2p-join-copy" class="p2p-btn hidden">Copy Response</button>
                        <button id="p2p-join-back" class="p2p-btn">Back</button>
                    </div>

                    <div id="p2p-session" class="hidden">
                        <p id="p2p-session-info" class="p2p-subtitle">Connected!</p>
                        <div id="p2p-peer-info"></div>
                        <button id="p2p-sync-btn" class="p2p-btn">Sync Now</button>
                        <button id="p2p-session-leave" class="p2p-btn danger">Leave</button>
                    </div>
                </div>
            </div>
            <button id="spotify-p2p-toggle">
                <svg viewBox="0 0 24 24" width="24" height="24" fill="currentColor">
                    <path d="M12 3v10.55c-.59-.34-1.27-.55-2-.55-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4V7h4V3h-6z"/>
                </svg>
            </button>
        `;
        document.body.appendChild(c);

        document.getElementById('spotify-p2p-toggle').onclick = () => document.getElementById('spotify-p2p-panel').classList.toggle('hidden');
        document.getElementById('p2p-close').onclick = () => document.getElementById('spotify-p2p-panel').classList.add('hidden');
        document.getElementById('p2p-host-btn').onclick = startHost;
        document.getElementById('p2p-join-btn').onclick = showJoin;
        document.getElementById('p2p-host-copy').onclick = copyHostOffer;
        document.getElementById('p2p-host-accept').onclick = acceptAnswer;
        document.getElementById('p2p-host-leave').onclick = leave;
        document.getElementById('p2p-join-connect').onclick = generateAnswer;
        document.getElementById('p2p-join-copy').onclick = copyJoinAnswer;
        document.getElementById('p2p-join-back').onclick = showHome;
        document.getElementById('p2p-sync-btn').onclick = manualSync;
        document.getElementById('p2p-session-leave').onclick = leave;
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

    function setHostStatus(text, type = '') {
        const el = document.getElementById('p2p-host-status');
        el.textContent = text;
        el.className = 'p2p-status ' + type;
    }

    async function startHost() {
        isHost = true;
        isGuest = false;

        hostPC = new RTCPeerConnection(STUN_SERVERS);

        hostPC.onicecandidate = (e) => {
            if (e.candidate && e.candidate.candidate) {
                updateHostOffer();
            }
        };

        hostPC.onconnectionstatechange = () => {
            if (hostPC.connectionState === 'connected') {
                setHostStatus('Connected!', '');
                document.getElementById('p2p-host-session').classList.remove('hidden');
            } else if (hostPC.connectionState === 'disconnected' || hostPC.connectionState === 'failed') {
                setHostStatus('Guest disconnected', 'error');
                document.getElementById('p2p-host-session').classList.add('hidden');
            }
        };

        const offer = await hostPC.createOffer();
        await hostPC.setLocalDescription(offer);

        setTimeout(() => updateHostOffer(), 500);

        showHostView();
    }

    function updateHostOffer() {
        if (!hostPC || !hostPC.localDescription) return;
        const encoded = encode(hostPC.localDescription);
        document.getElementById('p2p-host-offer').textContent = encoded;
    }

    function copyHostOffer() {
        const text = document.getElementById('p2p-host-offer').textContent;
        navigator.clipboard.writeText(text).then(() => {
            const btn = document.getElementById('p2p-host-copy');
            btn.textContent = 'Copied!';
            setTimeout(() => btn.textContent = 'Copy Code', 2000);
        });
    }

    async function acceptAnswer() {
        const input = document.getElementById('p2p-host-answer');
        const text = input.value.trim();
        if (!text) return;

        try {
            const answer = decode(text);
            await hostPC.setRemoteDescription(answer);
            setHostStatus('Connecting...', '');

            hostPC.ondatachannel = (e) => {
                setupDataChannel(e.channel, true);
            };

            input.value = '';
        } catch (err) {
            setHostStatus('Invalid answer code', 'error');
        }
    }

    function setupDataChannel(channel, isHostSide) {
        dataChannel = channel;

        channel.onopen = () => {
            console.log('SpotifyP2P: Data channel open');
            const profile = getProfile();
            sendData({ type: 'profile', profile });

            if (isHost) {
                startHeartbeat();
                broadcastState();
            } else {
                showSessionView();
            }
        };

        channel.onmessage = (e) => {
            const data = JSON.parse(e.data);
            if (isHost) handleHostMessage(data);
            else handleGuestMessage(data);
        };

        channel.onclose = () => {
            console.log('SpotifyP2P: Data channel closed');
            stopHeartbeat();
            if (!isHost) showHome();
        };
    }

    function handleHostMessage(data) {
        switch (data.type) {
            case 'profile':
                remoteProfile = data.profile;
                updatePeerDisplay();
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
                updatePeerDisplay();
                break;
        }
    }

    function updatePeerDisplay() {
        const el = document.getElementById('p2p-peer-info');
        if (!el || !remoteProfile) return;
        el.innerHTML = `
            <div class="p2p-peer">
                ${remoteProfile.image ? `<img src="${remoteProfile.image}" class="p2p-avatar">` : '<div class="p2p-avatar"></div>'}
                <span>${remoteProfile.name}</span>
            </div>
        `;
    }

    async function generateAnswer() {
        const input = document.getElementById('p2p-join-offer');
        const text = input.value.trim();
        if (!text) return;

        try {
            isGuest = true;
            isHost = false;

            guestPC = new RTCPeerConnection(STUN_SERVERS);

            guestPC.onconnectionstatechange = () => {
                if (guestPC.connectionState === 'disconnected' || guestPC.connectionState === 'failed') {
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

            setTimeout(() => {
                const encoded = encode(guestPC.localDescription);
                document.getElementById('p2p-join-answer').textContent = encoded;
                document.getElementById('p2p-join-answer').classList.remove('hidden');
                document.getElementById('p2p-join-copy').classList.remove('hidden');
            }, 500);

        } catch (err) {
            console.error('SpotifyP2P: Failed to create answer', err);
            alert('Invalid host code. Make sure you copied the entire code.');
        }
    }

    function copyJoinAnswer() {
        const text = document.getElementById('p2p-join-answer').textContent;
        navigator.clipboard.writeText(text).then(() => {
            const btn = document.getElementById('p2p-join-copy');
            btn.textContent = 'Copied!';
            setTimeout(() => btn.textContent = 'Copy Response', 2000);
        });
    }

    function manualSync() {
        if (isHost) broadcastState();
        else sendData({ type: 'request-sync' });
    }

    function leave() {
        stopHeartbeat();
        if (dataChannel) dataChannel.close();
        if (hostPC) hostPC.close();
        if (guestPC) guestPC.close();
        dataChannel = null;
        hostPC = null;
        guestPC = null;
        remoteProfile = null;
        isHost = false;
        isGuest = false;
        showHome();

        document.getElementById('p2p-host-session')?.classList.add('hidden');
        document.getElementById('p2p-host-offer').textContent = 'Generating...';
        document.getElementById('p2p-host-answer').value = '';
        document.getElementById('p2p-join-offer').value = '';
        document.getElementById('p2p-join-answer').textContent = '';
        document.getElementById('p2p-join-answer').classList.add('hidden');
        document.getElementById('p2p-join-copy').classList.add('hidden');
        setHostStatus('Waiting for guest...', 'waiting');
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
        console.log('SpotifyP2P: Extension loaded');
    }

    init();
})();