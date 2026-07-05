import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// D1 import-boundary fidelity guard (green-on-healthy, fail-closed, CI-wireable).
//
// Lints the committed negative fixture — a core-dir module that illegally imports
// an adapter — with the MAIN eslint.config.mjs, so the app's ACTUAL boundary zone
// (`src/inbox` → `src/adapters`) is what's exercised. The fixture is in the main
// config's `ignores` (so `npm run lint` stays green); ESLint skips ignored files
// even when passed explicitly, so we MUST pass `--no-ignore` or the guard would
// false-green on a silently-skipped file.
//
// We don't trust the exit code alone: we parse the JSON report and require that
// (a) the fixture was actually linted, and (b) `import/no-restricted-paths` fired
// on it. If the boundary zone's target list ever regresses (e.g. `src/inbox`
// dropped), the rule stops firing → guard exits non-zero.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const eslintBin = path.join(root, 'node_modules', '.bin', 'eslint');
const FIXTURE = 'src/inbox/__illegal_import_fixture__.ts';
const RULE = 'import/no-restricted-paths';

const r = spawnSync(eslintBin, ['--no-ignore', '-f', 'json', FIXTURE], {
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

const fileResult = results.find((f) => f.filePath.endsWith('__illegal_import_fixture__.ts'));
if (!fileResult) {
  console.error(
    `✗ BOUNDARY GUARD FAILED: fixture ${FIXTURE} was not linted at all ` +
      '(skipped/ignored — is --no-ignore in place?). Cannot verify the boundary.',
  );
  process.exit(1);
}

const fired = fileResult.messages.some((m) => m.ruleId === RULE);
if (!fired) {
  console.error(
    `✗ BOUNDARY GUARD FAILED: ${RULE} did NOT fire on the core→adapter fixture. ` +
      'The main-config boundary zone is broken (target list regressed?).',
  );
  process.exit(1);
}

console.log(
  `✓ boundary guard OK: ${RULE} correctly rejected the core→adapter import in ${FIXTURE} ` +
    '(main-config zone src/inbox → src/adapters).',
);
process.exit(0);
