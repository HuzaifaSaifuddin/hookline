import { mmss } from '../lib/format.ts';

/** Whole-song timeline with the hook window highlighted and a live playhead. */
export function HookBar({ duration, startSec, endSec, position }: { duration?: number; startSec: number; endSec: number; position: number }) {
  const total = Math.max(duration ?? endSec + 20, endSec, 1);
  const pct = (s: number) => `${Math.max(0, Math.min(100, (s / total) * 100))}%`;
  const playedEnd = Math.max(startSec, Math.min(position, endSec));
  return (
    <div className="hookbar" aria-label={`Playing ${mmss(startSec)} to ${mmss(endSec)} of ${mmss(total)}`}>
      <div className="track" />
      <div className="hook" style={{ left: pct(startSec), width: `calc(${pct(endSec)} - ${pct(startSec)})` }} />
      <div className="played" style={{ left: pct(startSec), width: `calc(${pct(playedEnd)} - ${pct(startSec)})` }} />
      <div className="head" style={{ left: pct(position) }} />
      <span className="lbl" style={{ left: pct(startSec) }}>
        in {mmss(startSec)}
      </span>
      <span className="lbl" style={{ left: pct(endSec) }}>
        out {mmss(endSec)}
      </span>
    </div>
  );
}
