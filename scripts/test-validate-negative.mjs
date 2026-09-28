// NEGATIVE TEST for validate.mjs.
//
// A validator that only passes on the good file proves nothing: it must FAIL on
// the exact defect that shipped. This reproduces that defect (re-adding
// `- subagent` to every specialist's deny list) in an ISOLATED copy of the
// workspace, runs the real validate.mjs there, and asserts it now exits non-zero.
//
// It also runs the unmodified file first, so a validator that simply always
// fails cannot pass this test either.
//
// Run: node scripts/test-validate-negative.mjs   (no asar access needed to set up;
//      validate.mjs itself is invoked with the Electron binary)
import { mkdtempSync, mkdirSync, copyFileSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');

const HARNESS = 'C:\\Users\\Administrator\\AppData\\Local\\Programs\\DeepSeek Harness\\DeepSeek Harness.exe';

const failures = [];
const check = (ok, label, detail = '') => {
  if (!ok) failures.push(`${label}${detail ? ` — ${detail}` : ''}`);
  return ok;
};

/** Run validate.mjs in `dir` and return {code, out}. */
function runValidate(dir) {
  try {
    const out = execFileSync(HARNESS, [join(dir, 'scripts', 'validate.mjs')], {
      encoding: 'utf8',
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { code: 0, out };
  } catch (error) {
    return { code: error.status ?? 1, out: `${error.stdout ?? ''}${error.stderr ?? ''}` };
  }
}

const work = mkdtempSync(join(tmpdir(), 'cluster-validate-'));
try {
  mkdirSync(join(work, 'scripts'), { recursive: true });
  mkdirSync(join(work, 'prompts'), { recursive: true });
  mkdirSync(join(work, 'cluster-preset'), { recursive: true });
  copyFileSync(join(root, 'cluster.patch.yml'), join(work, 'cluster.patch.yml'));
  copyFileSync(join(root, 'cluster-preset', 'lifecycle-reminder.js'),
    join(work, 'cluster-preset', 'lifecycle-reminder.js'));
  copyFileSync(join(root, 'cluster-preset', 'package.json'),
    join(work, 'cluster-preset', 'package.json'));
  copyFileSync(join(root, 'scripts', 'validate.mjs'), join(work, 'scripts', 'validate.mjs'));
  copyFileSync(join(root, 'scripts', 'install.mjs'), join(work, 'scripts', 'install.mjs'));

  // ── (1) the GOOD file must still validate ─────────────────────────────────
  const good = runValidate(work);
  console.log(`=== unmodified preset -> exit ${good.code} ===`);
  check(good.code === 0, 'the fixed preset validates', (good.out.split('=== failures ===')[1] ?? good.out).slice(0, 400));
  check(/VALID/.test(good.out), 'good run reports VALID');

  // ── (2) re-introduce the shipped defect ───────────────────────────────────
  // The defect was the PAIRING: the generic `subagent` row carried
  // `modelSelectionSettings: true` (so it registered per Agent, own-layer, and
  // stopped being restrictable) WHILE every specialist deny list named it. Put
  // the flag back and leave the deny list alone — exactly the shipped state.
  const yml = join(work, 'cluster.patch.yml');
  const before = readFileSync(yml, 'utf8');
  // Insert the flag right after the generic row's `toolName: subagent` line,
  // reusing that line's exact indentation (a flat string replace would miss it
  // because the generated YAML indents the row's config).
  const after = before
    .split('\n')
    .flatMap((line) => {
      if (/^(\s*)toolName: subagent\s*$/.test(line)) {
        return [line, `${line.match(/^(\s*)/)[1]}modelSelectionSettings: true`];
      }
      return [line];
    })
    .join('\n');
  writeFileSync(yml, after, 'utf8');
  const flagged = (after.match(/modelSelectionSettings: true/g) ?? []).length;
  const denySubagent = after.split('\n').filter((l) => /^\s+- subagent$/.test(l)).length;
  console.log(`\n=== restored modelSelectionSettings on the subagent row (${flagged} flag(s), ${denySubagent} deny entries) ===`);
  check(flagged === 1, 'the flag was restored exactly once', `${flagged}`);
  check(denySubagent === 5, 'the five deny lists still name "subagent"', `${denySubagent}`);

  const bad = runValidate(work);
  console.log(`=== broken preset -> exit ${bad.code} ===`);
  const detail = bad.out.split('=== failures ===')[1] ?? bad.out;
  console.log(detail.trim().slice(0, 1200));

  check(bad.code !== 0, 'validate.mjs REJECTS the shipped defect', `exit ${bad.code}`);
  check(/INVALID/.test(bad.out), 'broken run reports INVALID');
  check(/subagent/.test(detail), 'the diagnostic names the offending tool', '');
  check(/modelSelectionSettings|per-agent|own scope/.test(detail),
    'the diagnostic explains WHY (own-scope registration)', detail.slice(0, 300));

  // ── (3) the depth cap must not be silently relaxed ────────────────────────
  // Removing `maxDepth: 1` opens recursion, because the unfilterable per-agent
  // `subagent` is then guarded by nothing — and an omitted cap inherits the
  // Host setting (maxDepth: 3 in this profile), not 1. Drop the line cleanly
  // (line-level filter, so indentation cannot be corrupted) and assert failure.
  const yml2 = join(work, 'cluster.patch.yml');
  const noDepth = before
    .split('\n')
    .filter((line) => !/^\s+maxDepth: 1\s*$/.test(line))
    .join('\n');
  writeFileSync(yml2, noDepth, 'utf8');
  const dropped = (before.match(/^\s+maxDepth: 1\s*$/gm) ?? []).length;
  const left = (noDepth.match(/^\s+maxDepth: 1\s*$/gm) ?? []).length;
  console.log(`\n=== removed maxDepth: 1 (${dropped} removed, ${left} remain) ===`);
  check(dropped === 5 && left === 0, 'the depth cap was removed from all five specialists', `${dropped}/${left}`);
  const r3 = runValidate(work);
  console.log(`=== no-depth preset -> exit ${r3.code} ===`);
  const d3 = r3.out.split('=== failures ===')[1] ?? r3.out;
  check(r3.code !== 0, 'dropping the depth cap is rejected', `exit ${r3.code}`);
  check(/pins maxDepth/.test(d3), 'the diagnostic points at the missing depth cap', d3.slice(0, 300));

  // ── (4) the owning manifest must not disappear ────────────────────────────
  // Without it, the nearest manifest for the relative plugin is the profile's
  // own version-less `package.json`, and the DeepSeek request-extension
  // inventory throws — killing every turn with REQUEST_EXTENSION.
  writeFileSync(yml2, before, 'utf8'); // restore the good patch
  rmSync(join(work, 'cluster-preset', 'package.json'), { force: true });
  console.log('\n=== removed cluster-preset/package.json ===');
  const r4 = runValidate(work);
  console.log(`=== no-manifest preset -> exit ${r4.code} ===`);
  const d4 = r4.out.split('=== failures ===')[1] ?? r4.out;
  check(r4.code !== 0, 'a missing owning manifest is rejected', `exit ${r4.code}`);
  check(/owning manifest/.test(d4), 'the diagnostic names the manifest', d4.slice(0, 300));
} finally {
  rmSync(work, { recursive: true, force: true });
}

console.log('\n=== verdict ===');
if (failures.length === 0) {
  console.log('  the validator passes the fixed file and fails the shipped defect');
  console.log('\nNEGATIVE TEST OK');
  process.exit(0);
}
for (const f of failures) console.log('  ✗ ' + f);
console.log('\nNEGATIVE TEST FAILED');
process.exit(1);
