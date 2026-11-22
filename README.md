# Session Restore for Claude Code

Run several Claude Code sessions in VS Code terminals, then quit VS Code, let
it crash, or reboot the machine: each window resumes its own sessions, in
terminals with their old names, in the right folders, with the flags they were
started with.

## How it works

- **Snapshot:** every 60 s, and 5 s after a terminal opens or closes, each
  window records which of its terminals runs an interactive `claude` process.
  The session ID comes from the file Claude Code writes for every process
  (`~/.claude/sessions/<pid>.json`), so the mapping is exact, not guessed from
  the folder. The terminal name, folder and CLI flags are recorded too.
- **Restore:** when a window starts, it looks for sessions in its snapshot that
  no process is running any more and whose transcript still exists, and runs
  `claude --resume <id> <original flags>` for each. A session you already
  resumed by hand is skipped. If VS Code revived the old shell under the same
  name, the session resumes there; otherwise in a new terminal.
- **Other terminals and windows:** VS Code's persistent terminals bring back
  plain shells, and `window.restoreWindows` brings back windows. On first run
  the extension offers to turn both on so they also survive quitting VS Code
  and rebooting.

The initial prompt of a session is not sent again, and flags that would start
something new (`--fork-session`, `--worktree`, `--print`, `--continue`, …) are
not carried over.

## Settings

| Setting | Default | |
|---|---|---|
| `claudeRestore.mode` | `auto` | `auto` resumes without asking. `ask` asks first, in a dialog that waits for you. `off` does nothing until you run the Resume command. |
| `claudeRestore.intervalSeconds` | `60` | How often to snapshot. |
| `claudeRestore.claudeConfigDir` | empty | Claude Code's config directory, if not `$CLAUDE_CONFIG_DIR` or `~/.claude`. |

## Commands

Command Palette, "Claude Restore":

- **Resume sessions from last snapshot**
- **Reopen windows that have sessions to resume.** Use this after a reboot if
  VS Code didn't reopen every window.
- **Snapshot sessions now**
- **Show this window's snapshot**

Logs: Output panel, "Claude Session Restore".

## Requirements and limits

- macOS or Linux, including Remote SSH, WSL and Dev Container windows. Native
  Windows is not supported.
- Claude Code run in VS Code's integrated terminal. Sessions in the Claude
  Code chat panel are not covered.
- An empty window, with no folder open, is not snapshotted.
- On macOS, a flag value that contains spaces (for example
  `--append-system-prompt "be brief"`) is split into words, because `ps` does
  not keep argument boundaries.
- Published on the VS Code Marketplace. For Cursor and other editors that use
  Open VSX, download the `.vsix` from the
  [latest release](https://github.com/zeev-finaloop/claude-code-session-restore/releases/latest)
  and run `cursor --install-extension <file>.vsix`.

## Development

```bash
node --test                                                  # unit tests
npx @vscode/vsce package && code --install-extension *.vsix  # try it locally
```

Pushing a `v*` tag runs the tests and attaches the `.vsix` to a GitHub
release. Upload that file to the VS Code Marketplace by hand.
