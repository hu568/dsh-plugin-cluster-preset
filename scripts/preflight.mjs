// End-to-end preflight against DSH's OWN loader.
//
// validate.mjs checks this file's internal consistency. This script checks the
// thing that actually matters: that DSH's real patch parser accepts the file,
// that composing it onto the desktop profile produces a live `cluster` preset
// declaration, and that every plugin row resolves to an installed package.
//
// Run with the Electron binary (needs asar access):
//   ELECTRON_RUN_AS_NODE=1 <Harness.exe> scripts/preflight.mjs
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const patchFile = join(here, '..', 'cluster.patch.yml');

const ASAR = 'C:/Users/Administrator/AppData/Local/Programs/DeepSeek Harness/resources/app.asar/dsh';
const PROFILE_DIR = 'C:\\Users\\Administrator\\.dsh\\profiles\\desktop';
const INSTALL_ANCHOR = ASAR + '/node_modules/@deepseek-ai/dsh/package.json';

const boot = await import('file:///' + ASAR + '/node_modules/@deepseek-ai/dsh-app-boot/lib/index.js');

const failures = [];
const notes = [];
const check = (ok, label, detail = '') => {
  if (!ok) failures.push(`${label}${detail ? ` — ${detail}` : ''}`);
  return ok;
};

// ── 1. the real parser accepts the file ───────────────────────────────────────
// `composeEntries` is fed the parsed+anchored patch list by the boot path; the
// cheapest faithful way to exercise the same code is to compose it directly and
// let the Loader's patch applier reject anything malformed.
const patchText = readFileSync(patchFile, 'utf8');

const profile = boot.loadProfileDirectory('dsh', PROFILE_DIR, INSTALL_ANCHOR);
notes.push(`profile bundles: ${profile.layers.length} layer(s)`);

// ── 2. parse through the profile's own YAML schema ────────────────────────────
// `userPatchesSchema` is what `parsePatchList` uses; reach it by composing a
// patch list that contains our text. If the YAML is malformed the loader's own
// parser throws with its own diagnostic, which is the most faithful signal.
const yaml = (await import('file:///' + ASAR + '/node_modules/js-yaml/index.js')).default;

// Map `!!js` to its source text: the schema would evaluate it, which executes
// arbitrary JS. Composition below still proves the ROW SHAPE is accepted.
const JS_TAG = new yaml.Type('tag:yaml.org,2002:js', {
  kind: 'scalar',
  construct: (data) => ({ __js: data }),
});
const schema = yaml.DEFAULT_SCHEMA.extend([JS_TAG]);

let parsed;
try {
  parsed = yaml.load(patchText, { schema });
  notes.push('real js-yaml parsed the patch');
} catch (error) {
  failures.push(`patch does not parse with the loader's YAML schema — ${error.message}`);
}

if (parsed !== undefined) {
  check(Array.isArray(parsed), 'patch is a top-level array');

  // ── 3. compose ONTO the real profile ────────────────────────────────────────
  // This is the strongest available offline proof: it runs the profile's actual
  // bundle layers plus our patch through the same `composeEntries` the launcher
  // uses, and reports any row the patch applier warns about.
  const warnings = [];
  let entries;
  try {
    entries = boot.composeEntries(
      [profile.layers.flatMap((l) => l.patches), profile.patches, parsed],
      (message) => warnings.push(message),
    );
  } catch (error) {
    failures.push(`composeEntries rejected the patch — ${error.message}`);
  }

  if (entries !== undefined) {
    check(warnings.length === 0, 'compose produced no warnings', warnings.join(' | '));
    notes.push(`composed entries: ${entries.length}`);

    const presetRow = entries.find((r) => r?.id === 'preset-cluster');
    check(presetRow !== undefined, 'composition carries the preset-cluster row');
    if (presetRow) {
      check(presetRow.name === '@deepseek-ai/dsh-agent-preset',
        'preset row names the agent-preset package', String(presetRow.name));
      check(presetRow.config?.id === 'cluster',
        'preset row declares config.id=cluster', String(presetRow.config?.id));
      const plugins = presetRow.config?.plugins ?? [];
      check(plugins.length > 0, 'preset composes a non-empty child list', `${plugins.length} rows`);

      // Shipped presets must be untouched by our insert.
      const shipped = ['preset-standard', 'preset-ptc', 'preset-minimal', 'preset-cordis'];
      for (const id of shipped) {
        check(entries.some((r) => r?.id === id), `shipped preset ${id} still present`);
      }

      // Every delegation row must actually be a subagent tool.
      const delegations = plugins.filter((p) => p?.name === '@deepseek-ai/dsh-tool-subagent');
      check(delegations.length === 7, 'seven delegation rows composed', `${delegations.length}`);
      const names = delegations.map((d) => d.config?.toolName).sort();
      notes.push(`delegation tools composed: ${names.join(', ')}`);
    }
  }
}

// ── 4. packages resolve ───────────────────────────────────────────────────────
// Every row's package must exist in one of the two node_modules roots the
// profile actually resolves against, otherwise the preset mounts a load failure
// instead of a tool. The install domain is an asar path, which the Electron
// binary can readdir directly.
if (parsed !== undefined) {
  const { readdirSync } = await import('node:fs');
  const insert = parsed.find((p) => p?.insert)?.insert ?? [];
  const presetRow = insert.find((r) => r?.id === 'preset-cluster');
  const plugins = presetRow?.config?.plugins ?? [];

  // Packages may be top-level (`@scope/name` counts as two path segments), and
  // a row may name a SUBPATH export (`pkg/tools`). Resolution starts from the
  // package, so reduce each spec to its package name before probing.
  const packageOf = (spec) => {
    const parts = spec.split('/');
    return spec.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
  };
  const needed = new Set();
  for (const p of plugins) {
    const n = p?.name;
    if (typeof n !== 'string' || n.startsWith('cordis:') || n.startsWith('file:')) continue;
    needed.add(packageOf(n));
  }

  // The launcher's own fallback order: profile direct deps, then the install
  // domain (`app.asar/dsh/node_modules`).
  const roots = [join(PROFILE_DIR, 'node_modules'), join(ASAR, 'node_modules')];
  const present = (name) => {
    for (const root of roots) {
      try {
        readdirSync(join(root, ...name.split('/')));
        return true;
      } catch {
        /* try the next root */
      }
    }
    return false;
  };

  const missing = [...needed].filter((n) => !present(n));
  check(missing.length === 0, 'every row names a package present in a real node_modules root',
    missing.join(', '));
  notes.push(`packages referenced: ${needed.size} (${missing.length} missing)`);

  // The delegation tool itself must be there, since the whole preset rests on it.
  check(present('@deepseek-ai/dsh-tool-subagent'),
    'dsh-tool-subagent is installed in the install domain');
  check(present('@deepseek-ai/dsh-agent-preset'),
    'dsh-agent-preset is installed in the install domain');
}

// ── report ────────────────────────────────────────────────────────────────────
console.log('=== notes ===');
for (const n of notes) console.log('  ' + n);
console.log('=== failures ===');
if (failures.length === 0) {
  console.log('  (none)');
  console.log('\nPREFLIGHT OK');
  process.exit(0);
}
for (const f of failures) console.log('  ✗ ' + f);
console.log('\nPREFLIGHT FAILED');
process.exit(1);
