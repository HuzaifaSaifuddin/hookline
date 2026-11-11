# Deployment plan

> **Nothing has been deployed or pushed.** This is the plan, prepared for your approval.

## Recommendation

Run Hookline as **one container with a persistent volume** on a host that supports long‑lived WebSockets. My default suggestion is **Fly.io** (single machine in `bom`/Mumbai, 1 GB volume); any Docker host (Render, Railway, a VPS) works the same way.

Why not serverless or edge functions? Rooms are in‑memory aggregates held by long‑lived WebSockets, and SQLite needs a persistent disk. Serverless would force an external realtime service plus an external database, which is more moving parts for no V1 benefit.

**Estimated cost:** one shared‑CPU 512 MB machine with a 1 GB volume runs a few US dollars a month (it can suspend when idle). The YouTube Data API is free within its default quota (search is optional).

## What's prepared
- `Dockerfile`: multi‑stage build. It runs `npm ci`, builds the web app, **typechecks and runs the full test suite** (the build fails if tests fail), then runs as the non‑root `node` user with a healthcheck on `/api/health`.
- `deploy/fly.toml`: example config (volume mounted at `/data`, HTTPS forced, health checks, suspend when idle). The app name and URL are placeholders.
- `.env.example`: all configuration.

## Steps (after your approval)
1. Create a GitHub repository and push (`git remote add origin …; git push -u origin main`). *Needs your approval and account.*
2. `fly launch --no-deploy --copy-config --config deploy/fly.toml` and pick a unique app name. *Needs your Fly account.*
3. `fly volumes create hookline_data --size 1 --region bom`
4. Secrets (optional): `fly secrets set YOUTUBE_API_KEY=… HOOKLINE_STUDIO_KEY=…`. **Set `HOOKLINE_STUDIO_KEY` for any public deployment** so strangers can't edit hooks or import songs.
5. Set `PUBLIC_URL=https://<app>.fly.dev` so QR codes point at the public URL.
6. `fly deploy`, then smoke test: `/api/health`, start a party, join from a phone on mobile data.

## Before going public (checklist)
- [ ] Studio key set; consider putting `/studio` behind auth.
- [ ] Room expiry job (rooms older than 7 days are already ignored; add deletion).
- [ ] Guest name moderation (profanity filter) if rooms are publicly shareable.
- [ ] Back up the SQLite volume (Fly volume snapshots are daily by default; or Litestream to object storage).
- [ ] Review YouTube API Services Terms for your use (embedded player visible, no audio extraction: already the case).
- [ ] Privacy note: guests' chosen display names and reactions are stored per room. No accounts and no tracking cookies.

## Scaling path
One instance handles hundreds of concurrent parties. Beyond that: multiple instances with **sticky routing by room code** (Fly `fly-replay` header or a consistent‑hash proxy), with SQLite moved to Postgres.
