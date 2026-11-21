# claude-session-restore

A local VS Code extension. It brings back the Claude Code sessions in each
window after VS Code or the Mac restarts.

## How it works

- **Snapshot:** every 60 s, and 5 s after any terminal opens or closes, each
  window records which of its terminals runs an interactive `claude` process.
  The session ID comes from the file Claude Code writes for every process,
  `~/.claude/sessions/<pid>.json`, so the mapping is exact. The extension also
  records the terminal name, the cwd and the CLI flags (for example
  `--dangerously-skip-permissions`). Snapshots are written to
  `~/.claude/vscode-restore/<window>.json`.
- **Restore:** when a window starts, the extension checks its snapshot for
  sessions that no live process is on and whose transcript still exists, and
  resumes them without asking. Set `claudeRestore.mode` to `ask` (a modal
  dialog, no timeout) or `off` to change that. Sessions you already resumed by
  hand are skipped. Each session is resumed with
  `claude --resume <id> <original flags>`. When VS Code has revived the old
  shell under the same name, the session runs in that shell; otherwise in a
  new terminal.
- **Plain shells:** VS Code's own persistent terminals restore them, with
  their cwd and scrollback. Turn that on for reboots too; see Install.

## Install

```bash
./install.sh
```

The script packages and installs the extension. It also sets
`terminal.integrated.persistentSessionReviveProcess` to
`onExitAndWindowClose` and `window.restoreWindows` to `all`.

## After a reboot

1. Open VS Code. It normally reopens its windows by itself.
2. If it doesn't, run `./reopen-windows.sh` to list the windows from the
   snapshots, then `./reopen-windows.sh --open` to open them.
3. Click **Resume** in each window.

**Commands** (Command Palette → "Claude Restore"):

- Resume sessions from last snapshot
- Snapshot sessions now
- Show this window's snapshot

**Logs:** Output panel → "Claude Session Restore".

## Caveats

- Answering "Not now" skips the resume. The next snapshot, within 60 s, then
  replaces the old list.
- An empty window, with no folder open, has no stable key and is not
  snapshotted.
