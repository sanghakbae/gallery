// Fill missing locationText by propagating from temporally-adjacent photos
// that already have an AI-identified location. Photos sorted by capturedAt form
// geographically coherent runs (a trip stays in one place for a stretch), so a
// blank photo inherits the location of the nearest located photo in sequence —
// as long as that anchor is within MAXGAP positions (else left blank).
//
// Only photos WITH capturedAt participate (no date => no reliable position).
// Also sets coordinatesText + mapsUrl from the place centroid.
//
// Usage: node scripts/infer-locations-by-sequence.mjs [--dry-run] [--maxgap N]
// Requires R2 creds in env.

import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';

const dryRun = process.argv.includes('--dry-run');
const mgIdx = process.argv.indexOf('--maxgap');
const MAXGAP = mgIdx >= 0 ? Number(process.argv[mgIdx + 1]) : 25;
const key = 'metadata/photos.json';

const COORDS = {
  '베네치아, 이탈리아': [45.4371, 12.3326],
  '부라노, 베네치아, 이탈리아': [45.4853, 12.4167],
  '로마, 이탈리아': [41.8902, 12.4922],
  '아말피 해안, 이탈리아': [40.6340, 14.6029],
  '토스카나, 이탈리아': [43.0703, 11.6580],
  '피사, 이탈리아': [43.7230, 10.3966],
  '밀라노, 이탈리아': [45.4641, 9.1919],
  '스위스': [46.8182, 8.2275],
  '레만호, 스위스': [46.4500, 6.5500],
  '제네바, 스위스': [46.2074, 6.1557],
  '베른, 스위스': [46.9480, 7.4474],
  '루체른, 스위스': [47.0516, 8.3076],
  '카이에 초콜릿 공장, 스위스': [46.6053, 7.0997],
  '하와이, 미국': [21.3069, -157.8583],
  '제부도, 대한민국': [37.1672, 126.6206],
};

const r2 = new S3Client({
  region: 'auto',
  endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  forcePathStyle: true,
  credentials: { accessKeyId: process.env.R2_ACCESS_KEY_ID, secretAccessKey: process.env.R2_SECRET_ACCESS_KEY },
});
const bucket = process.env.R2_BUCKET_NAME;

async function main() {
  const res = await r2.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  const photos = JSON.parse(Buffer.from(await res.Body.transformToByteArray()).toString('utf8'));
  const byId = new Map(photos.map((p) => [p.id, p]));

  const dated = photos
    .filter((p) => String(p.capturedAt || '').trim())
    .sort((a, b) => String(a.capturedAt).localeCompare(String(b.capturedAt))
      || String(a.createdAt || '').localeCompare(String(b.createdAt || '')));

  // anchor = has a known place label (in COORDS)
  const anchor = dated.map((p) => (COORDS[String(p.locationText || '').trim()] ? String(p.locationText).trim() : null));

  const assign = {}; // id -> location
  for (let i = 0; i < dated.length; i += 1) {
    if (anchor[i]) continue;
    if (String(dated[i].locationText || '').trim()) continue; // keep any existing (e.g. URL) text
    // nearest anchor by index distance
    let best = null; let bestDist = Infinity;
    for (let d = 1; d <= MAXGAP; d += 1) {
      if (i - d >= 0 && anchor[i - d]) { best = anchor[i - d]; bestDist = d; break; }
      if (i + d < dated.length && anchor[i + d]) { best = anchor[i + d]; bestDist = d; break; }
    }
    if (best) assign[dated[i].id] = best;
  }

  const counts = {};
  for (const loc of Object.values(assign)) counts[loc] = (counts[loc] || 0) + 1;
  console.log(`Total photos: ${photos.length}`);
  console.log(`Already located: ${photos.filter((p) => String(p.locationText || '').trim()).length}`);
  console.log(`Dated photos: ${dated.length} | anchors: ${anchor.filter(Boolean).length}`);
  console.log(`Will infer location on: ${Object.keys(assign).length} (maxgap=${MAXGAP})`);
  Object.entries(counts).sort((a, b) => b[1] - a[1]).forEach(([k, n]) => console.log(`  ${n}\t${k}`));
  const stillBlank = photos.length - photos.filter((p) => String(p.locationText || '').trim()).length - Object.keys(assign).length;
  console.log(`Still blank after: ${stillBlank}`);

  if (dryRun) { console.log('\nDRY RUN — no write.'); return; }

  const now = new Date().toISOString();
  const updated = photos.map((p) => {
    const loc = assign[p.id];
    if (!loc) return p;
    const [lat, lng] = COORDS[loc];
    return {
      ...p,
      locationText: loc,
      coordinatesText: `${lat.toFixed(4)}, ${lng.toFixed(4)}`,
      mapsUrl: `https://www.google.com/maps?q=${lat},${lng}`,
      locationInferred: true,
      updatedAt: now,
    };
  });

  await r2.send(new PutObjectCommand({
    Bucket: bucket,
    Key: key,
    Body: Buffer.from(`${JSON.stringify(updated, null, 2)}\n`, 'utf8'),
    ContentType: 'application/json; charset=utf-8',
  }));
  console.log('Wrote metadata/photos.json back to R2.');
}

main().then(() => process.exit(0), (e) => { console.error('ERROR:', e.message); process.exit(1); });
