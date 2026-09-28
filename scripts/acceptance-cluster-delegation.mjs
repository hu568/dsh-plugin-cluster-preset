// ACCEPTANCE TEST for the "cluster" preset fix — drives the LIVE Host.
//
// ⚠️ This one COSTS REAL MODEL TURNS: it creates a real session and sends one
// prompt, so expect one small orchestrator turn plus one small child turn. It is
// deliberately NOT part of the routine suite (`validate` / `preflight` /
// `test-restrict-scope` / `test-validate-negative` / `test-lifecycle`).
//
// What it proves: an orchestrator session on the `cluster` preset delegates to
// `explore` and the delegation SUCCEEDS. Before the fix the first delegation
// failed with
//   tools.restrict() names unknown global tool "subagent";
// so "orchestrator called explore == true && restrict() errors == 0" is the
// end-to-end signal that the defect is gone.
//
// Usage (a Host must be running):
//   $env:ELECTRON_RUN_AS_NODE='1'
//   & "<Harness.exe>" scripts\acceptance-cluster-delegation.mjs [preset]
//
// `preset` defaults to `cluster`; pass `standard` as a CONTROL — it isolates
// request-preparation failures from anything preset-specific (and is cheap).
//
// Overridable via environment:
//   DSH_SESSIONS_ROOT  session bucket (default: this workspace's)
//   DSH_PROBE_CWD      workspace the session is created in
//   DSH_PROBE_PROVIDER / DSH_PROBE_MODEL
//     The profile's default model is `workbuddy-cn/deepseek-v4.1-flash`, which
//     has NO credentials on this machine, so the turn would die before any tool
//     ran. These default to a route that does have credentials.
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { zstdDecompressSync } from 'node:zlib';
import { createHash, createHmac, randomUUID } from 'node:crypto';
import { join } from 'node:path';

const CRED = 'C:\\Users\\Administrator\\.dsh\\.credentials.yaml';
const BASE = 'http://127.0.0.1:19387';
const AUTHORITY = '127.0.0.1:19387';
const SESSIONS = process.env.DSH_SESSIONS_ROOT ?? 'C:\\Users\\Administrator\\.dsh\\sessions\\--D-WORK-qun--';
const CWD = process.env.DSH_PROBE_CWD ?? 'D:\\WORK\\qun';
const PRESET = process.argv[2] ?? 'cluster';
const MODEL = {
  provider: process.env.DSH_PROBE_PROVIDER ?? 'deepseek-account',
  model: process.env.DSH_PROBE_MODEL ?? 'deepseek-flash',
};

const PROMPT = PRESET === 'cluster'
  ? [
    '请只做一件事：调用 explore 工具一次。',
    `explore 的 prompt 参数写：读取 ${CWD}\\README.md 的前 5 行，原样返回。`,
    '等它返回后，用一句话汇报 explore 返回的内容。不要使用其他工具。',
  ].join('\n')
  : 'Reply with exactly this word: ok. Do not use any tools.';

// ── browser-session cookie (same construction as the other HTTP probes) ──────
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
  const res = await fetch(`${BASE}/api/${endpoint}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ type: 'client-request', rpcId: randomUUID(), method: endpoint, payload: { args } }),
  });
  const text = await res.text();
  let parsed;
  try { parsed = JSON.parse(text); } catch { return { status: res.status, raw: text }; }
  return { status: res.status, parsed };
}

const unwrap = (r) => r.parsed?.result?.value ?? r.parsed?.result ?? r.parsed;

// ── 1. create a session on the requested preset ─────────────────────────────
// Each Remote method declares ONE parameter named `request`, so the gateway
// expects `args: { request: {...} }`; a bare field map is rejected with
// `gateway/arguments-invalid`.
const created = await rpc('session/create', { request: { cwd: CWD, agentPreset: PRESET } });
console.log(`=== session/create -> HTTP ${created.status} ===`);
console.log(JSON.stringify(unwrap(created), null, 2).slice(0, 800));
const sessionId = unwrap(created)?.sessionId;
if (typeof sessionId !== 'string') {
  console.log('\nsession/create did not return a sessionId; cannot continue');
  process.exit(2);
}

// ── 2. pin a model that actually has credentials ────────────────────────────
const selected = await rpc('session/selectModel', { request: { sessionId, ...MODEL } });
console.log(`\n=== session/selectModel ${MODEL.provider}/${MODEL.model} -> HTTP ${selected.status} ===`);
console.log(JSON.stringify(unwrap(selected)).slice(0, 300));

// ── 3. send the prompt ──────────────────────────────────────────────────────
const sent = await rpc('session/prompt', {
  request: {
    requestId: randomUUID(),
    sessionId,
    mode: 'queue',
    content: [{ type: 'text', text: PROMPT }],
    clientTimeZone: 'Asia/Shanghai',
  },
});
console.log(`\n=== session/prompt -> HTTP ${sent.status} ===`);
console.log(JSON.stringify(unwrap(sent)).slice(0, 300));

// ── 4. watch the session log until the turn ends ────────────────────────────
/** Decode every concatenated zstd frame of one session file. */
function decodeFrames(file) {
  const buf = readFileSync(file);
  const magic = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
  const offsets = [];
  for (let i = 0; (i = buf.indexOf(magic, i)) !== -1; i += 4) offsets.push(i);
  const out = [];
  for (let n = 0; n < offsets.length; n += 1) {
    try {
      out.push(zstdDecompressSync(buf.subarray(offsets[n], offsets[n + 1])).toString('utf8'));
    } catch { /* partial trailing frame while live */ }
  }
  return out.join('').split(/\r?\n/).filter(Boolean);
}

function findLog(id) {
  const direct = join(SESSIONS, id, 'session.v4.jsonl.zstd');
  if (existsSync(direct)) return direct;
  const hit = readdirSync(SESSIONS).find((d) => d.includes(id.replace(/^session-/, '')));
  if (hit === undefined) return undefined;
  const p = join(SESSIONS, hit, 'session.v4.jsonl.zstd');
  return existsSync(p) ? p : undefined;
}

const deadline = Date.now() + 240_000;
let logFile;
let finished = false;
let lastCount = 0;
const seen = { calls: [], errors: [] };

while (Date.now() < deadline && !finished) {
  logFile ??= findLog(sessionId);
  if (logFile !== undefined && statSync(logFile).size > 0) {
    const lines = decodeFrames(logFile);
    if (lines.length !== lastCount) {
      lastCount = lines.length;
      for (const line of lines) {
        let e;
        try { e = JSON.parse(line); } catch { continue; }
        if (e.type === 'tool/call') {
          const name = e.data.name;
          if (!seen.calls.includes(name)) {
            seen.calls.push(name);
            console.log(`  [call] ${name}`);
          }
        }
        if (e.type === 'tool/result' && e.data.message?.isError) {
          const t = (e.data.message.content ?? []).map((c) => c.text ?? '').join(' ').replace(/\s+/g, ' ');
          if (!seen.errors.includes(t)) {
            seen.errors.push(t);
            console.log(`  [ERROR] ${t.slice(0, 220)}`);
          }
        }
        if (e.type === 'turn/end') finished = true;
      }
    }
  }
  if (!finished) await new Promise((r) => setTimeout(r, 3000));
}

console.log(`\n=== session log: ${logFile ?? '(not found)'} ===`);
console.log(`  tool calls made : ${seen.calls.join(', ') || '(none)'}`);
console.log(`  tool errors     : ${seen.errors.length}`);

// ── 5. verdict ──────────────────────────────────────────────────────────────
const bad = seen.errors.filter((t) => /tools\.restrict|unknown global tool/.test(t));
const delegated = seen.calls.includes('explore');

console.log('\n=== verdict ===');
console.log(`  orchestrator called explore : ${delegated}`);
console.log(`  restrict() errors           : ${bad.length}`);
console.log(`  (inspect the above session with: scripts\\session-dump.mjs ${sessionId})`);
if (bad.length > 0) {
  console.log(`  ✗ STILL BROKEN: ${bad[0].slice(0, 200)}`);
  process.exit(1);
}
if (!delegated) {
  console.log('  ? the orchestrator did not delegate this turn — no conclusion (rerun, or steer it)');
  process.exit(2);
}
// A successful delegation leaves a child session at depth 1 behind.
const child = readdirSync(SESSIONS)
  .map((d) => join(SESSIONS, d, 'session.v4.jsonl.zstd'))
  .filter(existsSync)
  .map((p) => ({ p, m: statSync(p).mtimeMs }))
  .sort((a, b) => b.m - a.m)
  .slice(0, 4)
  .filter(({ p }) => {
    try {
      return decodeFrames(p).some((l) => l.includes('"delegationDepth":1'));
    } catch { return false; }
  });
console.log(`  child session(s) created    : ${child.length > 0 ? 'yes' : 'not detected'}`);
console.log(bad.length === 0 && delegated
  ? '\nDELEGATION OK — the specialist ran without a restrict() failure'
  : '\nDELEGATION concluded with issues');
process.exit(0);
