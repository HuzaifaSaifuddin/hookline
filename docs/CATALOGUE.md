# Catalogue

## Where it came from

Version 1 starts from a **999‑song seed catalogue** of song metadata: titles, artists, language, durations, hook in/out times, energy, occasion tags and YouTube video ids. Entries from it carry `"provenance": { "origin": "seed" }` and hooks marked `"source": "seed"`.

It contains **metadata only**. No audio is stored or downloaded. Artwork comes from YouTube's public thumbnail URLs for the video actually being played.

## Format

One JSON array per language. Each entry is validated by `CatalogEntrySchema` (`packages/core/src/catalog.ts`):

```jsonc
{
  "id": "kala-chashma",                         // kebab-case, unique across files
  "title": "Kala Chashma",
  "artists": ["Amar Arshi", "Badshah", "Neha Kakkar"],
  "language": "hindi",
  "durationSec": 184,
  "hook": { "startSec": 43, "endSec": 120, "source": "seed" },   // positions in the song, not a duration
  "energy": 10,                                 // 1 (ambient) .. 10 (peak)
  "popularity": 1,                              // 0..1 sing-along factor
  "popularitySource": "derived",                // or "curator"
  "tags": ["baraat", "birthday", "late-night", "mehendi", "sangeet", "wedding", "workout"],
  "sources": [{ "provider": "youtube", "id": "cCmZ7aFU1xY" }, ...],   // alternates, best first after verification
  "provenance": { "origin": "seed", "importedAt": "2026-11-11" },
  "verified": true                              // optional: curator confirmed sources despite a fuzzy mismatch
}
```

`hook.source` records who decided the timings: `seed` (from the seed catalogue), `curator` (Studio), `crowd` (calibrated from nudges at runtime) or `default` (a heuristic for songs with no hook).

## Verification (what was actually checked)

`npm run catalog:verify` checks every YouTube id through YouTube's **public oEmbed endpoint** (no key, no scraping). Results are cached in `catalog/verification/youtube.json` and refreshed when older than 30 days:

| Result | Count |
|---|---|
| Public and embeddable | 2,532 |
| Embedding disabled by owner | 19 |
| Songs with no playable upload | 1 |

oEmbed also returns each video's **real title**. Comparing it with our song title, using consonant‑skeleton matching that tolerates romanised spelling variants, found that **57 songs (5.7%) have no upload that plausibly matches**. For example, *Chand Chupa Badal Mein* points to *Tauba Tauba (Karan Aujla)*, and several Marathi entries ("Dolby Beat Marathi", "Saglyat Bhari Marathi") point to unrelated videos. A wrong video makes the hook times meaningless, so such songs are **quarantined**: they stay searchable but out of autoplay and appear under **Studio → Needs review**, where a curator can preview and confirm them. Jukebox and non‑stop uploads attached to a single song are demoted the same way.

**Resolved on 2026‑11‑12** (`scripts/fix-mismatched-sources.ts`): rather than keep them quarantined, each flagged song now *is* what its upload actually plays. 35 were renamed to the real song (hand‑checked title and artists, one upload kept, hook and duration cleared so the DJ uses its default hook until a curator tunes it), 1 was a false alarm and is confirmed, and 23 were removed (16 duplicated an existing song's upload, 6 weren't single songs, 1 had nothing playable). The review queue is empty; new imports or edits can still land there.

## Curation rules (`scripts/curate.mjs`)

Explicit, idempotent and reviewable in git history:
1. **Devotional** tracks (aarti, jaap, mantra, bhajan…; 26 songs) lose their wedding and party tags, gain `devotional` + `festival`, and power the new **Festival** occasion. *Gondhal* (folk‑devotional, danced at Maharashtrian events) keeps its party tags and also gains `festival`.
2. **Medleys** (non‑stop mixes and DJ compilations, by the song's own title; 4 songs) get `medley` and are never auto‑played, because hooks don't apply.
3. **Popularity** is derived from how many alternate uploads the seed catalogue lists (its best‑known hits have five). It's a usable recognisability proxy, and a curator can override it.

## Current state

976 songs · **973 auto‑playable** (3 are non‑stop mixes) · Hindi 513, Marathi 259, Punjabi 190, English 11 (playable counts). Known issue: 66 YouTube uploads are listed under two different songs, so a few songs are effectively duplicates.

## Growing it

- **In the app:** Studio → Add songs (paste any YouTube link: verified via oEmbed, any language). Studio hook edits and "sources are correct" confirmations are stored in the DB.
- **Back into git:** `npm run catalog:export` writes curator hooks, confirmations, learned durations and added songs into `catalog/songs/*.json`. Review with `git diff catalog/`, then `npm run catalog:validate`.
- **By hand or by script:** append entries to the language file, run `npm run catalog:verify && npm run catalog:validate`.
