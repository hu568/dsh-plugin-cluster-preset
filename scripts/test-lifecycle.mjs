// Drive the lifecycle reminder through its real `agent/pre-step` handler and
// assert the four 壮年 stages fire exactly once, at the documented ages.
//
// `probe-rows.mjs` proves the row MOUNTS. This proves it BEHAVES: the age
// arithmetic, the threshold crossing, the once-only ledger, the
// subject-preset gate, and the injected message shape are all exercised here
// against the plugin's real exported code — no copies, no mocks of its internals.
//
// The only thing faked is the host surface the plugin reads through `ctx.get()`,
// which is exactly the seam the plugin was written against.
//
// Run: node scripts/test-lifecycle.mjs
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const pluginPath = join(here, '..', 'lifecycle-reminder.js');

const mod = await import(pathToFileURL(pluginPath).href
  // Cache-bust so a re-run after editing picks up the new file.
  + `?t=${Date.now()}`);

const failures = [];
const notes = [];
const check = (ok, label, detail = '') => {
  if (!ok) failures.push(`${label}${detail ? ` — ${detail}` : ''}`);
  return ok;
};

// ── a minimal host surface, matching what the plugin was written against ──────
//
// `stateOf` is backed by folding the plugin's OWN registered projection over the
// messages the plugin injects. That is what the real session projection does, so
// the once-only ledger is tested rather than stubbed.

function makeHost({ preset = 'cluster', contextWindow = 100_000, pressureRef, services = {} } = {}) {
  const registrations = new Map();
  const injected = []; // every user/message the plugin produced
  const handlers = {};

  const foldState = (key) => {
    const def = registrations.get(key);
    if (def === undefined) return undefined;
    let state = def.init();
    for (const message of injected) {
      state = def.apply(state, { type: 'user/message', data: message });
    }
    return state;
  };

  const projections = {
    register: (def) => { registrations.set(def.key, def); },
    stateOf: (_session, key) => {
      if (key === 'contextPressure') {
        return { pressureTokens: pressureRef.value, contextWindow };
      }
      return foldState(key);
    },
  };

  const ctx = {
    get: (service) => {
      // `services` lets one test drop a host service (e.g. the token meter) to
      // prove the plugin degrades to silence rather than throwing.
      if (Object.hasOwn(services, service)) return services[service];
      if (service === 'sessionProjections') return projections;
      if (service === 'tokenMeter') {
        return { measure: () => ({ totalTokens: pressureRef.value }) };
      }
      if (service === 'agentPresets') {
        return { composedPreset: () => preset };
      }
      if (service === 'systemPrompt') {
        return {
          section: (def) => ({ dispose() {} }),
          variable: () => ({ dispose() {} }),
        };
      }
      return undefined;
    },
    effect: (fn) => { fn(); return () => {}; },
    on: (event, handler) => { handlers[event] = handler; },
    logger: { warn: () => {} },
  };
  return { ctx, handlers, injected, registrations };
}

// A pre-step waterfall: the plugin awaits `next()` then may append messages.
function makeStepRunner(host) {
  return async (agent) => {
    const handler = host.handlers['agent/pre-step'];
    if (handler === undefined) throw new Error('plugin registered no agent/pre-step handler');
    const decision = await handler({ agent, signal: { aborted: false } }, async () => ({
      kind: 'enter',
      messages: [],
    }));
    if (decision.kind !== 'enter') return [];
    const mine = decision.messages.filter((m) => m?.source?.kind === 'cluster-lifecycle-reminder');
    host.injected.push(...decision.messages);
    return mine;
  };
}

const fakeAgent = (depth = 0) => ({ session: { header: { delegationDepth: depth } }, ctx: {} });

// ── 1. age arithmetic matches the document's scale ───────────────────────────
// 智能体寿命论.md: 年龄 = 上下文占用百分比, so 1% of the window = 1 year.
{
  const { theoreticalAge, lifeProgress } = mod.renderScales(10_000, 100_000, 100_000);
  check(Math.abs(theoreticalAge - 10) < 1e-9, '1% of the window is 1 year', `got ${theoreticalAge}`);
  check(Math.abs(lifeProgress - 10) < 1e-9, 'equal windows give equal progress', `got ${lifeProgress}`);
  notes.push(`scale: 10k/100k -> ${theoreticalAge} years`);
}
{
  // The document's asymmetric case: a 1M nominal window over a 300k effective one.
  const { theoreticalAge, lifeProgress } = mod.renderScales(300_000, 1_000_000, 300_000);
  check(Math.abs(theoreticalAge - 30) < 1e-9, 'nominal 1M window: 300k is 30 years', `got ${theoreticalAge}`);
  check(Math.abs(lifeProgress - 100) < 1e-9, 'effective 300k window: 300k is life-complete', `got ${lifeProgress}`);
  const { text } = mod.renderScales(300_000, 1_000_000, 300_000);
  check(/不是老死的|最能干的时候/.test(text), 'the asymmetric case reports the document conclusion');
  notes.push('asymmetry: 300k/1M nominal over 300k effective -> 30 years, 100% life');
}

// ── 2. config validation fails loud ─────────────────────────────────────────
{
  const bad = [
    [{ stages: [] }, 'empty stages'],
    [{ stages: [{ age: 0, label: 'x', lines: ['y'] }] }, 'age below 1'],
    [{ stages: [{ age: 20, label: '', lines: ['y'] }] }, 'empty label'],
    [{ stages: [{ age: 20, label: 'x', lines: [] }] }, 'empty lines'],
    [{ stages: [{ age: 20, label: 'x', lines: ['y'] }, { age: 20, label: 'z', lines: ['w'] }] }, 'duplicate age'],
    [{ theoreticalWindow: -1 }, 'negative window'],
    [{ subjectPreset: '' }, 'empty subjectPreset'],
  ];
  for (const [config, what] of bad) {
    let threw = false;
    try { mod.resolveConfig(config); } catch { threw = true; }
    check(threw, `resolveConfig rejects ${what}`);
  }
  // A valid config must round-trip with stages sorted ascending.
  const cfg = mod.resolveConfig({ stages: [{ age: 60, label: 'c', lines: ['x'] }, { age: 20, label: 'a', lines: ['y'] }] });
  check(cfg.stages.map((s) => s.age).join(',') === '20,60', 'stages normalize to ascending order');
}

// ── 3. each stage fires exactly once, on crossing ────────────────────────────
{
  const pressureRef = { value: 0 };
  const host = makeHost({ contextWindow: 100_000, pressureRef });
  mod.apply(host.ctx, {});
  const run = makeStepRunner(host);
  check(host.registrations.has('clusterLifecycle'), 'plugin registers its ledger projection');

  const agent = fakeAgent();
  const fired = [];
  // Sweep pressure from 0 to 70% of the window in 5k steps (0 → 70 years).
  for (let tokens = 0; tokens <= 70_000; tokens += 5_000) {
    pressureRef.value = tokens;
    for (const m of await run(agent)) {
      const age = Number(m.source.summary.match(/理论年龄\s*([0-9.]+)/)[1]);
      fired.push({ tokens, age: Math.round(age), summary: m.source.summary });
    }
  }

  const ages = fired.map((f) => f.age);
  check(JSON.stringify(ages) === JSON.stringify([20, 30, 40, 60]),
    'the four 壮年 stages fire once each, in order', JSON.stringify(ages));

  // Pin the crossing points to the documented thresholds.
  const expected = [[20, 20_000], [30, 30_000], [40, 40_000], [60, 60_000]];
  for (const [age, tokens] of expected) {
    const hit = fired.find((f) => f.age === age);
    check(hit !== undefined && hit.tokens === tokens,
      `stage ${age} fires at exactly ${tokens} tokens`, hit === undefined ? 'never fired' : `at ${hit.tokens}`);
  }
  notes.push(`fired at: ${fired.map((f) => `${f.age}y@${f.tokens}`).join(', ')}`);

  // Idempotence: re-running across the same range must add nothing.
  const before = fired.length;
  for (let tokens = 0; tokens <= 70_000; tokens += 5_000) {
    pressureRef.value = tokens;
    await run(agent);
  }
  check(fired.length === before, 'no stage repeats after the ledger records it');
}

// ── 4. a jump marks every stage it skipped, so nothing queues up behind ──────
{
  const pressureRef = { value: 0 };
  const host = makeHost({ contextWindow: 100_000, pressureRef });
  mod.apply(host.ctx, {});
  const run = makeStepRunner(host);
  const agent = fakeAgent();

  // Jump straight past 20/30 to 45 years.
  pressureRef.value = 45_000;
  const first = await run(agent);
  check(first.length === 1, 'a jump injects exactly one reminder', `${first.length}`);
  const ledger = host.ctx.get('sessionProjections').stateOf(agent.session, 'clusterLifecycle');
  check(JSON.stringify(ledger.announced) === JSON.stringify([20, 30, 40]),
    'the jump marks every crossed stage as announced', JSON.stringify(ledger.announced));

  // Continuing forward must not replay 20/30/40.
  pressureRef.value = 65_000;
  const next = await run(agent);
  check(next.length === 1 && next[0].source.summary.includes('60'),
    'only the new 60-year stage follows the jump',
    next.map((m) => m.source.summary).join(' | '));
}

// ── 5. the gates ────────────────────────────────────────────────────────────
{
  // Wrong preset: silent.
  const pressureRef = { value: 50_000 };
  const host = makeHost({ preset: 'standard', contextWindow: 100_000, pressureRef });
  mod.apply(host.ctx, {});
  const run = makeStepRunner(host);
  check((await run(fakeAgent())).length === 0, 'a session outside subjectPreset is not reminded');

  // subjectPreset: null = every session.
  const host2 = makeHost({ preset: 'standard', contextWindow: 100_000, pressureRef });
  mod.apply(host2.ctx, { subjectPreset: null });
  const run2 = makeStepRunner(host2);
  check((await run2(fakeAgent())).length === 1, 'subjectPreset: null reminds any session');

  // Subagents excluded on request.
  const host3 = makeHost({ contextWindow: 100_000, pressureRef });
  mod.apply(host3.ctx, { includeSubagents: false });
  const run3 = makeStepRunner(host3);
  check((await run3(fakeAgent(0))).length === 1, 'a top-level session is reminded');
  check((await run3(fakeAgent(1))).length === 0, 'a subagent is skipped when includeSubagents is false');

  // A missing meter must not break the step: `makeHost` drops the service only.
  const host4 = makeHost({ contextWindow: 100_000, pressureRef, services: { tokenMeter: undefined, sessionProjections: undefined } });
  mod.apply(host4.ctx, {});
  const run4 = makeStepRunner(host4);
  check((await run4(fakeAgent())).length === 0, 'absent meter/projections degrade to silence, not failure');
}

// ── 6. the injected message satisfies the session's shape rules ──────────────
// `assertMessageEventShape`: non-empty string id, role "user", object source with
// a non-empty `kind`, and an array `content`.
{
  const pressureRef = { value: 25_000 };
  const host = makeHost({ contextWindow: 100_000, pressureRef });
  mod.apply(host.ctx, {});
  const run = makeStepRunner(host);
  const [m] = await run(fakeAgent());

  check(m !== undefined, 'a message was injected');
  if (m !== undefined) {
    check(typeof m.id === 'string' && m.id.length > 0, 'message has a non-empty id');
    check(m.role === 'user', 'message role is "user"');
    check(Array.isArray(m.content) && m.content.length > 0, 'content is a non-empty array');
    check(m.content.every((b) => b.type === 'text' && typeof b.text === 'string' && b.text.length > 0),
      'content is non-empty text blocks');
    check(typeof m.source?.kind === 'string' && m.source.kind === 'cluster-lifecycle-reminder',
      'source.kind matches the plugin name');
    check(m.source.form === 'notice', 'source.form is "notice"');
    check(typeof m.source.summary === 'string' && m.source.summary.length > 0, 'notice carries a summary');
    check(m.source.summary.length <= 120, 'summary respects the notice bound', `${m.source.summary.length} chars`);
    notes.push(`notice summary: ${m.source.summary}`);
  }
}

// ── 7. every default stage is present in the shipped config ──────────────────
{
  const cfg = mod.resolveConfig({});
  check(cfg.stages.map((s) => s.age).join(',') === '20,30,40,60',
    'the four documented ages ship as defaults', cfg.stages.map((s) => s.age).join(','));
  // The document moved from the workspace root into `docs/`; accept either so a
  // reorganisation does not turn a content assertion into a path failure.
  const docCandidates = [join(here, '..', 'docs', '智能体寿命论.md'), join(here, '..', '智能体寿命论.md')];
  const docPath = docCandidates.find((candidate) => existsSync(candidate));
  check(docPath !== undefined, '智能体寿命论.md is present',
    `looked in: ${docCandidates.join(', ')}`);
  const doc = docPath === undefined ? '' : readFileSync(docPath, 'utf8');
  for (const age of [20, 30, 40, 60]) {
    check(doc.includes(`**${age} 岁**`), `智能体寿命论.md still documents the ${age}-year stage`);
  }
}

// ── report ──────────────────────────────────────────────────────────────────
console.log('=== notes ===');
for (const n of notes) console.log('  ' + n);
console.log('=== failures ===');
if (failures.length === 0) {
  console.log('  (none)');
  console.log('\nLIFECYCLE OK');
  process.exit(0);
}
for (const f of failures) console.log('  ✗ ' + f);
console.log('\nLIFECYCLE FAILED');
process.exit(1);
