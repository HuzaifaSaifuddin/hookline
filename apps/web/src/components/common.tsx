import { useEffect, useState } from 'react';
import QRCode from 'qrcode';
import type { Toast, ConnState } from '../lib/useRoom.ts';
import { navigate } from '../lib/router.ts';
import { energyColor } from '../lib/format.ts';

export function Logo() {
  return (
    <a
      className="brand"
      href="/"
      onClick={(e) => {
        e.preventDefault();
        navigate('/');
      }}
    >
      <svg viewBox="0 0 64 64" aria-hidden>
        <defs>
          <linearGradient id="lg" x1="0" x2="1">
            <stop offset="0" stopColor="#3dd6d0" />
            <stop offset=".5" stopColor="#8b5cf6" />
            <stop offset="1" stopColor="#ff4d6d" />
          </linearGradient>
        </defs>
        <rect width="64" height="64" rx="16" fill="#1c1927" />
        <path d="M8 44 C18 44 20 20 30 20 S42 40 48 30 S54 18 56 18" fill="none" stroke="url(#lg)" strokeWidth="6" strokeLinecap="round" />
        <circle cx="48" cy="30" r="5" fill="#fff" />
      </svg>
      Hookline
    </a>
  );
}

export function Link({ to, children, className }: { to: string; children: React.ReactNode; className?: string }) {
  return (
    <a
      href={to}
      className={className}
      onClick={(e) => {
        if (e.metaKey || e.ctrlKey) return;
        e.preventDefault();
        navigate(to);
      }}
    >
      {children}
    </a>
  );
}

export function Toasts({ toasts }: { toasts: Toast[] }) {
  return (
    <div className="toasts" role="status" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className={`toast ${t.tone ?? ''}`}>
          {t.text}
        </div>
      ))}
    </div>
  );
}

export function Conn({ state }: { state: ConnState }) {
  const label = { connecting: 'Connecting…', open: 'Live', reconnecting: 'Reconnecting…', failed: 'Disconnected' }[state];
  return <span className={`conn ${state}`}>{label}</span>;
}

export function EnergyDot({ energy }: { energy: number }) {
  return <span className="energy-dot" style={{ background: energyColor(energy) }} title={`Energy ${energy}/10`} />;
}

export function Art({ src, alt, size = 48 }: { src?: string; alt: string; size?: number }) {
  return src ? (
    <img className="art" src={src} alt={alt} width={size} height={size} loading="lazy" style={{ objectFit: 'cover', borderRadius: 10 }} />
  ) : (
    <div className="art" style={{ width: size, height: size, borderRadius: 10, background: 'var(--raised)' }} />
  );
}

export function QR({ text }: { text: string }) {
  const [svg, setSvg] = useState('');
  useEffect(() => {
    QRCode.toString(text, { type: 'svg', margin: 0, errorCorrectionLevel: 'M', color: { dark: '#0c0b12', light: '#ffffff' } })
      .then(setSvg)
      .catch(() => setSvg(''));
  }, [text]);
  return <div className="qr" aria-label={`QR code for ${text}`} dangerouslySetInnerHTML={{ __html: svg }} />;
}

export function Spinner() {
  return <div className="spinner" role="progressbar" aria-label="Loading" />;
}

/** Re-render every `ms` (for progress bars driven by the clock). */
export function useNow(ms = 500): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}
