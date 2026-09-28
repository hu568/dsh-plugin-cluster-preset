// REPRODUCE + GUARD the "cluster" preset defect, against the REAL runtime and
// the REAL shipped `cluster.patch.yml`.
//
// Symptom (from the owner's exported session 4686f914): every specialist tool
// (`explore` / `librarian` / `oracle` / `metis` / `momus`) failed at the FIRST
// delegation with
//
//   tools.restrict() names unknown global tool "subagent";
//   known global tools: …, explore, …, subagent_fork, …
//
// Note the asymmetry: `subagent_fork` IS in that known list, `subagent` is NOT,
// and `subagent` is the ONLY name called out. That is the whole diagnosis, and
// it was not a typo.
//
// ── the mechanism, in two facts ──────────────────────────────────────────────
//
// 1. `restrict()` validates every name against `view(scope).restrictableNames`,
//    which `dsh-tools` builds as "the GLOBAL layer + every ANCESTOR layer on the
//    chain — never what the calling scope's OWN layer registers"
//    (dsh-tools/lib/index.js:2937-2958 comment, loop at 2962-2974).
//
// 2. A `dsh-tool-subagent` row with `modelSelectionSettings: true` does NOT
//    register at mount. It waits for an Agent and registers through
//    `candidate.ctx.inject(...)` — into THAT AGENT'S OWN layer
//    (dsh-tool-subagent/lib/index.js:610-659, esp. 626-632). Every delegated
//    child gets its own copy, and own-layer registrations are exempt from
//    restrictions, so no filter can ever take the tool away from a specialist.
//
// The shipped preset therefore leaves that flag OFF: registration stays at mount
// time (an ancestor layer), where `deny` works. This test asserts that choice
// and, separately, SYNTHESISES the per-agent shape to prove the original failure
// is still what the runtime does — so the constraint cannot be forgotten.
//
// Run with the Electron binary (asar):
//   set ELECTRON_RUN_AS_NODE=1
//   & "<Harness>\DeepSeek Harness.exe" scripts\test-restrict-scope.mjs
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ASAR = 'C:/Users/Administrator/AppData/Local/Programs/DeepSeek Harness/resources/app.asar/dsh';
const require = createRequire(ASAR + '/node_modules/@deepseek-ai/dsh/package.json');

const { Context } = require('@deepseek-ai/cordis');
const { ToolRuntime, defineTool } = require('@deepseek-ai/dsh-tools');
const { createScope, scopeOf } = require('@deepseek-ai/dsh-scope');
const { SystemPrompt } = require('@deepseek-ai/dsh-system-prompt');
const yaml = require('js-yaml');

const here = dirname(fileURLToPath(import.meta.url));
const patchFile = join(here, '..', 'cluster.patch.yml');

const failures = [];
const check = (ok, label, detail = '') => {
  if (!ok) failures.push(`${label}${detail ? ` — ${detail}` : ''}`);
  return ok;
};

// ── read the SHIPPED preset ──────────────────────────────────────────────────
// `!!js` is mapped to its source text: it is never evaluated here.
const JS_TAG = new yaml.Type('tag:yaml.org,2002:js', {
  kind: 'scalar',
  construct: (data) => ({ __js: data }),
});
const doc = yaml.load(readFileSync(patchFile, 'utf8'), { schema: yaml.DEFAULT_SCHEMA.extend([JS_TAG]) });
const preset = (doc.find((r) => r?.insert)?.insert ?? []).find((r) => r?.name === '@deepseek-ai/dsh-agent-preset');
const plugins = preset?.config?.plugins ?? [];
const subagentRows = plugins.filter((p) => p?.name === '@deepseek-ai/dsh-tool-subagent');

check(subagentRows.length === 7, 'the shipped preset declares seven delegation rows', `${subagentRows.length}`);

// A row with the flag registers PER AGENT (own layer) and becomes unfilterable.
const perAgentTools = new Set(
  subagentRows.filter((p) => p?.config?.modelSelectionSettings === true).map((p) => p.config.toolName),
);
console.log('=== what the shipped preset pins ===');
console.log(`  delegation rows        : ${subagentRows.map((r) => r.config?.toolName).join(', ')}`);
console.log(`  per-agent (own layer)  : ${[...perAgentTools].sort().join(', ') || '(none)'}`);

check(perAgentTools.size === 0,
  'no delegation row sets modelSelectionSettings (all mount-time, hence restrictable)',
  [...perAgentTools].join(', '));

// Filter-carrying rows are the specialists.
const filteredRows = subagentRows.filter((p) => p?.config?.toolFilter !== undefined);
console.log(`  rows carrying a filter : ${filteredRows.map((r) => r.id).join(', ')}`);
check(filteredRows.length === 5, 'five specialists carry a toolFilter', `${filteredRows.length}`);

// Every name any filter references.
const referenced = new Set();
for (const row of filteredRows) {
  for (const kind of ['allow', 'deny']) for (const n of row.config.toolFilter[kind] ?? []) referenced.add(n);
}
const delegationNames = subagentRows.map((r) => r.config?.toolName);
console.log(`  names referenced by filters: ${[...referenced].sort().join(', ')}`);

// ── build the real runtime next to it ────────────────────────────────────────
const stub = (name) => defineTool({
  name,
  description: `${name} (test stub)`,
  parameters: {},
  output: { schema: { type: 'object', additionalProperties: true }, render: () => [] },
  execute: async () => ({}),
});

// A `Service` subclass registers itself in its constructor.
const root = new Context();
new SystemPrompt(root, {});
const runtime = new ToolRuntime(root, {});

const presetScope = createScope(root, {});
const presetKey = scopeOf(presetScope.ctx);
check(presetKey !== undefined, 'the preset scope carries a scope tag');

// ── PHASE A: the shipped shape — everything registers at MOUNT time ──────────
// This is what the preset relies on: an ancestor-layer (inherited) surface.
const disposers = [];
for (const name of referenced) disposers.push(presetScope.ctx.tools.register(stub(name)));

const agentScope = createScope(presetScope.ctx, {}, { parent: presetKey });
const agentKey = scopeOf(agentScope.ctx);
check(agentKey !== undefined && agentKey !== presetKey, 'the agent owns a nested scope');

const seenByAgent = runtime.view(agentKey).restrictableNames;
console.log('\n=== PHASE A: restrictable from the agent scope (shipped shape) ===');
console.log(`  ${[...seenByAgent].sort().join(', ') || '(none)'}`);

for (const name of referenced) {
  check(seenByAgent.has(name), `${name} is restrictable when registered at mount time`);
}

let accepted = 0;
for (const row of filteredRows) {
  let thrown;
  try {
    agentScope.ctx.tools.restrict(row.config.toolFilter);
  } catch (error) {
    thrown = error;
  }
  const deny = row.config.toolFilter.deny ?? [];
  console.log(`\n=== ${row.id}: deny = ${JSON.stringify(deny)} ===`);
  console.log(`  -> ${thrown === undefined ? 'ACCEPTED' : 'THREW: ' + thrown.message}`);
  check(thrown === undefined, `${row.id}: the shipped deny list is ACCEPTED`, thrown?.message ?? '');
  if (thrown === undefined) accepted += 1;
}
check(accepted === filteredRows.length, 'every shipped deny list is accepted',
  `${accepted}/${filteredRows.length}`);

// ── the filter must actually HIDE the delegation tools from a child ──────────
{
  const child = createScope(agentScope.ctx, {}, { parent: agentKey });
  const childVisible = runtime.view(scopeOf(child.ctx)).visible;
  const hidden = delegationNames.filter((n) => seenByAgent.has(n) && !childVisible.has(n));
  const stillVisible = delegationNames.filter((n) => childVisible.has(n));
  console.log('\n=== the child created under those restrictions ===');
  console.log(`  delegation tools hidden: ${hidden.join(', ') || '(none)'}`);
  console.log(`  still visible          : ${stillVisible.join(', ') || '(none)'}`);
  for (const n of delegationNames) {
    check(hidden.includes(n), `${n} is hidden from the delegated child`);
  }
  check(!childVisible.has('write') && !childVisible.has('edit'),
    'write/edit are hidden from the delegated child');
  await child.dispose();
}

// ── PHASE B: SYNTHESISE the per-agent shape — the original failure ───────────
// In the real defect the row's tool was registered ONLY per Agent: because
// `modelSelectionSettings: true` takes the `installScoped` path, its mount-time
// `install(ctx, undefined)` never runs, so the PRESET layer has no `subagent` at
// all. Reproduce that faithfully on a separate preset scope: every other
// referenced name registers at mount, `subagent` only in the agent's own layer.
{
  const trapPreset = createScope(root, {});
  const trapPresetKey = scopeOf(trapPreset.ctx);
  for (const name of referenced) {
    if (name === 'subagent') continue; // mount-time registration is what the flag removes
    disposers.push(trapPreset.ctx.tools.register(stub(name)));
  }

  const trapScope = createScope(trapPreset.ctx, {}, { parent: trapPresetKey });
  const trapKey = scopeOf(trapScope.ctx);
  // own-layer registration for `subagent`, as `candidate.ctx.inject(...)` does.
  disposers.push(trapScope.ctx.tools.register(stub('subagent')));

  const seenByTrap = runtime.view(trapKey).restrictableNames;
  console.log('\n=== PHASE B: synthesised per-agent shape (`subagent` own-layer only) ===');
  console.log(`  restrictable: ${[...seenByTrap].sort().join(', ') || '(none)'}`);
  check(!seenByTrap.has('subagent'),
    'an own-layer-only registration is NOT restrictable (the root cause)');
  check(seenByTrap.has('subagent_fork'),
    'a mount-time registration IS restrictable (the asymmetry in the error message)');

  // The shipped deny list, run in that shape.
  const shippedDeny = filteredRows[0].config.toolFilter.deny ?? [];
  let thrown;
  try {
    trapScope.ctx.tools.restrict({ deny: shippedDeny });
  } catch (error) {
    thrown = error;
  }
  console.log(`\n  shipped deny list vs per-agent shape: ${thrown === undefined ? 'ACCEPTED (unexpected!)' : 'THREW: ' + thrown.message}`);
  check(thrown !== undefined, 'the shipped deny list WOULD be rejected in the per-agent shape');
  if (thrown !== undefined) {
    const firstClause = thrown.message.split(';')[0];
    check(/names unknown global tool "subagent"/.test(firstClause),
      'the rejection reproduces the reported message exactly', firstClause);
    check(/known global tools:.*subagent_fork/.test(thrown.message),
      'the rejection lists subagent_fork as known (the diagnostic asymmetry)', '');
  }
  await trapScope.dispose();
  await trapPreset.dispose();
}

// ── teardown ────────────────────────────────────────────────────────────────
for (const d of disposers) d();
await agentScope.dispose();
await presetScope.dispose();

console.log('\n=== verdict ===');
if (failures.length === 0) {
  console.log('  shipped filters accepted, children truly lose the tools, and the');
  console.log('  per-agent shape still reproduces the original failure');
  console.log('\nRESTRICT-SCOPE OK');
  process.exit(0);
}
for (const f of failures) console.log('  ✗ ' + f);
console.log('\nRESTRICT-SCOPE FAILED');
process.exit(1);
