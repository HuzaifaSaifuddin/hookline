# Hookline: the DJ that reads the room

Hookline is an autonomous, **hook‑based** party DJ. You pick the occasion, languages and how much of each song to play. It plans an energy curve for the night, plays the best part of each song (curated `hook_start` → `hook_end`) with equal‑power crossfades, and lets guests request, upvote, react and vote to skip from their phones. It explains every pick and learns from skips, likes and hook feedback.

> Status: **Version 1, local only.** Nothing has been pushed or deployed. See [Deployment plan](docs/DEPLOYMENT.md).

---

## Run it

Requirements: **Node ≥ 22.13** (uses the built‑in `node:sqlite`; no native modules, no database to install).

```bash
npm install
npm start            # builds the web app, then serves everything on http://localhost:8787
```

Open **http://localhost:8787** on the computer connected to the speaker.

- **Dev mode** (hot reload for web + server): `npm run dev`, then open http://localhost:5173
- **Tests**: `npm test` (68 tests: domain, catalogue data quality, API and WebSocket integration)
- **Typecheck**: `npm run typecheck`

Guests join from phones on the **same Wi‑Fi** by scanning the QR code on the DJ screen, which shows the server's LAN address. Your OS firewall may ask you to allow incoming connections to Node.

> **Open the DJ screen and the Studio at `http://localhost:8787`, not the LAN address.** YouTube refuses to embed many label‑owned music videos ("Video unavailable", error 150) on pages served over plain http from a network address (`192.168.x.x`, `*.local`), while the same videos play on `localhost` and on HTTPS sites. Guests are unaffected because their phones don't play video. To run the DJ screen on another device (e.g. a TV), serve Hookline over HTTPS. The app shows a warning when this applies.
>
> Measured 2026‑11‑11 (6 videos × 2 runs each): LAN `http://192.168.x.x` → 8/12 failed with error 150, always the same 4 label videos. `https://…ngrok-free.app` → 12/12 played. `http://localhost` → 12/12 played.

### Over HTTPS with ngrok (phone/TV as the DJ screen, or remote guests)

This makes your local Hookline **publicly reachable** while the tunnel runs, so lock the Studio first:

```bash
HOOKLINE_STUDIO_KEY=$(openssl rand -hex 16) npm start   # Studio edits now need this key
ngrok http 8787                                          # open the https://…ngrok-free.app URL it prints
```

The QR code automatically uses the ngrok address. Stop ngrok (Ctrl+C) when the party's over.

### Optional configuration

Everything works without keys. Copy `.env.example` to `.env` to enable extras:

| Variable | Effect |
|---|---|
| `YOUTUBE_API_KEY` | Enables *Search YouTube* in the Studio (YouTube Data API v3). Adding songs by link works without it. |
| `HOOKLINE_STUDIO_KEY` | Locks Studio write endpoints (hook edits, imports) behind a shared key. |
| `PUBLIC_URL` | Base URL for guest links when hosted (otherwise the LAN IP is used). |
| `PORT`, `HOOKLINE_DB` | Port (default 8787) and SQLite path (default `data/hookline.db`). |

---

## Try the important journeys

1. **Start a party.** On the home page pick an occasion (e.g. **House Party**), optionally languages and a style (Quick hits / Hooks / Full songs). Press **Start the DJ**, then **Start the party**.
2. **Hook playback.** The bar under the video shows the whole song with the hook window highlighted; playback starts at `hook_start`. About 25s before `hook_end` the next track pre‑rolls *muted* on the standby deck. At T‑6s it crossfades and the next song comes in at its own hook. Press ⏭ to crossfade early.
3. **Explainable flow.** Every track shows why it was picked ("Building up ↑ energy 9", "Punjabi, as you prefer", "Big sing‑along for the peak"). The **Energy plan** chart shows the planned curve and what actually played.
4. **Steer it live.** Use **Energy −/+**, 👍/👎, ✕ (not tonight), ⤴ (play next) or ↻ Re‑plan. The queue re‑plans immediately; the cued next track stays locked so the crossfade isn't disrupted.
5. **Guests.** Open the join link (or `http://localhost:8787/join/CODE` in another browser). Search and **Request** a song: it's woven in within a track or two and credited ("🙋 Priya"). Others can ▲ vote. 🔥/😴 reactions shift energy for a few minutes. Skip votes past the threshold (40% of guests, minimum 2) skip the track.
6. **Recovery.** Stop the server (Ctrl+C) mid‑song and start it again. The DJ page reconnects by itself and offers **Resume the party**, which picks up the interrupted song. Guests reconnect too.
7. **Hook Studio** (`/studio`). Browse the catalogue, filter **Needs review** (songs whose YouTube video doesn't match the title), preview them, set IN/OUT at the playhead, save. The next play uses the new hook. **Add songs** imports any YouTube link (any language) after checking it allows embedded playback.
8. **Learning.** On the DJ page, *Hook timing off?* records crowd nudges; three or more agreeing nudges shift the hook by their median. Skips, completions and likes feed a long‑term quality score. Blocked or dead uploads fail over to alternates and are demoted.

---

## What's in the box

```
catalog/            the music catalogue (data, not code), versioned in git
  songs/<lang>.json   999 songs: title, artists, language, duration, hook, energy, tags, YouTube sources
  verification/       cached oEmbed checks of every YouTube id (status + actual video title)
packages/core       pure TypeScript domain: planner, energy arcs, hooks, set plan, catalogue rules, protocol
apps/server         Fastify HTTP + WebSocket, rooms, SQLite learning store, YouTube import
apps/web            React (Vite) DJ console, guest view, Hook Studio, two-deck YouTube engine
scripts/            catalogue import / curation / verification / export
docs/               product, architecture, catalogue, deployment
```

- [Product: research, vision, scope](docs/PRODUCT.md)
- [Architecture & decisions](docs/ARCHITECTURE.md)
- [Catalogue: provenance, verification, curation](docs/CATALOGUE.md)
- [Deployment plan](docs/DEPLOYMENT.md)

## Known limitations (V1)

- **Playback uses YouTube embeds** in the host's browser (the legitimate way to play this catalogue). Ads may occasionally appear for some videos, and some uploads block embedding; those fall back to alternates or get skipped. True beat‑matching isn't possible without audio access.
- **The catalogue is party‑heavy.** The seed catalogue is celebration music (energy 6–10; Hindi/Marathi/Punjabi). Chill or dinner sets are only as calm as the catalogue allows. Any song can be added by link, and the format is language‑agnostic.
- **Keep the DJ tab open**, ideally in the foreground. Wake Lock keeps the screen on. Mobile browsers may pause background tabs.
- **Hosts are trusted by device.** The host key lives in that browser's localStorage. There are no user accounts in V1.
- **Single server process.** Rooms live in memory with SQLite persistence. Horizontal scaling would need sticky routing by room (see Architecture).
