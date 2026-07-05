#!/usr/bin/env bash
# Run the agent-orchestrator (backend-only) in a tmux session so it can be
# restarted/inspected independently. Always kills a leftover session first.
#
# STABLE run by default (`tsx src/main.ts`, NO watch) — a watch server would
# auto-reload and live-execute in-progress edits (which once processed real gate
# data mid-build). Re-run this script to restart after a code change. Use --watch
# ONLY for active local dev on a branch nobody is editing underneath you.
#
#   ./debug.sh                     # stable run (attaches if interactive)
#   ./debug.sh --fast-reconcile    # stable + WHATSAPP_RECONCILE_INTERVAL_MS=15000 (drills)
#   ./debug.sh --watch             # tsx-watch (auto-reload) — dev only, NOT during a build
#   tmux capture-pane -pt ao-debug # peek at logs without attaching
#   tmux kill-session -t ao-debug  # stop
#
# Logs are also mirrored to ./tmp/ao-debug.log for non-interactive inspection.
set -euo pipefail

SESSION="ao-debug"
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOG_DIR="$ROOT_DIR/tmp"
LOG_FILE="$LOG_DIR/ao-debug.log"
mkdir -p "$LOG_DIR"

# Stable (non-watch) by default; opt into watch explicitly.
RUN="npx tsx src/main.ts"
ENVP=""
for arg in "$@"; do
  case "$arg" in
    --watch) RUN="npm run dev" ;;
    --fast-reconcile) ENVP="WHATSAPP_RECONCILE_INTERVAL_MS=15000 $ENVP" ;;
  esac
done
DEV_CMD="${ENVP}${RUN}"

# Kill any prior session so we always start clean.
tmux kill-session -t "$SESSION" 2>/dev/null || true
sleep 1 2>/dev/null || true
: > "$LOG_FILE"

tmux new-session -d -s "$SESSION" -n dev -c "$ROOT_DIR"
# Mirror the pane to a logfile so logs are readable without attaching.
tmux pipe-pane -t "$SESSION:dev.0" -o "cat >> '$LOG_FILE'"
tmux send-keys -t "$SESSION:dev.0" "$DEV_CMD" Enter

cat <<INFO
▶ agent-orchestrator starting in tmux '$SESSION'
   backend : http://localhost:3100   (health: /health)
   logs    : tail -f $LOG_FILE   |   tmux capture-pane -pt $SESSION
   stop    : tmux kill-session -t $SESSION
INFO

# Attach only when run interactively; otherwise leave it running detached so this
# script can be launched in the background (e.g. by tooling) without blocking.
if [ -t 1 ]; then
  exec tmux attach -t "$SESSION"
fi
