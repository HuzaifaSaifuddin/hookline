import { useEffect, useState } from 'react';
import type { MetaResponse, SetStyle } from '@hookline/core';
import { api, safeSet } from '../lib/api.ts';
import { navigate } from '../lib/router.ts';
import { cap } from '../lib/format.ts';
import { Link, Logo, Spinner } from '../components/common.tsx';

const STYLES: Array<{ id: SetStyle; name: string; hint: string }> = [
  { id: 'quick', name: 'Quick hits', hint: '~50s per song' },
  { id: 'hooks', name: 'Hooks', hint: 'the best 60–90s' },
  { id: 'full', name: 'Full songs', hint: 'start to finish' },
];

export function Home() {
  const [meta, setMeta] = useState<MetaResponse | null>(null);
  const [metaError, setMetaError] = useState<string | null>(null);
  const [occasion, setOccasion] = useState<string | null>(null);
  const [languages, setLanguages] = useState<string[]>([]);
  const [style, setStyle] = useState<SetStyle | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [joinCode, setJoinCode] = useState('');

  useEffect(() => {
    api.meta().then(setMeta, (e: Error) => setMetaError(e.message));
  }, []);

  const effectiveStyle = style ?? meta?.occasions.find((o) => o.id === (occasion ?? 'house-party'))?.style ?? 'hooks';

  const start = async () => {
    setBusy(true);
    setError(null);
    try {
      const { code, hostKey } = await api.createRoom({
        occasion: occasion ?? undefined,
        languages: languages.length ? languages : undefined,
        style: style ?? undefined,
      });
      safeSet(`hookline.host.${code}`, hostKey);
      navigate(`/host/${code}`);
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };

  const toggleLang = (l: string) => setLanguages((ls) => (ls.includes(l) ? ls.filter((x) => x !== l) : [...ls, l]));

  return (
    <div className="shell">
      <div className="topbar">
        <Logo />
        <div className="nav">
          <Link to="/studio" className="btn ghost sm">
            Hook Studio
          </Link>
        </div>
      </div>

      <section className="hero">
        <div>
          <h1>
            Pick the vibe.
            <br />
            <span className="ramp">It runs the party.</span>
          </h1>
          <p className="lede">
            Hookline is an autonomous DJ that plays the best part of every song, plans the night's energy like a pro, and lets your guests request and react from their phones.
          </p>
        </div>

        <div className="card composer">
          <div className="stack">
            <h2>Occasion</h2>
            <div className="occasions">
              {meta?.occasions.map((o) => (
                <button key={o.id} className="occasion" aria-pressed={occasion === o.id} onClick={() => setOccasion(occasion === o.id ? null : o.id)}>
                  <span className="em">{o.emoji}</span>
                  <span className="nm">{o.name}</span>
                  <span className="bl">{o.blurb}</span>
                </button>
              ))}
              {!meta && !metaError && <Spinner />}
            </div>
          </div>

          <div className="row wrap between" style={{ gap: 20 }}>
            <div className="stack" style={{ gap: 8 }}>
              <h2>Languages</h2>
              <div className="row wrap" style={{ gap: 6 }}>
                <button className="chip" aria-pressed={languages.length === 0} onClick={() => setLanguages([])}>
                  Any
                </button>
                {meta?.languages.map((l) => (
                  <button key={l.language} className="chip" aria-pressed={languages.includes(l.language)} onClick={() => toggleLang(l.language)}>
                    {cap(l.language)} <span className="faint tiny">{l.count}</span>
                  </button>
                ))}
              </div>
            </div>
            <div className="stack" style={{ gap: 8 }}>
              <h2>How much of each song</h2>
              <div className="row wrap" style={{ gap: 6 }}>
                {STYLES.map((s) => (
                  <button key={s.id} className="chip" aria-pressed={effectiveStyle === s.id} onClick={() => setStyle(s.id)} title={s.hint}>
                    {s.name}
                  </button>
                ))}
              </div>
            </div>
          </div>

          {(error || metaError) && <div className="tag warn">{error ?? `Server unreachable: ${metaError}`}</div>}
          <div className="row wrap between">
            <span className="small faint">{meta ? `${meta.playableCount.toLocaleString()} songs ready · hooks curated` : ' '}</span>
            <button className="btn primary" style={{ minWidth: 200, minHeight: 50, fontSize: 16 }} onClick={start} disabled={busy || !meta}>
              {busy ? 'Setting up the decks…' : 'Start the DJ  →'}
            </button>
          </div>
        </div>

        <div className="card row wrap between">
          <div>
            <h3 style={{ fontSize: 20 }}>At a party already?</h3>
            <div className="small muted">Enter the code on the DJ screen to request songs and vote.</div>
          </div>
          <form
            className="join-inline"
            onSubmit={(e) => {
              e.preventDefault();
              if (joinCode.trim().length >= 4) navigate(`/join/${joinCode.trim().toUpperCase()}`);
            }}
          >
            <input className="input" value={joinCode} onChange={(e) => setJoinCode(e.target.value.toUpperCase().slice(0, 6))} placeholder="CODE" aria-label="Party code" autoCapitalize="characters" />
            <button className="btn" type="submit" disabled={joinCode.trim().length < 4}>
              Join
            </button>
          </form>
        </div>
      </section>

      <section className="features">
        <div className="card feature">
          <h3>🎯 Straight to the hook</h3>
          <p>Every song has curated in and out points. The DJ drops in at the good part and blends into the next with an equal-power crossfade.</p>
        </div>
        <div className="card feature">
          <h3>📈 Plans the night</h3>
          <p>Warm-up, build, peak, breathers. Each occasion has an energy curve, and every pick tells you why it was chosen.</p>
        </div>
        <div className="card feature">
          <h3>📱 The room has a say</h3>
          <p>Guests scan a QR code to request songs, upvote, react 🔥 or vote to skip. The DJ fits requests in where they suit the flow.</p>
        </div>
        <div className="card feature">
          <h3>🔁 Gets better with use</h3>
          <p>Skips, likes and hook feedback tune future sets. Broken videos fall back to alternate uploads automatically.</p>
        </div>
      </section>
    </div>
  );
}
