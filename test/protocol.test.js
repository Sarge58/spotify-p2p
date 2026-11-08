'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
    PROTOCOL_VERSION,
    createPeerMessage,
    createSessionTracker,
    createTimerRegistry,
    createSessionId,
    createSignalEnvelope,
    decode,
    encode,
    hasIceCandidate,
    normalizeProfile,
    parseSignalEnvelope,
    validateControlMessage,
    validatePeerMessage,
    validateSyncState
} = require('../extension.js');

const SESSION_ID = 'AAAAAAAAAAAAAAAAAAAAAA';

function validState(overrides = {}) {
    return {
        playing: true,
        pos: 42000,
        uri: 'spotify:track:0BxE4FqsDD1Ot4YuBXwAPp',
        name: '505',
        artist: 'Arctic Monkeys',
        image: null,
        ts: Date.now(),
        ...overrides
    };
}

test('signaling descriptions survive an encode/decode round trip', async () => {
    const description = { type: 'offer', sdp: 'v=0\r\na=ice-ufrag:test\r\n' };
    assert.deepEqual(await decode(await encode(description)), description);
});

test('signaling envelopes carry a protocol version and session identity', () => {
    const description = { type: 'offer', sdp: 'v=0\r\n' };
    const envelope = createSignalEnvelope(description, SESSION_ID);
    assert.equal(envelope.protocol, PROTOCOL_VERSION);
    assert.deepEqual(parseSignalEnvelope(envelope, 'offer'), {
        description,
        sessionId: SESSION_ID
    });
});

test('session identifiers are random base64url values', () => {
    const first = createSessionId();
    const second = createSessionId();
    assert.match(first, /^[A-Za-z0-9_-]{22}$/);
    assert.notEqual(first, second);
});

test('session tracker invalidates stale asynchronous work', () => {
    const tracker = createSessionTracker();
    const first = tracker.begin();
    const second = tracker.begin();
    assert.equal(tracker.isCurrent(first), false);
    assert.equal(tracker.isCurrent(second), true);
    tracker.invalidate();
    assert.equal(tracker.isCurrent(second), false);
});

test('timer registry replaces and clears lifecycle notices', () => {
    let nextId = 0;
    const scheduled = new Map();
    const cleared = [];
    const scheduler = {
        setTimeout(callback) {
            const id = ++nextId;
            scheduled.set(id, callback);
            return id;
        },
        clearTimeout(id) {
            cleared.push(id);
            scheduled.delete(id);
        }
    };
    const timers = createTimerRegistry(scheduler);
    timers.schedule('connection', 100, () => {});
    timers.schedule('connection', 100, () => {});
    assert.deepEqual(cleared, [1]);
    timers.clearAll();
    assert.deepEqual(cleared, [1, 2]);
    assert.equal(scheduled.size, 0);
});

test('signaling rejects incompatible versions and stale responses', () => {
    const description = { type: 'answer', sdp: 'v=0\r\n' };
    const envelope = createSignalEnvelope(description, SESSION_ID);
    assert.throws(
        () => parseSignalEnvelope({ ...envelope, protocol: PROTOCOL_VERSION + 1 }, 'answer'),
        { code: 'version-mismatch' }
    );
    assert.throws(
        () => parseSignalEnvelope(envelope, 'answer', 'BBBBBBBBBBBBBBBBBBBBBB'),
        { code: 'stale-session' }
    );
});

test('oversized signaling input is rejected before decoding', async () => {
    await assert.rejects(decode(`j.${'a'.repeat(250001)}`), /too large/);
});

test('compressed signaling cannot expand past the decoded size limit', async (context) => {
    if (!globalThis.CompressionStream) context.skip('CompressionStream is unavailable');
    const source = new TextEncoder().encode(JSON.stringify({ value: 'x'.repeat(250001) }));
    const stream = new Blob([source]).stream().pipeThrough(new CompressionStream('deflate-raw'));
    const compressed = new Uint8Array(await new Response(stream).arrayBuffer());
    const code = `z.${Buffer.from(compressed).toString('base64url')}`;
    await assert.rejects(decode(code), /too large/);
});

test('connection diagnostics require a gathered ICE candidate', () => {
    assert.equal(hasIceCandidate({ localDescription: { sdp: 'v=0\r\na=ice-ufrag:test\r\n' } }), false);
    assert.equal(hasIceCandidate({
        localDescription: {
            sdp: 'v=0\r\na=ice-ufrag:test\r\na=candidate:1 1 UDP 2122260223 192.0.2.1 5000 typ host\r\n'
        }
    }), true);
});

test('valid playback state is normalized', () => {
    const state = validState();
    assert.deepEqual(validateSyncState(state), state);
});

test('malformed playback state and unsafe URIs are rejected', () => {
    assert.equal(validateSyncState(validState({ pos: Number.NaN })), null);
    assert.equal(validateSyncState(validState({ pos: -1 })), null);
    assert.equal(validateSyncState(validState({ uri: 'https://example.com/audio' })), null);
    assert.equal(validateSyncState(validState({ uri: 'spotify:local:artist:album:track:120' })), null);
    assert.equal(validateSyncState(validState({ playing: 'yes' })), null);
});

test('control messages use an allowlist and validate seek positions', () => {
    assert.deepEqual(validateControlMessage({ action: 'next' }), { type: 'control', action: 'next' });
    assert.deepEqual(validateControlMessage({ action: 'seek', pos: 12345 }), {
        type: 'control', action: 'seek', pos: 12345
    });
    assert.deepEqual(validateControlMessage({
        action: 'play-uri',
        uri: 'spotify:track:0BxE4FqsDD1Ot4YuBXwAPp'
    }), {
        type: 'control',
        action: 'play-uri',
        uri: 'spotify:track:0BxE4FqsDD1Ot4YuBXwAPp'
    });
    assert.equal(validateControlMessage({ action: 'volume', level: 1 }), null);
    assert.equal(validateControlMessage({ action: 'seek', pos: Infinity }), null);
    assert.equal(validateControlMessage({ action: 'play-uri', uri: 'https://example.com/audio' }), null);
});

test('messages are restricted by recipient role', () => {
    const approved = createPeerMessage({ type: 'approved' }, SESSION_ID);
    const control = createPeerMessage({ type: 'control', action: 'next' }, SESSION_ID);
    assert.equal(validatePeerMessage(approved, 'host', SESSION_ID), null);
    assert.deepEqual(validatePeerMessage(approved, 'guest', SESSION_ID), { type: 'approved' });
    assert.equal(validatePeerMessage(control, 'guest', SESSION_ID), null);
    assert.deepEqual(validatePeerMessage(control, 'host', SESSION_ID), {
        type: 'control', action: 'next'
    });
    assert.equal(validatePeerMessage(control, 'host', 'BBBBBBBBBBBBBBBBBBBBBB'), null);
});

test('profile fields are trimmed and bounded', () => {
    const profile = normalizeProfile({
        name: `  ${'x'.repeat(100)}  `,
        image: 'x'.repeat(501),
        uri: 123
    });
    assert.equal(profile.name.length, 80);
    assert.equal(profile.image, null);
    assert.equal(Object.hasOwn(profile, 'uri'), false);
});
