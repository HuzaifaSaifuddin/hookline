export function mmss(sec: number | undefined): string {
  if (sec === undefined || !Number.isFinite(sec)) return '–:––';
  const s = Math.max(0, Math.round(sec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

export const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

export function artists(a: string[], max = 2): string {
  return a.length > max ? `${a.slice(0, max).join(', ')} +${a.length - max}` : a.join(', ');
}

/** Energy 1..10 -> colour on the cool→hot ramp. */
export function energyColor(e: number): string {
  const t = Math.max(0, Math.min(1, (e - 5) / 5));
  const stops = [
    [61, 214, 208],
    [139, 92, 246],
    [255, 77, 109],
  ];
  const i = t < 0.5 ? 0 : 1;
  const local = t < 0.5 ? t / 0.5 : (t - 0.5) / 0.5;
  const [a, b] = [stops[i]!, stops[i + 1]!];
  const c = a.map((v, k) => Math.round(v + (b[k]! - v) * local));
  return `rgb(${c[0]}, ${c[1]}, ${c[2]})`;
}

export function joinUrl(code: string, meta?: { publicUrl?: string; lanHosts: string[] }): string {
  if (meta?.publicUrl) return `${meta.publicUrl}/join/${code}`;
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname);
  const host = local && meta?.lanHosts[0] ? meta.lanHosts[0] : location.hostname;
  const port = location.port ? `:${location.port}` : '';
  return `${location.protocol}//${host}${port}/join/${code}`;
}
