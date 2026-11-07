'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
    PROTOCOL_VERSION,
    createPeerMessage,
    createSessionId,
    createSignalEnvelope,
    decode,
    encode,
    parseSignalEnvelope,
    validatePeerMessage
} = require('../extension.js');

class InMemoryPeer {
    constructor(role, sessionId) {
        this.role = role;
        this.sessionId = sessionId;
        this.received = [];
    }

    send(payload) {
        return JSON.stringify(createPeerMessage(payload, this.sessionId));
    }

    receive(serialized) {
        const message = validatePeerMessage(JSON.parse(serialized), this.role, this.sessionId);
        assert.ok(message, `${this.role} rejected an expected message`);
        this.received.push(message);
        return message;
    }
}

test('host and guest complete a versioned session flow', async () => {
    const sessionId = createSessionId();
    const offer = { type: 'offer', sdp: 'v=0\r\na=setup:actpass\r\n' };
    const offerCode = await encode(createSignalEnvelope(offer, sessionId));

    const guestSignal = parseSignalEnvelope(await decode(offerCode), 'offer');
    assert.equal(guestSignal.sessionId, sessionId);

    const answer = { type: 'answer', sdp: 'v=0\r\na=setup:active\r\n' };
    const answerCode = await encode(createSignalEnvelope(answer, guestSignal.sessionId));
    const hostSignal = parseSignalEnvelope(await decode(answerCode), 'answer', sessionId);
    assert.deepEqual(hostSignal.description, answer);

    const host = new InMemoryPeer('host', sessionId);
    const guest = new InMemoryPeer('guest', sessionId);

    assert.deepEqual(host.receive(guest.send({
        type: 'profile',
        profile: { name: 'Guest', image: null }
    })), {
        type: 'profile',
        profile: { name: 'Guest', image: null }
    });

    assert.deepEqual(guest.receive(host.send({ type: 'approved' })), { type: 'approved' });

    const state = {
        playing: true,
        pos: 12000,
        uri: 'spotify:track:0BxE4FqsDD1Ot4YuBXwAPp',
        name: '505',
        artist: 'Arctic Monkeys',
        image: null,
        ts: Date.now()
    };
    assert.deepEqual(guest.receive(host.send({ type: 'sync', state })), { type: 'sync', state });
    assert.deepEqual(host.receive(guest.send({ type: 'control', action: 'pause' })), {
        type: 'control',
        action: 'pause'
    });
});

test('stale sessions and incompatible clients cannot cross the boundary', () => {
    const currentSession = createSessionId();
    const staleSession = createSessionId();
    const host = new InMemoryPeer('host', currentSession);
    const staleMessage = JSON.stringify(createPeerMessage({ type: 'control', action: 'next' }, staleSession));

    assert.equal(validatePeerMessage(JSON.parse(staleMessage), 'host', currentSession), null);

    const incompatibleOffer = {
        ...createSignalEnvelope({ type: 'offer', sdp: 'v=0\r\n' }, currentSession),
        protocol: PROTOCOL_VERSION + 1
    };
    assert.throws(() => parseSignalEnvelope(incompatibleOffer, 'offer'), { code: 'version-mismatch' });
    assert.equal(host.received.length, 0);
});
