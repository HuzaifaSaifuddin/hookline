/** Minimal typings + loader for the official YouTube IFrame Player API. */

export interface YTPlayer {
  loadVideoById(o: { videoId: string; startSeconds?: number; endSeconds?: number }): void;
  cueVideoById(o: { videoId: string; startSeconds?: number }): void;
  playVideo(): void;
  pauseVideo(): void;
  stopVideo(): void;
  seekTo(s: number, allowSeekAhead: boolean): void;
  setVolume(v: number): void;
  getVolume(): number;
  mute(): void;
  unMute(): void;
  isMuted(): boolean;
  getCurrentTime(): number;
  getDuration(): number;
  getPlayerState(): number;
  getVideoData?(): { video_id: string; title: string };
  destroy(): void;
}

export const YTState = { UNSTARTED: -1, ENDED: 0, PLAYING: 1, PAUSED: 2, BUFFERING: 3, CUED: 5 } as const;

declare global {
  interface Window {
    YT?: { Player: new (el: HTMLElement | string, opts: unknown) => YTPlayer };
    onYouTubeIframeAPIReady?: () => void;
  }
}

let apiPromise: Promise<void> | null = null;

export function loadYouTubeApi(): Promise<void> {
  if (window.YT?.Player) return Promise.resolve();
  if (apiPromise) return apiPromise;
  apiPromise = new Promise<void>((resolve, reject) => {
    const prev = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => {
      prev?.();
      resolve();
    };
    const s = document.createElement('script');
    s.src = 'https://www.youtube.com/iframe_api';
    s.async = true;
    s.onerror = () => {
      apiPromise = null;
      reject(new Error('Could not load the YouTube player. Check your connection or ad-blocker.'));
    };
    document.head.appendChild(s);
  });
  return apiPromise;
}

export function createPlayer(
  el: HTMLElement,
  handlers: { onReady: () => void; onStateChange: (s: number) => void; onError: (code: number) => void },
): YTPlayer {
  return new window.YT!.Player(el, {
    width: '100%',
    height: '100%',
    playerVars: {
      autoplay: 0,
      controls: 0,
      disablekb: 1,
      fs: 0,
      playsinline: 1,
      rel: 0,
      iv_load_policy: 3,
      modestbranding: 1,
      origin: location.origin,
    },
    events: {
      onReady: handlers.onReady,
      onStateChange: (e: { data: number }) => handlers.onStateChange(e.data),
      onError: (e: { data: number }) => handlers.onError(e.data),
    },
  });
}

/** YouTube error codes -> human text. 101/150 = embedding disabled by owner. */
export function describeYTError(code: number): string {
  switch (code) {
    case 2:
      return 'invalid video id';
    case 5:
      return 'HTML5 player error';
    case 100:
      return 'video removed or private';
    case 101:
    case 150:
      return 'owner blocks playback in other apps';
    case -1:
      return 'timed out loading';
    default:
      return `player error ${code}`;
  }
}
