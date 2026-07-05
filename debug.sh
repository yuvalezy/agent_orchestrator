#!/usr/bin/env bash
# Run the agent-orchestrator (backend-only) in a tmux session so it can be
# restarted/inspected independently. `npm run dev` is tsx-watch, so it also
# auto-restarts on file changes. Always kills a leftover session first — safe to
# re-run anytime.
#
#   ./debug.sh                     # start (attaches if interactive)
#   ./debug.sh --fast-reconcile    # start with WHATSAPP_RECONCILE_INTERVAL_MS=15000 (drills)
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

# Optional: a short reconcile interval for the M1.3 gate drills.
DEV_CMD="npm run dev"
if [ "${1:-}" = "--fast-reconcile" ]; then
  DEV_CMD="WHATSAPP_RECONCILE_INTERVAL_MS=15000 npm run dev"
fi

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
