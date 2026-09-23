#!/usr/bin/env node
/**
 * check-preset — validate a DSH agent-preset composition against the harness
 * that will mount it.
 *
 * Why this exists: a user preset is a one-time COPY of a shipped preset. Nothing
 * keeps it in step afterwards, and when DSH updates, a plugin's config contract can
 * move. The copy still parses as YAML and still looks healthy on disk, so the rot
 * surfaces only when a session fails to start:
 *
 *   failed to apply loader entry persona (@deepseek-ai/dsh-persona):
 *   invalid config: - $.prefix missing required value (at prefix)
 *
 * That exact failure happens when the copy still writes the retired `text:` key
 * where the current schema requires `prefix:` (DSH 0.9.1 / dsh-persona 0.1.5-rc.2).
 *
 * The check resolves every row's plugin package out of the harness install and runs
 * the row's REAL Config schema on the row's config — the same validation the loader
 * performs at mount, minus running the plugin. It also verifies that rows naming
 * preset-local files resolve, and reports rows the shipped `standard` preset has
 * gained since the copy was taken (that half is informational: a copy may be trimmed
 * on purpose, and a missing `present` row only loses a tool).
 *
 * Usage:
 *   node tools/check-preset.mjs <agent.cordis.yml> [harness-app-dir] [--verbose]
 *
 * `harness-app-dir` is the `resources/app` directory of the running DSH install (it
 * holds `node_modules/@deepseek-ai/dsh-agent-presets`). Omitted, `DSH_HARNESS_APP`
 * is read, then the standard Electron install roots are scanned. Find the running
 * one with:
 *   (Get-Process 'DSH Desktop')[0].Path   # then append \resources\app
 *
 * Exit codes: 0 every checkable row is valid, 1 at least one row is invalid,
 * 2 the composition or the harness could not be read.
 */
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { existsSync, readdirSync } from 'node:fs';
import { isAbsolute, join, resolve as resolvePath } from 'node:path';
import { pathToFileURL } from 'node:url';

const USAGE = `check-preset — validate a DSH agent preset against the harness schemas

  node tools/check-preset.mjs <agent.cordis.yml> [harness-app-dir] [--verbose]

  harness-app-dir  resources/app of the running DSH install (or $DSH_HARNESS_APP)
  --verbose        also print each row's resolved config
`;

const argv = process.argv.slice(2);
const flags = new Set(argv.filter((arg) => arg.startsWith('-')));
const positional = argv.filter((arg) => !arg.startsWith('-'));
if (flags.has('-h') || flags.has('--help')) {
  process.stdout.write(USAGE);
  process.exit(0);
}
if (positional.length === 0) {
  process.stderr.write(USAGE);
  process.exit(2);
}

const compositionPath = resolvePath(positional[0]);
const verbose = flags.has('--verbose');

/** Every install root worth scanning for a harness, in preference order. */
function candidateHarnessRoots() {
  const roots = [];
  const programs = [process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, 'Programs'), process.env.ProgramFiles, process.env['ProgramFiles(x86)']];
  for (const root of programs) {
    if (!root || !existsSync(root)) continue;
    for (const name of safeReaddir(root)) {
      roots.push(join(root, name, 'resources', 'app'));
    }
  }
  return roots;
}

/** Directory entries, or [] when the directory is unreadable. */
function safeReaddir(directory) {
  try {
    return readdirSync(directory);
  } catch {
    return [];
  }
}

/** Whether `directory` is a harness install. */
function isHarness(directory) {
  return existsSync(join(directory, 'node_modules', '@deepseek-ai', 'dsh-agent-presets', 'package.json'));
}

/** The harness install to validate against, or a readable failure. */
function resolveHarness() {
  const explicit = positional[1] ?? process.env.DSH_HARNESS_APP;
  if (explicit) {
    const directory = resolvePath(explicit);
    if (!isHarness(directory)) {
      process.stderr.write(`error: ${directory} is not a DSH harness install (no node_modules/@deepseek-ai/dsh-agent-presets)\n`);
      process.exit(2);
    }
    return directory;
  }
  const found = candidateHarnessRoots().filter(isHarness);
  if (found.length === 1) return found[0];
  if (found.length > 1) {
    process.stderr.write(`error: several harness installs found — pass the running one explicitly:\n${found.map((dir) => `  ${dir}\n`).join('')}`);
    process.exit(2);
  }
  process.stderr.write('error: no harness install found — pass <harness-app-dir> or set DSH_HARNESS_APP\n');
  process.exit(2);
}

const harnessApp = resolveHarness();
const require = createRequire(pathToFileURL(join(harnessApp, 'noop.js')).href);
const importFromHarness = async (name) => import(pathToFileURL(require.resolve(name)).href);

let compositionText;
try {
  compositionText = await readFile(compositionPath, 'utf8');
} catch (error) {
  process.stderr.write(`error: cannot read ${compositionPath}: ${error.message}\n`);
  process.exit(2);
}

const { load } = (await importFromHarness('js-yaml')).default;
const { entryListSchema } = await importFromHarness('@deepseek-ai/cordis-plugin-include');

// Parse with the loader's own dialect, so `!!js` nodes read the way a mount reads them.
let rows;
try {
  rows = load(compositionText, { schema: entryListSchema });
} catch (error) {
  process.stderr.write(`FAIL ${compositionPath}\n  the composition is not valid YAML: ${error.message.split('\n')[0]}\n`);
  process.exit(2);
}

/** Flatten groups into their rows, keeping a readable row path for diagnostics. */
function flatten(list, at, found) {
  for (const [index, row] of list.entries()) {
    const label = at === '' ? `row ${index + 1}` : `${at} row ${index + 1}`;
    if (row.group === true) {
      flatten(row.config, label, found);
      continue;
    }
    found.push({ label, row });
  }
  return found;
}

const flat = flatten(rows, '', []);
const presetBase = new URL('.', pathToFileURL(compositionPath)).href;

let failures = 0;
let checked = 0;
let skipped = 0;
const FAILURES = [];
const SCOPED = [];

function report(row, verdict, detail) {
  const id = typeof row.id === 'string' && row.id !== '' ? row.id : row.name;
  process.stdout.write(`- ${id}: ${verdict}${detail ? ` ${detail}` : ''}\n`);
}

for (const { row } of flat) {
  const name = row.name;
  if (typeof name !== 'string' || name === '') {
    failures += 1;
    FAILURES.push(`${row.label} names no plugin`);
    report(row, 'FAIL', '(no "name")');
    continue;
  }
  if (row.disabled === true) {
    skipped += 1;
    report(row, 'SKIP', '(disabled)');
    continue;
  }
  const condition = typeof row.disabled === 'object' && row.disabled !== null ? ' (disabled is a !!js expression — validated as enabled)' : '';

  // A row naming a file the preset ships must resolve against the composition directory.
  if (name.startsWith('.') || name.startsWith('file:') || isAbsolute(name)) {
    const target = name.startsWith('file:') ? new URL(name) : isAbsolute(name) ? pathToFileURL(name) : new URL(name, presetBase);
    if (existsSync(target)) {
      skipped += 1;
      report(row, 'OK', `preset-local ${name}`);
    } else {
      failures += 1;
      FAILURES.push(`${row.id ?? row.label}: preset-local file is missing: ${name}`);
      report(row, 'FAIL', `preset-local file is missing: ${name}`);
    }
    continue;
  }
  if (name.startsWith('cordis:')) {
    skipped += 1;
    report(row, 'SKIP', `builtin ${name}`);
    continue;
  }

  let module;
  try {
    module = await importFromHarness(name);
  } catch (error) {
    failures += 1;
    FAILURES.push(`${row.id ?? row.label}: cannot be resolved from the harness: ${name}`);
    report(row, 'FAIL', `cannot be resolved from the harness (${name}): ${error.message.split('\n')[0]}`);
    continue;
  }
  if (typeof module.Config !== 'function') {
    skipped += 1;
    report(row, 'SKIP', `${name} exports no Config schema${condition}`);
    continue;
  }
  try {
    const resolved = module.Config(row.config ?? {});
    checked += 1;
    const keys = Object.keys(row.config ?? {});
    report(row, 'OK', `${name} config [${keys.join(', ')}]${condition}`);
    if (verbose) process.stdout.write(`    ${JSON.stringify(resolved)}\n`);
  } catch (error) {
    failures += 1;
    const detail = error.message.split('\n')[0];
    FAILURES.push(`${row.id ?? row.label} (${name}): ${detail}`);
    report(row, 'FAIL', `${name} config rejected: ${detail}`);
  }
}

// Informational: rows the shipped `standard` preset has gained since this copy was taken.
const baselinePath = join(harnessApp, 'node_modules', '@deepseek-ai', 'dsh-agent-presets', 'presets', 'standard', 'agent.cordis.yml');
if (existsSync(baselinePath)) {
  try {
    const baselineRows = flatten(load(await readFile(baselinePath, 'utf8'), { schema: entryListSchema }), '', []);
    const mine = new Set(flat.map(({ row }) => row.id).filter((id) => typeof id === 'string'));
    const missing = baselineRows.map(({ row }) => row.id).filter((id) => typeof id === 'string' && !mine.has(id));
    if (missing.length > 0) SCOPED.push(`rows in the shipped standard preset that this copy lacks: ${missing.join(', ')}`);
  } catch {
    // A baseline that will not parse is not this preset's problem.
  }
}

process.stdout.write(`\nharness: ${harnessApp}\npreset:  ${compositionPath}\n`);
process.stdout.write(`rows=${flat.length} schema-validated=${checked} skipped=${skipped} failures=${failures}\n`);
if (SCOPED.length > 0) {
  for (const note of SCOPED) process.stdout.write(`note: ${note}\n`);
  process.stdout.write('note: informational only — a deliberately trimmed copy can ignore this; a missing tool row silently costs that tool.\n');
}
if (failures > 0) {
  process.stdout.write('\nfailed rows:\n');
  for (const line of FAILURES) process.stdout.write(`  - ${line}\n`);
  process.stdout.write('\nrepair: bring the flagged row to the current contract (the shipped `standard` preset shows it), or delete\n');
  process.stdout.write('this preset and re-run the `memory-dsh-hook` operation to copy a fresh one.\n');
}
process.exit(failures === 0 ? 0 : 1);
