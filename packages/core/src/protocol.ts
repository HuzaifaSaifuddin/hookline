import { z } from 'zod';
import { IntentPatchSchema } from './intent.ts';
import type { ArcShape, SetIntent, SetStyle } from './types.ts';

/**
 * Wire protocol between the server (authoritative room state) and clients
 * (host = the device that plays audio; guests = phones in the room).
 *
 * The server pushes full snapshots rather than deltas: a room snapshot is a
 * few KB, updates are human-paced (a few per minute), and full snapshots make
 * reconnects and late joiners trivially correct.
 */

export interface TrackView {
  id: string;
  title: string;
  artists: string[];
  language: string;
  energy: number;
  artwork?: string;
  durationSec?: number;
  tags: string[];
}

export interface PlayWindowView {
  startSec: number;
  endSec: number;
  basis: string;
}

export interface QueueItemView {
  track: TrackView;
  reasons: string[];
  targetEnergy: number;
  window: PlayWindowView;
  /** Playable provider ids, best first. The host tries them in order. */
  sourceIds: string[];
  requestId?: string;
  requestedBy?: string;
  locked: boolean;
}

export interface NowPlayingView extends QueueItemView {
  startedAt: number;
  sourceId: string;
  setOffsetSec: number;
}

export interface HistoryItemView {
  track: TrackView;
  startedAt: number;
  outcome?: 'completed' | 'skipped' | 'error';
  requestedBy?: string;
}

export interface RequestView {
  id: string;
  track: TrackView;
  requestedBy: string;
  votes: number;
  createdAt: number;
  /** Ids of guests who requested/voted — lets a guest know they already voted. */
  voters: string[];
}

export interface RoomSnapshot {
  code: string;
  /** Server clock at snapshot time, so clients can correct for device clock skew. */
  serverTime: number;
  createdAt: number;
  status: 'idle' | 'playing' | 'paused';
  intent: SetIntent;
  intentSummary: string;
  occasion: { id: string; name: string; emoji: string };
  nowPlaying: NowPlayingView | null;
  queue: QueueItemView[];
  history: HistoryItemView[];
  requests: RequestView[];
  guestCount: number;
  hostOnline: boolean;
  energy: {
    phase: string;
    bias: number;
    liveBias: number;
    /** [minute, targetEnergy] for the next ~90 minutes from set start. */
    curve: Array<[number, number]>;
    /** [minute, energy] of tracks actually played. */
    played: Array<[number, number]>;
  };
  reactions: { fire: number; love: number; meh: number };
  skipVotes: number;
  skipThreshold: number;
  elapsedSec: number;
}

// ---------------------------------------------------------------------------
// Client -> server
// ---------------------------------------------------------------------------

const id = z.string().min(1).max(120);

export const HostMessageSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('play') }),
  z.object({ type: z.literal('pause') }),
  z.object({
    type: z.literal('started'),
    songId: id,
    sourceId: id,
    actualDurationSec: z.number().positive().max(36000).optional(),
    previous: z
      .object({
        songId: id,
        outcome: z.enum(['completed', 'skipped', 'error']),
        listenedSec: z.number().min(0).max(36000),
      })
      .optional(),
  }),
  z.object({ type: z.literal('preloading'), songId: id }),
  z.object({ type: z.literal('sourceFailed'), songId: id, sourceId: id, code: z.number().int() }),
  z.object({ type: z.literal('songUnplayable'), songId: id }),
  z.object({ type: z.literal('duration'), songId: id, durationSec: z.number().positive().max(36000) }),
  z.object({ type: z.literal('energy'), delta: z.number().int().min(-1).max(1) }),
  z.object({ type: z.literal('feedback'), songId: id, kind: z.enum(['like', 'dislike']) }),
  z.object({ type: z.literal('hookNudge'), songId: id, edge: z.enum(['start', 'end']), deltaSec: z.number().min(-30).max(30) }),
  z.object({ type: z.literal('intent'), patch: IntentPatchSchema }),
  z.object({ type: z.literal('queueRemove'), songId: id }),
  z.object({ type: z.literal('playNext'), songId: id }),
  z.object({ type: z.literal('requestDismiss'), requestId: id }),
  z.object({ type: z.literal('reshuffle') }),
]);
export type HostMessage = z.infer<typeof HostMessageSchema>;

export const GuestMessageSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('request'), songId: id }),
  z.object({ type: z.literal('vote'), requestId: id }),
  z.object({ type: z.literal('react'), kind: z.enum(['fire', 'love', 'meh']) }),
  z.object({ type: z.literal('skipVote') }),
]);
export type GuestMessage = z.infer<typeof GuestMessageSchema>;

export const HelloSchema = z.object({
  type: z.literal('hello'),
  room: z.string().min(3).max(8),
  role: z.enum(['host', 'guest']),
  hostKey: z.string().max(100).optional(),
  guestId: z.string().max(64).optional(),
  name: z.string().trim().min(1).max(24).optional(),
});
export type Hello = z.infer<typeof HelloSchema>;

export type ClientMessage = Hello | HostMessage | GuestMessage;

// ---------------------------------------------------------------------------
// Server -> client
// ---------------------------------------------------------------------------

export type ServerMessage =
  | { type: 'welcome'; role: 'host' | 'guest'; guestId: string; name: string }
  | { type: 'snapshot'; room: RoomSnapshot }
  | { type: 'command'; command: 'skip' }
  | { type: 'toast'; text: string; tone?: 'info' | 'success' | 'warn' }
  | { type: 'error'; message: string };

// ---------------------------------------------------------------------------
// REST
// ---------------------------------------------------------------------------

export const CreateRoomSchema = z.object({
  occasion: z.string().max(40).optional(),
  languages: z.array(z.string().max(30)).max(10).optional(),
  style: z.enum(['quick', 'hooks', 'full']).optional(),
  arc: z.enum(['build', 'waves', 'peak', 'intervals', 'steady', 'cooldown']).optional(),
});
export type CreateRoomInput = z.infer<typeof CreateRoomSchema>;

export interface CreateRoomResult {
  code: string;
  hostKey: string;
}

export interface MetaResponse {
  occasions: Array<{ id: string; name: string; emoji: string; blurb: string; arc: ArcShape; style: SetStyle }>;
  arcs: Array<{ id: ArcShape; name: string; description: string }>;
  languages: Array<{ language: string; count: number }>;
  catalogSize: number;
  playableCount: number;
  youtubeSearchEnabled: boolean;
  /** Explicit public base URL, if configured. */
  publicUrl?: string;
  /** LAN IPv4 addresses of the server, so phones on the same Wi-Fi can join. */
  lanHosts: string[];
  studioLocked: boolean;
}

export interface SongDetail {
  id: string;
  title: string;
  artists: string[];
  language: string;
  energy: number;
  popularity: number;
  tags: string[];
  durationSec?: number;
  hook?: { startSec: number; endSec: number; source: string };
  review?: string;
  origin: string;
  artwork?: string;
  sources: Array<{ id: string; status: string; titleMatch: number | null; providerTitle?: string }>;
  stats: { plays: number; completions: number; earlySkips: number; likes: number; dislikes: number };
  nudges: number;
  autoPlayable: boolean;
}
