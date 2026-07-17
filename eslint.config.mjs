import tseslint from 'typescript-eslint';
import importPlugin from 'eslint-plugin-import';

// Flat config (ESLint 9). The load-bearing piece is the D1 import-boundary rule
// (import/no-restricted-paths): core domain + port modules may NOT import
// adapters — adapters are wired only in src/main.ts (the composition root).
//
// The committed negative fixtures (src/inbox/__illegal_import_fixture__.ts and
// src/knowledge/__illegal_import_fixture__.ts) each live in a REAL core dir, so
// THIS config's own zones (src/inbox → src/adapters, src/knowledge → src/adapters)
// are what reject them — the guard exercises the actual target list the app relies
// on. Each is listed in `ignores` so `npm run lint` (and typecheck/build) stay
// green; `npm run lint:boundary` lints just those files with `--no-ignore`
// (overriding the ignore) and asserts THIS rule fires on each (green-on-healthy,
// fail-closed if the rule ever stops firing). See scripts/check-boundary.mjs.
export default tseslint.config(
  {
    ignores: [
      'dist/**',
      '.claude/**', // agent tooling + transient git worktrees, not project source
      'web/**', // independently built Vite application (console)
      'app/**', // independently built Vite application (AO Founder PWA)
      'node_modules/**',
      'src/inbox/__illegal_import_fixture__.ts',
      'src/knowledge/__illegal_import_fixture__.ts',
      'src/query/__illegal_import_fixture__.ts',
      'src/commitments/__illegal_import_fixture__.ts',
    ],
  },
  ...tseslint.configs.recommended,
  {
    files: ['src/**/*.ts'],
    plugins: { import: importPlugin },
    settings: { 'import/resolver': { typescript: true } },
    rules: {
      // Honor the `_`-prefix convention used throughout (e.g. Express's 4-arg
      // error handler needs `_next` present but unused to be detected as such).
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' },
      ],
      'import/no-restricted-paths': [
        'error',
        {
          zones: [
            {
              // ◆ allowlist-by-omission (blueprint §5 guardrail): this names
              // TODAY's core dirs. Every future milestone that adds a core dir
              // (e.g. M2 src/memory/) MUST extend this target list.
              target: [
                './src/inbox',
                './src/triage',
                './src/customers',
                './src/outbound',
                './src/decisions',
                './src/ports',
                './src/knowledge',
                './src/query',
                './src/commitments',
              ],
              from: './src/adapters',
              message:
                'Core domain/port modules may not import adapters (D1 — hexagonal core). Wire adapters only in src/main.ts.',
            },
          ],
        },
      ],
    },
  },
);
