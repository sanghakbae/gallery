// Connect a custom domain to the R2 bucket via the Cloudflare API, then poll
// until it is active. Reads CLOUDFLARE_API_TOKEN from the environment.
//
// Usage: node scripts/setup-r2-cdn.mjs <domain> <bucket> [accountId]

const token = process.env.CLOUDFLARE_API_TOKEN;
const domain = process.argv[2] || 'cdn.sanghak.kr';
const bucket = process.argv[3] || 'photos-mgmt-system';
const accountId = process.argv[4] || '02f0426678a5977483be4b2210cdf293';
const zoneName = domain.split('.').slice(-2).join('.');

const api = 'https://api.cloudflare.com/client/v4';
const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

async function cf(method, path, body) {
  const res = await fetch(`${api}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json();
  if (!json.success) {
    throw new Error(`${method} ${path} failed: ${JSON.stringify(json.errors)}`);
  }
  return json.result;
}

async function main() {
  if (!token) throw new Error('CLOUDFLARE_API_TOKEN missing');

  const zones = await cf('GET', `/zones?name=${zoneName}`);
  if (!zones.length) throw new Error(`Zone not found: ${zoneName}`);
  const zoneId = zones[0].id;
  console.log(`zone ${zoneName} = ${zoneId}`);

  // Only remove genuinely manual conflicting records. R2-managed records
  // (e.g. CNAME -> public.r2.dev) are correct and cannot/should not be deleted.
  const existing = await cf('GET', `/zones/${zoneId}/dns_records?name=${domain}`);
  for (const rec of existing) {
    const managed = /r2\.dev|r2\.cloudflarestorage/.test(rec.content || '');
    if (managed) {
      console.log(`keeping R2-managed DNS record: ${rec.type} ${rec.name} -> ${rec.content}`);
      continue;
    }
    console.log(`deleting conflicting manual DNS record: ${rec.type} ${rec.name} -> ${rec.content}`);
    await cf('DELETE', `/zones/${zoneId}/dns_records/${rec.id}`);
  }

  // Check whether the custom domain is already attached.
  const list = await cf('GET', `/accounts/${accountId}/r2/buckets/${bucket}/domains/custom`);
  const found = (list.domains || list || []).find?.((d) => d.domain === domain);
  if (found) {
    console.log(`custom domain already exists, status: ${JSON.stringify(found.status || found)}`);
  } else {
    console.log(`attaching custom domain ${domain} to bucket ${bucket}...`);
    await cf('POST', `/accounts/${accountId}/r2/buckets/${bucket}/domains/custom`, {
      domain,
      zoneId,
      enabled: true,
    });
    console.log('attached. waiting for activation...');
  }

  // Poll status.
  for (let i = 0; i < 24; i += 1) {
    const status = await cf('GET', `/accounts/${accountId}/r2/buckets/${bucket}/domains/custom`);
    const list2 = status.domains || status || [];
    const d = list2.find?.((x) => x.domain === domain);
    const ssl = d?.status?.ssl;
    const ownership = d?.status?.ownership;
    console.log(`  [${i}] ssl=${ssl} ownership=${ownership}`);
    if (ssl === 'active') {
      console.log('CUSTOM DOMAIN ACTIVE');
      return;
    }
    await new Promise((r) => setTimeout(r, 15000));
  }
  console.log('Still not active after polling; certificate may need more time.');
}

main().then(
  () => process.exit(0),
  (e) => { console.error('ERROR:', e.message); process.exit(1); },
);
