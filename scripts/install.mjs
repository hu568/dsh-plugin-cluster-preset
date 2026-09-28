// Append the cluster preset declaration to the desktop profile's own patch
// layer, which is the documented installation path for a new preset:
// "a new preset ... is a bundle patch: an `insert` of a `@deepseek-ai/dsh-agent-preset` row".
//
// Idempotent: re-running replaces the previously appended block instead of
// stacking a second copy. Stacking would be fatal, not cosmetic — the registry
// rejects a duplicate preset id, so the whole `cluster` preset would refuse to
// mount.
//
// ── the managed-block markers ─────────────────────────────────────────────────
// The markers are matched by a PATH-INDEPENDENT prefix (see MARKER_RE), because
// they used to embed the script's own location. This file has since moved from
// `cluster-preset/scripts/` to the workspace root, so the text changed while
// existing installs still carry the old wording. Matching on the stable prefix
// means one install refreshes either vintage instead of appending beside it.
//
// ── the relative-path plugin ──────────────────────────────────────────────────
// `cluster.patch.yml` mounts the lifecycle plugin by a relative name. A preset
// child row resolves against the DECLARING patch's directory — the profile's
// `cordis.patch.yml` — so the plugin file must sit beside THAT file, in the
// subdirectory the YAML names. `anchorInsertedPluginNames` does NOT rewrite a
// name nested inside `config.plugins`, so nothing else will place it for you.
// The plugin is therefore copied in on install and deleted on --remove; getting
// this wrong yields a preset that mounts but whose plugin row fails to import,
// which the roster reports as `broken`.
//
// Usage:
//   node scripts/install.mjs            # install / refresh
//   node scripts/install.mjs --remove   # uninstall
import { readFileSync, writeFileSync, copyFileSync, existsSync, rmSync, mkdirSync, readdirSync } from 'node:fs';
import { dirname, join, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
// `scripts/` sits directly in the workspace root, and the generated files sit
// beside it — one level up is the root.
const srcRoot = join(here, '..');
const srcFile = join(srcRoot, 'cluster.patch.yml');

const PROFILE = 'C:\\Users\\Administrator\\.dsh\\profiles\\desktop';
const target = join(PROFILE, 'cordis.patch.yml');

// Plugins referenced by relative path from the patch, and therefore copied in.
// They ship inside `PLUGIN_DIR_NAME` in the source tree too, so the repository
// layout mirrors the installed layout: as a bundle the patch resolves them
// inside the package, and this script's copy satisfies the non-bundle path.
const RELATIVE_PLUGINS = [join('cluster-preset', 'lifecycle-reminder.js')];

// ── the owning manifest ───────────────────────────────────────────────────────
// A relative-path plugin needs an owning `package.json` that declares a
// non-empty `name` AND `version`. Without one, the nearest manifest walking up
// from `cluster-preset/` is the PROFILE's own `package.json`, which DSH creates
// with `name` but NO `version`.
//
// That matters because of the DeepSeek request-extension inventory
// (`@deepseek-ai/dsh-plugin-package-inventory-deepseek`, default-on): it walks
// every active entry of the requesting agent's preset tree and resolves each
// one's owning package identity. A manifest with a name but no version makes it
// throw, and the adapter surfaces that as
//
//   TURN/END {"kind":"error","error":{"code":"REQUEST_EXTENSION",
//             "message":"DeepSeek request extension preparation failed"}}
//
// i.e. EVERY turn on a DeepSeek-model session of this preset dies before the
// model is even called. (Sessions on the profile's default provider do not hit
// it, which is why this stayed hidden.)
//
// Shipping this manifest gives the plugin a proper identity and keeps the
// inventory happy. It lives beside the plugin at `cluster-preset/package.json`.
const MANIFEST_SOURCE = join('cluster-preset', 'package.json');
const MANIFEST_TARGET = 'package.json';

/** Managed-block boundary: stable text, no path baked in. */
const MARKER = 'cluster preset';
const BEGIN = `# >>>>>>>>>>>> ${MARKER} (managed by scripts/install.mjs) >>>>>>>>>>>>`;
const END = `# <<<<<<<<<<<< ${MARKER} (managed by scripts/install.mjs) <<<<<<<<<<<<`;
/**
 * Locate a managed block by its stable prefix, so a block written by an older
 * revision of this script (whose marker embedded the old path) is still found
 * and replaced rather than duplicated.
 * @param {string} text - current patch file contents.
 * @returns {{begin: number, end: number}|undefined} offsets of the block body.
 */
function findManagedBlock(text) {
  const open = /^# >>>>>>>>>>>> cluster preset .*>>>>>>>>>>>>$/m.exec(text);
  if (open === null) return undefined;
  const close = /^# <<<<<<<<<<<< cluster preset .*<<<<<<<<<<<<$/m.exec(text.slice(open.index));
  if (close === null) return undefined;
  return { begin: open.index, end: open.index + close.index + close[0].length };
}

// The plugin is copied into this subdirectory of the profile; the YAML names it
// with the same prefix, so the two must stay in step.
const PLUGIN_DIR_NAME = 'cluster-preset';
const pluginDir = join(PROFILE, PLUGIN_DIR_NAME);

const remove = process.argv.includes('--remove');

// Strip the previous managed block, if any, so install is idempotent.
let current = readFileSync(target, 'utf8');
const block = findManagedBlock(current);
if (block !== undefined) {
  current = current.slice(0, block.begin) + current.slice(block.end);
  current = current.replace(/\n{3,}/g, '\n\n').trimEnd() + '\n';
}
const hadBlock = block !== undefined;

if (remove) {
  writeFileSync(target, current, 'utf8');
  let removed = 0;
  for (const name of [...RELATIVE_PLUGINS.map(basename), MANIFEST_TARGET]) {
    const dest = join(pluginDir, name);
    if (existsSync(dest)) {
      rmSync(dest, { force: true });
      removed += 1;
    }
  }
  if (existsSync(pluginDir) && readdirSync(pluginDir).length === 0) {
    rmSync(pluginDir, { recursive: true, force: true });
  }
  console.log(hadBlock ? 'removed the cluster preset block' : 'no cluster preset block was present');
  if (removed > 0) console.log(`removed ${removed} copied plugin file(s)`);
  console.log(`wrote ${target} (${current.length} bytes)`);
  process.exit(0);
}

// ── copy the relative-path plugins beside the patch ───────────────────────────
mkdirSync(pluginDir, { recursive: true });
for (const rel of RELATIVE_PLUGINS) {
  const src = join(srcRoot, rel);
  if (!existsSync(src)) {
    throw new Error(`install: missing plugin source ${src} — run scripts/build-preset.mjs first?`);
  }
  // Copy to the SAME relative position under the profile, so the layout is
  // identical whether the patch lives in a bundle or in the profile itself.
  copyFileSync(src, join(pluginDir, basename(rel)));
}

// The owning manifest must sit in the SAME directory as the relative plugin, so
// the inventory's nearest-manifest walk finds it before the (version-less)
// profile manifest. Validate it here rather than discovering it at request time.
{
  const src = join(srcRoot, MANIFEST_SOURCE);
  if (!existsSync(src)) throw new Error(`install: missing manifest source ${src}`);
  const manifest = JSON.parse(readFileSync(src, 'utf8'));
  if (typeof manifest.name !== 'string' || manifest.name.length === 0
    || typeof manifest.version !== 'string' || manifest.version.length === 0) {
    throw new Error(`install: ${MANIFEST_SOURCE} must declare non-empty name and version`);
  }
  copyFileSync(src, join(pluginDir, MANIFEST_TARGET));
}

const preset = readFileSync(srcFile, 'utf8').trimEnd();

const next = `${current.trimEnd()}\n\n${BEGIN}\n${preset}\n${END}\n`;
writeFileSync(target, next, 'utf8');

console.log(`${hadBlock ? 'refreshed' : 'appended'} the cluster preset block`);
console.log(`copied ${RELATIVE_PLUGINS.length} plugin file(s) + ${MANIFEST_TARGET} -> ${pluginDir}`);
console.log(`wrote ${target} (${next.length} bytes)`);
