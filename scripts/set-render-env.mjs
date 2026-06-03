// Set R2_PUBLIC_BASE_URL on the Render service and trigger a redeploy.
// Reads RENDER_API_KEY from the environment.
//
// Usage: node scripts/set-render-env.mjs <serviceName> <key> <value>

const apiKey = process.env.RENDER_API_KEY;
const serviceName = process.argv[2] || 'photos-mgmt-system-api';
const envKey = process.argv[3] || 'R2_PUBLIC_BASE_URL';
const envValue = process.argv[4] || 'https://cdn.sanghak.kr';

const api = 'https://api.render.com/v1';
const headers = { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json', Accept: 'application/json' };

async function render(method, path, body) {
  const res = await fetch(`${api}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status} ${text}`);
  return text ? JSON.parse(text) : null;
}

async function main() {
  if (!apiKey) throw new Error('RENDER_API_KEY missing');

  const services = await render('GET', `/services?name=${encodeURIComponent(serviceName)}&limit=20`);
  const svc = services.map((s) => s.service || s).find((s) => s.name === serviceName);
  if (!svc) throw new Error(`Service not found: ${serviceName}`);
  console.log(`service ${serviceName} = ${svc.id}`);

  console.log(`setting ${envKey}=${envValue}`);
  await render('PUT', `/services/${svc.id}/env-vars/${envKey}`, { value: envValue });

  console.log('triggering deploy...');
  const deploy = await render('POST', `/services/${svc.id}/deploys`, { clearCache: 'do_not_clear' });
  console.log(`deploy started: ${deploy.id} (status: ${deploy.status})`);
}

main().then(
  () => process.exit(0),
  (e) => { console.error('ERROR:', e.message); process.exit(1); },
);
