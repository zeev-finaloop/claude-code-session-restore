#!/usr/bin/env bash
# Package and install the extension, and turn on VS Code's own window/terminal restore.
set -euo pipefail
cd "$(dirname "$0")"

npx --yes @vscode/vsce@3.6.0 package --allow-missing-repository --skip-license -o claude-session-restore.vsix
code --install-extension claude-session-restore.vsix --force

SETTINGS="$HOME/Library/Application Support/Code/User/settings.json"
python3 - "$SETTINGS" <<'EOF'
import json, re, sys
p = sys.argv[1]
raw = open(p).read()
# settings.json is JSONC; refuse to rewrite it if it has comments rather than lose them.
if re.search(r'^\s*//|/\*', raw, re.M):
    print(f"settings.json has comments, not editing it. Add these by hand:\n"
          '  "window.restoreWindows": "all",\n'
          '  "terminal.integrated.enablePersistentSessions": true,\n'
          '  "terminal.integrated.persistentSessionReviveProcess": "onExitAndWindowClose"')
    sys.exit(0)
s = json.loads(raw or "{}")
s.setdefault("window.restoreWindows", "all")
s.setdefault("terminal.integrated.enablePersistentSessions", True)
s["terminal.integrated.persistentSessionReviveProcess"] = "onExitAndWindowClose"
open(p, "w").write(json.dumps(s, indent=4) + "\n")
print("VS Code settings updated.")
EOF

echo "Installed. Reload each VS Code window (Cmd+Shift+P → Developer: Reload Window) to start snapshotting."
