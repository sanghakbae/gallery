// Append high-confidence location tags to /tmp/locations.json.
// Usage: node scripts/tag-loc.mjs <offset> "<idx>=<location>" "<idx>=<location>" ...
// Looks up photo ids from /tmp/montage_<offset>.json.

import { readFileSync, writeFileSync, existsSync } from 'node:fs';

const offset = process.argv[2];
const pairs = process.argv.slice(3);
const map = JSON.parse(readFileSync(`/tmp/montage_${offset}.json`, 'utf8'));
const out = existsSync('/tmp/locations.json') ? JSON.parse(readFileSync('/tmp/locations.json', 'utf8')) : {};

let added = 0;
for (const pair of pairs) {
  const eq = pair.indexOf('=');
  const idx = pair.slice(0, eq).trim();
  const loc = pair.slice(eq + 1).trim();
  const entry = map[idx];
  if (!entry) { console.error(`no idx ${idx} in montage_${offset}`); continue; }
  out[entry.id] = loc;
  added += 1;
}
writeFileSync('/tmp/locations.json', JSON.stringify(out, null, 2));
console.log(`added ${added}; total tagged = ${Object.keys(out).length}`);
