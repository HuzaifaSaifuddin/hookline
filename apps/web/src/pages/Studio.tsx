import { useCallback, useEffect, useRef, useState } from 'react';
import type { MetaResponse, SongDetail } from '@hookline/core';
import { api, safeGet, safeSet } from '../lib/api.ts';
import { artists, cap, mmss } from '../lib/format.ts';
import { createPlayer, loadYouTubeApi, YTState, type YTPlayer } from '../lib/youtube.ts';
import { Link, Logo, PlaybackOriginNotice, Spinner, Toasts } from '../components/common.tsx';
import type { Toast } from '../lib/useRoom.ts';

type Tab = 'catalog' | 'add';
const FILTERS = [
  ['all', 'All songs'],
  ['review', 'Needs review'],
  ['no-hook', 'No curated hook'],
  ['skipped', 'Often skipped'],
  ['custom', 'Added by you'],
] as const;

function useToasts() {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const toast = useCallback((text: string, tone?: Toast['tone']) => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t.slice(-2), { id, text, tone }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 3500);
  }, []);
  return { toasts, toast };
}

export function Studio() {
  const [tab, setTab] = useState<Tab>('catalog');
  const [meta, setMeta] = useState<MetaResponse | null>(null);
  const [selected, setSelected] = useState<string | null>(() => new URLSearchParams(location.search).get('song'));
  const [refreshKey, setRefreshKey] = useState(0);
  const { toasts, toast } = useToasts();

  useEffect(() => {
    api.meta().then(setMeta, () => {});
  }, []);

  return (
    <div className="shell">
      <div className="topbar">
        <Logo />
        <div className="row wrap">
          <div className="tabs" role="tablist">
            {(
              [
                ['catalog', 'Catalogue'],
                ['add', 'Add songs'],
              ] as const
            ).map(([id, label]) => (
              <button key={id} role="tab" aria-selected={tab === id} onClick={() => setTab(id)}>
                {label}
              </button>
            ))}
          </div>
          <Link to="/" className="btn ghost sm">
            ← DJ
          </Link>
        </div>
      </div>
      <PlaybackOriginNotice />
      {meta?.studioLocked && <StudioKey />}

      {tab === 'catalog' && (
        <div className="studio-grid">
          <SongBrowser meta={meta} selected={selected} onSelect={setSelected} refreshKey={refreshKey} />
          <div style={{ position: 'sticky', top: 16 }}>
            {selected ? (
              <HookEditor key={selected} songId={selected} toast={toast} onChanged={() => setRefreshKey((k) => k + 1)} />
            ) : (
              <div className="card empty">
                <h3 style={{ fontSize: 22, color: 'var(--text)', marginBottom: 8 }}>Hook Studio</h3>
                Pick a song to tune where the DJ drops in and out.
              </div>
            )}
          </div>
        </div>
      )}
      {tab === 'add' && (
        <AddSongs
          meta={meta}
          toast={toast}
          onAdded={(id) => {
            setSelected(id);
            setTab('catalog');
            setRefreshKey((k) => k + 1);
          }}
        />
      )}
      <Toasts toasts={toasts} />
    </div>
  );
}

function StudioKey() {
  const [key, setKey] = useState(() => safeGet('hookline.studioKey') ?? '');
  return (
    <div className="card row wrap" style={{ marginBottom: 16 }}>
      <span className="small muted">This studio is locked. Enter the studio key to make changes:</span>
      <input className="input" style={{ maxWidth: 260 }} type="password" value={key} onChange={(e) => setKey(e.target.value)} />
      <button className="btn sm" onClick={() => safeSet('hookline.studioKey', key)}>
        Save key
      </button>
    </div>
  );
}

function SongBrowser({ meta, selected, onSelect, refreshKey }: { meta: MetaResponse | null; selected: string | null; onSelect: (id: string) => void; refreshKey: number }) {
  const [q, setQ] = useState('');
  const [filter, setFilter] = useState<string>('all');
  const [language, setLanguage] = useState('');
  const [items, setItems] = useState<SongDetail[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);

  const load = useCallback(
    (offset: number) => {
      setLoading(true);
      api
        .catalog({ q, filter, language, offset, limit: 40 })
        .then((r) => {
          setTotal(r.total);
          setItems((prev) => (offset === 0 ? r.items : [...prev, ...r.items]));
        })
        .finally(() => setLoading(false));
    },
    [q, filter, language],
  );

  useEffect(() => {
    const t = setTimeout(() => load(0), 200);
    return () => clearTimeout(t);
  }, [load, refreshKey]);

  return (
    <div className="card stack">
      <div className="row wrap">
        <input className="input grow" style={{ minWidth: 180 }} placeholder="Search title or artist" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search catalogue" />
        <select className="input" style={{ width: 'auto' }} value={filter} onChange={(e) => setFilter(e.target.value)} aria-label="Filter">
          {FILTERS.map(([id, label]) => (
            <option key={id} value={id}>
              {label}
            </option>
          ))}
        </select>
        <select className="input" style={{ width: 'auto' }} value={language} onChange={(e) => setLanguage(e.target.value)} aria-label="Language">
          <option value="">All languages</option>
          {meta?.languages.map((l) => (
            <option key={l.language} value={l.language}>
              {cap(l.language)}
            </option>
          ))}
        </select>
      </div>
      <div className="small faint">{total.toLocaleString()} songs</div>
      <div className="song-list">
        {items.map((s) => (
          <button key={s.id} className="song-item" aria-current={selected === s.id} onClick={() => onSelect(s.id)}>
            <img src={s.artwork} alt="" loading="lazy" />
            <div style={{ minWidth: 0 }}>
              <div className="ellipsis" style={{ fontWeight: 600 }}>
                {s.title}
              </div>
              <div className="small muted ellipsis">
                {artists(s.artists)} · {cap(s.language)}
              </div>
            </div>
            <div className="row" style={{ gap: 4 }}>
              {s.review && <span className="tag warn">review</span>}
              {s.hook?.source === 'curator' && <span className="tag ok">curated</span>}
              {s.hook?.source === 'crowd' && <span className="tag violet">crowd-tuned</span>}
              {s.tags.includes('medley') && <span className="tag">medley</span>}
            </div>
          </button>
        ))}
        {loading && (
          <div className="row" style={{ justifyContent: 'center', padding: 12 }}>
            <Spinner />
          </div>
        )}
        {!loading && items.length < total && (
          <button className="btn ghost" onClick={() => load(items.length)}>
            Load more
          </button>
        )}
        {!loading && items.length === 0 && <div className="empty">No songs match.</div>}
      </div>
    </div>
  );
}

function HookEditor({ songId, toast, onChanged }: { songId: string; toast: (t: string, tone?: Toast['tone']) => void; onChanged: () => void }) {
  const [song, setSong] = useState<SongDetail | null>(null);
  const [srcIdx, setSrcIdx] = useState(0); // best playable upload; chosen once the song loads
  const [inSec, setIn] = useState(0);
  const [outSec, setOut] = useState(60);
  const [pos, setPos] = useState(0);
  const [duration, setDuration] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [saving, setSaving] = useState(false);
  const stageRef = useRef<HTMLDivElement>(null);
  const playerRef = useRef<YTPlayer | null>(null);
  const stopAt = useRef<number | null>(null);

  useEffect(() => {
    api.song(songId).then(
      (s) => {
        setSong(s);
        setIn(s.hook?.startSec ?? 30);
        setOut(s.hook?.endSec ?? 105);
        setDuration(s.durationSec ?? 0);
        const firstOk = s.sources.findIndex((x) => x.status === 'ok');
        setSrcIdx(Math.max(0, firstOk));
      },
      (e: Error) => toast(e.message, 'warn'),
    );
  }, [songId, toast]);

  const videoId = song?.sources[srcIdx]?.id;
  useEffect(() => {
    if (!videoId || !stageRef.current) return;
    let disposed = false;
    const el = document.createElement('div');
    stageRef.current.appendChild(el);
    loadYouTubeApi().then(() => {
      if (disposed) return;
      const p = createPlayer(el, {
        onReady: () => {
          p.cueVideoById({ videoId, startSeconds: inSec });
        },
        onStateChange: (s) => {
          setPlaying(s === YTState.PLAYING);
          const d = p.getDuration();
          if (d > 0) setDuration(d);
        },
        onError: (c) => toast(`This upload can't play here (error ${c}). Try another source.`, 'warn'),
      });
      playerRef.current = p;
    });
    const t = setInterval(() => {
      const p = playerRef.current;
      if (!p?.getCurrentTime) return;
      const t = p.getCurrentTime();
      setPos(t);
      if (stopAt.current !== null && t >= stopAt.current) {
        p.pauseVideo();
        stopAt.current = null;
      }
    }, 150);
    return () => {
      disposed = true;
      clearInterval(t);
      try {
        playerRef.current?.destroy();
      } catch {
        /* noop */
      }
      playerRef.current = null;
      el.remove();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [videoId]);

  const playFrom = (sec: number, until?: number) => {
    const p = playerRef.current;
    if (!p) return;
    stopAt.current = until ?? null;
    p.seekTo(sec, true);
    p.playVideo();
  };

  const total = Math.max(duration || song?.durationSec || outSec + 30, outSec, 1);
  const pct = (s: number) => `${(Math.max(0, Math.min(total, s)) / total) * 100}%`;
  const dirty = song && (song.hook?.startSec !== inSec || song.hook?.endSec !== outSec);

  const save = async () => {
    if (!song) return;
    if (outSec - inSec < 10) return toast('A hook needs at least 10 seconds', 'warn');
    setSaving(true);
    try {
      const s = await api.saveHook(song.id, Math.round(inSec * 10) / 10, Math.round(outSec * 10) / 10);
      setSong(s);
      toast('Hook saved. The DJ will use it from the next play.', 'success');
      onChanged();
    } catch (e) {
      toast((e as Error).message, 'warn');
    } finally {
      setSaving(false);
    }
  };

  if (!song)
    return (
      <div className="card row" style={{ justifyContent: 'center', minHeight: 200 }}>
        <Spinner />
      </div>
    );

  return (
    <div className="card stack">
      <div className="row between wrap" style={{ alignItems: 'flex-start' }}>
        <div className="grow">
          <h3 style={{ fontSize: 26 }}>{song.title}</h3>
          <div className="muted">{song.artists.join(', ')}</div>
        </div>
        <div className="row wrap" style={{ gap: 4 }}>
          <span className="tag">{cap(song.language)}</span>
          <span className="tag">energy {song.energy}</span>
          {song.hook && <span className={`tag ${song.hook.source === 'curator' ? 'ok' : song.hook.source === 'crowd' ? 'violet' : ''}`}>hook: {song.hook.source}</span>}
          {!song.autoPlayable && <span className="tag warn">not in autoplay</span>}
        </div>
      </div>

      {song.review && (
        <div className="card tight stack" style={{ background: 'rgba(251,191,36,0.07)', borderColor: 'rgba(251,191,36,0.3)' }}>
          <div className="small">
            {song.review === 'title-mismatch'
              ? "⚠️ None of this song's YouTube sources seem to match its title, so it may be linked to the wrong video. Preview it: if it's right, confirm it."
              : '⚠️ No playable source. Every upload is unavailable or blocks embedding.'}
          </div>
          {song.review === 'title-mismatch' && (
            <button
              className="btn sm"
              style={{ width: 'fit-content' }}
              onClick={() =>
                api.verify(song.id).then(
                  (s) => {
                    setSong(s);
                    toast('Confirmed. Back in the DJ rotation.', 'success');
                    onChanged();
                  },
                  (e: Error) => toast(e.message, 'warn'),
                )
              }
            >
              ✓ Sources are correct
            </button>
          )}
        </div>
      )}

      <div className="editor-stage" ref={stageRef} />

      <div
        className="timeline"
        role="slider"
        aria-label="Seek"
        aria-valuemin={0}
        aria-valuemax={Math.round(total)}
        aria-valuenow={Math.round(pos)}
        tabIndex={0}
        onClick={(e) => {
          const r = e.currentTarget.getBoundingClientRect();
          playFrom(((e.clientX - r.left) / r.width) * total);
        }}
        onKeyDown={(e) => {
          if (e.key === 'ArrowRight') playFrom(pos + 5);
          if (e.key === 'ArrowLeft') playFrom(Math.max(0, pos - 5));
        }}
      >
        {song.hook && <div className="orig" style={{ left: pct(song.hook.startSec), width: `calc(${pct(song.hook.endSec)} - ${pct(song.hook.startSec)})` }} title="Saved hook" />}
        <div className="sel" style={{ left: pct(inSec), width: `calc(${pct(outSec)} - ${pct(inSec)})` }} />
        <div className="ph" style={{ left: pct(pos) }} />
      </div>
      <div className="row between small mono muted">
        <span>{mmss(pos)}</span>
        <span>
          hook {mmss(inSec)} → {mmss(outSec)} ({Math.round(outSec - inSec)}s)
        </span>
        <span>{mmss(total)}</span>
      </div>

      <div className="row wrap" style={{ gap: 6 }}>
        <button className="btn sm" onClick={() => (playing ? playerRef.current?.pauseVideo() : playFrom(pos))}>
          {playing ? '❚❚ Pause' : '▶ Play'}
        </button>
        <button className="btn sm" onClick={() => playFrom(inSec)}>
          ▶ From IN
        </button>
        <button className="btn sm" onClick={() => playFrom(Math.max(inSec, outSec - 8), outSec)}>
          ▶ Preview OUT
        </button>
      </div>
      <div className="row wrap" style={{ gap: 6 }}>
        <span className="small muted" style={{ width: 34 }}>
          IN
        </span>
        <button className="btn sm" onClick={() => setIn(Math.max(0, inSec - 1))}>
          −1s
        </button>
        <button className="btn sm primary" onClick={() => setIn(Math.min(pos, outSec - 10))}>
          Set at playhead
        </button>
        <button className="btn sm" onClick={() => setIn(Math.min(outSec - 10, inSec + 1))}>
          +1s
        </button>
      </div>
      <div className="row wrap" style={{ gap: 6 }}>
        <span className="small muted" style={{ width: 34 }}>
          OUT
        </span>
        <button className="btn sm" onClick={() => setOut(Math.max(inSec + 10, outSec - 1))}>
          −1s
        </button>
        <button className="btn sm primary" onClick={() => setOut(Math.max(pos, inSec + 10))}>
          Set at playhead
        </button>
        <button className="btn sm" onClick={() => setOut(Math.min(total, outSec + 1))}>
          +1s
        </button>
      </div>
      <div className="row wrap">
        <button className="btn primary" onClick={save} disabled={!dirty || saving}>
          {saving ? 'Saving…' : 'Save hook'}
        </button>
        {song.hook?.source === 'curator' && (
          <button
            className="btn ghost"
            onClick={() =>
              api.resetHook(song.id).then((s) => {
                setSong(s);
                setIn(s.hook?.startSec ?? 30);
                setOut(s.hook?.endSec ?? 105);
                toast('Reverted to the catalogue hook');
                onChanged();
              })
            }
          >
            Revert to original
          </button>
        )}
      </div>

    </div>
  );
}

function AddSongs({ meta, toast, onAdded }: { meta: MetaResponse | null; toast: (t: string, tone?: Toast['tone']) => void; onAdded: (id: string) => void }) {
  const [url, setUrl] = useState('');
  const [title, setTitle] = useState('');
  const [artistsText, setArtists] = useState('');
  const [language, setLanguage] = useState('hindi');
  const [energy, setEnergy] = useState(8);
  const [tags, setTags] = useState<string[]>(['party']);
  const [busy, setBusy] = useState(false);
  const [q, setQ] = useState('');
  const [hits, setHits] = useState<Array<{ id: string; title: string; channel: string; thumbnail: string; durationSec?: number }>>([]);
  const TAGS = ['party', 'wedding', 'sangeet', 'mehendi', 'baraat', 'birthday', 'late-night', 'workout', 'retro', 'festival'];

  const submit = async (e?: React.FormEvent) => {
    e?.preventDefault();
    setBusy(true);
    try {
      const s = await api.importSong({
        url,
        title: title.trim() || undefined,
        artists: artistsText.trim() ? artistsText.split(',').map((a) => a.trim()).filter(Boolean) : undefined,
        language: language.trim().toLowerCase(),
        energy,
        tags,
      });
      toast(`Added "${s.title}". Set its hook next.`, 'success');
      onAdded(s.id);
    } catch (err) {
      toast((err as Error).message, 'warn');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="studio-grid">
      <form className="card stack" onSubmit={submit}>
        <h3 style={{ fontSize: 24 }}>Add any song by YouTube link</h3>
        <p className="small muted" style={{ margin: 0 }}>
          Any language, any genre. We check the video is public and allows embedded playback, then it joins the catalogue. Hooks default to a sensible guess until you tune them.
        </p>
        <label className="field">
          YouTube link
          <input className="input" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://www.youtube.com/watch?v=…" required />
        </label>
        <div className="row wrap">
          <label className="field grow">
            Title (optional, cleaned from YouTube otherwise)
            <input className="input" value={title} onChange={(e) => setTitle(e.target.value)} />
          </label>
          <label className="field grow">
            Artists (comma-separated, optional)
            <input className="input" value={artistsText} onChange={(e) => setArtists(e.target.value)} />
          </label>
        </div>
        <div className="row wrap">
          <label className="field">
            Language
            <input className="input" list="langs" value={language} onChange={(e) => setLanguage(e.target.value)} style={{ width: 180 }} />
            <datalist id="langs">
              {meta?.languages.map((l) => <option key={l.language} value={l.language} />)}
              {['tamil', 'telugu', 'bengali', 'gujarati', 'spanish', 'korean', 'arabic', 'french'].map((l) => (
                <option key={l} value={l} />
              ))}
            </datalist>
          </label>
          <label className="field grow">
            Energy: {energy}/10
            <input type="range" min={1} max={10} value={energy} onChange={(e) => setEnergy(Number(e.target.value))} />
          </label>
        </div>
        <div className="stack" style={{ gap: 6 }}>
          <span className="small muted">Fits occasions</span>
          <div className="row wrap" style={{ gap: 6 }}>
            {TAGS.map((t) => (
              <button type="button" key={t} className="chip" aria-pressed={tags.includes(t)} onClick={() => setTags((ts) => (ts.includes(t) ? ts.filter((x) => x !== t) : [...ts, t]))}>
                {t}
              </button>
            ))}
          </div>
        </div>
        <button className="btn primary" type="submit" disabled={busy || !url.trim() || tags.length === 0}>
          {busy ? 'Checking with YouTube…' : 'Add to catalogue'}
        </button>
      </form>

      <div className="card stack">
        <h3 style={{ fontSize: 20 }}>Search YouTube</h3>
        {meta?.youtubeSearchEnabled ? (
          <>
            <form
              className="row"
              onSubmit={(e) => {
                e.preventDefault();
                api.youtubeSearch(q).then(setHits, (err: Error) => toast(err.message, 'warn'));
              }}
            >
              <input className="input grow" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Song or artist" />
              <button className="btn" type="submit">
                Search
              </button>
            </form>
            <div className="queue">
              {hits.map((h) => (
                <div className="qrow" key={h.id}>
                  <img className="art" src={h.thumbnail} alt="" />
                  <div className="grow">
                    <div className="t ellipsis">{h.title}</div>
                    <div className="small muted">
                      {h.channel} {h.durationSec ? `· ${mmss(h.durationSec)}` : ''}
                    </div>
                  </div>
                  <button className="btn sm" onClick={() => setUrl(`https://www.youtube.com/watch?v=${h.id}`)}>
                    Use
                  </button>
                </div>
              ))}
            </div>
          </>
        ) : (
          <p className="small muted">
            Set <code>YOUTUBE_API_KEY</code> on the server to search YouTube from here. Until then, paste links on the left.
          </p>
        )}
      </div>
    </div>
  );
}
