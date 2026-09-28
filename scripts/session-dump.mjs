// Dump one DSH session log as a compact event trace.
//
// Session logs are CONCATENATED zstd frames (one per flush). Neither
// `zstdDecompressSync` nor `createZstdDecompress` walks past the first frame, so
// reading one naively yields a single event and looks like a truncated session.
// This scans the frame magic and decodes every frame in order.
//
// Usage:
//   $env:ELECTRON_RUN_AS_NODE='1'
//   & "<Harness.exe>" scripts\session-dump.mjs <session-id-or-fragment> [sessions-root]
//
// `sessions-root` defaults to this workspace's bucket under DSH_HOME, and can
// also come from `$env:DSH_SESSIONS_ROOT`.
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { zstdDecompressSync } from 'node:zlib';
import { join } from 'node:path';

const DEFAULT_ROOT = 'C:\\Users\\Administrator\\.dsh\\sessions\\--D-WORK-qun--';
const ROOT = process.argv[3] ?? process.env.DSH_SESSIONS_ROOT ?? DEFAULT_ROOT;
const needle = process.argv[2];

if (needle === undefined) {
  console.log('usage: session-dump.mjs <session-id-or-fragment> [sessions-root]');
  process.exit(2);
}

function resolveLog(id) {
  const dirs = readdirSync(ROOT).filter((d) => d.includes(id.replace(/^session-/, '')));
  for (const d of dirs) {
    const p = join(ROOT, d, 'session.v4.jsonl.zstd');
    if (existsSync(p)) return p;
  }
  return undefined;
}

/** Decode every concatenated zstd frame of one session file, in order. */
function decodeFrames(p) {
  const buf = readFileSync(p);
  const magic = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
  const offsets = [];
  for (let i = 0; (i = buf.indexOf(magic, i)) !== -1; i += 4) offsets.push(i);
  const out = [];
  for (let n = 0; n < offsets.length; n += 1) {
    try {
      out.push(zstdDecompressSync(buf.subarray(offsets[n], offsets[n + 1])).toString('utf8'));
    } catch { /* partial trailing frame while the session is live */ }
  }
  return out.join('').split(/\r?\n/).filter(Boolean);
}

const file = resolveLog(needle);
if (file === undefined) {
  console.log(`no session log matching "${needle}" under ${ROOT}`);
  process.exit(2);
}

console.log(`file: ${file} (${statSync(file).size}B)`);
const lines = decodeFrames(file);
console.log(`events: ${lines.length}\n`);

for (const line of lines) {
  let e;
  try { e = JSON.parse(line); } catch { continue; }
  const t = e.type;
  if (t === 'session') console.log(`meta: ${JSON.stringify({ id: e.id, preset: e.agentPreset, depth: e.delegationDepth })}`);
  else if (t === 'request/context') console.log(`context: ${JSON.stringify(e.data)}`);
  else if (t === 'agent-preset/selected') console.log(`preset: ${JSON.stringify(e.data)}`);
  else if (t === 'tool/call') console.log(`CALL ${e.data.name} :: ${JSON.stringify(e.data.arguments).slice(0, 200)}`);
  else if (t === 'tool/result') {
    const m = e.data.message;
    const txt = (m.content ?? []).map((c) => c.text ?? `[${c.type}]`).join(' ').replace(/\s+/g, ' ');
    console.log(`RESULT isError=${m.isError} :: ${txt.slice(0, 300)}`);
  } else if (t === 'assistant/message') {
    const txt = (e.data.message.content ?? []).filter((c) => c.type === 'text').map((c) => c.text).join(' ').slice(0, 240);
    console.log(`ASSISTANT step=${e.data.step} interrupted=${e.data.interrupted ?? false} :: ${txt}`);
  } else if (t === 'turn/end') console.log(`TURN/END ${JSON.stringify(e.data.reason).slice(0, 400)}`);
  else if (t === 'turn/start' || t === 'step/start' || t === 'step/end') console.log(`${t} ${JSON.stringify(e.data)}`);
}
