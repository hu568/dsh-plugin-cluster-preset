// Ask the LIVE Host for its agent-preset roster, to distinguish "mounted" from
// "activates successfully".
//
// `cordis_inspect Config` already showed `include:preset-cluster` in the running
// Loader, but a mounted declaration can still be a *broken* preset. The roster's
// `broken` field is the only signal that settles it, and the roster is a unary
// Remote method — not plain HTTP-looking, but carried by the `/api` fetch
// channel with this envelope:
//
//   POST /api/<namespace>/<method>
//   content-type: application/json
//   { rpcId, method, payload: { args } }
//
// See `rpcFetchHandler` in @deepseek-ai/dsh-client-connection.
//
// Run: node scripts/probe-roster.mjs
import { readFileSync } from 'node:fs';
import { createHash, createHmac, randomUUID } from 'node:crypto';

const CRED = 'C:\\Users\\Administrator\\.dsh\\.credentials.yaml';
const BASE = 'http://127.0.0.1:19387';
const AUTHORITY = '127.0.0.1:19387';

// ── browser-session cookie (same construction as the working HTTP probes) ─────
const yamlText = readFileSync(CRED, 'utf8');
const anchor = yamlText.indexOf('client-connection/browser-session');
const secretB64 = yamlText.slice(anchor).match(/secret:\s*([A-Za-z0-9_\-]+)/)[1];
const secret = Buffer.from(
  secretB64.replaceAll('-', '+').replaceAll('_', '/')
    + '='.repeat((4 - (secretB64.length % 4)) % 4),
  'base64',
);
const b64u = (b) => Buffer.from(b).toString('base64').replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
const cookieName = 'dsh-auth-' + b64u(createHash('sha256').update(AUTHORITY).digest());
const now = Date.now();
const body = b64u(JSON.stringify({ version: 1, authority: AUTHORITY, issuedAt: now, expiresAt: now + 86_400_000 }));
const cookie = `${cookieName}=v1.${body}.${b64u(createHmac('sha256', secret).update(body).digest())}`;

async function rpc(endpoint, args = {}) {
  const method = endpoint; // the endpoint IS `<namespace>/<method>`
  const res = await fetch(`${BASE}/api/${endpoint}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    // The envelope type discriminator is required by `clientRequestSchema`.
    body: JSON.stringify({ type: 'client-request', rpcId: randomUUID(), method, payload: { args } }),
  });
  const text = await res.text();
  let parsed;
  try { parsed = JSON.parse(text); } catch { return { status: res.status, raw: text }; }
  return { status: res.status, parsed };
}

// ── the roster ────────────────────────────────────────────────────────────────
const r = await rpc('agentPresets/list');
console.log(`=== agentPresets/list -> HTTP ${r.status} ===`);

const roster = r.parsed?.result?.value ?? r.parsed?.result;
const presets = roster?.presets;

if (!Array.isArray(presets)) {
  console.log(JSON.stringify(r.parsed ?? r.raw, null, 2).slice(0, 3000));
} else {
  console.log(`${presets.length} preset(s):`);
  for (const p of presets) {
    const flag = p.broken === undefined ? 'ok' : `BROKEN: ${p.broken}`;
    console.log(`  ${p.isDefault ? '*' : ' '} ${p.id.padEnd(12)} ${(p.name ?? '(no name)').padEnd(12)} ${flag}`);
  }

  const cluster = presets.find((p) => p.id === 'cluster');
  console.log('\n=== verdict ===');
  if (!cluster) {
    console.log('  cluster is NOT in the roster');
  } else if (cluster.broken !== undefined) {
    console.log(`  cluster is registered but BROKEN: ${cluster.broken}`);
  } else {
    console.log(`  cluster is registered and healthy — name="${cluster.name}"`);
    console.log('  it is selectable for new sessions.');
  }
}

// ── composition inventory: does the cluster preset's child list report active rows? ──
const inv = await rpc('pluginInventory/list');
const compositions = inv.parsed?.result?.value?.agentPresets ?? inv.parsed?.result?.agentPresets;
if (Array.isArray(compositions)) {
  const c = compositions.find((x) => x.id === 'cluster');
  console.log('\n=== cluster composition inventory ===');
  if (!c) {
    console.log('  not present in the inventory');
  } else {
    console.log(`  broken: ${c.broken ?? '(none)'}`);
    const phases = {};
    for (const row of c.rows ?? []) phases[row.fiberPhase] = (phases[row.fiberPhase] ?? 0) + 1;
    console.log(`  rows: ${(c.rows ?? []).length}  phases: ${JSON.stringify(phases)}`);
    const failed = (c.rows ?? []).filter((row) => row.fiberPhase === 'FAILED');
    if (failed.length > 0) console.log(`  FAILED rows: ${failed.map((x) => x.moduleName).join(', ')}`);
  }
}
