import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

export interface Config {
  port: number;
  host: string;
  dbFile: string;
  catalogDir: string;
  webDist: string;
  /** Public base URL guests should use (e.g. behind a proxy). Otherwise LAN IPs are offered. */
  publicUrl?: string;
  youtubeApiKey?: string;
  logLevel: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return {
    port: Number(env.PORT ?? 8787),
    host: env.HOST ?? '0.0.0.0',
    dbFile: env.HOOKLINE_DB ?? path.join(repoRoot, 'data', 'hookline.db'),
    catalogDir: env.HOOKLINE_CATALOG ?? path.join(repoRoot, 'catalog'),
    webDist: path.join(repoRoot, 'apps', 'web', 'dist'),
    publicUrl: env.PUBLIC_URL?.replace(/\/$/, ''),
    youtubeApiKey: env.YOUTUBE_API_KEY || undefined,
    logLevel: env.LOG_LEVEL ?? (env.NODE_ENV === 'test' ? 'silent' : 'info'),
  };
}
