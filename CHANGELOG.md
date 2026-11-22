# Changelog

## 0.3.0

- First public release.
- Flags are read from `claude --help`, so an initial prompt is not sent again
  and `--fork-session`, `--worktree`, `--print` and similar are not carried over.
- Works when `claude` is installed with npm (`node …/claude` on the command line).
- Snapshots live in the editor's own storage, so VS Code and Cursor don't
  resume the same sessions twice.
- New command: reopen windows that have sessions to resume.
- Offers to turn on VS Code's persistent terminals and window restore,
  instead of an install script editing settings.json.
- Honors `CLAUDE_CONFIG_DIR` and a `claudeRestore.claudeConfigDir` setting.

## 0.2.0

- Resume without asking by default; `ask` mode uses a dialog that doesn't time out.
- Skip sessions already resumed by hand.

## 0.1.0

- Snapshot Claude sessions per window and resume them after a restart.
