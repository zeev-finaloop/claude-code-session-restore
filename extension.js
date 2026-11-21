// Claude Session Restore
//
// Every window snapshots which of its terminals run an interactive `claude`
// process and which session each one is on. Claude Code writes
// ~/.claude/sessions/<pid>.json for every interactive process (pid ->
// sessionId, cwd, name), so the mapping is exact, not guessed from cwd.
//
// When a window starts and its snapshot lists sessions whose processes are
// gone (VS Code restart, crash, reboot), it offers to resume them, each in a
// terminal with the original name and cwd, using the original CLI flags.

const vscode = require('vscode');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');

const HOME = os.homedir();
const SESSIONS_DIR = path.join(HOME, '.claude', 'sessions');
const PROJECTS_DIR = path.join(HOME, '.claude', 'projects');
const STATE_DIR = path.join(HOME, '.claude', 'vscode-restore');

// Flags that pick the session; everything else (e.g. --dangerously-skip-permissions,
// --model x) is carried over to the resumed process.
const SESSION_FLAGS_WITH_VALUE = new Set(['--resume', '-r', '--session-id']);
const SESSION_FLAGS_BARE = new Set(['--continue', '-c']);

let out;
let snapshotting = false;
let restoreDone = false;

function log(msg) {
  out.appendLine(`${new Date().toISOString()} ${msg}`);
}

function windowFolders() {
  if (vscode.workspace.workspaceFile && vscode.workspace.workspaceFile.scheme === 'file') {
    return { kind: 'workspace', paths: [vscode.workspace.workspaceFile.fsPath] };
  }
  const folders = (vscode.workspace.workspaceFolders || []).map((f) => f.uri.fsPath);
  return { kind: 'folders', paths: folders };
}

function windowKey() {
  const { kind, paths } = windowFolders();
  if (paths.length === 0) return null; // empty window: nothing stable to key on
  return crypto.createHash('sha1').update(kind + '\n' + [...paths].sort().join('\n')).digest('hex').slice(0, 16);
}

function snapshotPath(key) {
  return path.join(STATE_DIR, `${key}.json`);
}

function run(cmd, args) {
  return new Promise((resolve) => {
    execFile(cmd, args, { maxBuffer: 32 * 1024 * 1024 }, (err, stdout) => resolve(err ? '' : stdout));
  });
}

// pid -> [child pids], from one `ps` call.
async function processTree() {
  const text = await run('/bin/ps', ['-axo', 'pid=,ppid=']);
  const children = new Map();
  for (const line of text.split('\n')) {
    const m = line.trim().match(/^(\d+)\s+(\d+)$/);
    if (!m) continue;
    const pid = Number(m[1]);
    const ppid = Number(m[2]);
    if (!children.has(ppid)) children.set(ppid, []);
    children.get(ppid).push(pid);
  }
  return children;
}

function descendants(children, root) {
  const result = [];
  const stack = [...(children.get(root) || [])];
  while (stack.length) {
    const pid = stack.pop();
    result.push(pid);
    stack.push(...(children.get(pid) || []));
  }
  return result;
}

function readSessionFile(pid) {
  try {
    const s = JSON.parse(fs.readFileSync(path.join(SESSIONS_DIR, `${pid}.json`), 'utf8'));
    if (s.kind && s.kind !== 'interactive') return null;
    if (!s.sessionId) return null;
    return s;
  } catch {
    return null;
  }
}

async function processArgs(pid) {
  const cmd = (await run('/bin/ps', ['-o', 'command=', '-p', String(pid)])).trim();
  return cmd ? cmd.split(/\s+/) : [];
}

function carriedFlags(argv) {
  const flags = [];
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    if (SESSION_FLAGS_WITH_VALUE.has(a)) { i++; continue; }
    if ([...SESSION_FLAGS_WITH_VALUE].some((f) => a.startsWith(f + '='))) continue;
    if (SESSION_FLAGS_BARE.has(a)) continue;
    flags.push(a);
  }
  return flags;
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}

// Session IDs that some live claude process is on right now, whatever its pid.
// Catches sessions the user already resumed by hand after a restart, so they
// are not resumed a second time.
function liveSessionIds() {
  const ids = new Set();
  let files = [];
  try { files = fs.readdirSync(SESSIONS_DIR); } catch {}
  for (const f of files) {
    const m = f.match(/^(\d+)\.json$/);
    if (!m || !isAlive(Number(m[1]))) continue;
    const s = readSessionFile(Number(m[1]));
    if (s) ids.add(s.sessionId);
  }
  return ids;
}

// A snapshot entry counts as running if the same pid is alive and still on the
// same session (pids get reused after a reboot), or if any other live process
// is on that session.
function stillRunning(entry, live) {
  if ((live || liveSessionIds()).has(entry.sessionId)) return true;
  if (!isAlive(entry.pid)) return false;
  const s = readSessionFile(entry.pid);
  return !!s && s.sessionId === entry.sessionId;
}

function transcriptExists(sessionId) {
  try {
    for (const dir of fs.readdirSync(PROJECTS_DIR)) {
      if (fs.existsSync(path.join(PROJECTS_DIR, dir, `${sessionId}.jsonl`))) return true;
    }
  } catch {}
  return false;
}

async function takeSnapshot(reason) {
  const key = windowKey();
  if (!key || snapshotting || !restoreDone) return;
  snapshotting = true;
  try {
    const tree = await processTree();
    const sessions = [];
    const terminals = vscode.window.terminals;
    for (let i = 0; i < terminals.length; i++) {
      const t = terminals[i];
      const shellPid = await t.processId;
      if (!shellPid) continue;
      for (const pid of descendants(tree, shellPid)) {
        const s = readSessionFile(pid);
        if (!s) continue;
        const argv = await processArgs(pid);
        sessions.push({
          terminalName: t.name,
          terminalIndex: i,
          pid,
          sessionId: s.sessionId,
          sessionName: s.name || null,
          cwd: s.cwd,
          flags: carriedFlags(argv),
        });
      }
    }
    const file = snapshotPath(key);
    const snapshot = {
      version: 1,
      takenAt: new Date().toISOString(),
      window: windowFolders(),
      sessions,
    };
    fs.mkdirSync(STATE_DIR, { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(snapshot, null, 2));
    fs.renameSync(tmp, file);
    if (reason !== 'timer') log(`snapshot (${reason}): ${sessions.length} session(s) -> ${file}`);
  } catch (e) {
    log(`snapshot failed: ${e.stack || e}`);
  } finally {
    snapshotting = false;
  }
}

// Claude retitles its terminal while it runs ("✳ <task>", "◑ <task>", or its
// version when idle), so tab names are a poor key. Strip the status glyph, and
// fall back to the session's name when all that's left is a version number.
function displayName(e) {
  const t = (e.terminalName || '').replace(/^[^\p{L}\p{N}]+/u, '').trim();
  if (!t || /^\d+\.\d+\.\d+$/.test(t)) return e.sessionName || 'claude';
  return t;
}

function shellQuote(s) {
  return /^[A-Za-z0-9_\-./=:@]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`;
}

async function pendingSessions() {
  const key = windowKey();
  if (!key) return [];
  let snap;
  try {
    snap = JSON.parse(fs.readFileSync(snapshotPath(key), 'utf8'));
  } catch {
    return [];
  }
  const live = liveSessionIds();
  return (snap.sessions || []).filter((e) => !stillRunning(e, live) && transcriptExists(e.sessionId));
}

async function resume(entries) {
  const tree = await processTree();
  const used = new Set();
  for (const e of entries) {
    // VS Code's persistent sessions usually revive the old shell (same name,
    // scrollback, no child process). Reuse it so there's no duplicate tab.
    let target;
    for (const t of vscode.window.terminals) {
      if (used.has(t) || displayName({ terminalName: t.name }) !== displayName(e)) continue;
      const pid = await t.processId;
      if (pid && descendants(tree, pid).length === 0) { target = t; break; }
    }
    if (!target) {
      target = vscode.window.createTerminal({ name: displayName(e), cwd: e.cwd });
    }
    used.add(target);
    const cmd = ['claude', '--resume', e.sessionId, ...e.flags].map(shellQuote).join(' ');
    target.sendText(`cd ${shellQuote(e.cwd)} && ${cmd}`, true);
    log(`resumed ${e.sessionId} (${displayName(e)}) in "${target.name}"`);
  }
  if (entries.length) vscode.window.terminals.find((t) => used.has(t))?.show(true);
}

async function maybeRestore(manual) {
  try {
    const entries = await pendingSessions();
    if (entries.length === 0) {
      if (manual) vscode.window.showInformationMessage('Claude Restore: nothing to resume, every snapshotted session is still running.');
      return;
    }
    const mode = vscode.workspace.getConfiguration('claudeRestore').get('mode');
    if (!manual && mode === 'off') return;
    if (!manual && mode === 'ask') {
      const names = entries.map(displayName).join(', ');
      // Modal: a plain notification toast hides itself after a few seconds.
      const pick = await vscode.window.showInformationMessage(
        `Resume ${entries.length} Claude session(s) from before the restart?`,
        { modal: true, detail: names },
        'Resume', 'Not now');
      if (pick !== 'Resume') return;
    }
    await resume(entries);
  } finally {
    restoreDone = true;
  }
}

function activate(context) {
  out = vscode.window.createOutputChannel('Claude Session Restore');
  context.subscriptions.push(out);

  context.subscriptions.push(
    vscode.commands.registerCommand('claudeRestore.restoreNow', () => maybeRestore(true)),
    vscode.commands.registerCommand('claudeRestore.snapshotNow', async () => {
      restoreDone = true;
      await takeSnapshot('manual');
      vscode.window.showInformationMessage('Claude Restore: snapshot written.');
    }),
    vscode.commands.registerCommand('claudeRestore.showSnapshot', async () => {
      const key = windowKey();
      if (!key || !fs.existsSync(snapshotPath(key))) {
        vscode.window.showInformationMessage('Claude Restore: no snapshot for this window yet.');
        return;
      }
      const doc = await vscode.workspace.openTextDocument(snapshotPath(key));
      vscode.window.showTextDocument(doc, { preview: true });
    }),
  );

  // Give revived terminals a few seconds to come back before deciding what's missing.
  setTimeout(() => maybeRestore(false), 8000);

  const seconds = Math.max(15, vscode.workspace.getConfiguration('claudeRestore').get('intervalSeconds') || 60);
  const timer = setInterval(() => takeSnapshot('timer'), seconds * 1000);
  context.subscriptions.push({ dispose: () => clearInterval(timer) });

  let debounce;
  const soon = (reason) => {
    clearTimeout(debounce);
    debounce = setTimeout(() => takeSnapshot(reason), 5000);
  };
  context.subscriptions.push(
    vscode.window.onDidOpenTerminal(() => soon('terminal-opened')),
    vscode.window.onDidCloseTerminal(() => soon('terminal-closed')),
  );
}

function deactivate() {}

module.exports = { activate, deactivate };
