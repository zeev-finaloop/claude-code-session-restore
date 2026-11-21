#!/usr/bin/env bash
# Reopen every VS Code window that had Claude sessions in its last snapshot.
# Use after a reboot if VS Code did not bring the windows back by itself; each
# window then offers to resume its sessions (the extension does that part).
#
#   ./reopen-windows.sh          list windows and sessions, open nothing
#   ./reopen-windows.sh --open   open them
set -euo pipefail

STATE_DIR="$HOME/.claude/vscode-restore"
shopt -s nullglob
files=("$STATE_DIR"/*.json)
[[ ${#files[@]} -eq 0 ]] && { echo "No snapshots in $STATE_DIR"; exit 0; }

for f in "${files[@]}"; do
  n=$(jq '.sessions | length' "$f")
  [[ "$n" -eq 0 ]] && continue
  taken=$(jq -r '.takenAt' "$f")
  echo "== $(jq -r '.window.paths | join(", ")' "$f")  ($n session(s), snapshot $taken)"
  jq -r '.sessions[] | "   \(.terminalName)  \(.sessionName // "-")  \(.sessionId)  \(.cwd)"' "$f"
  if [[ "${1:-}" == "--open" ]]; then
    jq -r '.window.paths[]' "$f" | while read -r p; do
      [[ -e "$p" ]] && code -n "$p" || echo "   (missing: $p)"
    done
  fi
done
