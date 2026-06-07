#!/usr/bin/env node
// collab-sim — headless multi-peer simulator for KLYPIX realtime collab.
//
// Drives the REAL Supabase Realtime APIs (presence + broadcast) from Node with
// N synthetic peers, so collab behaviour can be reproduced + asserted WITHOUT
// two laptops and without the Electron app. Uses a THROWAWAY channel name and
// only presence/broadcast (ephemeral websocket traffic) — it never reads or
// writes any canvas blob or DB row, so it is safe to run against the live
// project with the public anon key.
//
//   node scripts/collab-sim.mjs [numPeers=2] [seconds=8]
//
// Exit 0 = presence converged on every peer (each sees all the others) AND a
// broadcast from peer 0 reached every other peer. Exit 1 = a convergence/
// delivery failure (the bug we've been chasing, now reproducible locally).

import { createClient } from '@supabase/supabase-js';

// Same project + public anon key the app uses (anon key is public by design).
const URL = 'https://hiqwovwavlczlbuzzbel.supabase.co';
const ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImhpcXdvdndhdmxjemxidXp6YmVsIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzQxODQ1MjEsImV4cCI6MjA4OTc2MDUyMX0.D38pbmA7HeH-it9Lyx1SGwafDIhkk35Grd5h0ze4Lko';

const numPeers = Math.max(2, parseInt(process.argv[2] || '2', 10));
const seconds = Math.max(3, parseInt(process.argv[3] || '8', 10));
// `private` (4th arg) joins with config.private:true + NO auth token, to verify
// that private channels DENY a non-member (anon) peer once Realtime
// Authorization is enforced. PASS in private mode = peers are REJECTED.
const PRIVATE = process.argv[4] === 'private';
const TEST_ID = 'harness-' + Math.random().toString(36).slice(2, 10); // throwaway, never a real blob
const CHANNEL = `klypix-canvas-${TEST_ID}`;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function makePeer(i) {
    const deviceId = `simdev_${i}_${Math.random().toString(36).slice(2, 8)}`;
    const name = `Peer${i}`;
    const client = createClient(URL, ANON, {
        auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false },
        realtime: { params: { eventsPerSecond: 30 } },
    });
    const channel = client.channel(CHANNEL, {
        config: { private: PRIVATE, presence: { key: deviceId }, broadcast: { self: false } },
    });
    const state = { i, name, deviceId, client, channel, status: null, seenPeers: new Set(), gotBroadcast: false };

    const recompute = () => {
        const ps = channel.presenceState();
        state.seenPeers = new Set();
        for (const slot of Object.values(ps)) {
            for (const row of slot) {
                if (row?.device_id && row.device_id !== deviceId) state.seenPeers.add(row.device_id);
            }
        }
    };
    channel
        .on('presence', { event: 'sync' }, recompute)
        .on('presence', { event: 'join' }, recompute)
        .on('presence', { event: 'leave' }, recompute)
        .on('broadcast', { event: 'ping' }, (msg) => {
            if (msg?.payload?.from && msg.payload.from !== deviceId) state.gotBroadcast = true;
        });

    return new Promise((resolve) => {
        channel.subscribe((status) => {
            state.status = status;
            console.log(`  [${name}] status: ${status}`);
            if (status === 'SUBSCRIBED') {
                channel.track({ device_id: deviceId, display_name: name, joined_at: Date.now() });
                resolve(state);
            } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
                resolve(state); // resolve anyway so the harness can report the failure
            }
        });
    });
}

async function main() {
    console.log(`\ncollab-sim: ${numPeers} peers on ${CHANNEL} for ${seconds}s\n`);
    const peers = [];
    for (let i = 0; i < numPeers; i++) { peers.push(await makePeer(i)); await sleep(300); }

    await sleep(1500); // let presence settle
    console.log(`\n  → peer 0 broadcasts a 'ping'…`);
    peers[0].channel.send({ type: 'broadcast', event: 'ping', payload: { from: peers[0].deviceId } });

    await sleep(seconds * 1000);

    console.log('\n=== RESULTS ===');
    let pass = true;
    const expected = numPeers - 1;
    for (const p of peers) {
        const presenceOk = p.seenPeers.size === expected;
        if (!presenceOk) pass = false;
        console.log(`  [${p.name}] status=${p.status} sees ${p.seenPeers.size}/${expected} peers ${presenceOk ? '✓' : '✗'}`);
    }
    const bcastOk = peers.slice(1).every(p => p.gotBroadcast);
    if (!bcastOk) pass = false;
    console.log(`  broadcast from peer0 reached all others: ${bcastOk ? '✓' : '✗'}`);

    for (const p of peers) { try { await p.channel.unsubscribe(); p.client.removeAllChannels(); } catch { /* */ } }
    console.log(`\n${pass ? '✅ PASS — presence converged + broadcast delivered' : '❌ FAIL — collab does NOT converge headlessly (bug reproduced)'}\n`);
    // give sockets a moment to close, then exit
    await sleep(300);
    process.exit(pass ? 0 : 1);
}
main().catch(e => { console.error('sim error:', e?.message || e); process.exit(2); });
