# Architecture

## Shape of the system

```
                ┌──────────────────────── host browser (laptop/TV + speaker) ─────────────────────────┐
                │  React DJ console                                                                    │
                │  DeckEngine: 2 × YouTube IFrame players, pre-roll, equal-power crossfade, failover   │
                └──────────────▲──────────────────────────────────────────┬─────────────────────────────┘
                     snapshots │ (WebSocket)                  "started", "preloading",
                               │                               "sourceFailed", energy, vibe…
┌──────────────────────────────┴──────────────────────────────────────────▼─────────────────────────────┐
│ Node process (Fastify)                                                                                 │
│                                                                                                        │
│  RoomManager ── transport, auth (host key), rate limits, debounced broadcast & persistence            │
│     └─ Room ── authoritative party state: intent, now playing, locked next, queue, requests,           │
│                reactions, taste, history.  Pure logic, injectable clock.                               │
│  IntentParser ── Claude structured output ─┐ fallback ─▶ rule parser (core)                            │
│  CatalogStore ── git catalogue + runtime learning overlays (hooks, nudges, source health, stats)       │
│  REST: /api/meta, /rooms, /search, /catalog, /songs/:id/hook|verify, /songs/import, /insights, /health │
│                                                                                                        │
│  @hookline/core (pure TS, shared with the browser): planner · arcs · hooks · intent · text · protocol │
└───────────────┬─────────────────────────────────────────────┬──────────────────────────────────────────┘
                │ node:sqlite (WAL)                           │ HTTPS
        data/hookline.db                         YouTube oEmbed / Data API · Anthropic API
                ▲
   catalog/songs/*.json (git) ── loaded at boot; `npm run catalog:export` folds curation back
                ▲
     guest phones ── React guest view ── WebSocket (requests, votes, reactions, skip votes)
```

One deployable unit, one language (TypeScript end to end), one data store.

## Key decisions

### 1. A modular monolith, not services
**Chosen:** one Node process with clear modules (`core` domain, `room` aggregate, `catalog-store`, transport).
**Alternatives:** separate catalogue, room and AI services; serverless functions plus a hosted realtime service.
**Why:** the hot path is "a reaction arrives → re‑plan → broadcast to ~50 phones", which is sub‑millisecond in memory. Distribution would add network hops, consistency problems and operational cost without solving a real problem. The domain core is already pure and I/O‑free, so it can be extracted later if needed.

### 2. Server‑authoritative rooms, browser‑authoritative audio
The **server** decides *what* plays next (so all guests see one truth, requests are fair, and state survives a host reload). The **host browser** decides *when*, because only it knows actual playback time and whether a YouTube video really started. The protocol reflects this: the host reports facts (`started`, `preloading`, `sourceFailed`) and the server replies with plans.

Two subtleties:
- **Next‑track lock.** When the host starts pre‑rolling track N+1 (T‑25s), it sends `preloading`, and the server locks that track at the head of the queue. Reactions and requests can still re‑plan everything after it, but never the track that's already buffering. The host can still override with *play next*.
- **Stable plans.** The planner's tie‑breaking jitter is a hash of `(songId, room seed)`, not a sequential RNG. Re‑planning only changes picks whose inputs changed, so the guest "coming up" list doesn't reshuffle every time a song starts. A browser test caught this.

### 3. Full snapshots over WebSocket, not deltas or CRDTs
A snapshot is a few KB; updates happen a few times a minute. Full snapshots make reconnects, late joiners and server restarts trivially correct. Broadcasts are debounced (40ms) to coalesce bursts. Messages are validated with Zod on both sides (`packages/core/src/protocol.ts`).

### 4. The planner is an explainable scoring function, not an LLM
For each candidate: `fit(occasion tags) + energy distance to the arc target + flow (artist repeats, language streaks, energy jumps) + long‑term quality (Bayesian completion/skip/like score) + freshness + session taste + popularity (weighted up at peaks) + requests (with wait and vote boosts) + stable jitter`. The top contributing factors become user‑facing reasons. Constraints relax step by step (strict → any tag → repeats of the longest‑ago tracks) so the DJ never goes silent.
**Why not an LLM?** Each pick would take seconds and cost money, results wouldn't be reproducible (hard to test), and it could hallucinate songs outside the catalogue. The scorer plans 60 tracks in milliseconds, is deterministic under a seed (tests rely on this), and explains itself.

**Arc fitting.** Arcs are authored on a 7–10 scale. Each occasion and language slice of the catalogue has its own energy range (festival music sits at 8–10), so the arc is stretched onto the slice's 10th–90th percentile. Without this, a "warm‑up" target pulled in off‑occasion songs; a test caught it.

### 5. Where AI is used, and where it isn't
| Problem | Approach | Reason |
|---|---|---|
| "Sangeet, aunties need 90s first, then Punjabi, no Honey Singh" → plan | **Claude** (`claude-opus-5-5`, `effort: low`, Zod structured output, cached system prompt, 12s timeout) | Understanding messy natural language is what LLMs are for. Output is small, schema‑validated and checked against the real catalogue (artists fuzzy‑matched, seed songs resolved). |
| Same, without a key / on failure / refusal | **Rule parser** in core | The product must never depend on the AI being up. The landing page uses it for free live previews as you type. |
| Picking songs, ordering, energy | Scoring planner | See above. |
| Is this YouTube video really this song? | **Consonant‑skeleton fuzzy matching** tuned for romanised Indic titles (Chhote/Chote, Jehda/Jedha) | Deterministic, free, testable; caught 57 wrong videos. |
| Hook calibration | Median of crowd nudges (≥3 votes, bounded ±20s) | Robust to trolls; curator edits always win. |

**Cost:** one Claude call per "talk to the DJ" message or party creation with text. That's on the order of a few hundred tokens out, so fractions of a cent per party.

### 6. Catalogue as data in git, learning in SQLite
`catalog/songs/<language>.json` is canonical and human‑reviewable (schema‑validated in CI via `npm run catalog:validate`). The database holds only what's **learned at runtime**: curator hooks, crowd nudges, source health, durations, user‑added songs, play events, feedback and rooms. `npm run catalog:export` folds curated data back into the files, so the catalogue grows independently of any one deployment. See [CATALOGUE.md](CATALOGUE.md).

### 7. Technology choices
| Choice | Why | Alternatives considered |
|---|---|---|
| **TypeScript everywhere** | One language for domain, server and browser; the planner, protocol and schemas are shared, not duplicated. | Go or Rust server: faster but splits the domain across languages for no measurable gain at this scale. |
| **Fastify + @fastify/websocket** | Mature, fast, first‑class `inject`/`injectWS` for integration tests. | Socket.IO (unneeded fallbacks and protocol), Hono (lighter WS story on Node). |
| **`node:sqlite`** | Zero native build, single file, WAL mode, synchronous and simple. Writes are tiny and infrequent. | Postgres (an extra service), better‑sqlite3 (native compile). Swapping is localised to `db.ts` and `catalog-store.ts`. |
| **React + Vite**, no router or state library | The UI is four screens; a 20‑line router and hooks are enough. 95 KB gzipped. | Next.js (SSR unnecessary for a realtime client app). |
| **Zod** | One schema serves validation, types and Claude structured output. | |
| **YouTube IFrame API** | The legitimate way to play this catalogue: no downloading, no proxying, ToS‑compliant visible player. | Spotify/Apple SDKs: need Premium accounts, and their terms prohibit clipping. |

## Reliability and failure handling

| Failure | Handling |
|---|---|
| A YouTube upload is deleted or blocks embedding (errors 100/101/150) | The engine tries the next upload. The server treats the error as a *report* and confirms it with oEmbed before demoting the upload for everyone, because these errors can be caused by the embedding page rather than the video (label videos fail on plain‑http LAN origins but play on localhost/HTTPS). Unconfirmed failures only skip the song for that party. If no uploads are left, the song is marked unplayable and skipped instantly. Pre‑roll at T‑25s means most failures happen *before* the transition. |
| Video stalls while loading | 12s watchdog → treated as a failed source. Autoplay blocked → "Tap to let the music play". |
| Incoming deck fails mid‑crossfade | The fade is aborted, the current song keeps playing, and another track is tried. |
| Upload shorter or longer than the one the catalogue timed | Hook window clamped to the real duration reported by the player. |
| Server restarts | Rooms are persisted (debounced 1s, flushed on SIGTERM) and restored lazily, paused. Clients reconnect with capped exponential backoff and re‑hello; the host resumes the interrupted song. |
| Host tab closes | Guests see "DJ screen offline"; requests still accumulate. |
| Claude unavailable, slow or refusing | Falls back to the rule parser (logged). |
| Planner pool exhausted | Constraints relax step by step; repeats of the longest‑ago tracks are the last resort. |
| Abuse | Host commands need a 144‑bit host key (constant‑time compare). Per‑connection token‑bucket rate limit. Zod validation on every message. 16 KB WS frame cap. Per‑guest request cap (3 pending). Reaction de‑bounce. Names sanitised. Optional Studio key. |

## Observability
- Structured JSON logs (pino via Fastify) for room lifecycle, source failures, unplayable songs, curator edits, AI latency and fallbacks.
- `GET /api/health`: catalogue size, live rooms and peers, AI status, uptime.
- `play_events` and `feedback` tables power **Studio → Insights** (most played, skip rates, failing uploads) and the planner's quality scores.

## Testing
- **Domain (core):** planner invariants on the *real* catalogue (no repeats, no back‑to‑back artists, the arc rises, language filters and preferences, avoid lists, seeds, requests, stable re‑plans), hook windows and calibration, title matching, intent parsing.
- **Data quality:** every catalogue entry validated against the schema; ID uniqueness; hook bounds; at least 90% auto‑playable.
- **Integration (server):** real Fastify app, in‑memory SQLite, WebSocket clients and a controllable clock: host auth, request → queue → credit flow, cooldowns, crowd skip, preload lock and host override, source failure, dislike, rate limiting, link import (stubbed oEmbed), studio lock, crash recovery and resume.
- **Manual end‑to‑end in Chrome:** start from a sentence, real YouTube playback, skip crossfade, automatic hook‑end transition (logged at 1s resolution: fade from T‑6s to exactly `hook_end`), server restart and resume, guest join, request and react, Studio quarantine preview.

## How it scales and evolves
- **Today:** one process comfortably handles hundreds of concurrent rooms (all state in memory, tiny snapshots).
- **Next:** multiple instances behind a load balancer with **sticky routing by room code** (rooms are independent aggregates), and SQLite → Postgres when multiple writers appear.
- **Extraction points:** `@hookline/core` could run the planner on the edge or in the host browser for offline parties. The protocol is already transport‑agnostic.
