import type { RoomSnapshot } from '@hookline/core';
import { energyColor } from '../lib/format.ts';

/**
 * The set's energy journey: the planned target curve (gradient line),
 * what actually played (dots coloured by energy), and a "now" marker.
 */
export function EnergyArc({ energy, nowMin, height = 150 }: { energy: RoomSnapshot['energy']; nowMin: number; height?: number }) {
  const W = 600;
  const H = height;
  const pad = { l: 26, r: 10, t: 12, b: 20 };
  const curve = energy.curve;
  if (curve.length < 2) return null;
  const span = Math.min(curve[curve.length - 1]![0], Math.max(60, nowMin + 40));
  const visible = curve.filter(([m]) => m <= span);
  const lo = 5;
  const hi = 10;
  const x = (m: number) => pad.l + (m / span) * (W - pad.l - pad.r);
  const y = (e: number) => pad.t + (1 - (Math.max(lo, Math.min(hi, e)) - lo) / (hi - lo)) * (H - pad.t - pad.b);
  const d = visible.map(([m, e], i) => `${i ? 'L' : 'M'}${x(m).toFixed(1)},${y(e).toFixed(1)}`).join(' ');
  const area = `${d} L${x(visible[visible.length - 1]![0])},${H - pad.b} L${x(0)},${H - pad.b} Z`;
  const ticks = [0, 15, 30, 45, 60, 75, 90, 120, 150, 180].filter((t) => t <= span);
  return (
    <svg className="arc" viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`Energy plan. Now ${energy.phase}.`}>
      <defs>
        <linearGradient id="arcLine" x1="0" y1="1" x2="0" y2="0">
          <stop offset="0" stopColor="#3dd6d0" />
          <stop offset=".5" stopColor="#8b5cf6" />
          <stop offset="1" stopColor="#ff4d6d" />
        </linearGradient>
        <linearGradient id="arcFill" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="rgba(139,92,246,0.28)" />
          <stop offset="1" stopColor="rgba(139,92,246,0)" />
        </linearGradient>
      </defs>
      {[6, 8, 10].map((e) => (
        <g key={e}>
          <line x1={pad.l} x2={W - pad.r} y1={y(e)} y2={y(e)} stroke="rgba(255,255,255,0.06)" />
          <text x={4} y={y(e) + 3}>{e}</text>
        </g>
      ))}
      {ticks.map((t) => (
        <text key={t} x={x(t)} y={H - 5} textAnchor="middle">
          {t}m
        </text>
      ))}
      <path d={area} fill="url(#arcFill)" />
      <path d={d} fill="none" stroke="url(#arcLine)" strokeWidth={3} strokeLinecap="round" />
      <line x1={x(nowMin)} x2={x(nowMin)} y1={pad.t - 4} y2={H - pad.b} stroke="rgba(255,255,255,0.55)" strokeDasharray="3 3" />
      {energy.played
        .filter(([m]) => m <= span)
        .map(([m, e], i) => (
          <circle key={i} cx={x(m)} cy={y(e)} r={4.5} fill={energyColor(e)} stroke="#0c0b12" strokeWidth={1.5} />
        ))}
    </svg>
  );
}
