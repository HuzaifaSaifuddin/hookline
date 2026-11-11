import type {
  CreateRoomInput,
  CreateRoomResult,
  IntentParseResult,
  MetaResponse,
  RoomSnapshot,
  SongDetail,
  TrackView,
} from '@hookline/core';

export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const headers: Record<string, string> = { ...(init?.body ? { 'content-type': 'application/json' } : {}) };
  const studioKey = safeGet('hookline.studioKey');
  if (studioKey) headers['x-studio-key'] = studioKey;
  const res = await fetch(path, { ...init, headers: { ...headers, ...(init?.headers as Record<string, string>) } });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, (body as { error?: string }).error ?? `Request failed (${res.status})`);
  return body as T;
}

export const api = {
  meta: () => call<MetaResponse>('/api/meta'),
  parseIntent: (text: string) => call<IntentParseResult>('/api/intent/parse', { method: 'POST', body: JSON.stringify({ text }) }),
  createRoom: (input: CreateRoomInput) => call<CreateRoomResult>('/api/rooms', { method: 'POST', body: JSON.stringify(input) }),
  room: (code: string) => call<RoomSnapshot>(`/api/rooms/${encodeURIComponent(code)}`),
  search: (q: string, limit = 20) => call<TrackView[]>(`/api/search?q=${encodeURIComponent(q)}&limit=${limit}`),
  catalog: (params: Record<string, string | number | undefined>) => {
    const qs = new URLSearchParams(Object.entries(params).filter(([, v]) => v !== undefined && v !== '').map(([k, v]) => [k, String(v)]));
    return call<{ total: number; items: SongDetail[] }>(`/api/catalog?${qs}`);
  },
  song: (id: string) => call<SongDetail>(`/api/songs/${encodeURIComponent(id)}`),
  saveHook: (id: string, startSec: number, endSec: number) =>
    call<SongDetail>(`/api/songs/${encodeURIComponent(id)}/hook`, { method: 'PUT', body: JSON.stringify({ startSec, endSec }) }),
  resetHook: (id: string) => call<SongDetail>(`/api/songs/${encodeURIComponent(id)}/hook`, { method: 'DELETE' }),
  verify: (id: string) => call<SongDetail>(`/api/songs/${encodeURIComponent(id)}/verify`, { method: 'POST' }),
  importSong: (body: { url: string; title?: string; artists?: string[]; language: string; energy: number; tags: string[] }) =>
    call<SongDetail>('/api/songs/import', { method: 'POST', body: JSON.stringify(body) }),
  youtubeSearch: (q: string) =>
    call<Array<{ id: string; title: string; channel: string; thumbnail: string; durationSec?: number }>>(`/api/youtube/search?q=${encodeURIComponent(q)}`),
  insights: () =>
    call<{
      totals: { plays: number; rooms: number };
      top: Array<{ song_id: string; title: string; plays: number; completions: number; skips: number }>;
      failing: Array<{ song_id: string; title: string; source_id: string; failures: number; last_code: number }>;
      catalog: { songs: number; quarantined: number; custom: number; invalid: string[] };
    }>('/api/insights'),
};

export function safeGet(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function safeSet(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* private mode etc. */
  }
}
