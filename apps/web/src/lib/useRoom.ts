import { useCallback, useEffect, useRef, useState } from 'react';
import type { GuestMessage, HostMessage, RoomSnapshot, ServerMessage } from '@hookline/core';

export interface Toast {
  id: number;
  text: string;
  tone?: 'info' | 'success' | 'warn';
}

export type ConnState = 'connecting' | 'open' | 'reconnecting' | 'failed';

interface Options {
  code: string;
  role: 'host' | 'guest';
  hostKey?: string;
  guestId?: string;
  name?: string;
  enabled?: boolean;
  onCommand?: (cmd: 'skip') => void;
}

/**
 * Live connection to a room. Reconnects with capped exponential backoff and
 * re-sends hello, so a flaky venue Wi-Fi or a server restart heals itself.
 * Messages sent while disconnected are dropped (they're all idempotent-ish
 * user actions; the UI shows the connection state).
 */
export function useRoom(opts: Options) {
  const [room, setRoom] = useState<RoomSnapshot | null>(null);
  const [conn, setConn] = useState<ConnState>('connecting');
  const [fatal, setFatal] = useState<string | null>(null);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [me, setMe] = useState<{ guestId: string; name: string } | null>(null);
  const [clockOffset, setClockOffset] = useState(0);
  const wsRef = useRef<WebSocket | null>(null);
  const optsRef = useRef(opts);
  optsRef.current = opts;

  const toast = useCallback((text: string, tone?: Toast['tone']) => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t.slice(-3), { id, text, tone }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 4200);
  }, []);

  useEffect(() => {
    if (opts.enabled === false) return;
    let attempt = 0;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const open = () => {
      const proto = location.protocol === 'https:' ? 'wss' : 'ws';
      const ws = new WebSocket(`${proto}://${location.host}/ws`);
      wsRef.current = ws;
      setConn(attempt === 0 ? 'connecting' : 'reconnecting');
      ws.onopen = () => {
        attempt = 0;
        const o = optsRef.current;
        ws.send(JSON.stringify({ type: 'hello', room: o.code, role: o.role, hostKey: o.hostKey, guestId: o.guestId, name: o.name }));
      };
      ws.onmessage = (ev) => {
        const m = JSON.parse(ev.data as string) as ServerMessage;
        switch (m.type) {
          case 'welcome':
            setConn('open');
            setFatal(null);
            setMe({ guestId: m.guestId, name: m.name });
            break;
          case 'snapshot':
            setRoom(m.room);
            setClockOffset(m.room.serverTime - Date.now());
            break;
          case 'toast':
            toast(m.text, m.tone);
            break;
          case 'command':
            optsRef.current.onCommand?.(m.command);
            break;
          case 'error':
            if (/not found|not authorised|ended/i.test(m.message)) {
              setFatal(m.message);
              stopped = true;
            } else toast(m.message, 'warn');
            break;
        }
      };
      ws.onclose = () => {
        if (wsRef.current === ws) wsRef.current = null;
        if (stopped) {
          setConn('failed');
          return;
        }
        attempt++;
        setConn('reconnecting');
        timer = setTimeout(open, Math.min(10_000, 400 * 2 ** Math.min(attempt, 5)) + Math.random() * 300);
      };
    };
    open();
    return () => {
      stopped = true;
      clearTimeout(timer);
      wsRef.current?.close();
    };
  }, [opts.code, opts.role, opts.hostKey, opts.enabled, toast]);

  const send = useCallback((m: HostMessage | GuestMessage): boolean => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return false;
    ws.send(JSON.stringify(m));
    return true;
  }, []);

  return { room, conn, fatal, toasts, toast, me, send, clockOffset };
}
