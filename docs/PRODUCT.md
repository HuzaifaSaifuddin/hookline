# Product

## 1. The problem

**Hooks, not whole songs**, make an automatic DJ feel like a DJ: drop in at the recognisable part, blend into the next one, keep the floor moving. But playing hooks isn't enough on its own. These are the problems Hookline is designed around:

| Problem | Consequence |
|---|---|
| A catalogue baked into the app | It can't grow without a release, there's no curation workflow, and errors persist. |
| Every song tagged as a peak‑time track | There's no signal for building a night; everything is peak. |
| Randomised selection | There's no arc, no memory of what the room liked, and no explanation of picks. |
| Unverified source data. In the seed catalogue, **~6% of entries linked the wrong video** (e.g. *Chand Chupa Badal Mein* → *Tauba Tauba*), 19 uploads blocked embedding, and some entries were 40‑minute jukeboxes or devotional chants tagged as wedding songs | The wrong song plays, and its hook times are meaningless. |
| A single device, no guests | Nobody else at the party can take part. |
| Generic hooks for newly added songs | There's no way to fix a bad hook. |

## 2. Vision

**Hookline is the DJ that reads the room.** You tell it the occasion, it runs the night, and the room steers it.

The hook idea is the foundation, but a real DJ does three more things:
1. **Plans an arc.** Warm‑up, build, peak, breathers. The opening song of a wedding is not the 11pm song.
2. **Reads the crowd.** Requests, energy, what's landing and what's emptying the floor.
3. **Can explain itself.** "I went Punjabi because you asked, and the energy's climbing."

### Who it's for
- **Primary:** the host of a South‑Asian celebration (wedding functions, sangeet, mehendi, house parties, birthdays) who wants great music without hiring a DJ or babysitting a playlist. They have a laptop or TV, a speaker and a room full of phones.
- **Secondary:** gym and workout sessions, road trips, festivals (Ganeshotsav, Navratri). The occasion model is data, so any culture's occasions and catalogue can be added.

### Positioning
Spotify's "DJ" talks *to one listener*. Hookline plays *for a room*: it gives up the full song for the best part, and gives guests a real say.

## 3. Version 1 scope (built)

| Capability | Why it's in V1 |
|---|---|
| **Hook‑based two‑deck playback** with muted pre‑roll and equal‑power crossfades; three styles (quick ~50s, hooks, full songs) | The core identity. Pre‑roll makes failures visible early, while there's still time to fall back. |
| **Energy‑arc planner** (build / waves / peak / intervals / steady / cooldown), fitted to the catalogue's actual energy range | The main "DJ intelligence". Deterministic, explainable and free to run. |
| **Explainable picks** (top reasons per track) | Builds trust and makes the planner debuggable. |
| **Natural‑language set intent** (Claude with the rule parser as fallback) | People describe parties in messy, mixed language. This is where an LLM earns its place. |
| **Room mode**: QR join, requests and votes, 🔥/❤️/😴 reactions → live energy bias, crowd skip votes | Parties are social; this is the most distinctive feature. |
| **Live steering**: energy ±, like/dislike, play‑next, remove, re‑plan, "talk to the DJ" | The DJ should be autonomous, but the host keeps control. |
| **Self‑healing catalogue**: oEmbed verification, title‑match quarantine, runtime source failover and demotion | Source data has real errors; the product shouldn't play the wrong song. |
| **Hook Studio**: preview, set in/out, confirm sources, add any song by link | Curation is how the catalogue gets better. |
| **Learning loop**: completion/skip/like stats → quality score; crowd hook nudges → median‑calibrated hooks | The more it's used, the better it gets, without ML infrastructure. |
| **Crash recovery**: rooms persisted; host and guests auto‑reconnect; resume the interrupted song | Parties don't forgive outages. |

### Deliberately not in V1
- **Accounts, payments, multi‑host.** A device‑bound host key is enough for a party.
- **Spotify / Apple Music.** Playback SDKs need Premium accounts and forbid this kind of hook‑clipping of the catalogue. YouTube embeds are the legitimate, universal option.
- **Automatic hook detection from audio.** It would need audio access, which we can't legitimately get from embeds. The crowd‑nudge and curator loop is the V1 answer (see roadmap).
- **LLM‑chosen songs.** Slower, costlier and less controllable than the planner, and it can hallucinate songs that aren't in the catalogue.

## 4. Roadmap (what I'd do next)

1. **Catalogue breadth.** Bulk‑import calmer material (dinner, cocktail, haldi) and more languages (Tamil, Telugu, Bengali, Gujarati, global pop), using the Data API search plus the verification pipeline.
2. **Hook intelligence.** Learn hook windows from listening behaviour across rooms (where people react 🔥 and where they skip), and offer "suggested hooks" in the Studio for human approval. An offline model over licensed audio previews could suggest initial hooks.
3. **Moments.** Scheduled cues for weddings ("first dance at 9:30", "cake cutting", "bride entry"), so the DJ builds toward a planned moment and then plays a pinned song.
4. **Smarter transitions.** Use BPM and key metadata (from a licensed metadata API) for harmonic, tempo‑aware ordering, and vary crossfade length by energy delta.
5. **Hosted parties.** Public URL per room, room expiry and moderation (guest name filtering, request limits per room), and a PWA install for guests.
6. **Personal taste profiles** that carry across parties (opt‑in accounts).
