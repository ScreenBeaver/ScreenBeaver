/**
 * One-shot: search Openverse + cache a soft corporate bed for the open take.
 */
import {
  cacheMusicLocally,
  pickBestMusicHit,
  searchOpenverseMusic,
} from "../src/music.ts";

const query = "upbeat corporate instrumental soft product demo";
const hits = await searchOpenverseMusic(query, 12);
const best = pickBestMusicHit(hits);
if (!best) {
  console.error(JSON.stringify({ ok: false, error: "no hits" }));
  process.exit(1);
}
const cached = await cacheMusicLocally(best);
console.log(
  JSON.stringify(
    {
      ok: true,
      query,
      track: best,
      localUrl: cached.localUrl,
      filePath: cached.filePath,
    },
    null,
    2,
  ),
);
