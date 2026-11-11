import type { ArcShape } from './types.ts';

/**
 * Energy arcs: the target energy (1..10) for a slot in the set, as a function
 * of elapsed set time (minutes) and track index. A real DJ doesn't play 40
 * peak tracks in a row; they warm the room, build, give it breathers and
 * return to peaks. Arcs are deterministic so the plan is explainable and
 * testable; live inputs (host knob, guest reactions) shift the curve via a bias.
 */

export interface ArcInfo {
  id: ArcShape;
  name: string;
  description: string;
}

export const ARCS: ArcInfo[] = [
  { id: 'build', name: 'Slow build', description: 'Warm up, climb to a peak, then ride waves near the top.' },
  { id: 'waves', name: 'Waves', description: 'Rises and breathers every ~15 minutes.' },
  { id: 'peak', name: 'Peak time', description: 'Floor-fillers back-to-back with brief breathers.' },
  { id: 'intervals', name: 'Intervals', description: 'Four hard pushes, one recovery. Repeat.' },
  { id: 'steady', name: 'Steady cruise', description: 'Comfortable, consistent energy.' },
  { id: 'cooldown', name: 'Cool down', description: 'Gradually bring the room down.' },
];

export function arcTarget(shape: ArcShape, elapsedMin: number, trackIndex: number): number {
  const t = Math.max(0, elapsedMin);
  switch (shape) {
    case 'build': {
      if (t < 8) return 7;
      if (t < 40) return 7 + ((t - 8) / 32) * 2.6; // 7 -> 9.6
      return 9.2 + 0.6 * Math.sin(((t - 40) / 20) * 2 * Math.PI);
    }
    case 'waves': {
      // Starts at the trough (7.4) and rises; period 16 min.
      return 8.6 - 1.2 * Math.cos((t / 16) * 2 * Math.PI);
    }
    case 'peak':
      return trackIndex > 0 && trackIndex % 6 === 5 ? 8.4 : 9.7;
    case 'intervals':
      return trackIndex % 5 === 4 ? 7.8 : 9.8;
    case 'steady':
      return 8;
    case 'cooldown':
      return Math.max(6.5, 9 - (t / 30) * 2.5);
  }
}

export function targetEnergy(
  shape: ArcShape,
  elapsedMin: number,
  trackIndex: number,
  bias: number,
): number {
  return clamp(arcTarget(shape, elapsedMin, trackIndex) + bias, 1, 10);
}

/** Sampled curve for visualisation: [minute, energy][]. */
export function arcCurve(shape: ArcShape, minutes: number, avgTrackMin: number, bias = 0, step = 1): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (let m = 0; m <= minutes; m += step) {
    out.push([m, targetEnergy(shape, m, Math.floor(m / Math.max(0.5, avgTrackMin)), bias)]);
  }
  return out;
}

export function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}
