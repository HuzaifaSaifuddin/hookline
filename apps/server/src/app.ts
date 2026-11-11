import fs from 'node:fs';
import os from 'node:os';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import websocket from '@fastify/websocket';
import fastifyStatic from '@fastify/static';
import { z } from 'zod';
import {
  ARCS,
  CreateRoomSchema,
  OCCASIONS,
  artworkUrl,
  defaultIntent,
  isAutoPlayable,
  slugify,
  type CreateRoomResult,
  type MetaResponse,
  type ServerMessage,
  type Song,
  type SongDetail,
} from '@hookline/core';
import type { Config } from './config.ts';
import { openDatabase, type DB } from './db.ts';
import { CatalogStore } from './catalog-store.ts';
import { RoomManager } from './room-manager.ts';
import { cleanVideoTitle, oembed, parseYouTubeId, searchYouTube, videoDurations } from './youtube.ts';

export interface AppContext {
  app: FastifyInstance;
  db: DB;
  store: CatalogStore;
  rooms: RoomManager;
}

export interface BuildOptions {
  /** Override for tests (e.g. stub oEmbed). */
  fetchImpl?: typeof fetch;
  clock?: () => number;
  studioKey?: string;
}

export async function buildApp(config: Config, opts: BuildOptions = {}): Promise<AppContext> {
  const app = Fastify({
    logger: { level: config.logLevel },
    bodyLimit: 64 * 1024,
    trustProxy: true,
  });

  const db = openDatabase(config.dbFile);
  const fetchImpl = opts.fetchImpl ?? fetch;
  const store = new CatalogStore(db, config.catalogDir, (id) => oembed(id, fetchImpl));
  const report = store.load();
  app.log.info(report.invalid.length ? { ...report, invalid: report.invalid.slice(0, 10) } : report, 'catalogue loaded');

  const rooms = new RoomManager(db, store, app.log, opts.clock);
  const studioKey = opts.studioKey ?? process.env.HOOKLINE_STUDIO_KEY;

  await app.register(websocket, { options: { maxPayload: 16 * 1024 } });

  const requireStudio = async (req: FastifyRequest, reply: FastifyReply) => {
    if (studioKey && req.headers['x-studio-key'] !== studioKey) return reply.code(401).send({ error: 'Studio key required' });
  };

  // ------------------------------------------------------------------ meta

  app.get('/api/health', async () => ({
    ok: true,
    catalog: store.catalog.size,
    ...rooms.stats(),
    uptimeSec: Math.round(process.uptime()),
  }));

  app.get('/api/meta', async (): Promise<MetaResponse> => {
    const all = store.catalog.all();
    return {
      occasions: OCCASIONS.map(({ id, name, emoji, blurb, arc, style }) => ({ id, name, emoji, blurb, arc, style })),
      arcs: ARCS,
      languages: store.catalog.languages(),
      catalogSize: all.length,
      playableCount: all.filter(isAutoPlayable).length,
      youtubeSearchEnabled: !!config.youtubeApiKey,
      publicUrl: config.publicUrl,
      lanHosts: lanAddresses(),
      studioLocked: !!studioKey,
    };
  });

  // ------------------------------------------------------------------ rooms

  app.post('/api/rooms', async (req, reply): Promise<CreateRoomResult | void> => {
    const body = CreateRoomSchema.safeParse(req.body ?? {});
    if (!body.success) return reply.code(400).send({ error: body.error.issues[0]?.message });
    const { occasion, languages, style, arc } = body.data;
    const intent = defaultIntent(occasion ?? 'house-party', languages ?? []);
    if (style) intent.style = style;
    if (arc) intent.arc = arc;
    const { room, hostKey } = rooms.create(intent);
    return { code: room.code, hostKey };
  });

  app.get('/api/rooms/:code', async (req, reply) => {
    const { code } = req.params as { code: string };
    const room = rooms.get(code);
    if (!room) return reply.code(404).send({ error: 'Party not found' });
    return room.snapshot(rooms.guestCount(room.code), rooms.hostOnline(room.code));
  });

  // ------------------------------------------------------------------ catalogue

  const trackView = (s: Song) => ({
    id: s.id,
    title: s.title,
    artists: s.artists,
    language: s.language,
    energy: s.energy,
    artwork: artworkUrl(s),
    durationSec: s.durationSec,
    tags: s.tags,
  });

  app.get('/api/search', async (req) => {
    const q = z.object({ q: z.string().max(100).default(''), limit: z.coerce.number().int().min(1).max(50).default(20) }).parse(req.query);
    if (!q.q.trim()) return [];
    return store.catalog.search(q.q, { limit: q.limit }).map(trackView);
  });

  const detail = (s: Song): SongDetail => ({
    id: s.id,
    title: s.title,
    artists: s.artists,
    language: s.language,
    energy: s.energy,
    popularity: s.popularity,
    tags: s.tags,
    durationSec: s.durationSec,
    hook: s.hook,
    review: s.review,
    origin: s.origin,
    artwork: artworkUrl(s),
    sources: s.sources.map((x) => ({ id: x.id, status: x.status, titleMatch: x.titleMatch, providerTitle: x.providerTitle })),
    stats: { plays: 0, completions: 0, earlySkips: 0, likes: 0, dislikes: 0, ...store.getStats(s.id) },
    nudges: store.nudgeCount(s.id),
    autoPlayable: isAutoPlayable(s),
  });

  app.get('/api/catalog', async (req) => {
    const q = z
      .object({
        q: z.string().max(100).default(''),
        filter: z.enum(['all', 'review', 'playable', 'custom', 'no-hook', 'skipped']).default('all'),
        language: z.string().max(30).optional(),
        offset: z.coerce.number().int().min(0).default(0),
        limit: z.coerce.number().int().min(1).max(100).default(40),
      })
      .parse(req.query);
    let songs = q.q.trim() ? store.catalog.search(q.q, { limit: 500, includeUnplayable: true }) : store.catalog.all().sort((a, b) => a.title.localeCompare(b.title));
    if (q.language) songs = songs.filter((s) => s.language === q.language);
    if (q.filter === 'review') songs = songs.filter((s) => s.review);
    if (q.filter === 'playable') songs = songs.filter(isAutoPlayable);
    if (q.filter === 'custom') songs = songs.filter((s) => s.origin === 'user');
    if (q.filter === 'no-hook') songs = songs.filter((s) => !s.hook || s.hook.source === 'default');
    if (q.filter === 'skipped') {
      songs = songs
        .filter((s) => (store.getStats(s.id)?.earlySkips ?? 0) > 0)
        .sort((a, b) => (store.getStats(b.id)?.earlySkips ?? 0) - (store.getStats(a.id)?.earlySkips ?? 0));
    }
    return { total: songs.length, items: songs.slice(q.offset, q.offset + q.limit).map(detail) };
  });

  app.get('/api/songs/:id', async (req, reply) => {
    const s = store.catalog.get((req.params as { id: string }).id);
    if (!s) return reply.code(404).send({ error: 'Song not found' });
    return detail(s);
  });

  app.put('/api/songs/:id/hook', { preHandler: requireStudio }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = z
      .object({ startSec: z.number().min(0).max(36000), endSec: z.number().min(1).max(36000) })
      .refine((b) => b.endSec - b.startSec >= 10, 'Hook must be at least 10 seconds')
      .safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: body.error.issues[0]?.message });
    const s = store.catalog.get(id);
    if (!s) return reply.code(404).send({ error: 'Song not found' });
    if (s.durationSec && body.data.endSec > s.durationSec + 1) return reply.code(400).send({ error: 'Hook ends after the song' });
    const updated = store.setCuratorHook(id, body.data.startSec, body.data.endSec)!;
    req.log.info({ song: id, ...body.data }, 'curator hook saved');
    return detail(updated);
  });

  app.delete('/api/songs/:id/hook', { preHandler: requireStudio }, async (req, reply) => {
    const s = store.clearCuratorHook((req.params as { id: string }).id);
    if (!s) return reply.code(404).send({ error: 'Song not found' });
    return detail(s);
  });

  app.post('/api/songs/:id/verify', { preHandler: requireStudio }, async (req, reply) => {
    const s = store.markVerified((req.params as { id: string }).id);
    if (!s) return reply.code(404).send({ error: 'Song not found' });
    return detail(s);
  });

  app.post('/api/songs/import', { preHandler: requireStudio }, async (req, reply) => {
    const body = z
      .object({
        url: z.string().min(5).max(300),
        title: z.string().trim().min(1).max(120).optional(),
        artists: z.array(z.string().trim().min(1).max(80)).max(8).optional(),
        language: z.string().trim().toLowerCase().regex(/^[a-z-]+$/).max(30),
        energy: z.number().int().min(1).max(10).default(8),
        tags: z.array(z.string().max(30)).max(10).default(['party']),
      })
      .safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: body.error.issues[0]?.message });
    const videoId = parseYouTubeId(body.data.url);
    if (!videoId) return reply.code(400).send({ error: "That doesn't look like a YouTube link" });
    const existing = store.findBySourceId(videoId);
    if (existing) return reply.code(409).send({ error: `Already in the catalogue as "${existing.title}"`, song: detail(existing) });

    const info = await oembed(videoId, fetchImpl);
    if (info.status === 'unembeddable') return reply.code(422).send({ error: "This video's owner doesn't allow it to be played in other apps" });
    if (info.status === 'unavailable') return reply.code(422).send({ error: 'Video is private, deleted or does not exist' });
    if (info.status === 'error') return reply.code(502).send({ error: 'Could not reach YouTube to verify the video. Try again.' });

    const title = body.data.title ?? cleanVideoTitle(info.title ?? 'Untitled');
    let id = slugify(title);
    for (let i = 2; store.hasId(id); i++) id = `${slugify(title)}-${i}`;
    let durationSec: number | undefined;
    if (config.youtubeApiKey) durationSec = (await videoDurations([videoId], config.youtubeApiKey, fetchImpl).catch(() => ({})) as Record<string, number>)[videoId];

    const song = store.addCustomSong(
      {
        id,
        title,
        artists: body.data.artists?.length ? body.data.artists : [info.author?.replace(/\s*-\s*Topic$|VEVO$/i, '').trim() || 'Unknown'],
        language: body.data.language,
        durationSec: durationSec || undefined,
        energy: body.data.energy,
        tags: body.data.tags,
        sources: [{ provider: 'youtube', id: videoId }],
        provenance: { origin: 'user', importedAt: new Date().toISOString().slice(0, 10) },
        verified: true,
      },
      info.title,
    );
    req.log.info({ song: song.id, videoId }, 'song imported');
    return detail(song);
  });

  app.get('/api/youtube/search', async (req, reply) => {
    if (!config.youtubeApiKey) return reply.code(501).send({ error: 'YouTube search is not configured (set YOUTUBE_API_KEY). Paste a link instead.' });
    const q = z.object({ q: z.string().trim().min(1).max(100) }).safeParse(req.query);
    if (!q.success) return reply.code(400).send({ error: 'q is required' });
    try {
      return await searchYouTube(q.data.q, config.youtubeApiKey, fetchImpl);
    } catch (err) {
      req.log.warn({ err: String(err) }, 'youtube search failed');
      return reply.code(502).send({ error: 'YouTube search failed' });
    }
  });

  app.get('/api/insights', async () => {
    const top = db
      .prepare(
        `SELECT song_id, COUNT(*) plays, SUM(outcome='completed') completions, SUM(outcome='skipped') skips
           FROM play_events GROUP BY song_id ORDER BY plays DESC LIMIT 15`,
      )
      .all() as Array<{ song_id: string; plays: number; completions: number; skips: number }>;
    const failing = db
      .prepare('SELECT song_id, source_id, failures, last_code FROM source_health WHERE failures > 0 ORDER BY failures DESC LIMIT 20')
      .all() as Array<{ song_id: string; source_id: string; failures: number; last_code: number }>;
    const totals = db.prepare(`SELECT COUNT(*) plays, COUNT(DISTINCT room) rooms FROM play_events`).get() as { plays: number; rooms: number };
    const name = (id: string) => store.catalog.get(id)?.title ?? id;
    return {
      totals,
      top: top.map((t) => ({ ...t, title: name(t.song_id) })),
      failing: failing.map((f) => ({ ...f, title: name(f.song_id) })),
      catalog: store.report,
    };
  });

  // ------------------------------------------------------------------ realtime

  app.get('/ws', { websocket: true }, (socket, req) => {
    const send = (m: ServerMessage) => {
      if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(m));
    };
    const peer = rooms.newPeer(send, () => socket.close());
    const alive = { v: true };
    socket.on('pong', () => (alive.v = true));
    const ping = setInterval(() => {
      if (!alive.v) return socket.terminate();
      alive.v = false;
      socket.ping();
    }, 25_000);
    socket.on('message', (raw: Buffer) => {
      rooms.onMessage(peer, raw.toString()).catch((err) => req.log.error({ err: String(err) }, 'ws handler error'));
    });
    socket.on('close', () => {
      clearInterval(ping);
      rooms.disconnect(peer);
    });
  });

  // ------------------------------------------------------------------ web app

  if (fs.existsSync(config.webDist)) {
    await app.register(fastifyStatic, { root: config.webDist, wildcard: false });
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith('/api/') || req.url.startsWith('/ws')) return reply.code(404).send({ error: 'Not found' });
      return reply.type('text/html').sendFile('index.html');
    });
  }

  const sweep = setInterval(() => rooms.sweep(), 5 * 60_000);
  app.addHook('onClose', async () => {
    clearInterval(sweep);
    rooms.flush();
    db.close();
  });

  return { app, db, store, rooms };
}

function lanAddresses(): string[] {
  const out: string[] = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const i of list ?? []) if (i.family === 'IPv4' && !i.internal) out.push(i.address);
  }
  return out;
}

