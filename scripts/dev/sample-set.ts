/** Prints a planned set for eyeballing DJ quality: npx tsx scripts/dev/sample-set.ts wedding 22 */
import { planQueue, seededRng, defaultIntent, emptyTaste } from '../../packages/core/src/index.ts';
import { realSongs } from '../../packages/core/test/fixtures.ts';
const [occ = 'wedding', n = '22', seed = '7'] = process.argv.slice(2);
const p = planQueue({ songs: realSongs(), intent: defaultIntent(occ), history: [], elapsedSec: 0, taste: emptyTaste(), requests: [], now: Date.now(), rng: seededRng(+seed) }, +n);
for (const x of p) console.log(`${x.targetEnergy.toFixed(1)} e${x.song.energy} ${x.song.language.slice(0, 3)} ${x.song.title.slice(0, 26).padEnd(26)} ${x.song.artists[0]!.slice(0, 16).padEnd(16)} | ${x.reasons.join(' / ')}`);
