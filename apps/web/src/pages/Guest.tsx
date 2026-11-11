import { useEffect, useState } from 'react';
import type { TrackView } from '@hookline/core';
import { api, safeGet, safeSet } from '../lib/api.ts';
import { useRoom } from '../lib/useRoom.ts';
import { artists, cap } from '../lib/format.ts';
import { Art, Conn, EnergyDot, Link, Logo, Toasts, useNow } from '../components/common.tsx';

function guestIdentity(): string {
  let id = safeGet('hookline.guestId');
  if (!id) {
    id = `g-${crypto.randomUUID()}`;
    safeSet('hookline.guestId', id);
  }
  return id;
}

export function Guest({ code }: { code: string }) {
  const [name, setName] = useState(() => safeGet('hookline.name') ?? '');
  const [joined, setJoined] = useState(() => !!safeGet('hookline.name'));
  if (!joined) {
    return (
      <div className="shell guest">
        <div className="topbar">
          <Logo />
        </div>
        <form
          className="card stack"
          onSubmit={(e) => {
            e.preventDefault();
            if (name.trim()) safeSet('hookline.name', name.trim());
            setJoined(true);
          }}
        >
          <h1 style={{ fontSize: 34 }}>You're at party {code} 🎉</h1>
          <p className="muted" style={{ margin: 0 }}>
            Request songs, upvote what others asked for, and let the DJ know how it's going.
          </p>
          <label className="field">
            Your name (shown with your requests)
            <input className="input" value={name} onChange={(e) => setName(e.target.value.slice(0, 24))} placeholder="e.g. Priya" autoFocus maxLength={24} />
          </label>
          <button className="btn primary" type="submit">
            Join the party
          </button>
        </form>
      </div>
    );
  }
  return <GuestRoom code={code} name={name.trim() || undefined} />;
}

function GuestRoom({ code, name }: { code: string; name?: string }) {
  const [guestId] = useState(guestIdentity);
  const { room, conn, fatal, toasts, send, clockOffset } = useRoom({ code, role: 'guest', guestId, name });
  const [q, setQ] = useState('');
  const [results, setResults] = useState<TrackView[]>([]);
  const [searching, setSearching] = useState(false);
  const [burst, setBurst] = useState<string | null>(null);
  const [skipVoted, setSkipVoted] = useState<string | null>(null);
  const now = useNow(500);

  useEffect(() => {
    if (q.trim().length < 2) {
      setResults([]);
      return;
    }
    setSearching(true);
    const t = setTimeout(() => {
      api
        .search(q, 12)
        .then(setResults, () => setResults([]))
        .finally(() => setSearching(false));
    }, 250);
    return () => clearTimeout(t);
  }, [q]);

  if (fatal) {
    return (
      <div className="shell guest">
        <div className="topbar">
          <Logo />
        </div>
        <div className="card stack">
          <h3 style={{ fontSize: 24 }}>{fatal}</h3>
          <Link to="/" className="btn">
            Back home
          </Link>
        </div>
      </div>
    );
  }

  const np = room?.nowPlaying;
  let progress = 0;
  if (np && room) {
    const elapsed = (now + clockOffset - np.startedAt) / 1000;
    progress = room.status === 'playing' ? Math.min(1, Math.max(0, elapsed / (np.window.endSec - np.window.startSec))) : progress;
  }
  const queuedIds = new Set([...(room?.queue.map((x) => x.track.id) ?? []), ...(room?.requests.map((r) => r.track.id) ?? [])]);

  const react = (kind: 'fire' | 'love' | 'meh') => {
    send({ type: 'react', kind });
    setBurst(kind);
    setTimeout(() => setBurst(null), 500);
  };

  return (
    <div className="shell guest">
      <div className="aura" />
      <div className="topbar">
        <Logo />
        <div className="row">
          <Conn state={conn} />
          <span className="tag mono">#{code}</span>
        </div>
      </div>

      <div className="stack" style={{ gap: 14 }}>
        {room && !room.hostOnline && <div className="tag warn" style={{ justifyContent: 'center', padding: 8 }}>The DJ screen is offline right now. Requests still count.</div>}

        <div className="card stack">
          <div className="row between">
            <span className="small muted">
              {room?.occasion.emoji} {room?.occasion.name} · {room?.energy.phase}
            </span>
            <span className="small faint">👥 {room?.guestCount ?? 0}</span>
          </div>
          {np ? (
            <>
              <div className="guest-now">
                <img src={np.track.artwork} alt="" />
                <div style={{ minWidth: 0 }}>
                  <div className="small muted">{np.requestedBy ? `🙋 Requested by ${np.requestedBy}` : room?.status === 'paused' ? 'Paused' : 'Now playing'}</div>
                  <div style={{ fontFamily: 'var(--display)', fontSize: 24, fontWeight: 800, lineHeight: 1.1 }} className="ellipsis">
                    {np.track.title}
                  </div>
                  <div className="muted ellipsis">{artists(np.track.artists, 3)}</div>
                </div>
              </div>
              <div className="progress">
                <div style={{ width: `${progress * 100}%` }} />
              </div>
              {np.reasons[0] && <div className="tiny faint">Why this song: {np.reasons.join(' · ')}</div>}
            </>
          ) : (
            <div className="empty">The DJ hasn't started yet. Get your requests in! 🎶</div>
          )}
        </div>

        <div className="reacts">
          {(
            [
              ['fire', '🔥', 'More energy'],
              ['love', '❤️', 'Love this'],
              ['meh', '😴', 'Bit slow'],
            ] as const
          ).map(([k, e, l]) => (
            <button key={k} className={`react ${burst === k ? 'burst' : ''}`} onClick={() => react(k)} disabled={!np} aria-label={l}>
              {e}
              <span>{l}</span>
            </button>
          ))}
        </div>

        {np && (
          <button
            className="btn"
            disabled={skipVoted === np.track.id}
            onClick={() => {
              send({ type: 'skipVote' });
              setSkipVoted(np.track.id);
            }}
          >
            ⏭ {skipVoted === np.track.id ? 'Skip vote counted' : 'Vote to skip'} · {room?.skipVotes ?? 0}/{room?.skipThreshold ?? 2}
          </button>
        )}

        <div className="card stack">
          <h2>Request a song</h2>
          <input className="input" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search title or artist…" aria-label="Search songs" enterKeyHint="search" />
          <div className="results">
            {searching && results.length === 0 && <div className="empty">Searching…</div>}
            {!searching && q.trim().length >= 2 && results.length === 0 && <div className="empty">No match in tonight's crate.</div>}
            {results.map((t) => {
              const playing = np?.track.id === t.id;
              const queued = queuedIds.has(t.id);
              return (
                <div className="qrow" key={t.id}>
                  <Art src={t.artwork} alt="" />
                  <div className="grow">
                    <div className="t ellipsis">{t.title}</div>
                    <div className="small muted ellipsis">
                      {artists(t.artists)} · {cap(t.language)}
                    </div>
                  </div>
                  <button
                    className="btn sm"
                    disabled={playing || queued}
                    onClick={() => {
                      send({ type: 'request', songId: t.id });
                      setQ('');
                    }}
                  >
                    {playing ? 'Playing' : queued ? 'Queued' : 'Request'}
                  </button>
                </div>
              );
            })}
          </div>
        </div>

        {room && room.requests.length > 0 && (
          <div className="card stack">
            <h2>Requests · vote for your favourites</h2>
            <div className="queue">
              {room.requests.map((r) => {
                const voted = r.voters.includes(guestId);
                return (
                  <div className="qrow" key={r.id}>
                    <Art src={r.track.artwork} alt="" />
                    <div className="grow">
                      <div className="t ellipsis">{r.track.title}</div>
                      <div className="small muted ellipsis">by {r.requestedBy}</div>
                    </div>
                    <button className="btn sm" disabled={voted} onClick={() => send({ type: 'vote', requestId: r.id })} aria-label={`Vote for ${r.track.title}`}>
                      ▲ {r.votes}
                    </button>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {room && room.queue.length > 0 && (
          <div className="card stack">
            <h2>Coming up</h2>
            <div className="queue">
              {room.queue.slice(0, 4).map((x) => (
                <div className="qrow" key={x.track.id}>
                  <Art src={x.track.artwork} alt="" />
                  <div className="grow">
                    <div className="row" style={{ gap: 6 }}>
                      <EnergyDot energy={x.track.energy} />
                      <span className="t ellipsis">{x.track.title}</span>
                    </div>
                    <div className="small muted ellipsis">{x.requestedBy ? `🙋 ${x.requestedBy}` : artists(x.track.artists)}</div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
      <Toasts toasts={toasts} />
    </div>
  );
}
