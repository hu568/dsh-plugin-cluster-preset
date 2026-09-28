// Build cluster.patch.yml from the prompt documents.
//
// The preset is one `@deepseek-ai/dsh-agent-preset` declaration. Its child rows
// are the orchestrator's own tools/persona plus one `dsh-tool-subagent`
// instance per specialist, each carrying its persona inline.
//
// Usage: ELECTRON_RUN_AS_NODE is NOT needed here (no asar access).
//   node scripts/build-preset.mjs
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const promptsDir = join(here, '..', 'prompts');
const outFile = join(here, '..', 'cluster.patch.yml');

const read = (name) => readFileSync(join(promptsDir, name), 'utf8').trimEnd();

// Indent every non-empty line by `n` spaces; blank lines stay blank.
const indent = (text, n) => {
  const pad = ' '.repeat(n);
  return text
    .split('\n')
    .map((line) => (line.length === 0 ? '' : pad + line))
    .join('\n');
};

// ── one plugin row, built at indent 0 then placed under config.plugins ────────
//
// Row skeleton (before the final shift):
//   - id: <id>            (0)
//     name: '<name>'      (2)
//     config:             (2)
//       <configLines>     (4)
// `extra` lines are emitted at row level (0), e.g. `disabled:`.
function row({ id, name, config, extra = [] }) {
  const lines = [`- id: ${id}`, `  name: '${name}'`];
  lines.push(...extra.map((l) => '  ' + l));
  if (config) {
    lines.push('  config:');
    lines.push(indent(config.trimEnd(), 4));
  }
  return lines.join('\n');
}

// ── the orchestrator's own identity + tools ──────────────────────────────────
// Same tool surface as the shipped `standard` preset, so anything that works
// there works here; the roster below is what makes this preset a cluster.

const ORCHESTRATOR_PERSONA = row({
  id: 'persona',
  name: '@deepseek-ai/dsh-persona',
  config: `prefix: |-
${indent(read('orchestrator.md'), 2)}
suffix: Your working directory is {{cwd}}.`,
});

const BASE_TOOLS = [
  row({
    id: 'agent-instructions',
    name: '@deepseek-ai/dsh-agent-instructions',
    config: 'maxBytes: 65536',
  }),
  row({
    id: 'tool-bash',
    name: '@deepseek-ai/dsh-tool-bash',
    extra: [`disabled: !!js process.platform === 'win32'`],
  }),
  row({
    id: 'tool-pwsh',
    name: '@deepseek-ai/dsh-tool-pwsh',
    extra: [`disabled: !!js process.platform !== 'win32'`],
  }),
  row({ id: 'tool-fs', name: '@deepseek-ai/dsh-tool-fs' }),
  row({
    id: 'tool-fs-search',
    name: '@deepseek-ai/dsh-tool-fs-search',
    config: 'sampleOverCapGlobResults: false',
  }),
  row({ id: 'tool-jobs', name: '@deepseek-ai/dsh-tool-jobs' }),
  row({ id: 'skill-filesystem', name: '@deepseek-ai/dsh-skill-filesystem' }),
  row({ id: 'tool-skill', name: '@deepseek-ai/dsh-tool-skill' }),
  row({ id: 'command-goal', name: '@deepseek-ai/dsh-command-goal' }),
  row({ id: 'tool-goal', name: '@deepseek-ai/dsh-tool-goal' }),
];

// ── plan mode ─────────────────────────────────────────────────────────────────
// `plan-mode` requires a NON-EMPTY `section`; omitting it fails the whole preset
// activation (the roster then reports the declaration as broken). The text below
// is the shipped one from `dsh-web-app/presets/standard.patch.yml`.
const PLAN_MODE_SECTION = `You are in plan mode. Stay in plan mode until exit_plan_mode succeeds or the user switches the session mode. Imperative language to implement changes means plan the implementation, not execute it. A user's conversational agreement — including an answer confirming something you asked — approves nothing and does not end plan mode; fold the confirmed decision into the plan and submit it through exit_plan_mode.

Explore first. Use non-mutating reads, searches, static analysis, and checks to ground the plan in the actual repository. Do not edit or write files, change configuration, run formatters or code generation that rewrites tracked files, commit, or otherwise carry out the plan. Prefer existing functions and patterns over new machinery.

The tool catalog stays the same across modes for request-cache stability. These plan-mode rules override any later tool description or guidance that suggests using mutation tools; those tools remain listed to keep the tool catalog unchanged. Do not use todo_write to track this planning phase: it tracks implementation after an approved plan, while the plan itself belongs in exit_plan_mode.

Resolve discoverable facts by inspection. Use ask_user_question only for user-owned choices or material ambiguity that inspection cannot answer. Do not ask the user where code lives or how current behavior works when you can find out.

Make the plan decision-complete: state the goal and success criteria; group implementation changes by subsystem; identify public API, schema, and data-flow changes; cover edge cases, failure modes, tests, acceptance criteria, and explicit assumptions. Keep it concise enough to review but detailed enough that another engineer can implement it without making design decisions.

When ready, call exit_plan_mode with the complete plan markdown, starting with a # title. Make exit_plan_mode the only and final tool call in that assistant response: it presents the plan for approval, and implementation begins only in a later step after approval. Do not paste the final plan as a plain reply or ask "should I proceed?" through prose or ask_user_question. If review rejects it, incorporate the feedback and present again. If the review channel is unavailable or aborted, stay in plan mode and ask the user to switch modes manually; do not proceed with implementation.`;

const GROUPED_TOOLS = [
  row({
    id: 'planning',
    name: 'cordis:group',
    extra: ['group: true', 'isolate:', '  planMode: true'],
    config: row({
      id: 'plan-mode',
      name: '@deepseek-ai/dsh-plan-mode',
      config: 'section: |\n' + indent(PLAN_MODE_SECTION, 2),
    }),
  }),
  row({
    id: 'compaction',
    name: 'cordis:group',
    extra: ['group: true', 'isolate:', '  compaction: true', '  toolResultPruner: true'],
    config: [
      row({ id: 'compaction-basic', name: '@deepseek-ai/dsh-compaction-basic' }),
      row({ id: 'command-compact', name: '@deepseek-ai/dsh-command-compact' }),
      row({
        id: 'tool-result-pruner',
        name: '@deepseek-ai/dsh-compaction-tool-result-pruner',
        config: 'thresholdChars: 8192\nheadChars: 4096\ntailChars: 1024',
      }),
    ].join('\n'),
  }),
  row({
    id: 'delegation',
    name: 'cordis:group',
    extra: ['group: true', 'isolate:', '  workflowEngine: true'],
    config: [
      row({ id: 'tool-subagent-control', name: '@deepseek-ai/dsh-tool-subagent-control' }),
      row({
        id: 'tool-subagent-list-agents',
        name: '@deepseek-ai/dsh-tool-subagent-control/list-agents',
      }),
    ].join('\n'),
  }),
];

// ── the specialist roster ─────────────────────────────────────────────────────
//
// Each entry becomes one `dsh-tool-subagent` row: one provider plus one
// model-facing tool name. `persona` carries that specialist's whole identity.
//
// `maxDepth: 1` is what makes every specialist a LEAF, and the value is not
// arbitrary. The subagent runtime caps the *child being created*: it resolves
// `childDepth = delegationDepthOf(parent) + 1` and refuses when
// `childDepth > maxDepth`. The orchestrator is depth 0, so its children are
// depth 1 — hence `maxDepth: 1` admits exactly the orchestrator's own calls.
// A specialist sits at depth 1, so any delegation it attempted would be depth 2
// and is refused. (`maxDepth: 0` would reject the ORCHESTRATOR's calls too,
// because that check runs on the child, not on the caller — it does not mean
// "this agent may not delegate".)
//
// `toolFilter` then removes the delegation tools from each specialist's surface
// anyway, so the constraint is belt-and-braces rather than the only guard.
// `deny` is chosen over `allow` so a specialist keeps the ordinary working
// tools (read/grep/glob/pwsh/web) without this file having to re-list them.
//
// Both filter names and `maxDepth` are validated when the child is created, not
// at load, so a misspelling surfaces on the first delegation. `validate.mjs`
// pins every name against the real global registry to catch that up front.

const LEAF = ['subagent', 'subagent_fork', 'explore', 'librarian', 'oracle', 'metis', 'momus'];

const specialists = [
  {
    id: 'cluster-explore',
    toolName: 'explore',
    prompt: 'explore.md',
    // Read-only researcher: no writes, no delegation.
    deny: ['write', 'edit', ...LEAF],
  },
  {
    id: 'cluster-librarian',
    toolName: 'librarian',
    prompt: 'librarian.md',
    deny: ['write', 'edit', ...LEAF],
  },
  {
    id: 'cluster-oracle',
    toolName: 'oracle',
    prompt: 'oracle.md',
    // Advises only; it must not act on the code it is reviewing.
    deny: ['write', 'edit', ...LEAF],
  },
  {
    id: 'cluster-metis',
    toolName: 'metis',
    prompt: 'metis.md',
    // Plans before questioning, so it keeps retrieval and may read — but never
    // writes, and never delegates (its own prompt tells it to explore itself).
    deny: ['write', 'edit', ...LEAF],
  },
  {
    id: 'cluster-momus',
    toolName: 'momus',
    prompt: 'momus.md',
    deny: ['write', 'edit', ...LEAF],
  },
];

const specialistRows = specialists.map((s) =>
  row({
    id: s.id,
    name: '@deepseek-ai/dsh-tool-subagent',
    config: `provider: spawn
toolName: ${s.toolName}
backgroundMode: continuable
maxDepth: 1
persona: |-
${indent(read(s.prompt), 2)}
toolFilter:
  deny:
${s.deny.map((n) => `    - ${n}`).join('\n')}`,
  }),
);

// Generic delegation, for work with no matching specialist. These are NOT
// depth-capped here, so they inherit the Host `subagent.maxDepth` setting —
// which is also how the shipped `standard` preset behaves.
const genericRows = [
  row({
    id: 'cluster-subagent',
    name: '@deepseek-ai/dsh-tool-subagent',
    config: `provider: spawn
toolName: subagent
modelSelectionSettings: true
backgroundMode: continuable`,
  }),
  row({
    id: 'cluster-subagent-fork',
    name: '@deepseek-ai/dsh-tool-subagent',
    config: `provider: fork
toolName: subagent_fork
backgroundMode: continuable`,
  }),
];

const TAIL_TOOLS = [
  row({ id: 'tool-ask-user', name: '@deepseek-ai/dsh-tool-ask-user' }),
  row({
    id: 'tool-todo',
    name: '@deepseek-ai/dsh-tool-todo',
    config: 'allowParallelInProgress: true',
  }),
  row({
    id: 'tool-web',
    name: '@deepseek-ai/dsh-tool-web',
    config: 'fetch: true\nsearchTimeoutMs: 60000',
  }),
  row({ id: 'present', name: '@deepseek-ai/dsh-tool-present' }),
  row({
    id: 'tool-plugin-manager',
    name: '@deepseek-ai/dsh-plugin-manager/tools',
    extra: ['disabled: true'],
  }),
  // ── 寿命论阶段提示器 ───────────────────────────────────────────────────────
  // A RELATIVE path plugin. The preset's child rows resolve against the
  // DECLARING entry's `baseUrl` — the directory of the profile patch that
  // carried this declaration — so `./cluster-preset/lifecycle-reminder.js`
  // means "beside the profile's cordis.patch.yml". `install.mjs` copies the
  // file there; a manual install has to copy it too.
  //
  // Do NOT expect `anchorInsertedPluginNames` to rewrite this: it only walks
  // top-level `insert` rows and `group: true` child arrays, so a name nested in
  // `config.plugins` is left exactly as written.
  row({
    id: 'cluster-lifecycle-reminder',
    name: './cluster-preset/lifecycle-reminder.js',
    config: null,
  }),
];

// ── assemble ─────────────────────────────────────────────────────────────────
//
// `config.plugins` sits at indent 8, so every child row is shifted by 10.

const children = [
  '# ── 编排者身份 ────────────────────────────────────────────────────────────',
  ORCHESTRATOR_PERSONA,
  '',
  '# ── 编排者自带的工具（与 standard 预设同款工作面板）──────────────────────',
  ...BASE_TOOLS,
  '',
  ...GROUPED_TOOLS,
  '',
  '# ── 专家名册：每个角色一个具名委派工具 ───────────────────────────────────',
  ...specialistRows,
  '',
  '# ── 通用委派：没有对口专家时使用 ─────────────────────────────────────────',
  ...genericRows,
  '',
  '# ── 编排者收尾工具 ───────────────────────────────────────────────────────',
  ...TAIL_TOOLS,
];

const PRESET_ROW = `    - id: preset-cluster
      name: '@deepseek-ai/dsh-agent-preset'
      config:
        id: cluster
        name: 集群模式
        description: 自主编排子智能体协同工作：委派专家、并行扇出、验证结果。
        order: 5
        plugins:
${indent(children.join('\n'), 10)}`;

const out = `# Agent preset "cluster" (集群模式): autonomous subagent orchestration.
#
# This file is a profile patch layer. Apply it with \`plugin_manager\`
# (install_bundle / set_bundle) or paste the \`- insert:\` block into the
# profile's \`cordis.patch.yml\`.
#
# The single row below is one \`@deepseek-ai/dsh-agent-preset\` declaration:
# \`config.plugins\` IS the Agent's complete child list, which is why the
# orchestrator's persona and its whole specialist roster live here.
#
# Regenerate with: node scripts/build-preset.mjs
# Validate with:   ELECTRON_RUN_AS_NODE=1 <Harness.exe> scripts/validate.mjs
- insert:
${PRESET_ROW}
`;

writeFileSync(outFile, out, 'utf8');
const lines = out.split('\n').length;
console.log(`wrote ${outFile} (${out.length} bytes, ${lines} lines)`);
console.log(`specialists: ${specialists.map((s) => `${s.toolName}(${s.id})`).join(', ')}`);
