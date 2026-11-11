import { usePath } from './lib/router.ts';
import { Home } from './pages/Home.tsx';
import { Host } from './pages/Host.tsx';
import { Guest } from './pages/Guest.tsx';
import { Studio } from './pages/Studio.tsx';

export function App() {
  const path = usePath();
  const host = path.match(/^\/host\/([A-Za-z0-9]{3,8})\/?$/);
  if (host) return <Host key={host[1]} code={host[1]!.toUpperCase()} />;
  const join = path.match(/^\/(?:join|j)\/([A-Za-z0-9]{3,8})\/?$/);
  if (join) return <Guest key={join[1]} code={join[1]!.toUpperCase()} />;
  if (path.startsWith('/studio')) return <Studio />;
  return <Home />;
}
