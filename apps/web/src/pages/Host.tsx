import { useCallback, useEffect, useRef, useState } from 'react';
import type { MetaResponse, QueueItemView, RoomSnapshot } from '@hookline/core';
import { api, safeGet } from '../lib/api.ts';
import { DeckEngine, type EngineState } from '../lib/deck-engine.ts';
import { useRoom } from '../lib/useRoom.ts';
import { artists, cap, joinUrl, mmss } from '../lib/format.ts';
import { navigate } from '../lib/router.ts';
import { Art, Conn, EnergyDot, Link, Logo, QR, Toasts } from '../components/common.tsx';
import { EnergyArc } from '../components/EnergyArc.tsx';
import { HookBar } from '../components/HookBar.tsx';

const CROSSFADE = { quick: 4, hooks: 6, full: 8 } as const;

export function Host({ code }: { code: string }) {
  const hostKey = safeGet(`hookline.host.${code}`) ?? undefined;
  if (!hostKey) {
    return (
      <div className="shell">
        <div className="topbar">
          <Logo />
        </div>
        <div className="card stack" style={{ maxWidth: 520 }}>
          <h3 style={{ fontSize: 24 }}>This device isn't the DJ for party {code}</h3>
          <p className="muted">Only the device that started the party can run the decks. You can still join as a guest to request songs and react.</p>
          <div className="row">
            <button className="btn primary" onClick={() => navigate(`/join/${code}`)}>
              Join as guest
            </button>
            <Link to="/" className="btn ghost">
              Start my own
            </Link>
          </div>
        </div>
      </div>
    );
  }
  return <Console code={code} hostKey={hostKey} />;
}

function Console({ code, hostKey }: { code: string; hostKey: string }) {
  const engineRef = useRef<DeckEngine | null>(null);
  const roomRef = useRef<RoomSnapshot | null>(null);
  const deckA = useRef<HTMLDivElement>(null);
  const deckB = useRef<HTMLDivElement>(null);
  const [engine, setEngine] = useState<EngineState | null>(null);
  const [meta, setMeta] = useState<MetaResponse | null>(null);
  const [vibe, setVibe] = useState('');
  const [vibeBusy, setVibeBusy] = useState(false);
  const [showHookFix, setShowHookFix] = useState(false);
  const [started, setStarted] = useState(false);

  const { room, conn, fatal, toasts, toast, send } = useRoom({
    code,
    role: 'host',
    hostKey,
    onCommand: (cmd) => {
      if (cmd === 'skip') engineRef.current?.skip();
    },
  });
  roomRef.current = room;

  useEffect(() => {
    api.meta().then(setMeta, () => {});
  }, []);

  // Build the two decks once. YouTube replaces the element it's given, so we
  // hand it a child created outside React's tree.
  useEffect(() => {
    if (!deckA.current || !deckB.current) return;
    const a = document.createElement('div');
    const b = document.createElement('div');
    deckA.current.appendChild(a);
    deckB.current.appendChild(b);
    const eng = new DeckEngine(a, b, {
      getQueue: () => roomRef.current?.queue ?? [],
      getResumeItem: () => roomRef.current?.nowPlaying ?? undefined,
      onStarted: (item, sourceId, actualDurationSec, previous) =>
        send({ type: 'started', songId: item.track.id, sourceId, actualDurationSec: actualDurationSec || undefined, previous }),
      onPreloading: (songId) => send({ type: 'preloading', songId }),
      onSourceFailed: (songId, sourceId, c) => send({ type: 'sourceFailed', songId, sourceId, code: c }),
      onSongUnplayable: (songId) => send({ type: 'songUnplayable', songId }),
      onChange: setEngine,
      onEmpty: () => toast('Nothing left to play with these settings. Try widening the vibe.', 'warn'),
      log: (m) => console.debug('[deck]', m),
    });
    engineRef.current = eng;
    (window as unknown as { __hookline?: unknown }).__hookline = { engine: eng }; // debug handle
    return () => {
      eng.destroy();
      engineRef.current = null;
      a.remove();
      b.remove();
    };
  }, [send, toast]);

  useEffect(() => {
    if (room) engineRef.current?.setCrossfade(CROSSFADE[room.intent.style]);
  }, [room?.intent.style]);

  // Keep the screen awake while the DJ runs (re-acquired when the tab becomes visible).
  useEffect(() => {
    if (!started || !('wakeLock' in navigator)) return;
    let lock: WakeLockSentinel | null = null;
    const acquire = () => navigator.wakeLock.request('screen').then((l) => (lock = l), () => {});
    void acquire();
    const onVis = () => document.visibilityState === 'visible' && void acquire();
    document.addEventListener('visibilitychange', onVis);
    return () => {
      document.removeEventListener('visibilitychange', onVis);
      void lock?.release();
    };
  }, [started]);

  const startParty = useCallback(() => {
    setStarted(true);
    send({ type: 'play' });
    engineRef.current?.start();
  }, [send]);

  const togglePlay = () => {
    const e = engineRef.current;
    if (!e || !engine) return;
    if (engine.status === 'playing') {
      e.pause();
      send({ type: 'pause' });
    } else {
      setStarted(true);
      send({ type: 'play' });
      e.resume();
    }
  };

  const submitVibe = (e: React.FormEvent) => {
    e.preventDefault();
    if (!vibe.trim()) return;
    if (send({ type: 'vibe', text: vibe.trim() })) {
      setVibeBusy(true);
      setVibe('');
      setTimeout(() => setVibeBusy(false), 1500);
    }
  };

  if (fatal) {
    return (
      <div className="shell">
        <div className="topbar">
          <Logo />
        </div>
        <div className="card stack" style={{ maxWidth: 520 }}>
          <h3 style={{ fontSize: 24 }}>{fatal}</h3>
          <Link to="/" className="btn primary">
            Start a new party
          </Link>
        </div>
      </div>
    );
  }

  const np = room?.nowPlaying;
  const current: QueueItemView | undefined = engine?.current ?? np ?? undefined;
  const playing = engine?.status === 'playing';
  const showStart = !!engine && (engine.status === 'idle' || (engine.status === 'starting' && !started)) && !engine.current;
  const loadingApi = !engine || engine.status === 'loading-api';
  const url = joinUrl(code, meta ?? undefined);
  const fade = engine?.crossfade ?? 0;
  const activeIsA = engine?.activeDeck !== 'B';
  const nowMin = room ? (np ? np.setOffsetSec / 60 + Math.max(0, (engine?.position ?? 0) - (engine?.window?.startSec ?? 0)) / 60 : 0) : 0;
  const win = engine?.window ?? current?.window;

  return (
    <div className="shell">
      <div className="aura" />
      <div className="topbar">
        <Logo />
        <div className="row">
          <Conn state={conn} />
          <span className="tag">
            {room?.occasion.emoji} {room?.occasion.name ?? '…'}
          </span>
          <span className="tag mono">#{code}</span>
        </div>
      </div>

      <div className="host-grid">
        {/* ------------------------------------------------ left: now playing */}
        <div className="stack" style={{ gap: 16 }}>
          <div className="card now">
            <div className="stage">
              <div className="deck" ref={deckA} style={{ opacity: activeIsA ? 1 - fade : fade, zIndex: activeIsA ? 2 : 1 }} />
              <div className="deck" ref={deckB} style={{ opacity: activeIsA ? fade : 1 - fade, zIndex: activeIsA ? 1 : 2 }} />
              {fade > 0 && engine?.incoming && (
                <span className="badge tag violet">
                  Mixing into {engine.incoming.track.title} · {Math.round(fade * 100)}%
                </span>
              )}
              {(loadingApi || showStart || engine?.needsGesture || engine?.status === 'error') && (
                <div className="overlay">
                  {engine?.status === 'error' ? (
                    <div className="stack" style={{ alignItems: 'center' }}>
                      <h3 style={{ fontSize: 22 }}>Player couldn't load</h3>
                      <p className="muted small">{engine.error}</p>
                      <button className="btn" onClick={() => location.reload()}>
                        Retry
                      </button>
                    </div>
                  ) : loadingApi ? (
                    <div className="stack" style={{ alignItems: 'center' }}>
                      <div className="spinner" />
                      <span className="muted small">Warming up the decks…</span>
                    </div>
                  ) : engine?.needsGesture ? (
                    <button className="btn primary" style={{ minHeight: 56, fontSize: 18 }} onClick={() => engineRef.current?.unblock()}>
                      ▶ Tap to let the music play
                    </button>
                  ) : (
                    <div className="stack" style={{ alignItems: 'center', gap: 14 }}>
                      {room?.djNote && <div className="djnote" style={{ maxWidth: 460 }}>{room.djNote}</div>}
                      <button className="btn primary" style={{ minHeight: 60, fontSize: 19, padding: '0 34px' }} onClick={startParty} disabled={!room?.queue.length}>
                        {room?.history.length || room?.nowPlaying ? '▶ Resume the party' : '▶ Start the party'}
                      </button>
                      <span className="small muted">Plug in a speaker. Guests can join with the QR code.</span>
                    </div>
                  )}
                </div>
              )}
            </div>
            <div className="now-body">
              <div className="row between wrap" style={{ alignItems: 'flex-start' }}>
                <div className="grow">
                  <div className="small muted">
                    {current ? (np?.requestedBy ? `Requested by ${np.requestedBy}` : room?.energy.phase ?? 'Now playing') : 'Up first'}
                  </div>
                  <div className="now-title ellipsis">{current?.track.title ?? room?.queue[0]?.track.title ?? '—'}</div>
                  <div className="muted">{artists((current ?? room?.queue[0])?.track.artists ?? [], 3)}</div>
                </div>
                <div className="row" style={{ gap: 6 }}>
                  <button className="btn icon sm" title="Like: more like this" aria-label="Like" disabled={!current} onClick={() => current && send({ type: 'feedback', songId: current.track.id, kind: 'like' })}>
                    👍
                  </button>
                  <button
                    className="btn icon sm"
                    title="Dislike: skip and avoid"
                    aria-label="Dislike"
                    disabled={!current}
                    onClick={() => {
                      if (!current) return;
                      send({ type: 'feedback', songId: current.track.id, kind: 'dislike' });
                      engineRef.current?.skip();
                    }}
                  >
                    👎
                  </button>
                </div>
              </div>

              {win && (
                <HookBar duration={engine?.duration ?? current?.track.durationSec} startSec={win.startSec} endSec={win.endSec} position={engine?.position ?? win.startSec} />
              )}

              {current && current.reasons.length > 0 && (
                <div className="reasons">
                  {current.reasons.map((r) => (
                    <span key={r} className="reason">
                      {r}
                    </span>
                  ))}
                </div>
              )}

              <div className="controls">
                <div className="main">
                  <button className="btn icon lg" onClick={togglePlay} disabled={!engine || loadingApi || (!current && !room?.queue.length)} aria-label={playing ? 'Pause' : 'Play'}>
                    {playing ? '❚❚' : '▶'}
                  </button>
                  <button className="btn icon" onClick={() => engineRef.current?.skip()} disabled={!current} aria-label="Skip to next" title="Skip (crossfades into the next hook)">
                    ⏭
                  </button>
                  <span className="small muted mono">
                    {win ? `${mmss((engine?.position ?? win.startSec) - win.startSec)} / ${mmss(win.endSec - win.startSec)}` : ''}
                  </span>
                </div>
                <div className="energy-knob" aria-label="Energy">
                  <button className="btn icon sm ghost" aria-label="Bring the energy down" onClick={() => send({ type: 'energy', delta: -1 })}>
                    −
                  </button>
                  <span className="val">
                    Energy {room ? (room.intent.energyBias > 0 ? `+${room.intent.energyBias}` : room.intent.energyBias) : 0}
                  </span>
                  <button className="btn icon sm ghost" aria-label="Turn the energy up" onClick={() => send({ type: 'energy', delta: 1 })}>
                    +
                  </button>
                </div>
              </div>

              <div className="row wrap between">
                <button className="btn ghost sm" onClick={() => setShowHookFix((v) => !v)} disabled={!current}>
                  🎯 Hook timing off?
                </button>
                {room && (
                  <span className="small faint">
                    {room.intentSummary}
                  </span>
                )}
              </div>
              {showHookFix && current && (
                <div className="row wrap" style={{ gap: 6 }}>
                  {(
                    [
                      ['Missed the good part', 'start', -8],
                      ['Started too early', 'start', 8],
                      ['Cut off too soon', 'end', 12],
                      ['Went on too long', 'end', -12],
                    ] as const
                  ).map(([label, edge, delta]) => (
                    <button
                      key={label}
                      className="btn sm"
                      onClick={() => {
                        send({ type: 'hookNudge', songId: current.track.id, edge, deltaSec: delta });
                        setShowHookFix(false);
                      }}
                    >
                      {label}
                    </button>
                  ))}
                  <Link to={`/studio?song=${current.track.id}`} className="btn sm ghost">
                    Fix precisely in Studio →
                  </Link>
                </div>
              )}
            </div>
          </div>

          <div className="card stack">
            <div className="row between">
              <h2>Energy plan</h2>
              <span className="small muted">
                {room?.energy.phase}
                {room && room.energy.liveBias !== 0 ? ` · crowd ${room.energy.liveBias > 0 ? '🔥' : '😴'} ${room.energy.liveBias > 0 ? '+' : ''}${room.energy.liveBias}` : ''}
              </span>
            </div>
            {room && <EnergyArc energy={room.energy} nowMin={nowMin} />}
          </div>

          <form className="card stack" onSubmit={submitVibe}>
            <div className="row between">
              <h2>Talk to the DJ</h2>
              <span className="tiny faint">{meta?.aiEnabled ? '✨ Claude' : 'Rule-based understanding'}</span>
            </div>
            {room?.djNote && <div className="djnote">{room.djNote}</div>}
            <div className="row">
              <input className="input grow" value={vibe} onChange={(e) => setVibe(e.target.value)} placeholder="e.g. more Punjabi, bring it down for dinner, no Badshah" maxLength={500} aria-label="Tell the DJ what you want" />
              <button className="btn primary" type="submit" disabled={!vibe.trim() || vibeBusy}>
                {vibeBusy ? '…' : 'Send'}
              </button>
            </div>
            <div className="row wrap" style={{ gap: 6 }}>
              {['Turn it up 🔥', 'Bring it down', 'Mostly Punjabi', 'Play some 90s retro', 'Full songs now'].map((s) => (
                <button key={s} type="button" className="chip" onClick={() => send({ type: 'vibe', text: s })}>
                  {s}
                </button>
              ))}
            </div>
          </form>
        </div>

        {/* ------------------------------------------------ right: queue, guests */}
        <div className="stack" style={{ gap: 16 }}>
          <div className="card joincard">
            <QR text={url} />
            <div className="stack" style={{ gap: 4, minWidth: 0 }}>
              <span className="small muted">Guests join at</span>
              <span className="code">{code}</span>
              <a className="small muted ellipsis" href={url} target="_blank" rel="noreferrer">
                {url.replace(/^https?:\/\//, '')}
              </a>
              <div className="meter">
                <span>👥 {room?.guestCount ?? 0}</span>
                <span>🔥 {room?.reactions.fire ?? 0}</span>
                <span>❤️ {room?.reactions.love ?? 0}</span>
                <span>😴 {room?.reactions.meh ?? 0}</span>
                {room && room.skipVotes > 0 && (
                  <span className="tag warn">
                    ⏭ {room.skipVotes}/{room.skipThreshold}
                  </span>
                )}
              </div>
            </div>
          </div>

          {room && room.requests.length > 0 && (
            <div className="card stack">
              <h2>Requests</h2>
              <div className="queue">
                {room.requests.map((r) => (
                  <div className="qrow" key={r.id}>
                    <Art src={r.track.artwork} alt="" />
                    <div className="grow">
                      <div className="t ellipsis">{r.track.title}</div>
                      <div className="small muted ellipsis">
                        {r.requestedBy} · {r.votes} vote{r.votes === 1 ? '' : 's'}
                      </div>
                    </div>
                    <div className="acts">
                      <button className="btn icon sm" title="Play next" aria-label={`Play ${r.track.title} next`} onClick={() => send({ type: 'playNext', songId: r.track.id })}>
                        ⤴
                      </button>
                      <button className="btn icon sm" title="Dismiss request" aria-label={`Dismiss ${r.track.title}`} onClick={() => send({ type: 'requestDismiss', requestId: r.id })}>
                        ✕
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          <div className="card stack">
            <div className="row between">
              <h2>Up next</h2>
              <button className="btn ghost sm" onClick={() => send({ type: 'reshuffle' })} title="Re-plan with a different mix">
                ↻ Re-plan
              </button>
            </div>
            <div className="queue">
              {room?.queue.map((q, i) => (
                <div className="qrow" key={q.track.id}>
                  <Art src={q.track.artwork} alt="" />
                  <div className="grow">
                    <div className="row" style={{ gap: 6 }}>
                      <EnergyDot energy={q.track.energy} />
                      <span className="t ellipsis">{q.track.title}</span>
                    </div>
                    <div className="small muted ellipsis">
                      {artists(q.track.artists)} · {cap(q.track.language)}
                    </div>
                    <div className="tiny faint ellipsis" title={q.reasons.join(' · ')}>
                      {q.requestedBy ? <span className="tag hot" style={{ marginRight: 6 }}>🙋 {q.requestedBy}</span> : null}
                      {i === 0 && q.locked ? '🔒 Cued · ' : ''}
                      {q.reasons.slice(q.requestedBy ? 1 : 0).join(' · ')}
                    </div>
                  </div>
                  <div className="acts">
                    {i > 0 && (
                      <button className="btn icon sm" title="Play next" aria-label={`Play ${q.track.title} next`} onClick={() => send({ type: 'playNext', songId: q.track.id })}>
                        ⤴
                      </button>
                    )}
                    <button className="btn icon sm" title="Not tonight" aria-label={`Remove ${q.track.title}`} onClick={() => send({ type: 'queueRemove', songId: q.track.id })}>
                      ✕
                    </button>
                  </div>
                </div>
              ))}
              {room && room.queue.length === 0 && <div className="empty">Nothing matches this vibe. Try widening it.</div>}
            </div>
          </div>

          {room && room.history.length > 0 && (
            <details className="card">
              <summary style={{ cursor: 'pointer' }}>
                <h2 style={{ display: 'inline' }}>Played ({room.history.length})</h2>
              </summary>
              <div className="queue" style={{ marginTop: 8 }}>
                {room.history.slice(0, 15).map((h) => (
                  <div className="qrow" key={h.startedAt}>
                    <Art src={h.track.artwork} alt="" />
                    <div className="grow">
                      <div className="t ellipsis">{h.track.title}</div>
                      <div className="small muted">{new Date(h.startedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</div>
                    </div>
                    <span className={`tag ${h.outcome === 'completed' ? 'ok' : h.outcome === 'error' ? 'hot' : ''}`}>{h.outcome ?? '—'}</span>
                  </div>
                ))}
              </div>
            </details>
          )}
        </div>
      </div>
      <Toasts toasts={toasts} />
    </div>
  );
}
