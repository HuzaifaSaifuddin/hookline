import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { RoomSnapshot, ServerMessage } from '@hookline/core';
import { buildApp, type AppContext } from '../src/app.ts';
import { loadConfig } from '../src/config.ts';
import { RoomManager } from '../src/room-manager.ts';

/**
 * Integration tests: real Fastify app, real catalogue, in-memory SQLite,
 * WebSocket clients via fastify.injectWS, and a controllable clock.
 */

let ctx: AppContext;
let time = Date.parse('2026-11-11T20:00:00Z');
const clock = () => time;

const fakeFetch: typeof fetch = async (input) => {
  const url = String(input);
  if (url.includes('oembed')) {
    const id = decodeURIComponent(url).match(/v=([\w-]{11})/)?.[1];
    if (id === 'NOEMBED0000') return new Response('', { status: 401 });
    if (id === 'GONEGONE000') return new Response('', { status: 404 });
    return Response.json({ title: 'Tum Hi Ho (Official Video) | Aashiqui 2', author_name: 'T-Series' });
  }
  return new Response('', { status: 500 });
};

beforeEach(async () => {
  time = Date.parse('2026-11-11T20:00:00Z');
  const config = { ...loadConfig({ NODE_ENV: 'test' }), dbFile: ':memory:', webDist: '/nonexistent' };
  ctx = await buildApp(config, { clock, fetchImpl: fakeFetch, studioKey: '' });
  await ctx.app.ready();
});
afterEach(async () => {
  await ctx.app.close();
});

async function createRoom(body: object = { occasion: 'wedding' }) {
  const res = await ctx.app.inject({ method: 'POST', url: '/api/rooms', payload: body });
  expect(res.statusCode).toBe(200);
  return res.json() as { code: string; hostKey: string };
}

/** A small WS client that records messages and can wait for one matching a predicate. */
async function connect(hello: object) {
  const ws = await ctx.app.injectWS('/ws');
  const inbox: ServerMessage[] = [];
  const waiters: Array<{ pred: (m: ServerMessage) => boolean; resolve: (m: ServerMessage) => void }> = [];
  ws.on('message', (raw: Buffer) => {
    const m = JSON.parse(raw.toString()) as ServerMessage;
    inbox.push(m);
    for (const w of [...waiters]) if (w.pred(m)) {
      waiters.splice(waiters.indexOf(w), 1);
      w.resolve(m);
    }
  });
  const next = (pred: (m: ServerMessage) => boolean, timeoutMs = 1500) =>
    new Promise<ServerMessage>((resolve, reject) => {
      const found = inbox.find(pred);
      if (found) {
        inbox.splice(inbox.indexOf(found), 1);
        return resolve(found);
      }
      const t = setTimeout(() => reject(new Error('timeout waiting for message; inbox: ' + JSON.stringify(inbox.map((m) => m.type)))), timeoutMs);
      waiters.push({ pred, resolve: (m) => (clearTimeout(t), inbox.splice(inbox.indexOf(m), 1), resolve(m)) });
    });
  const snapshot = async (pred: (r: RoomSnapshot) => boolean = () => true) =>
    ((await next((m) => m.type === 'snapshot' && pred(m.room))) as Extract<ServerMessage, { type: 'snapshot' }>).room;
  const send = (m: object) => ws.send(JSON.stringify(m));
  send(hello);
  return { ws, inbox, next, snapshot, send };
}

describe('REST', () => {
  it('meta describes the catalogue and capabilities', async () => {
    const meta = (await ctx.app.inject('/api/meta')).json();
    expect(meta.catalogSize).toBeGreaterThan(900);
    expect(meta.playableCount).toBeGreaterThan(850);
    expect(meta.aiEnabled).toBe(false);
    expect(meta.occasions.map((o: { id: string }) => o.id)).toContain('sangeet');
  });

  it('creates a room from free text using the rule engine when AI is off', async () => {
    const { code } = await createRoom({ text: 'workout, only punjabi, quick hooks' });
    const snap = (await ctx.app.inject(`/api/rooms/${code}`)).json() as RoomSnapshot;
    expect(snap.intent.occasion).toBe('workout');
    expect(snap.intent.languages).toEqual(['punjabi']);
    expect(snap.queue).toHaveLength(6);
    expect(snap.queue.every((q) => q.track.language === 'punjabi')).toBe(true);
    expect(snap.queue.every((q) => q.window.endSec - q.window.startSec <= 50)).toBe(true);
    expect(snap.queue.every((q) => q.sourceIds.length > 0)).toBe(true);
  });

  it('404s unknown rooms and validates input', async () => {
    expect((await ctx.app.inject('/api/rooms/ZZZZ')).statusCode).toBe(404);
    expect((await ctx.app.inject({ method: 'POST', url: '/api/rooms', payload: { style: 'loud' } })).statusCode).toBe(400);
  });

  it('search tolerates misspellings', async () => {
    const hits = (await ctx.app.inject('/api/search?q=kala%20chasma')).json();
    expect(hits[0].id).toBe('kala-chashma');
  });

  it('curator hook edits flow into the play window', async () => {
    const res = await ctx.app.inject({ method: 'PUT', url: '/api/songs/kala-chashma/hook', payload: { startSec: 40, endSec: 100 } });
    expect(res.statusCode).toBe(200);
    expect(res.json().hook).toEqual({ startSec: 40, endSec: 100, source: 'curator' });
    const bad = await ctx.app.inject({ method: 'PUT', url: '/api/songs/kala-chashma/hook', payload: { startSec: 40, endSec: 45 } });
    expect(bad.statusCode).toBe(400);
  });

  it('imports a song from a YouTube link after verifying it via oEmbed', async () => {
    const ok = await ctx.app.inject({ method: 'POST', url: '/api/songs/import', payload: { url: 'https://youtu.be/IJq0yyWug1k', language: 'hindi' } });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().title).toBe('Tum Hi Ho');
    expect(ok.json().autoPlayable).toBe(true);
    const dup = await ctx.app.inject({ method: 'POST', url: '/api/songs/import', payload: { url: 'IJq0yyWug1k', language: 'hindi' } });
    expect(dup.statusCode).toBe(409);
    const blocked = await ctx.app.inject({ method: 'POST', url: '/api/songs/import', payload: { url: 'https://www.youtube.com/watch?v=NOEMBED0000', language: 'hindi' } });
    expect(blocked.statusCode).toBe(422);
    const notYt = await ctx.app.inject({ method: 'POST', url: '/api/songs/import', payload: { url: 'https://example.com/x', language: 'hindi' } });
    expect(notYt.statusCode).toBe(400);
  });

  it('studio endpoints can be locked with a key', async () => {
    await ctx.app.close();
    const config = { ...loadConfig({ NODE_ENV: 'test' }), dbFile: ':memory:', webDist: '/nonexistent' };
    ctx = await buildApp(config, { clock, fetchImpl: fakeFetch, studioKey: 'sekret' });
    const denied = await ctx.app.inject({ method: 'PUT', url: '/api/songs/kala-chashma/hook', payload: { startSec: 40, endSec: 100 } });
    expect(denied.statusCode).toBe(401);
    const allowed = await ctx.app.inject({ method: 'PUT', url: '/api/songs/kala-chashma/hook', headers: { 'x-studio-key': 'sekret' }, payload: { startSec: 40, endSec: 100 } });
    expect(allowed.statusCode).toBe(200);
  });
});

describe('realtime party flow', () => {
  it('rejects a host without the right key', async () => {
    const { code } = await createRoom();
    const c = await connect({ type: 'hello', room: code, role: 'host', hostKey: 'nope' });
    const err = await c.next((m) => m.type === 'error');
    expect(err).toMatchObject({ message: expect.stringMatching(/not authorised/i) });
  });

  it('host plays, guests request and vote, the DJ weaves requests in', async () => {
    const { code, hostKey } = await createRoom({ occasion: 'house-party' });
    const host = await connect({ type: 'hello', room: code, role: 'host', hostKey });
    expect(await host.next((m) => m.type === 'welcome')).toMatchObject({ role: 'host' });
    let snap = await host.snapshot();
    const first = snap.queue[0]!;

    host.send({ type: 'play' });
    host.send({ type: 'started', songId: first.track.id, sourceId: first.sourceIds[0], actualDurationSec: 230 });
    snap = await host.snapshot((r) => r.nowPlaying?.track.id === first.track.id);
    expect(snap.status).toBe('playing');
    expect(snap.queue.find((q) => q.track.id === first.track.id)).toBeUndefined();

    const guest = await connect({ type: 'hello', room: code, role: 'guest', name: 'Sara', guestId: 'guest-sara-1' });
    await guest.next((m) => m.type === 'welcome');
    const other = await connect({ type: 'hello', room: code, role: 'guest', name: 'Ali', guestId: 'guest-ali-1' });
    await other.next((m) => m.type === 'welcome');

    guest.send({ type: 'request', songId: 'gasolina' });
    const toast = await guest.next((m) => m.type === 'toast');
    expect(toast).toMatchObject({ tone: 'success' });
    snap = await host.snapshot((r) => r.requests.length === 1);
    expect(snap.requests[0]).toMatchObject({ requestedBy: 'Sara', votes: 1 });
    const queued = snap.queue.find((q) => q.track.id === 'gasolina');
    expect(queued?.requestedBy).toBe('Sara');
    expect(snap.queue.indexOf(queued!)).toBeLessThanOrEqual(1);

    other.send({ type: 'vote', requestId: snap.requests[0]!.id });
    snap = await host.snapshot((r) => r.requests[0]?.votes === 2);

    // Host transitions into the request; it is consumed and credited.
    time += 80_000;
    host.send({ type: 'started', songId: 'gasolina', sourceId: queued!.sourceIds[0], previous: { songId: first.track.id, outcome: 'completed', listenedSec: 80 } });
    snap = await host.snapshot((r) => r.nowPlaying?.track.id === 'gasolina');
    expect(snap.nowPlaying?.requestedBy).toBe('Sara');
    expect(snap.requests).toHaveLength(0);
    expect(snap.history[0]).toMatchObject({ outcome: 'completed' });
    expect(snap.guestCount).toBe(2);
  });

  it('guests cannot re-request a song that just played', async () => {
    const { code, hostKey } = await createRoom();
    const host = await connect({ type: 'hello', room: code, role: 'host', hostKey });
    const snap = await host.snapshot();
    const a = snap.queue[0]!;
    const b = snap.queue[1]!;
    host.send({ type: 'started', songId: a.track.id, sourceId: a.sourceIds[0] });
    host.send({ type: 'started', songId: b.track.id, sourceId: b.sourceIds[0], previous: { songId: a.track.id, outcome: 'completed', listenedSec: 70 } });
    await host.snapshot((r) => r.nowPlaying?.track.id === b.track.id);
    const g = await connect({ type: 'hello', room: code, role: 'guest', name: 'Z' });
    await g.next((m) => m.type === 'welcome');
    g.send({ type: 'request', songId: a.track.id });
    expect(await g.next((m) => m.type === 'toast')).toMatchObject({ tone: 'warn', text: expect.stringMatching(/played/) });
  });

  it('crowd skip vote sends a skip command to the host', async () => {
    const { code, hostKey } = await createRoom();
    const host = await connect({ type: 'hello', room: code, role: 'host', hostKey });
    const snap = await host.snapshot();
    host.send({ type: 'started', songId: snap.queue[0]!.track.id, sourceId: snap.queue[0]!.sourceIds[0] });
    const guests = await Promise.all(['g-aaaaaa1', 'g-bbbbbb2', 'g-cccccc3'].map((guestId) => connect({ type: 'hello', room: code, role: 'guest', guestId, name: guestId })));
    for (const g of guests) await g.next((m) => m.type === 'welcome');
    guests[0]!.send({ type: 'skipVote' });
    guests[0]!.send({ type: 'skipVote' }); // duplicate is ignored
    await host.snapshot((r) => r.skipVotes === 1 && r.skipThreshold === 2);
    guests[1]!.send({ type: 'skipVote' });
    expect(await host.next((m) => m.type === 'command')).toEqual({ type: 'command', command: 'skip' });
  });

  it('preloading locks the next track against re-planning; host can still override', async () => {
    const { code, hostKey } = await createRoom();
    const host = await connect({ type: 'hello', room: code, role: 'host', hostKey });
    let snap = await host.snapshot();
    host.send({ type: 'started', songId: snap.queue[0]!.track.id, sourceId: snap.queue[0]!.sourceIds[0] });
    snap = await host.snapshot((r) => !!r.nowPlaying);
    const next = snap.queue[0]!.track.id;
    host.send({ type: 'preloading', songId: next });
    snap = await host.snapshot((r) => r.queue[0]!.locked);
    host.send({ type: 'energy', delta: 1 });
    host.send({ type: 'energy', delta: 1 });
    snap = await host.snapshot((r) => r.intent.energyBias === 2);
    expect(snap.queue[0]!.track.id).toBe(next);
    host.send({ type: 'playNext', songId: 'kala-chashma' });
    snap = await host.snapshot((r) => r.queue[0]!.track.id === 'kala-chashma');
    expect(snap.queue[0]!.reasons).toContain('Host pick');
  });

  it('a song whose sources all fail is dropped from the plan', async () => {
    const { code, hostKey } = await createRoom();
    const host = await connect({ type: 'hello', room: code, role: 'host', hostKey });
    let snap = await host.snapshot();
    const victim = snap.queue[0]!;
    for (const src of victim.sourceIds) host.send({ type: 'sourceFailed', songId: victim.track.id, sourceId: src, code: 150 });
    snap = await host.snapshot((r) => !r.queue.some((q) => q.track.id === victim.track.id));
    expect(ctx.store.catalog.get(victim.track.id)!.review).toBe('no-playable-source');
  });

  it('host dislike removes the song for the night and is remembered globally', async () => {
    const { code, hostKey } = await createRoom();
    const host = await connect({ type: 'hello', room: code, role: 'host', hostKey });
    const snap = await host.snapshot();
    const target = snap.queue[2]!.track.id;
    host.send({ type: 'feedback', songId: target, kind: 'dislike' });
    await host.snapshot((r) => !r.queue.some((q) => q.track.id === target));
    expect(ctx.store.getStats(target)!.dislikes).toBe(1);
  });

  it('rate-limits floods from a single connection', async () => {
    const { code } = await createRoom();
    const g = await connect({ type: 'hello', room: code, role: 'guest', name: 'Spammy' });
    await g.next((m) => m.type === 'welcome');
    for (let i = 0; i < 40; i++) g.send({ type: 'react', kind: 'fire' });
    expect(await g.next((m) => m.type === 'error')).toMatchObject({ message: expect.stringMatching(/slow down/i) });
  });
});

describe('recovery', () => {
  it('re-starting the current song without a hand-off is a resume, not a new history entry', async () => {
    const { code, hostKey } = await createRoom();
    const host = await connect({ type: 'hello', room: code, role: 'host', hostKey });
    const snap = await host.snapshot();
    const a = snap.queue[0]!;
    host.send({ type: 'started', songId: a.track.id, sourceId: a.sourceIds[0] });
    await host.snapshot((r) => r.nowPlaying?.track.id === a.track.id);
    time += 30_000;
    host.send({ type: 'started', songId: a.track.id, sourceId: a.sourceIds[0] });
    const after = await host.snapshot((r) => r.nowPlaying?.startedAt === time);
    expect(after.history).toHaveLength(0);
  });

  it('restores a room from SQLite after a restart (paused, history intact)', async () => {
    const { code, hostKey } = await createRoom({ occasion: 'sangeet' });
    const host = await connect({ type: 'hello', room: code, role: 'host', hostKey });
    const snap = await host.snapshot();
    host.send({ type: 'play' });
    host.send({ type: 'started', songId: snap.queue[0]!.track.id, sourceId: snap.queue[0]!.sourceIds[0] });
    await host.snapshot((r) => !!r.nowPlaying);
    ctx.rooms.flush();
    const room = ctx.rooms.get(code)!;
    ctx.rooms.persist(room);

    // A fresh manager over the same DB simulates a process restart.
    const fresh = new RoomManager(ctx.db, ctx.store, ctx.intents, { info() {}, warn() {}, error() {} }, clock);
    const restored = fresh.get(code)!;
    expect(restored.state.intent.occasion).toBe('sangeet');
    expect(restored.state.status).toBe('paused');
    expect(restored.state.now?.songId).toBe(snap.queue[0]!.track.id);
    expect(fresh.checkHostKey(code, hostKey)).toBe(true);
    expect(fresh.checkHostKey(code, hostKey + 'x')).toBe(false);
  });
});
