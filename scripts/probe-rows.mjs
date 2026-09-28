// Confirm the cluster preset's two non-active rows are platform-disabled, not broken.
//
// The inventory reported 29 rows with phases {active: 27, null: 2}. `null` means
// the fiber never started, which is what a satisfied `disabled: !!js ...`
// condition looks like — but it is also what an unloaded row could look like, so
// name them explicitly.
//
// Run: node scripts/probe-rows.mjs
import { readFileSync } from 'node:fs';
import { createHash, createHmac, randomUUID } from 'node:crypto';

const CRED = 'C:\\Users\\Administrator\\.dsh\\.credentials.yaml';
const BASE = 'http://127.0.0.1:19387';
const AUTHORITY = '127.0.0.1:19387';

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

const rpc = async (endpoint, args = {}) => {
  const res = await fetch(`${BASE}/api/${endpoint}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ type: 'client-request', rpcId: randomUUID(), method: endpoint, payload: { args } }),
  });
  return JSON.parse(await res.text());
};

const inv = await rpc('pluginInventory/list');
const c = (inv.result?.value?.agentPresets ?? inv.result?.agentPresets ?? []).find((x) => x.id === 'cluster');

console.log(`preset cluster: broken=${c?.broken ?? '(none)'}, rows=${c?.rows?.length ?? 0}`);
console.log('');
console.log('rows:');
for (const row of c?.rows ?? []) {
  const phase = row.fiberPhase ?? 'null';
  const flag = phase === 'active' ? '  ' : '<<';
  console.log(`${flag} ${String(phase).padEnd(7)} ${row.moduleName.padEnd(46)} enabled=${JSON.stringify(row.enabled)}${row.condition === undefined ? '' : ` cond=${row.condition}`}`);
}

const nonActive = (c?.rows ?? []).filter((r) => r.fiberPhase !== 'active');
console.log('');
console.log(`non-active rows: ${nonActive.length}`);
for (const r of nonActive) {
  // A row disabled by a satisfied `!!js` condition is `enabled: false` with a
  // condition recorded; an inconsistent combination would be the real worry.
  console.log(`  ${r.moduleName}: enabled=${JSON.stringify(r.enabled)} condition=${JSON.stringify(r.condition ?? null)}`);
}
