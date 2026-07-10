// ⚠️  COMMITTED NEGATIVE FIXTURE — DO NOT "FIX" THIS IMPORT, DO NOT DELETE.
//
// A stand-in core-domain module: it lives in the REAL core dir `src/knowledge/`
// and ILLEGALLY imports an adapter. Because it sits inside a real core dir, the
// MAIN eslint.config.mjs D1 zone (`src/knowledge` → `src/adapters`) is exactly
// what must reject it — so this guard exercises the actual target list the app
// relies on, not a boundary-specific stand-in.
//
// `npm run lint:boundary` lints just this file with the MAIN config and
// `--no-ignore` (this file is in the main config's `ignores` so `npm run lint`
// stays green; ESLint skips ignored files even when passed explicitly, so the
// guard MUST override the ignore or it would false-green on a skipped file). The
// guard passes (exit 0) when `import/no-restricted-paths` fires here, and fails
// (non-zero, fail-closed) if the rule ever STOPS firing. See
// scripts/check-boundary.mjs.
//
// Excluded from `npm run typecheck` / `build` / dist via tsconfig `exclude`, so
// it never turns the normal build red.
import * as adapters from '../adapters';

export const __illegalBoundaryProbe = adapters;
