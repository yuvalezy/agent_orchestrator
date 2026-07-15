#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")"

step() {
  echo
  echo "=== $1 ==="
  shift
  "$@"
}

step "typecheck (server)"   npm run typecheck
step "typecheck (console)"  npm run typecheck:console
step "lint"                 npm run lint
step "lint:boundary"        npm run lint:boundary
step "test (server)"        npm test
step "test (console)"       npm --prefix web run test
step "build (server)"       npm run build
step "build (console)"      npm run build:console

echo
echo "=== CI PASSED ==="
