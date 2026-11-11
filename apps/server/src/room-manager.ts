import crypto from 'node:crypto';
import {
  GuestMessageSchema,
  HelloSchema,
  HostMessageSchema,
  type ServerMessage,
  type SetIntent,
} from '@hookline/core';
import type { CatalogStore } from './catalog-store.ts';
import type { DB } from './db.ts';
import { Room, type Effects, type RoomState } from './room.ts';

export interface Peer {
  id: string;
  role: 'host' | 'guest' | 'pending';
  guestId: string;
  name: string;
  room?: string;
  send(msg: ServerMessage): void;
  close(): void;
  /** Token bucket for rate limiting. */
  tokens: number;
  lastRefill: number;
}

interface Logger {
  info(o: object, msg?: string): void;
  warn(o: object, msg?: string): void;
  error(o: object, msg?: string): void;
}

/** Room code alphabet: no 0/O, 1/I/L, so codes survive being read aloud at a loud party. */
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const ROOM_MAX_AGE_MS = 7 * 24 * 60 * 60_000;
const RATE = { capacity: 20, refillPerSec: 2 };

export class RoomManager {
  private rooms = new Map<string, Room>();
  private hostKeys = new Map<string, string>();
  private peers = new Map<string, Set<Peer>>();
  private broadcastTimers = new Map<string, NodeJS.Timeout>();
  private persistTimers = new Map<string, NodeJS.Timeout>();

  constructor(
    private db: DB,
    private store: CatalogStore,
    private log: Logger,
    private clock: () => number = Date.now,
  ) {}

  // ------------------------------------------------------------- lifecycle

  create(intent: SetIntent): { room: Room; hostKey: string } {
    let code: string;
    do code = randomCode(4);
    while (this.rooms.has(code) || this.db.prepare('SELECT 1 FROM rooms WHERE code = ?').get(code));
    const hostKey = crypto.randomBytes(18).toString('base64url');
    const room = Room.create(code, intent, this.store, this.clock);
    this.rooms.set(code, room);
    this.hostKeys.set(code, hostKey);
    this.db
      .prepare('INSERT INTO rooms (code, host_key, state, created_at, updated_at) VALUES (?,?,?,?,?)')
      .run(code, hostKey, JSON.stringify(room.state), room.state.createdAt, this.clock());
    this.log.info({ room: code, occasion: intent.occasion }, 'room created');
    return { room, hostKey };
  }

  get(code: string): Room | undefined {
    const c = code.toUpperCase();
    const live = this.rooms.get(c);
    if (live) return live;
    const row = this.db.prepare('SELECT host_key, state, updated_at FROM rooms WHERE code = ?').get(c) as
      | { host_key: string; state: string; updated_at: number }
      | undefined;
    if (!row || this.clock() - row.updated_at > ROOM_MAX_AGE_MS) return undefined;
    try {
      const state = JSON.parse(row.state) as RoomState;
      // After a restart the host's browser must re-engage playback (autoplay rules).
      if (state.status === 'playing') state.status = 'paused';
      const room = new Room(state, this.store, this.clock);
      this.rooms.set(c, room);
      this.hostKeys.set(c, row.host_key);
      this.log.info({ room: c }, 'room restored from disk');
      return room;
    } catch (err) {
      this.log.error({ room: c, err: String(err) }, 'failed to restore room');
      return undefined;
    }
  }

  checkHostKey(code: string, key: string | undefined): boolean {
    const expected = this.hostKeys.get(code.toUpperCase());
    if (!expected || !key) return false;
    const a = Buffer.from(expected);
    const b = Buffer.from(key);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  }

  // ------------------------------------------------------------- peers

  newPeer(send: (m: ServerMessage) => void, close: () => void): Peer {
    return {
      id: crypto.randomUUID(),
      role: 'pending',
      guestId: '',
      name: '',
      send,
      close,
      tokens: RATE.capacity,
      lastRefill: this.clock(),
    };
  }

  guestCount(code: string): number {
    const ids = new Set<string>();
    for (const p of this.peers.get(code) ?? []) if (p.role === 'guest') ids.add(p.guestId);
    return ids.size;
  }

  hostOnline(code: string): boolean {
    for (const p of this.peers.get(code) ?? []) if (p.role === 'host') return true;
    return false;
  }

  disconnect(peer: Peer): void {
    if (!peer.room) return;
    const set = this.peers.get(peer.room);
    set?.delete(peer);
    if (set && set.size === 0) this.peers.delete(peer.room);
    this.scheduleBroadcast(peer.room);
  }

  async onMessage(peer: Peer, raw: string): Promise<void> {
    if (!this.takeToken(peer)) {
      peer.send({ type: 'error', message: 'Slow down a little 🙂' });
      return;
    }
    let data: unknown;
    try {
      data = JSON.parse(raw);
    } catch {
      peer.send({ type: 'error', message: 'Invalid message' });
      return;
    }

    if (peer.role === 'pending') {
      const hello = HelloSchema.safeParse(data);
      if (!hello.success) return peer.send({ type: 'error', message: 'Say hello first' });
      const room = this.get(hello.data.room);
      if (!room) {
        peer.send({ type: 'error', message: 'Party not found. Check the code.' });
        return peer.close();
      }
      if (hello.data.role === 'host' && !this.checkHostKey(room.code, hello.data.hostKey)) {
        peer.send({ type: 'error', message: 'Not authorised to control this party' });
        return peer.close();
      }
      peer.role = hello.data.role;
      peer.room = room.code;
      peer.guestId = hello.data.guestId && /^[\w-]{6,64}$/.test(hello.data.guestId) ? hello.data.guestId : crypto.randomUUID();
      peer.name = hello.data.role === 'host' ? 'DJ' : sanitizeName(hello.data.name) ?? `Guest ${peer.guestId.slice(0, 3).toUpperCase()}`;
      let set = this.peers.get(room.code);
      if (!set) this.peers.set(room.code, (set = new Set()));
      set.add(peer);
      peer.send({ type: 'welcome', role: peer.role, guestId: peer.guestId, name: peer.name });
      peer.send({ type: 'snapshot', room: room.snapshot(this.guestCount(room.code), this.hostOnline(room.code)) });
      this.scheduleBroadcast(room.code);
      return;
    }

    const room = peer.room ? this.get(peer.room) : undefined;
    if (!room) return peer.send({ type: 'error', message: 'Party has ended' });

    let effects: Effects;
    try {
      effects = peer.role === 'host' ? await this.handleHost(room, data) : this.handleGuest(room, peer, data);
    } catch (err) {
      this.log.error({ room: room.code, err: String(err) }, 'command failed');
      return peer.send({ type: 'error', message: 'Something went wrong handling that' });
    }
    this.apply(room, effects, peer);
  }

  private async handleHost(room: Room, data: unknown): Promise<Effects> {
    const parsed = HostMessageSchema.safeParse(data);
    if (!parsed.success) return { changed: false, reply: { text: 'Unknown command', tone: 'warn' } };
    const m = parsed.data;
    switch (m.type) {
      case 'play':
        return room.play();
      case 'pause':
        return room.pause();
      case 'started':
        return room.started(m.songId, m.sourceId, m.actualDurationSec, m.previous);
      case 'preloading':
        return room.preloading(m.songId);
      case 'sourceFailed': {
        this.log.warn({ room: room.code, song: m.songId, source: m.sourceId, code: m.code }, 'source failure reported');
        const effects = room.sourceFailed(m.songId, m.sourceId, m.code);
        void this.store
          .confirmSourceFailure(m.songId, m.sourceId, m.code)
          .then((song) => {
            if (!song) return;
            this.log.warn({ song: m.songId, source: m.sourceId }, 'source failure confirmed by YouTube; demoted globally');
            room.replan();
            this.apply(room, { changed: true });
          })
          .catch((err) => this.log.error({ err: String(err) }, 'source confirmation failed'));
        return effects;
      }
      case 'songUnplayable':
        this.log.warn({ room: room.code, song: m.songId }, 'song unplayable');
        return room.songUnplayable(m.songId);
      case 'duration':
        this.store.recordDuration(m.songId, m.durationSec);
        return { changed: false };
      case 'energy':
        return room.energy(m.delta);
      case 'feedback':
        return room.feedback(m.songId, m.kind);
      case 'hookNudge':
        return room.hookNudge(m.songId, m.edge, m.deltaSec);
      case 'intent':
        return room.patchIntent(m.patch);
      case 'queueRemove':
        return room.queueRemove(m.songId);
      case 'playNext':
        return room.playNext(m.songId);
      case 'requestDismiss':
        return room.requestDismiss(m.requestId);
      case 'reshuffle':
        return room.reshuffle();
    }
  }

  private handleGuest(room: Room, peer: Peer, data: unknown): Effects {
    const parsed = GuestMessageSchema.safeParse(data);
    if (!parsed.success) return { changed: false, reply: { text: 'Unknown command', tone: 'warn' } };
    const m = parsed.data;
    switch (m.type) {
      case 'request':
        return room.request(m.songId, peer.guestId, peer.name);
      case 'vote':
        return room.vote(m.requestId, peer.guestId);
      case 'react':
        return room.react(m.kind, peer.guestId);
      case 'skipVote':
        return room.skipVote(peer.guestId, this.guestCount(room.code));
    }
  }

  private apply(room: Room, e: Effects, peer?: Peer): void {
    if (e.reply && peer) peer.send({ type: 'toast', text: e.reply.text, tone: e.reply.tone });
    const peers = this.peers.get(room.code) ?? new Set();
    if (e.toastAll) for (const p of peers) if (p !== peer || !e.reply) p.send({ type: 'toast', text: e.toastAll });
    if (e.commandHost) for (const p of peers) if (p.role === 'host') p.send({ type: 'command', command: e.commandHost });
    if (e.changed) {
      this.scheduleBroadcast(room.code);
      this.schedulePersist(room);
    }
  }

  // ------------------------------------------------------------- fan-out & persistence

  private scheduleBroadcast(code: string): void {
    if (this.broadcastTimers.has(code)) return;
    this.broadcastTimers.set(
      code,
      setTimeout(() => {
        this.broadcastTimers.delete(code);
        const room = this.rooms.get(code);
        const peers = this.peers.get(code);
        if (!room || !peers) return;
        const msg: ServerMessage = { type: 'snapshot', room: room.snapshot(this.guestCount(code), this.hostOnline(code)) };
        for (const p of peers) p.send(msg);
      }, 40),
    );
  }

  private schedulePersist(room: Room): void {
    if (this.persistTimers.has(room.code)) return;
    this.persistTimers.set(
      room.code,
      setTimeout(() => {
        this.persistTimers.delete(room.code);
        this.persist(room);
      }, 1000),
    );
  }

  persist(room: Room): void {
    this.db.prepare('UPDATE rooms SET state = ?, updated_at = ? WHERE code = ?').run(JSON.stringify(room.state), this.clock(), room.code);
  }

  /** Flush pending writes (graceful shutdown). */
  flush(): void {
    for (const [code, t] of this.persistTimers) {
      clearTimeout(t);
      const room = this.rooms.get(code);
      if (room) this.persist(room);
    }
    this.persistTimers.clear();
  }

  /** Drop idle rooms from memory (they stay on disk). */
  sweep(idleMs = 30 * 60_000): void {
    for (const [code, room] of this.rooms) {
      if (this.peers.has(code)) continue;
      const last = room.state.now?.startedAt ?? room.state.createdAt;
      if (this.clock() - last > idleMs) {
        this.persist(room);
        this.rooms.delete(code);
      }
    }
  }

  stats(): { rooms: number; peers: number } {
    let peers = 0;
    for (const s of this.peers.values()) peers += s.size;
    return { rooms: this.rooms.size, peers };
  }

  private takeToken(p: Peer): boolean {
    const now = this.clock();
    p.tokens = Math.min(RATE.capacity, p.tokens + ((now - p.lastRefill) / 1000) * RATE.refillPerSec);
    p.lastRefill = now;
    if (p.tokens < 1) return false;
    p.tokens -= 1;
    return true;
  }
}

function randomCode(n: number): string {
  const bytes = crypto.randomBytes(n);
  let s = '';
  for (let i = 0; i < n; i++) s += CODE_ALPHABET[bytes[i]! % CODE_ALPHABET.length];
  return s;
}

function sanitizeName(name?: string): string | undefined {
  const n = name?.replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 24);
  return n || undefined;
}
