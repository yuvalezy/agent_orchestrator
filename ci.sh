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
step "typecheck (app)"      npm run typecheck:app
step "lint"                 npm run lint
step "lint:boundary"        npm run lint:boundary
step "test (server)"        npm test
step "test (database)"      npm run test:containers
step "test (console)"       npm --prefix web run test
step "test (app)"           npm --prefix app run test
step "build (server)"       npm run build
step "build (console)"      npm run build:console
step "build (app)"          npm run build:app

echo
echo "=== CI PASSED ==="
