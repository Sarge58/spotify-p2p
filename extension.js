// SpotifyP2P - Listen Together Extension
// P2P WebRTC-based real-time sync for Spicetify

(function(root) {
    'use strict';

    const EXTENSION_KEY = '__spotifyP2P';
    const PROTOCOL_VERSION = 1;
    const isCommonJS = typeof document === 'undefined'
        && typeof module !== 'undefined'
        && module.exports;
    if (!isCommonJS) root[EXTENSION_KEY]?.dispose?.();

    const STUN_SERVERS = {
        iceServers: [
            { urls: 'stun:stun.l.google.com:19302' },
            { urls: 'stun:stun1.l.google.com:19302' }
        ],
        iceCandidatePoolSize: 2
    };
    const DRIFT_THRESHOLD = 500;
    const HEARTBEAT_INTERVAL = 1000;
    const DISCONNECT_GRACE_PERIOD = 5000;
    const TOAST_DURATION = 3000;
    const MAX_SIGNAL_LENGTH = 250000;
    const MAX_DATA_MESSAGE_LENGTH = 32768;
    const MAX_TRACK_POSITION = 24 * 60 * 60 * 1000;
    const MAX_PROFILE_NAME_LENGTH = 80;
    const MAX_METADATA_LENGTH = 500;
    const CONTROL_COOLDOWN = 150;
    const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{22}$/;
    const ALLOWED_CONTROL_ACTIONS = new Set(['play', 'pause', 'next', 'prev', 'seek']);

    let isHost = false;
    let isGuest = false;
    let hostPC = null;
    let guestPC = null;
    let dataChannel = null;
    let remoteProfile = null;
    let guestApproved = false;
    let hostApproved = false;
    let heartbeatInterval = null;
    let topbarButton = null;
    let disconnectTimer = null;
    let applyingState = false;
    let pendingState = null;
    let sessionVersion = 0;
    let lastRemoteControlAt = 0;
    let activeSessionId = null;

    // ── Helpers ──

    function getProfile() {
        try {
            const user = Spicetify.Platform?.User || Spicetify.User;
            if (user) {
                return {
                    name: user.displayName || user.name || 'Unknown',
                    image: user.image || null
                };
            }
        } catch(e) {}
        return { name: 'Unknown', image: null };
    }

    function bytesToBase64Url(bytes) {
        let binary = '';
        const chunkSize = 0x8000;
        for (let start = 0; start < bytes.length; start += chunkSize) {
            binary += String.fromCharCode(...bytes.subarray(start, start + chunkSize));
        }
        return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    }

    function base64UrlToBytes(encoded) {
        const normalized = encoded.replace(/-/g, '+').replace(/_/g, '/');
        const padded = normalized + '='.repeat((4 - normalized.length % 4) % 4);
        return Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
    }

    class ProtocolError extends Error {
        constructor(code, message) {
            super(message);
            this.name = 'ProtocolError';
            this.code = code;
        }
    }

    function assertProtocol(condition, code, message) {
        if (!condition) throw new ProtocolError(code, message);
    }

    function createSessionId(cryptoApi = globalThis.crypto) {
        const bytes = new Uint8Array(16);
        cryptoApi.getRandomValues(bytes);
        return bytesToBase64Url(bytes);
    }

    function createSignalEnvelope(description, sessionId) {
        return {
            protocol: PROTOCOL_VERSION,
            sessionId,
            description
        };
    }

    function parseSignalEnvelope(value, expectedType, expectedSessionId = null) {
        assertProtocol(isRecord(value), 'invalid-signal', 'Invalid signaling envelope');
        assertProtocol(value.protocol === PROTOCOL_VERSION, 'version-mismatch', 'Incompatible SpotifyP2P protocol');
        assertProtocol(SESSION_ID_PATTERN.test(value.sessionId), 'invalid-session', 'Invalid session identifier');
        assertProtocol(expectedSessionId === null || value.sessionId === expectedSessionId,
            'stale-session', 'This response belongs to another session');
        assertProtocol(isRecord(value.description)
            && value.description.type === expectedType
            && typeof value.description.sdp === 'string',
        'invalid-description', `Expected a WebRTC ${expectedType} description`);

        return { description: value.description, sessionId: value.sessionId };
    }

    function createPeerMessage(payload, sessionId) {
        return {
            ...payload,
            protocol: PROTOCOL_VERSION,
            sessionId
        };
    }

    const SIGNAL_ERROR_MESSAGES = Object.freeze({
        'version-mismatch': 'This code was made by an incompatible SpotifyP2P version.',
        'stale-session': 'This response belongs to an older or different session.',
        'invalid-session': 'This code has an invalid session identifier.',
        'invalid-description': 'This code does not contain the expected connection description.',
        'invalid-signal': 'This is not a valid SpotifyP2P connection code.'
    });

    function getSignalErrorMessage(error) {
        return SIGNAL_ERROR_MESSAGES[error?.code] || 'The connection code is invalid or incomplete.';
    }

    async function encode(obj) {
        const bytes = new TextEncoder().encode(JSON.stringify(obj));
        if (!globalThis.CompressionStream) return `j.${bytesToBase64Url(bytes)}`;

        try {
            const compressed = new Blob([bytes]).stream().pipeThrough(new CompressionStream('deflate-raw'));
            const output = new Uint8Array(await new Response(compressed).arrayBuffer());
            return `z.${bytesToBase64Url(output)}`;
        } catch (error) {
            console.warn('SpotifyP2P: Compression unavailable; using plain signaling', error);
            return `j.${bytesToBase64Url(bytes)}`;
        }
    }

    async function readTextWithLimit(stream, limit) {
        const reader = stream.getReader();
        const decoder = new TextDecoder();
        let size = 0;
        let text = '';

        try {
            while (true) {
                const { value, done } = await reader.read();
                if (done) break;
                size += value.byteLength;
                if (size > limit) throw new Error('Decompressed signaling code is too large');
                text += decoder.decode(value, { stream: true });
            }
            return text + decoder.decode();
        } catch (error) {
            await reader.cancel(error).catch(() => {});
            throw error;
        } finally {
            reader.releaseLock();
        }
    }

    async function decode(str) {
        if (typeof str !== 'string' || !str || str.length > MAX_SIGNAL_LENGTH) {
            throw new Error('Signaling code is empty or too large');
        }
        // Accept offers from the pre-compression extension as well as new codes.
        if (!str.startsWith('z.') && !str.startsWith('j.')) {
            const binary = atob(str);
            const legacyBytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
            return JSON.parse(new TextDecoder().decode(legacyBytes));
        }

        const format = str.slice(0, 1);
        const bytes = base64UrlToBytes(str.slice(2));
        if (format === 'j') return JSON.parse(new TextDecoder().decode(bytes));
        if (!globalThis.DecompressionStream) throw new Error('This Spotify version cannot read compressed signaling codes');

        const decompressed = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
        return JSON.parse(await readTextWithLimit(decompressed, MAX_SIGNAL_LENGTH));
    }

    function isFinitePosition(value) {
        return Number.isFinite(value) && value >= 0 && value <= MAX_TRACK_POSITION;
    }

    function isPlayableSpotifyUri(value) {
        return typeof value === 'string' && /^spotify:(track|episode):[^\s]{1,500}$/.test(value);
    }

    function isRecord(value) {
        return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
    }

    function validateSyncState(state) {
        const optionalText = ['name', 'artist', 'image'];
        const isValid = isRecord(state)
            && typeof state.playing === 'boolean'
            && isFinitePosition(state.pos)
            && (state.uri === null || isPlayableSpotifyUri(state.uri))
            && Number.isFinite(state.ts)
            && optionalText.every((key) => state[key] == null
                || (typeof state[key] === 'string' && state[key].length <= MAX_METADATA_LENGTH));

        return isValid ? {
            playing: state.playing,
            pos: state.pos,
            uri: state.uri,
            name: state.name ?? null,
            artist: state.artist ?? null,
            image: state.image ?? null,
            ts: state.ts
        } : null;
    }

    function validateControlMessage(data) {
        const isValid = isRecord(data)
            && ALLOWED_CONTROL_ACTIONS.has(data.action)
            && (data.action !== 'seek' || isFinitePosition(data.pos));
        if (!isValid) return null;
        return data.action === 'seek'
            ? { type: 'control', action: data.action, pos: data.pos }
            : { type: 'control', action: data.action };
    }

    const PEER_MESSAGE_VALIDATORS = Object.freeze({
        host: Object.freeze({
            profile: (data) => ({ type: 'profile', profile: normalizeProfile(data.profile) }),
            control: validateControlMessage,
            'request-sync': () => ({ type: 'request-sync' })
        }),
        guest: Object.freeze({
            sync: (data) => {
                const state = validateSyncState(data.state);
                return state ? { type: 'sync', state } : null;
            },
            profile: (data) => ({ type: 'profile', profile: normalizeProfile(data.profile) }),
            approved: () => ({ type: 'approved' })
        })
    });

    function validatePeerMessage(data, recipient, sessionId) {
        const envelopeIsValid = isRecord(data)
            && data.protocol === PROTOCOL_VERSION
            && data.sessionId === sessionId
            && SESSION_ID_PATTERN.test(data.sessionId)
            && typeof data.type === 'string';
        if (!envelopeIsValid) return null;
        return PEER_MESSAGE_VALIDATORS[recipient]?.[data.type]?.(data) ?? null;
    }

    function getPlayerState() {
        const p = Spicetify.Player;
        if (!p) return null;
        const track = p.data?.item;
        if (track?.uri?.startsWith('spotify:local:')) return null;
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
        if (!state) return;
        if (applyingState) {
            pendingState = state;
            return;
        }

        applyingState = true;
        const activeVersion = sessionVersion;
        try {
            const p = Spicetify.Player;
            if (!p) return;

            if (state.uri && p.data?.item?.uri !== state.uri) {
                await p.playUri(state.uri);
                await new Promise((resolve) => setTimeout(resolve, 300));
            }

            if (activeVersion !== sessionVersion || !isGuest || !hostApproved) return;

            // Do not compare wall-clock timestamps across peers: clocks may be
            // seconds apart, which is worse than the small direct-channel delay.
            const targetPosition = state.pos;
            if (Math.abs(p.getPosition() - targetPosition) > DRIFT_THRESHOLD) {
                p.seek(targetPosition);
            }

            if (state.playing && !p.isPlaying()) p.play();
            else if (!state.playing && p.isPlaying()) p.pause();

            updateNowPlaying(state);
        } catch (error) {
            console.error('SpotifyP2P: Failed to apply playback state', error);
        } finally {
            applyingState = false;
            if (pendingState) {
                const nextState = pendingState;
                pendingState = null;
                applyState(nextState);
            }
        }
    }

    function sendData(data) {
        if (dataChannel?.readyState === 'open' && activeSessionId) {
            dataChannel.send(JSON.stringify(createPeerMessage(data, activeSessionId)));
        }
    }

    function broadcastState() {
        const state = getPlayerState();
        if (state) {
            sendData({ type: 'sync', state });
            if (isHost) updateNowPlaying(state, 'p2p-host-now-playing');
        }
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

    function updateNowPlaying(state, elementId = 'p2p-now-playing') {
        const el = document.getElementById(elementId);
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

            .p2p-controls {
                display: grid; grid-template-columns: repeat(5, 1fr); gap: 6px;
                margin: 12px 0;
            }
            .p2p-control-btn {
                min-width: 0; padding: 10px 4px; border: 1px solid #333;
                border-radius: 8px; background: #282828; color: white;
                font-size: 13px; cursor: pointer;
            }
            .p2p-control-btn:hover { background: #3e3e3e; }
            .p2p-control-btn:disabled { opacity: 0.45; cursor: not-allowed; }

            .p2p-code {
                font-size: 14px; font-weight: 500; text-align: center;
                padding: 16px; background: #1a1a1a; border: 1px solid #333;
                border-radius: 8px; margin-bottom: 12px;
                font-family: monospace; white-space: nowrap;
                line-height: 1.6; color: #e0e0e0;
                overflow-x: auto; overflow-y: hidden; user-select: all; cursor: text;
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
                        <button id="p2p-host-copy" class="p2p-btn" disabled>Copy Code</button>

                        <hr class="p2p-divider">

                        <div class="p2p-step">
                            <div class="p2p-step-num">2</div>
                            <div class="p2p-step-text">Paste their response code below</div>
                        </div>
                        <textarea id="p2p-host-answer" class="p2p-input" placeholder="Paste guest's response code here..." rows="3"></textarea>
                        <button id="p2p-host-accept" class="p2p-btn primary">Accept Answer</button>
                        <button id="p2p-host-reconnect" class="p2p-btn">Generate New Connection Code</button>

                        <div id="p2p-host-session" class="hidden">
                            <hr class="p2p-divider">
                            <div id="p2p-host-now-playing" class="p2p-now-playing-host"></div>
                            <div id="p2p-host-guests"></div>
                            <div id="p2p-host-approval" class="hidden">
                                <p class="p2p-status waiting">Review the guest above before sharing playback.</p>
                                <button id="p2p-host-approve" class="p2p-btn primary">Approve Guest</button>
                                <button id="p2p-host-reject" class="p2p-btn danger">Reject Guest</button>
                            </div>
                            <button id="p2p-host-sync" class="p2p-btn" disabled>Sync Now</button>
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

                        <p class="p2p-subtitle">Control host playback</p>
                        <div id="p2p-guest-controls" class="p2p-controls">
                            <button class="p2p-control-btn" data-p2p-action="prev" aria-label="Previous track">⏮</button>
                            <button class="p2p-control-btn" data-p2p-action="seek-back" aria-label="Seek back 15 seconds">−15s</button>
                            <button class="p2p-control-btn" data-p2p-action="toggle" aria-label="Play or pause">⏯</button>
                            <button class="p2p-control-btn" data-p2p-action="seek-forward" aria-label="Seek forward 15 seconds">+15s</button>
                            <button class="p2p-control-btn" data-p2p-action="next" aria-label="Next track">⏭</button>
                        </div>

                        <hr class="p2p-divider">
                        <button id="p2p-sync-btn" class="p2p-btn">Sync Now</button>
                        <button id="p2p-session-reconnect" class="p2p-btn hidden">Reconnect</button>
                        <button id="p2p-session-leave" class="p2p-btn danger">Leave Session</button>
                    </div>
                </div>
            </div>

        `;
        document.body.appendChild(c);

        document.getElementById('p2p-close').onclick = togglePanel;
        document.getElementById('p2p-host-btn').onclick = () => runNewSessionTask(startHost);
        document.getElementById('p2p-join-btn').onclick = showJoinView;
        document.getElementById('p2p-host-copy').onclick = copyHostOffer;
        document.getElementById('p2p-host-accept').onclick = acceptAnswer;
        document.getElementById('p2p-host-reconnect').onclick = () => runNewSessionTask(startHost);
        document.getElementById('p2p-host-leave').onclick = leave;
        document.getElementById('p2p-host-sync').onclick = manualSync;
        document.getElementById('p2p-host-approve').onclick = approveGuest;
        document.getElementById('p2p-host-reject').onclick = rejectGuest;
        document.getElementById('p2p-join-connect').onclick = generateAnswer;
        document.getElementById('p2p-join-copy').onclick = copyJoinAnswer;
        document.getElementById('p2p-join-back').onclick = leave;
        document.getElementById('p2p-sync-btn').onclick = manualSync;
        document.getElementById('p2p-session-reconnect').onclick = beginGuestReconnect;
        document.getElementById('p2p-session-leave').onclick = leave;
        document.querySelectorAll('[data-p2p-action]').forEach((button) => {
            button.onclick = () => sendGuestControl(button.dataset.p2pAction);
        });
        setGuestControlsEnabled(false);
    }

    function togglePanel() {
        document.getElementById('spotify-p2p-panel').classList.toggle('open');
    }

    function runNewSessionTask(task) {
        const expectedVersion = sessionVersion + 1;
        void task().catch((error) => {
            if (sessionVersion !== expectedVersion) return;
            console.error('SpotifyP2P: Failed to start session', error);
            leave();
            showToast('Could not start the session', 'error');
        });
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

    function setGuestConnectionStatus(label, state) {
        const dot = document.getElementById('p2p-connection-dot2');
        const status = document.getElementById('p2p-connection-label2');
        if (dot) dot.className = `p2p-dot p2p-dot-${state}`;
        if (status) status.textContent = label;
    }

    function setGuestControlsEnabled(enabled) {
        document.querySelectorAll('[data-p2p-action]').forEach((button) => {
            button.disabled = !enabled;
        });
    }

    function createSeekControl(offset) {
        const player = Spicetify.Player;
        const duration = player.getDuration?.();
        const maximum = Number.isFinite(duration) ? duration : MAX_TRACK_POSITION;
        return {
            type: 'control',
            action: 'seek',
            pos: Math.max(0, Math.min(maximum, player.getPosition() + offset))
        };
    }

    const GUEST_CONTROL_BUILDERS = Object.freeze({
        toggle: () => ({
            type: 'control',
            action: Spicetify.Player.isPlaying() ? 'pause' : 'play'
        }),
        'seek-back': () => createSeekControl(-15000),
        'seek-forward': () => createSeekControl(15000),
        prev: () => ({ type: 'control', action: 'prev' }),
        next: () => ({ type: 'control', action: 'next' })
    });

    function sendGuestControl(action) {
        if (!isGuest || !hostApproved || dataChannel?.readyState !== 'open') {
            showToast('Guest controls are unavailable until the host approves you', 'warning');
            return;
        }
        const message = GUEST_CONTROL_BUILDERS[action]?.();
        if (message) sendData(message);
    }

    function clearDisconnectGracePeriod() {
        if (!disconnectTimer) return;
        clearTimeout(disconnectTimer);
        disconnectTimer = null;
    }

    function handleConnectionLoss(peerConnection, onFailure) {
        if (peerConnection.connectionState === 'failed') {
            clearDisconnectGracePeriod();
            onFailure();
            return;
        }
        if (peerConnection.connectionState !== 'disconnected' || disconnectTimer) return;

        disconnectTimer = setTimeout(() => {
            disconnectTimer = null;
            if (peerConnection.connectionState === 'disconnected') onFailure();
        }, DISCONNECT_GRACE_PERIOD);
    }

    function reportIceServerError(event) {
        if (event.errorCode !== 701) return;
        console.warn('SpotifyP2P: ICE server unreachable', event.url, event.errorText);
        showToast('Your network cannot reach the connection helper server', 'error');
    }

    function prepareGuestReconnect() {
        showSessionView();
        setGuestConnectionStatus('Disconnected — get a new code from the host', 'disconnected');
        document.getElementById('p2p-sync-btn').disabled = true;
        setGuestControlsEnabled(false);
        document.getElementById('p2p-session-reconnect').classList.remove('hidden');
    }

    function beginGuestReconnect() {
        leave();
        showJoinView();
        document.getElementById('p2p-join-offer').focus();
        showToast('Ask the host for their new connection code', 'info');
    }

    function approveGuest() {
        if (!isHost || !dataChannel || !remoteProfile) {
            showToast('No guest is waiting for approval', 'warning');
            return;
        }
        guestApproved = true;
        document.getElementById('p2p-host-approval').classList.add('hidden');
        document.getElementById('p2p-host-sync').disabled = false;
        sendData({ type: 'profile', profile: getProfile() });
        sendData({ type: 'approved' });
        startHeartbeat();
        broadcastState();
        showToast(`${remoteProfile.name} approved`, 'info');
    }

    function rejectGuest() {
        showToast('Guest rejected', 'info');
        leave();
    }

    function waitForIceGatheringComplete(peerConnection, timeout = 10000) {
        return new Promise((resolve) => {
            if (peerConnection.iceGatheringState === 'complete') {
                resolve();
                return;
            }

            const finish = () => {
                clearTimeout(timer);
                peerConnection.removeEventListener('icegatheringstatechange', check);
                resolve();
            };
            const check = () => {
                if (peerConnection.iceGatheringState === 'complete') finish();
            };
            const timer = setTimeout(finish, timeout);
            peerConnection.addEventListener('icegatheringstatechange', check);
        });
    }

    function closePeerConnection(peerConnection) {
        if (peerConnection && peerConnection.connectionState !== 'closed') {
            try { peerConnection.close(); } catch (error) {}
        }
    }

    function resetTransport() {
        const activeChannel = dataChannel;
        const activeHostPC = hostPC;
        const activeGuestPC = guestPC;
        dataChannel = null;
        hostPC = null;
        guestPC = null;
        lastRemoteControlAt = 0;
        try { activeChannel?.close(); } catch (error) {}
        closePeerConnection(activeHostPC);
        closePeerConnection(activeGuestPC);
    }

    async function parseSignal(text, expectedType, expectedSessionId = null) {
        return parseSignalEnvelope(await decode(text), expectedType, expectedSessionId);
    }

    // ── Host ──

    async function startHost() {
        const activeVersion = ++sessionVersion;
        clearDisconnectGracePeriod();
        resetTransport();
        activeSessionId = createSessionId();
        remoteProfile = null;
        guestApproved = false;
        hostApproved = false;
        isHost = true;
        isGuest = false;

        hostPC = new RTCPeerConnection(STUN_SERVERS);
        const currentHostPC = hostPC;

        hostPC.onicecandidate = () => {};
        hostPC.onicecandidateerror = (event) => {
            if (hostPC === currentHostPC) reportIceServerError(event);
        };

        hostPC.onicegatheringstatechange = () => {
            if (hostPC === currentHostPC && currentHostPC.iceGatheringState === 'complete') {
                void updateHostOffer().catch((error) => console.error('SpotifyP2P: Failed to update offer', error));
            }
        };

        hostPC.onconnectionstatechange = () => {
            if (hostPC !== currentHostPC) return;
            const state = currentHostPC.connectionState;
            if (state === 'connected') {
                clearDisconnectGracePeriod();
                setConnectionState('connected');
                document.getElementById('p2p-host-session').classList.remove('hidden');
                showToast('Guest connected!', 'info');
            } else if (state === 'disconnected' || state === 'failed') {
                if (state === 'disconnected') setConnectionState('reconnecting');
                handleConnectionLoss(currentHostPC, () => {
                setConnectionState('disconnected');
                document.getElementById('p2p-host-session').classList.add('hidden');
                showToast('Direct connection failed — generate a new code to reconnect', 'error');
                });
            } else if (state === 'connecting') {
                setConnectionState('connecting');
            }
        };

        hostPC.ondatachannel = (e) => {
            if (hostPC !== currentHostPC) return;
            setupDataChannel(e.channel);
        };

        // The host must create the channel before the offer; otherwise there is
        // nothing in the SDP to negotiate and no usable code is produced.
        setupDataChannel(hostPC.createDataChannel('spotify-p2p', { ordered: true }));

        const offer = await currentHostPC.createOffer();
        await currentHostPC.setLocalDescription(offer);

        showHostView();
        setConnectionState('connecting');
        await waitForIceGatheringComplete(currentHostPC);
        if (activeVersion !== sessionVersion || hostPC !== currentHostPC) return;
        await updateHostOffer();
    }

    async function updateHostOffer() {
        if (!hostPC || !hostPC.localDescription) return;
        const peerConnection = hostPC;
        const encoded = await encode(createSignalEnvelope(peerConnection.localDescription, activeSessionId));
        if (hostPC !== peerConnection) return;
        const el = document.getElementById('p2p-host-offer');
        el.textContent = encoded;
        document.getElementById('p2p-host-copy').disabled = false;
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
        if (!hostPC || !hostPC.localDescription || text === 'Generating...') {
            showToast('Your connection code is still being generated', 'warning');
            return;
        }
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
            if (!hostPC) throw new Error('Host session is no longer active');
            const currentHostPC = hostPC;
            const { description: answer } = await parseSignal(text, 'answer', activeSessionId);
            if (hostPC !== currentHostPC) return;
            await currentHostPC.setRemoteDescription(answer);
            setConnectionState('connecting');
            input.value = '';
            input.classList.remove('error');
        } catch (err) {
            console.error('SpotifyP2P:', err);
            input.classList.add('error');
            setTimeout(() => input.classList.remove('error'), 1500);
            showToast(getSignalErrorMessage(err), 'error');
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
        const answerEl = document.getElementById('p2p-join-answer');
        const copyButton = document.getElementById('p2p-join-copy');
        errorEl.classList.add('hidden');
        answerEl.textContent = '';
        answerEl.classList.add('hidden');
        copyButton.classList.add('hidden');
        const activeVersion = ++sessionVersion;

        try {
            clearDisconnectGracePeriod();
            resetTransport();
            activeSessionId = null;
            isGuest = true;
            isHost = false;
            hostApproved = false;

            guestPC = new RTCPeerConnection(STUN_SERVERS);
            const currentGuestPC = guestPC;
            guestPC.onicecandidateerror = (event) => {
                if (guestPC === currentGuestPC) reportIceServerError(event);
            };

            guestPC.onconnectionstatechange = () => {
                if (guestPC !== currentGuestPC) return;
                const state = currentGuestPC.connectionState;
                if (state === 'connected') {
                    clearDisconnectGracePeriod();
                } else if (state === 'disconnected' || state === 'failed') {
                    if (state === 'disconnected') setGuestConnectionStatus('Reconnecting...', 'connecting');
                    handleConnectionLoss(currentGuestPC, () => {
                        showToast('Direct connection failed — ask the host for a new code', 'error');
                        prepareGuestReconnect();
                    });
                }
            };

            guestPC.ondatachannel = (e) => {
                if (guestPC !== currentGuestPC) return;
                setupDataChannel(e.channel);
            };

            const parsedOffer = await parseSignal(text, 'offer');
            activeSessionId = parsedOffer.sessionId;
            const offer = parsedOffer.description;
            await currentGuestPC.setRemoteDescription(offer);

            const answer = await currentGuestPC.createAnswer();
            await currentGuestPC.setLocalDescription(answer);

            await waitForIceGatheringComplete(currentGuestPC);
            if (activeVersion !== sessionVersion || guestPC !== currentGuestPC) return;

            const encoded = await encode(createSignalEnvelope(currentGuestPC.localDescription, activeSessionId));
            answerEl.textContent = encoded;
            answerEl.classList.remove('hidden');
            copyButton.classList.remove('hidden');
            input.classList.remove('error');

            copyButton.onclick = copyJoinAnswer;

        } catch (err) {
            if (activeVersion !== sessionVersion) return;
            resetTransport();
            activeSessionId = null;
            isGuest = false;
            hostApproved = false;
            console.error('SpotifyP2P:', err);
            input.classList.add('error');
            setTimeout(() => input.classList.remove('error'), 1500);
            errorText.textContent = getSignalErrorMessage(err);
            errorEl.classList.remove('hidden');
        }
    }

    function copyJoinAnswer() {
        const text = document.getElementById('p2p-join-answer').textContent;
        if (!guestPC || !guestPC.localDescription || !text) {
            showToast('Your response code is still being generated', 'warning');
            return;
        }
        navigator.clipboard.writeText(text).then(() => {
            const btn = document.getElementById('p2p-join-copy');
            btn.textContent = 'Copied!';
            setTimeout(() => btn.textContent = 'Copy Response', 2000);
        }).catch(() => {
            showToast('Failed to copy — try selecting manually', 'error');
        });
    }

    // ── Data Channel ──

    function setupDataChannel(channel) {
        const channelIsUnexpected = channel.label !== 'spotify-p2p'
            || (dataChannel !== null && dataChannel !== channel);
        if (channelIsUnexpected) {
            channel.close();
            return;
        }
        dataChannel = channel;

        channel.onopen = () => {
            if (dataChannel !== channel) return;
            clearDisconnectGracePeriod();
            console.log('SpotifyP2P: Channel open');

            if (isHost) {
                setConnectionState('connected');
            } else {
                sendData({ type: 'profile', profile: getProfile() });
                setConnectionState('connected');
                showSessionView();
                setGuestConnectionStatus('Waiting for host approval', 'connecting');
                document.getElementById('p2p-sync-btn').disabled = true;
                document.getElementById('p2p-session-reconnect').classList.add('hidden');
            }
        };

        channel.onmessage = (e) => {
            if (dataChannel !== channel) return;
            try {
                if (typeof e.data !== 'string' || e.data.length > MAX_DATA_MESSAGE_LENGTH) {
                    throw new Error('Peer message is empty, binary, or too large');
                }
                const data = JSON.parse(e.data);
                const validated = validatePeerMessage(data, isHost ? 'host' : 'guest', activeSessionId);
                if (!validated) throw new Error('Peer message failed validation');
                if (isHost) handleHostMessage(validated);
                else handleGuestMessage(validated);
            } catch(err) {
                console.error('SpotifyP2P: Bad message', err);
            }
        };

        channel.onclose = () => {
            if (dataChannel !== channel) return;
            console.log('SpotifyP2P: Channel closed');
            stopHeartbeat();
            setConnectionState('disconnected');
            if (!isHost) {
                showToast('Disconnected from host', 'error');
                prepareGuestReconnect();
            } else {
                showToast('Guest disconnected', 'error');
                document.getElementById('p2p-host-session').classList.add('hidden');
            }
        };

        channel.onerror = (e) => {
            if (dataChannel !== channel) return;
            console.error('SpotifyP2P: Channel error', e);
        };
    }

    const HOST_CONTROL_HANDLERS = Object.freeze({
        play: () => Spicetify.Player.play(),
        pause: () => Spicetify.Player.pause(),
        next: () => Spicetify.Player.next(),
        prev: () => Spicetify.Player.back(),
        seek: (data) => {
            const duration = Spicetify.Player.getDuration?.();
            Spicetify.Player.seek(Number.isFinite(duration) ? Math.min(data.pos, duration) : data.pos);
        }
    });

    const HOST_MESSAGE_HANDLERS = Object.freeze({
        profile: (data) => {
            if (guestApproved) return;
            remoteProfile = data.profile;
            updateGuestDisplay();
            document.getElementById('p2p-host-approval').classList.remove('hidden');
            showToast(`${remoteProfile.name} wants to join`, 'info');
        },
        control: (data) => {
            if (!guestApproved) return;
            const now = performance.now();
            if (now - lastRemoteControlAt < CONTROL_COOLDOWN) return;
            lastRemoteControlAt = now;
            HOST_CONTROL_HANDLERS[data.action](data);
            setTimeout(broadcastState, 100);
        },
        'request-sync': () => guestApproved && broadcastState()
    });

    const GUEST_MESSAGE_HANDLERS = Object.freeze({
        sync: (data) => hostApproved && applyState(data.state),
        profile: (data) => {
            remoteProfile = data.profile;
            updateGuestDisplay();
        },
        approved: () => {
            hostApproved = true;
            setGuestConnectionStatus('Connected to host', 'connected');
            document.getElementById('p2p-sync-btn').disabled = false;
            setGuestControlsEnabled(true);
            showToast('Host approved this session', 'info');
        }
    });

    function handleHostMessage(data) {
        HOST_MESSAGE_HANDLERS[data.type](data);
    }

    function handleGuestMessage(data) {
        GUEST_MESSAGE_HANDLERS[data.type](data);
    }

    function normalizeProfile(profile) {
        return {
            name: typeof profile?.name === 'string' && profile.name.trim()
                ? profile.name.trim().slice(0, MAX_PROFILE_NAME_LENGTH)
                : 'Unknown',
            image: typeof profile?.image === 'string' && profile.image.length <= MAX_METADATA_LENGTH
                ? profile.image
                : null
        };
    }

    function updateGuestDisplay() {
        const el = document.getElementById(isHost ? 'p2p-host-guests' : 'p2p-peer-info');
        if (!el || !remoteProfile) return;
        el.replaceChildren();
        const peer = document.createElement('div');
        peer.className = 'p2p-peer';
        if (typeof remoteProfile.image === 'string' && remoteProfile.image.startsWith('https://i.scdn.co/')) {
            const image = document.createElement('img');
            image.className = 'p2p-avatar';
            image.src = remoteProfile.image;
            image.alt = '';
            peer.appendChild(image);
        } else {
            const avatar = document.createElement('div');
            avatar.className = 'p2p-avatar';
            peer.appendChild(avatar);
        }
        const name = document.createElement('span');
        name.className = 'p2p-peer-name';
        name.textContent = typeof remoteProfile.name === 'string' ? remoteProfile.name : 'Unknown';
        peer.appendChild(name);
        el.appendChild(peer);
    }

    // ── Sync ──

    function manualSync() {
        if (isHost) {
            if (!guestApproved) {
                showToast('Approve the guest before syncing', 'warning');
                return;
            }
            broadcastState();
            showToast('Synced all listeners', 'info');
        } else {
            if (!hostApproved) {
                showToast('Waiting for host approval', 'warning');
                return;
            }
            sendData({ type: 'request-sync' });
            showToast('Sync requested', 'info');
        }
    }

    // ── Leave ──

    function leave() {
        sessionVersion += 1;
        stopHeartbeat();
        clearDisconnectGracePeriod();
        resetTransport();
        activeSessionId = null;
        remoteProfile = null;
        pendingState = null;
        guestApproved = false;
        hostApproved = false;
        isHost = false;
        isGuest = false;
        setConnectionState('disconnected');
        if (!document.getElementById('spotify-p2p-container')) return;
        showHome();

        document.getElementById('p2p-host-session')?.classList.add('hidden');
        document.getElementById('p2p-host-offer').textContent = 'Generating...';
        document.getElementById('p2p-host-copy').disabled = true;
        document.getElementById('p2p-host-answer').value = '';
        document.getElementById('p2p-join-offer').value = '';
        document.getElementById('p2p-join-answer').textContent = '';
        document.getElementById('p2p-join-answer').classList.add('hidden');
        document.getElementById('p2p-join-copy').classList.add('hidden');
        document.getElementById('p2p-join-error').classList.add('hidden');
        document.getElementById('p2p-session-reconnect').classList.add('hidden');
        document.getElementById('p2p-host-approval').classList.add('hidden');
        document.getElementById('p2p-host-sync').disabled = true;
        document.getElementById('p2p-sync-btn').disabled = false;
        setGuestControlsEnabled(false);
        setGuestConnectionStatus('Connected to host', 'connected');
        document.getElementById('p2p-now-playing').classList.add('hidden');
        document.getElementById('p2p-peer-info').innerHTML = '';
    }

    // ── Init ──

    function mountTopbarButton() {
        const icon = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 3v10.55c-.59-.34-1.27-.55-2-.55-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4V7h4V3h-6z"/></svg>';
        topbarButton = new Spicetify.Topbar.Button('SpotifyP2P', icon, togglePanel, false, true);
        topbarButton.element.id = 'spotify-p2p-topbar-toggle';
    }

    function dispose() {
        leave();
        topbarButton?.tippy?.destroy?.();
        topbarButton?.element?.remove();
        topbarButton = null;
        document.getElementById('spotify-p2p-container')?.remove();
        document.getElementById('spotify-p2p-styles')?.remove();
        document.getElementById('spotify-p2p-fallback-toggle')?.remove();
        document.getElementById('p2p-toast')?.remove();
    }

    function waitForSpicetify() {
        return new Promise((resolve) => {
            const check = () => {
                if (globalThis.Spicetify?.Player && globalThis.Spicetify?.Platform && globalThis.Spicetify?.Topbar) resolve();
                else setTimeout(check, 100);
            };
            check();
        });
    }

    async function init() {
        await waitForSpicetify();
        loadStyles();
        createUI();

        mountTopbarButton();
        console.log('SpotifyP2P: topbar button added');

        console.log('SpotifyP2P: Extension loaded');
    }

    if (isCommonJS) {
        module.exports = {
            PROTOCOL_VERSION,
            ProtocolError,
            createPeerMessage,
            createSessionId,
            createSignalEnvelope,
            decode,
            encode,
            getSignalErrorMessage,
            isFinitePosition,
            isPlayableSpotifyUri,
            normalizeProfile,
            parseSignalEnvelope,
            validateControlMessage,
            validatePeerMessage,
            validateSyncState
        };
        return;
    }

    root[EXTENSION_KEY] = { dispose };
    void init().catch((error) => console.error('SpotifyP2P: Extension failed to initialize', error));
})(typeof window !== 'undefined' ? window : globalThis);
