/**
 * Core domain types. This package is pure (no I/O) so the same logic can run
 * on the server, in tests, or in the browser.
 */

export type ProviderId = 'youtube';

/** Health of a playable source as far as we know it. */
export type SourceStatus =
  | 'ok' // verified public + embeddable
  | 'unverified' // never checked (e.g. freshly imported)
  | 'unembeddable' // owner disabled embedding (YouTube 101/150)
  | 'unavailable' // deleted / private / bad id (YouTube 100)
  | 'failing'; // verified once, but players report repeated runtime errors

export interface Source {
  provider: ProviderId;
  id: string;
  status: SourceStatus;
  /** 0..1 similarity between the song title and the provider's title; null = unknown (non-Latin title, unverified). */
  titleMatch: number | null;
  providerTitle?: string;
}

export type HookOrigin = 'seed' | 'curator' | 'crowd' | 'default';

export interface Hook {
  startSec: number;
  endSec: number;
  source: HookOrigin;
}

export interface Song {
  id: string;
  title: string;
  artists: string[];
  language: string;
  /** May be unknown for user-added songs until a player reports it. */
  durationSec?: number;
  hook?: Hook;
  /** 1 (ambient) .. 10 (peak floor-filler). */
  energy: number;
  /** 0..1 how widely recognised the song is (sing-along factor). */
  popularity: number;
  tags: string[];
  sources: Source[];
  origin: string;
  /** Set when the song should not be auto-played until a curator reviews it. */
  review?: 'title-mismatch' | 'no-playable-source';
}

/** How much of each song the DJ plays. */
export type SetStyle = 'quick' | 'hooks' | 'full';

export type ArcShape = 'build' | 'waves' | 'peak' | 'intervals' | 'steady' | 'cooldown';

export interface SetIntent {
  occasion: string;
  /** Hard filter. Empty = any language. */
  languages: string[];
  /** Soft preference ("mostly Punjabi"). */
  preferLanguages: string[];
  arc: ArcShape;
  style: SetStyle;
  /** Persistent energy bias chosen by the host (-3..+3). */
  energyBias: number;
  /** Extra vibe tags to favour (e.g. "retro"). */
  favorTags: string[];
  favorArtists: string[];
  avoidArtists: string[];
  /** Song ids the DJ should try to play early (from "start with X"). */
  seedSongIds: string[];
  /** Human-readable summary of what the DJ understood. */
  summary?: string;
}

export interface PlayedTrack {
  songId: string;
  startedAt: number;
  /** Seconds of the set elapsed when this track started. */
  setOffsetSec: number;
  energy: number;
  language: string;
  artists: string[];
  outcome?: 'completed' | 'skipped' | 'error';
  listenedSec?: number;
}

/** Aggregated long-term signal for a song, across all sessions. */
export interface SongStats {
  plays: number;
  completions: number;
  earlySkips: number;
  likes: number;
  dislikes: number;
  /** Epoch ms of the last time this song was played anywhere. */
  lastPlayedAt?: number;
}

export interface GuestRequest {
  id: string;
  songId: string;
  requestedBy: string;
  voters: string[];
  createdAt: number;
}

/** In-session taste signals coming from host/guest feedback. */
export interface SessionTaste {
  artistAffinity: Record<string, number>;
  languageAffinity: Record<string, number>;
  tagAffinity: Record<string, number>;
  bannedSongIds: string[];
}

export interface TrackPick {
  song: Song;
  score: number;
  /** Short, user-facing explanations, most important first. */
  reasons: string[];
  /** Target energy the planner aimed for at this slot. */
  targetEnergy: number;
  requestId?: string;
}

export const emptyTaste = (): SessionTaste => ({
  artistAffinity: {},
  languageAffinity: {},
  tagAffinity: {},
  bannedSongIds: [],
});
