import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// D1 import-boundary fidelity guard (green-on-healthy, fail-closed, CI-wireable).
//
// Lints the committed negative fixtures — core-dir modules that illegally import an
// adapter — with the MAIN eslint.config.mjs, so the app's ACTUAL boundary zones
// (`src/inbox` → `src/adapters`, `src/knowledge` → `src/adapters`) are what's
// exercised. The fixtures are in the main config's `ignores` (so `npm run lint`
// stays green); ESLint skips ignored files even when passed explicitly, so we MUST
// pass `--no-ignore` or the guard would false-green on a silently-skipped file.
//
// We don't trust the exit code alone: we parse the JSON report and require that
// EACH fixture (a) was actually linted, and (b) had `import/no-restricted-paths`
// fire on it. If any boundary zone's target list ever regresses (e.g. `src/inbox`
// or `src/knowledge` dropped), the rule stops firing on that fixture → guard exits
// non-zero. Adding a new core dir means adding its fixture here.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const eslintBin = path.join(root, 'node_modules', '.bin', 'eslint');
const RULE = 'import/no-restricted-paths';
const FIXTURES = [
  'src/inbox/__illegal_import_fixture__.ts',
  'src/knowledge/__illegal_import_fixture__.ts',
  'src/query/__illegal_import_fixture__.ts',
];

const r = spawnSync(eslintBin, ['--no-ignore', '-f', 'json', ...FIXTURES], {
  cwd: root,
  encoding: 'utf8',
});

if (r.error) {
  console.error('boundary guard could not run ESLint:', r.error.message);
  process.exit(2);
}

let results;
try {
  results = JSON.parse(r.stdout);
} catch {
  console.error(
    'boundary guard could not parse ESLint JSON output.\n--- stdout ---\n' +
      r.stdout +
      '\n--- stderr ---\n' +
      r.stderr,
  );
  process.exit(2);
}

for (const fixture of FIXTURES) {
  const base = path.basename(path.dirname(fixture)) + '/' + path.basename(fixture);
  const fileResult = results.find((f) => f.filePath.endsWith(base));
  if (!fileResult) {
    console.error(
      `✗ BOUNDARY GUARD FAILED: fixture ${fixture} was not linted at all ` +
        '(skipped/ignored — is --no-ignore in place?). Cannot verify the boundary.',
    );
    process.exit(1);
  }

  const fired = fileResult.messages.some((m) => m.ruleId === RULE);
  if (!fired) {
    console.error(
      `✗ BOUNDARY GUARD FAILED: ${RULE} did NOT fire on the core→adapter fixture ${fixture}. ` +
        'The main-config boundary zone is broken (target list regressed?).',
    );
    process.exit(1);
  }
}

console.log(
  `✓ boundary guard OK: ${RULE} correctly rejected the core→adapter import in ` +
    `${FIXTURES.length} fixtures (${FIXTURES.join(', ')}).`,
);
process.exit(0);
