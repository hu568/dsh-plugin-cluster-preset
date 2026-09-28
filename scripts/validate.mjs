// Validate cluster.patch.yml without touching the live profile.
//
// Checks, in order of what actually breaks a preset at load or delegation time:
//   1. YAML parses with the loader's own schema (including `!!js` tags).
//   2. Shape: top-level insert list -> one dsh-agent-preset row.
//   3. Row ids unique across the whole patch, and within config.plugins.
//   4. Every plugin row names a package.
//   5. Required config for the rows this preset configures.
//   6. Every `{{...}}` in a persona is a registered prompt variable.
//   7. Every toolFilter name is a real global tool for the target platform.
//   8. The relative-path lifecycle plugin exists and is namespaced correctly.
//   9. Each specialist is a genuine leaf (depth cap + delegation tools denied).
import { readFileSync } from 'node:fs';
import { dirname, join, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const here = dirname(fileURLToPath(import.meta.url));
const file = join(here, '..', 'cluster.patch.yml');

// Relative-path plugins live in this subdirectory of the installed profile,
// because `install.mjs` copies them there rather than beside cordis.patch.yml.
const PLUGIN_SUBDIR = 'cluster-preset';

// js-yaml is not a top-level dependency of the profile; it ships inside the
// DSH install domain. That lives behind an `app.asar` path, which only the
// Electron binary can read — so this script must run as:
//   ELECTRON_RUN_AS_NODE=1 <Harness.exe> scripts/validate.mjs
const ASAR = 'C:/Users/Administrator/AppData/Local/Programs/DeepSeek Harness/resources/app.asar/dsh';
const require = createRequire(ASAR + '/node_modules/@deepseek-ai/dsh/package.json');
let yaml;
try {
  yaml = require('js-yaml');
} catch (error) {
  console.error(`js-yaml is not reachable from the install domain: ${error.message}`);
  console.error('Run this script with ELECTRON_RUN_AS_NODE=1 and the DeepSeek Harness binary.');
  process.exit(2);
}

const failures = [];
const notes = [];
const check = (ok, label, detail = '') => {
  if (!ok) failures.push(`${label}${detail ? ` — ${detail}` : ''}`);
  return ok;
};

// ── 1. parse, treating `!!js` as an opaque scalar ─────────────────────────────
// `!!js` desugars to the tag `tag:yaml.org,2002:js`, which the loader evaluates
// as JavaScript. Evaluating it here is both unnecessary and unsafe, so the tag
// is mapped to its raw source text instead — structure is all this script
// validates. The real loader's own `!!js` handling is exercised separately.
const JS_TAG = new yaml.Type('tag:yaml.org,2002:js', {
  kind: 'scalar',
  construct: (data) => ({ __js: data }),
});
const schema = yaml.DEFAULT_SCHEMA.extend([JS_TAG]);

let doc;
try {
  doc = yaml.load(readFileSync(file, 'utf8'), { schema });
  notes.push('YAML parsed');
} catch (error) {
  failures.push(`YAML does not parse — ${error.message}`);
}

if (doc !== undefined) {
  // ── 2. shape ────────────────────────────────────────────────────────────────
  const isList = check(Array.isArray(doc), 'top level is a list', typeof doc);
  const insertRows = isList ? doc.find((r) => r && r.insert)?.insert : undefined;
  check(Array.isArray(insertRows), 'patch carries an `insert` list');

  const presets = (insertRows ?? []).filter((r) => r?.name === '@deepseek-ai/dsh-agent-preset');
  check(presets.length === 1, 'exactly one agent-preset declaration', `found ${presets.length}`);
  const preset = presets[0];

  if (preset) {
    const cfg = preset.config ?? {};
    check(typeof cfg.id === 'string' && cfg.id.length > 0, 'preset declares config.id');
    check(cfg.id !== 'standard' && cfg.id !== 'ptc' && cfg.id !== 'minimal' && cfg.id !== 'cordis',
      'preset id does not collide with a shipped preset', String(cfg.id));
    check(typeof cfg.name === 'string' && cfg.name.length > 0, 'preset declares a display name');
    check(typeof cfg.description === 'string', 'preset declares a description');
    check(Array.isArray(cfg.plugins), 'config.plugins is a list');

    const plugins = cfg.plugins ?? [];

    // ── 3. id uniqueness ──────────────────────────────────────────────────────
    const patchIds = (insertRows ?? []).map((r) => r?.id).filter(Boolean);
    const dupPatch = patchIds.filter((id, i) => patchIds.indexOf(id) !== i);
    check(dupPatch.length === 0, 'patch row ids are unique', dupPatch.join(', '));

    const pluginIds = plugins.map((p) => p?.id).filter(Boolean);
    const dupPlugin = pluginIds.filter((id, i) => pluginIds.indexOf(id) !== i);
    check(dupPlugin.length === 0, 'plugin row ids are unique', dupPlugin.join(', '));

    // Child ids are scoped to this declaration's own Loader tree, so reusing the
    // shipped `persona` / `tool-fs` ids is the established pattern (all four
    // shipped presets do it). Only intra-tree duplicates are a real defect, and
    // that is checked above. Recorded as a note purely for reviewers.
    const standardIds = new Set([
      'persona', 'agent-instructions', 'tool-bash', 'tool-pwsh', 'tool-fs',
      'tool-fs-search', 'tool-jobs', 'skill-filesystem', 'tool-skill',
      'command-goal', 'tool-goal', 'planning', 'compaction', 'delegation',
      'tool-ask-user', 'tool-todo', 'tool-web', 'present', 'tool-plugin-manager',
    ]);
    const reused = pluginIds.filter((id) => standardIds.has(id));
    if (reused.length > 0) {
      notes.push(`child ids mirroring the standard preset (expected): ${reused.length}`);
    }

    // ── 4. every row names a package ──────────────────────────────────────────
    const nameless = plugins.filter((p) => typeof p?.name !== 'string' || p.name.length === 0);
    check(nameless.length === 0, 'every plugin row names a package',
      nameless.map((p) => p?.id).join(', '));

    // ── 5. required config across the inherited tool rows ─────────────────────
    // Each of these plugins rejects its own mount when a required field is
    // missing, which surfaces as the whole preset being "broken" in the roster
    // rather than as a load error. Pin the ones this preset configures.
    const REQUIRED = [
      ['plan-mode', '@deepseek-ai/dsh-plan-mode', (c) => typeof c?.section === 'string' && c.section.trim().length > 0,
        'section must be a non-empty string'],
      ['agent-instructions', '@deepseek-ai/dsh-agent-instructions', (c) => typeof c?.maxBytes === 'number',
        'maxBytes is required'],
      ['tool-todo', '@deepseek-ai/dsh-tool-todo', (c) => typeof c?.allowParallelInProgress === 'boolean',
        'allowParallelInProgress is required'],
    ];
    for (const [id, pkg, ok, why] of REQUIRED) {
      const plugin = plugins.find((p) => p?.id === id);
      if (plugin === undefined) continue; // not mounted in this preset
      check(plugin.name === pkg, `${id} mounts ${pkg}`, String(plugin.name));
      check(ok(plugin.config), `${id} carries its required config`, why);
    }

    // ── 6. prompt variables ───────────────────────────────────────────────────
    // Registered by @deepseek-ai/dsh-agent-loop plus the web bundle.
    const KNOWN_VARS = new Set(['model', 'cwd', 'dshWebUrl']);
    const varProblems = [];
    for (const p of plugins) {
      const texts = [];
      if (typeof p?.config?.prefix === 'string') texts.push([`${p.id}.config.prefix`, p.config.prefix]);
      if (typeof p?.config?.suffix === 'string') texts.push([`${p.id}.config.suffix`, p.config.suffix]);
      if (typeof p?.config?.persona === 'string') texts.push([`${p.id}.config.persona`, p.config.persona]);
      for (const [label, text] of texts) {
        for (const m of text.matchAll(/\{\{([^}]*)\}\}/g)) {
          const name = m[1];
          if (!KNOWN_VARS.has(name)) varProblems.push(`${label} -> {{${name}}}`);
        }
      }
    }
    check(varProblems.length === 0,
      'every {{variable}} is registered (unregistered ones throw at render)',
      varProblems.join('; '));

    // ── 6. toolFilter names ───────────────────────────────────────────────────
    // `tools.restrict()` validates every name against what it can actually
    // restrict, and `dsh-tools` defines that as "the global layer plus every
    // ANCESTOR layer on the scope chain — never the calling scope's OWN layer"
    // (dsh-tools/lib/index.js:2937-2958). So the set is two-sided, and getting
    // this wrong is exactly the bug this section now catches.
    //
    // ANCESTOR-owned: registered at preset mount time, therefore restrictable
    // from a delegating agent's scope.
    const GLOBAL_TOOLS = new Set([
      'read', 'read_image', 'write', 'edit',
      'glob', 'grep',
      process.platform === 'win32' ? 'pwsh' : 'bash',
      'todo_write',
      'web_fetch', 'web_search',
      'skill',
      'job_list', 'job_output', 'job_kill',
      'create_goal', 'get_goal', 'update_goal',
      'present', 'ask_user_question',
      'exit_plan_mode',
      'list_agents', 'send_message', 'interrupt_agent',
      'workflow',
      // delegation tools registered at mount by this very preset
      'subagent', 'subagent_fork', 'explore', 'librarian', 'oracle', 'metis', 'momus',
    ]);

    const subagentRows = plugins.filter((p) => p?.name === '@deepseek-ai/dsh-tool-subagent');
    check(subagentRows.length >= 5, 'specialist roster present', `${subagentRows.length} rows`);

    // AGENT-owned: a row with `modelSelectionSettings: true` does not register
    // at mount. `dsh-tool-subagent` waits for an Agent and registers through
    // `candidate.ctx.inject(...)` — into THAT AGENT'S OWN layer
    // (dsh-tool-subagent/lib/index.js:610-659). Every agent joining this preset,
    // specialists included, therefore owns a copy of these tool names, and a
    // scope can never restrict away a tool it owns. Naming one in a `toolFilter`
    // throws on the first delegation:
    //
    //   tools.restrict() names unknown global tool "subagent";
    //   known global tools: …, explore, …, subagent_fork, …
    //
    // This set is DERIVED from the preset rather than hardcoded, so adding a
    // second model-selection row cannot silently reopen the hole.
    const perAgentTools = new Set(
      subagentRows
        .filter((p) => p?.config?.modelSelectionSettings === true)
        .map((p) => p.config.toolName),
    );

    const filterProblems = [];

    const toolNames = new Set();
    for (const p of subagentRows) {
      const tn = p?.config?.toolName;
      if (toolNames.has(tn)) filterProblems.push(`duplicate toolName "${tn}"`);
      toolNames.add(tn);
    }
    check(toolNames.size === subagentRows.length, 'every delegation tool name is unique');

    for (const p of subagentRows) {
      const f = p?.config?.toolFilter;
      if (f === undefined) continue;
      // allow and deny are mutually exclusive
      if (f.allow !== undefined && f.deny !== undefined) {
        filterProblems.push(`${p.id}: declares both allow and deny (mutually exclusive)`);
      }
      if (f.allow === undefined && f.deny === undefined) {
        filterProblems.push(`${p.id}: toolFilter names neither allow nor deny (rejected at mount)`);
      }
      for (const kind of ['allow', 'deny']) {
        for (const name of f[kind] ?? []) {
          if (name === 'run_code') filterProblems.push(`${p.id}: names reserved transport "run_code"`);
          else if (!GLOBAL_TOOLS.has(name)) filterProblems.push(`${p.id}.${kind}: unknown tool "${name}"`);
          // A per-agent registration is not restrictable from that agent's own
          // scope, so naming it throws on the first delegation. This is the
          // exact defect that shipped once: `subagent` was in every deny list.
          else if (perAgentTools.has(name)) {
            filterProblems.push(
              `${p.id}.${kind}: names per-agent tool "${name}" `
              + `(registered through the agent's own scope via modelSelectionSettings, `
              + `so tools.restrict() rejects it — the depth cap is the guard for this name)`,
            );
          }
        }
      }
    // ── 8. the relative-path plugin resolves to a real file ───────────────────
    // A preset child row resolves against the DECLARING patch's directory, so a
    // `./…` name must point at a file that will exist beside the installed patch.
    // `install.mjs` copies it into `PLUGIN_SUBDIR`; this keeps the two in step.
    const { existsSync } = await import('node:fs');
    const relRows = plugins.filter((p) => typeof p?.name === 'string' && p.name.startsWith('./'));
    check(relRows.length > 0, 'the lifecycle plugin is mounted by relative path',
      `${relRows.length} relative row(s)`);
    for (const r of relRows) {
      const source = join(here, '..', basename(r.name));
      check(existsSync(source), `${r.id}: relative plugin exists in the source tree`, source);
      check(r.name.startsWith(`./${PLUGIN_SUBDIR}/`),
        `${r.id}: relative plugin is namespaced to ./${PLUGIN_SUBDIR}/`, r.name);
    }

    // ── 8b. the relative plugin's OWNING MANIFEST ─────────────────────────────
    // It must sit in the same installed directory and declare a non-empty name
    // AND version. Otherwise the nearest manifest walking up from that directory
    // is the PROFILE's own `package.json` — which DSH writes with a name but NO
    // version — and the DeepSeek request-extension inventory
    // (`@deepseek-ai/dsh-plugin-package-inventory-deepseek`, default-on) throws
    // on exactly that shape. The adapter then surfaces
    //
    //   TURN/END {"kind":"error","error":{"code":"REQUEST_EXTENSION"}}
    //
    // so EVERY turn on a DeepSeek-model session of this preset dies before the
    // model is called. `install.mjs` copies this manifest in; keep them in step.
    const MANIFEST_SOURCE = 'cluster-preset.package.json';
    const manifestFile = join(here, '..', MANIFEST_SOURCE);
    if (check(existsSync(manifestFile), 'the relative plugin ships an owning manifest', manifestFile)) {
      let manifest;
      try {
        manifest = JSON.parse(readFileSync(manifestFile, 'utf8'));
      } catch (error) {
        failures.push(`the owning manifest is not valid JSON — ${error.message}`);
      }
      if (manifest !== undefined) {
        check(typeof manifest.name === 'string' && manifest.name.length > 0,
          'the owning manifest declares a non-empty name', String(manifest.name));
        check(typeof manifest.version === 'string' && manifest.version.length > 0,
          'the owning manifest declares a non-empty version', String(manifest.version));
      }
      const installer = readFileSync(join(here, 'install.mjs'), 'utf8');
      check(installer.includes(MANIFEST_SOURCE),
        'install.mjs copies that manifest into the profile', MANIFEST_SOURCE);
    }

    // ── 9. leaf semantics ───────────────────────────────────────────────────
      // A specialist must be a leaf: it may not delegate onward. The guard for
      // that is `maxDepth: 1`, and it is a HARD runtime check — the depth is
      // resolved on the child being created (`childDepth =
      // delegationDepthOf(parent) + 1`, refused when `childDepth > maxDepth`),
      // so a depth-1 specialist attempting a delegation is rejected at depth 2.
      //
      // `toolFilter` is the SECOND line of defence, and it is only able to
      // cover the delegation tools that live in an INHERITED layer. It can
      // never cover a name the delegating agent itself registers — that is the
      // `restrict()` exemption, and it is why `subagent` must not be named
      // (see the `perAgentTools` check above). So the invariant is stated
      // against exactly the restrictable delegation names, not against "all".
      //
      // (a) `maxDepth: 1` admits the orchestrator's own calls (whose child is
      //     depth 1) and refuses any call a depth-1 specialist would make.
      //     `maxDepth: 0` would be wrong: the runtime checks the child's depth,
      //     so 0 rejects the orchestrator too.
      // (b) `toolFilter` hides the inherited delegation tools.
      //
      // `maxDepth` is REQUIRED here, not merely permitted. A specialist cannot
      // filter away the per-agent `subagent`, so the depth cap is the only thing
      // stopping it from recursing — and an OMITTED cap does not mean 1, it means
      // "whatever the Host setting is". This profile raises that to 3
      // (`profiles/desktop/cordis.patch.yml`: `- id: subagent … maxDepth: 3`), so
      // an unpinned specialist could delegate to depth 2 and be admitted.
      const depth = p?.config?.maxDepth;
      check(depth === 1,
        `${p.id} pins maxDepth: 1 (the independent leaf guard)`,
        depth === undefined
          ? 'omitted — it would inherit the Host cap (maxDepth: 3 in this profile)'
          : String(depth));
      const f2 = p?.config?.toolFilter;
      const denied = new Set(f2?.deny ?? []);
      // Required to deny exactly the delegation names `restrict()` can remove.
      // A per-agent name is excluded here because it CANNOT be named at all
      // (naming it throws) — it is guarded by the depth cap instead.
      const restrictableDelegation =
        [...toolNames].filter((n) => !perAgentTools.has(n));
      const exposed = restrictableDelegation.filter((n) => !denied.has(n));
      check(exposed.length === 0,
        `${p.id} denies every restrictable delegation tool`,
        exposed.join(', '));
      if (depth !== 1) {
        // Without the cap, an unfilterable per-agent tool would let this leaf
        // recurse. Nothing else stands in the way once maxDepth is relaxed.
        check(perAgentTools.size === 0,
          `${p.id}: relaxing maxDepth is only safe while no per-agent tool exists`,
          `per-agent tools: ${[...perAgentTools].join(', ')}`);
      }
      const persona = p?.config?.persona;
      check(typeof persona === 'string' && persona.length > 100,
        `${p.id} carries an inline persona`, `${String(persona ?? '').length} chars`);
      check(p?.config?.provider === 'spawn' || p?.config?.provider === 'fork',
        `${p.id} names a real provider`, String(p?.config?.provider));
    }
    check(filterProblems.length === 0, 'every toolFilter references real tools', filterProblems.join('; '));

    // The orchestrator must be able to reach every specialist.
    const missing = [...GLOBAL_TOOLS]
      .filter((n) => ['explore', 'librarian', 'oracle', 'metis', 'momus'].includes(n))
      .filter((n) => !toolNames.has(n));
    check(missing.length === 0, 'roster exposes the full specialist set', missing.join(', '));

    // Every delegation name the preset PINS via modelSelectionSettings must be
    // excluded from every filter — the invariant that this defect violated.
    if (perAgentTools.size > 0) {
      const named = [];
      for (const p of subagentRows) {
        for (const kind of ['allow', 'deny']) {
          for (const name of p?.config?.toolFilter?.[kind] ?? []) {
            if (perAgentTools.has(name)) named.push(`${p.id}.${kind}:${name}`);
          }
        }
      }
      check(named.length === 0,
        'no toolFilter names a modelSelectionSettings tool',
        named.join(', '));
      notes.push(`per-agent (non-restrictable) delegation tools: ${[...perAgentTools].sort().join(', ')}`);
    }

    notes.push(`preset id=${cfg.id} name=${cfg.name}`);
    notes.push(`plugin rows: ${plugins.length}, delegation rows: ${subagentRows.length}`);
    notes.push(`delegation tools: ${[...toolNames].sort().join(', ')}`);
  }
}

// ── report ────────────────────────────────────────────────────────────────────
console.log('=== notes ===');
for (const n of notes) console.log('  ' + n);
console.log('=== failures ===');
if (failures.length === 0) {
  console.log('  (none)');
  console.log('\nVALID');
  process.exit(0);
}
for (const f of failures) console.log('  ✗ ' + f);
console.log('\nINVALID');
process.exit(1);
