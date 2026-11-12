import { useRef, useState } from 'react';
import { mmss } from '../lib/format.ts';

interface Props {
  duration?: number;
  startSec: number;
  endSec: number;
  position: number;
  /** When set, the bar is a scrubber: click or drag to jump within the hook window. */
  onSeek?: (sec: number) => void;
}

/** Whole-song timeline with the hook window highlighted and a live playhead. */
export function HookBar({ duration, startSec, endSec, position, onSeek }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<number | null>(null);
  const total = Math.max(duration ?? endSec + 20, endSec, 1);
  const pct = (s: number) => `${Math.max(0, Math.min(100, (s / total) * 100))}%`;
  // Seeking stays inside the hook; the last second is left so the outro crossfade can still run.
  const clamp = (s: number) => Math.max(startSec, Math.min(endSec - 1, s));
  const shown = drag ?? position;
  const playedEnd = Math.max(startSec, Math.min(shown, endSec));

  const secAt = (clientX: number) => {
    const r = ref.current!.getBoundingClientRect();
    return clamp(((clientX - r.left) / r.width) * total);
  };

  const scrub = onSeek
    ? {
        role: 'slider',
        tabIndex: 0,
        'aria-valuemin': Math.round(startSec),
        'aria-valuemax': Math.round(endSec),
        'aria-valuenow': Math.round(shown),
        'aria-valuetext': mmss(shown),
        onPointerDown: (e: React.PointerEvent<HTMLDivElement>) => {
          if (e.button !== 0) return;
          e.currentTarget.setPointerCapture(e.pointerId);
          setDrag(secAt(e.clientX));
        },
        onPointerMove: (e: React.PointerEvent<HTMLDivElement>) => {
          if (drag !== null) setDrag(secAt(e.clientX));
        },
        onPointerUp: (e: React.PointerEvent<HTMLDivElement>) => {
          if (drag === null) return;
          onSeek(secAt(e.clientX));
          setDrag(null);
        },
        onPointerCancel: () => setDrag(null),
        onKeyDown: (e: React.KeyboardEvent<HTMLDivElement>) => {
          const step = e.key === 'ArrowRight' ? 5 : e.key === 'ArrowLeft' ? -5 : 0;
          if (!step) return;
          e.preventDefault();
          onSeek(clamp(position + step));
        },
      }
    : {};

  return (
    <div
      ref={ref}
      className={`hookbar${onSeek ? ' seekable' : ''}${drag !== null ? ' dragging' : ''}`}
      aria-label={`Playing ${mmss(startSec)} to ${mmss(endSec)} of ${mmss(total)}`}
      title={onSeek ? 'Click or drag to jump within the hook' : undefined}
      {...scrub}
    >
      <div className="track" />
      <div className="hook" style={{ left: pct(startSec), width: `calc(${pct(endSec)} - ${pct(startSec)})` }} />
      <div className="played" style={{ left: pct(startSec), width: `calc(${pct(playedEnd)} - ${pct(startSec)})` }} />
      <div className="head" style={{ left: pct(shown) }} />
      {drag !== null && (
        <span className="lbl seek-lbl" style={{ left: pct(drag) }}>
          {mmss(drag)}
        </span>
      )}
      <span className="lbl" style={{ left: pct(startSec) }}>
        in {mmss(startSec)}
      </span>
      <span className="lbl" style={{ left: pct(endSec) }}>
        out {mmss(endSec)}
      </span>
    </div>
  );
}
