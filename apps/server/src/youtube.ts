/**
 * YouTube integration, using only official/public endpoints:
 *  - oEmbed (no key): validates a video is public + embeddable and gives its title.
 *  - Data API v3 (optional, YOUTUBE_API_KEY): search and durations.
 * Playback itself happens in the host's browser through the official IFrame
 * Player API; we never download or proxy media.
 */

export function parseYouTubeId(input: string): string | null {
  const s = input.trim();
  if (/^[A-Za-z0-9_-]{11}$/.test(s)) return s;
  try {
    const u = new URL(s);
    const host = u.hostname.replace(/^www\.|^m\.|^music\./, '');
    if (host === 'youtu.be') return valid(u.pathname.slice(1, 12));
    if (host === 'youtube.com' || host === 'youtube-nocookie.com') {
      if (u.searchParams.get('v')) return valid(u.searchParams.get('v')!);
      const m = u.pathname.match(/^\/(?:embed|shorts|live|v)\/([A-Za-z0-9_-]{11})/);
      if (m) return m[1]!;
    }
  } catch {
    /* not a URL */
  }
  return null;
}

const valid = (id: string) => (/^[A-Za-z0-9_-]{11}$/.test(id) ? id : null);

export interface OEmbedResult {
  status: 'ok' | 'unembeddable' | 'unavailable' | 'error';
  title?: string;
  author?: string;
}

export async function oembed(id: string, fetchImpl: typeof fetch = fetch): Promise<OEmbedResult> {
  const url = `https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(`https://www.youtube.com/watch?v=${id}`)}`;
  try {
    const res = await fetchImpl(url, { signal: AbortSignal.timeout(6000) });
    if (res.status === 200) {
      const j = (await res.json()) as { title: string; author_name: string };
      return { status: 'ok', title: j.title, author: j.author_name };
    }
    if (res.status === 401 || res.status === 403) return { status: 'unembeddable' };
    if (res.status === 404 || res.status === 400) return { status: 'unavailable' };
    return { status: 'error' };
  } catch {
    return { status: 'error' };
  }
}

/** "Kala Chashma | Baar Baar Dekho | Sidharth M Katrina K | Prem, Hardeep, Badshah" -> "Kala Chashma" */
export function cleanVideoTitle(title: string): string {
  let t = title
    .replace(/\[[^\]]*\]/g, ' ')
    .replace(/\((?:official|full|lyric|lyrical|audio|video|hd|4k|music video)[^)]*\)/gi, ' ');
  t = t.split(/\s[|•]\s|\s-\s(?=(?:official|full|lyric|lyrical|video|audio))/i)[0] ?? t;
  t = t.replace(/\b(official (music )?video|full (video|song|audio)|lyrical( video)?|lyrics?|audio song|video song|hd|4k)\b/gi, ' ');
  return t.replace(/\s{2,}/g, ' ').replace(/[-–:|]+\s*$/, '').trim() || title.trim();
}

export interface YouTubeSearchHit {
  id: string;
  title: string;
  channel: string;
  thumbnail: string;
  durationSec?: number;
}

export async function searchYouTube(query: string, apiKey: string, fetchImpl: typeof fetch = fetch): Promise<YouTubeSearchHit[]> {
  const params = new URLSearchParams({
    part: 'snippet',
    type: 'video',
    videoEmbeddable: 'true',
    videoCategoryId: '10', // Music
    maxResults: '8',
    q: query,
    key: apiKey,
  });
  const res = await fetchImpl(`https://www.googleapis.com/youtube/v3/search?${params}`, { signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(`YouTube search failed: HTTP ${res.status}`);
  const data = (await res.json()) as {
    items: Array<{ id: { videoId: string }; snippet: { title: string; channelTitle: string; thumbnails: { high?: { url: string } } } }>;
  };
  const hits = data.items.map((i) => ({
    id: i.id.videoId,
    title: decodeEntities(i.snippet.title),
    channel: i.snippet.channelTitle,
    thumbnail: i.snippet.thumbnails.high?.url ?? `https://i.ytimg.com/vi/${i.id.videoId}/hqdefault.jpg`,
  }));
  const durations = await videoDurations(hits.map((h) => h.id), apiKey, fetchImpl).catch(() => ({}) as Record<string, number>);
  return hits.map((h) => ({ ...h, durationSec: durations[h.id] }));
}

export async function videoDurations(ids: string[], apiKey: string, fetchImpl: typeof fetch = fetch): Promise<Record<string, number>> {
  if (ids.length === 0) return {};
  const params = new URLSearchParams({ part: 'contentDetails', id: ids.join(','), key: apiKey });
  const res = await fetchImpl(`https://www.googleapis.com/youtube/v3/videos?${params}`, { signal: AbortSignal.timeout(8000) });
  if (!res.ok) return {};
  const data = (await res.json()) as { items: Array<{ id: string; contentDetails: { duration: string } }> };
  return Object.fromEntries(data.items.map((i) => [i.id, isoDurationToSec(i.contentDetails.duration)]));
}

export function isoDurationToSec(iso: string): number {
  const m = iso.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
  if (!m) return 0;
  return Number(m[1] ?? 0) * 3600 + Number(m[2] ?? 0) * 60 + Number(m[3] ?? 0);
}

function decodeEntities(s: string): string {
  return s.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>');
}
