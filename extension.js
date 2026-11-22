// Session Restore for Claude Code
//
// Every window snapshots which of its terminals run an interactive `claude`
// process and which session each one is on. Claude Code writes
// <config dir>/sessions/<pid>.json for every interactive process (pid ->
// sessionId, cwd, name), so the mapping is exact, not guessed from cwd.
//
// When a window starts and its snapshot lists sessions whose processes are
// gone (VS Code restart, crash, reboot), it resumes them, each in a terminal
// with the original name and cwd, using the original CLI flags.

const vscode = require('vscode');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');
const { carriedFlags, parseHelpArity, programLength, displayName, shellQuote, FALLBACK_ARITY } = require('./lib');

let out;
let stateDir;
let snapshotting = false;
let restoreDone = false;
const helpArity = new Map(); // claude program path -> Promise<arity>

function log(msg) {
  out.appendLine(`${new Date().toISOString()} ${msg}`);
}

function config() {
  return vscode.workspace.getConfiguration('claudeRestore');
}

function claudeDir() {
  const fromSetting = config().get('claudeConfigDir');
  if (fromSetting) return fromSetting.replace(/^~(?=$|\/)/, os.homedir());
  return process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
}
const sessionsDir = () => path.join(claudeDir(), 'sessions');
const projectsDir = () => path.join(claudeDir(), 'projects');

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
  return path.join(stateDir, `${key}.json`);
}

function readSnapshot(key) {
  // 0.2.x kept snapshots in ~/.claude/vscode-restore; read those until the first new one is written.
  for (const file of [snapshotPath(key), path.join(os.homedir(), '.claude', 'vscode-restore', `${key}.json`)]) {
    try {
      return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {}
  }
  return null;
}

function run(cmd, args, timeout = 0) {
  return new Promise((resolve) => {
    execFile(cmd, args, { maxBuffer: 32 * 1024 * 1024, timeout }, (err, stdout) => resolve(err ? '' : stdout));
  });
}

// pid -> [child pids], from one `ps` call.
async function processTree() {
  const text = await run('ps', ['-A', '-o', 'pid=,ppid=']);
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
    const s = JSON.parse(fs.readFileSync(path.join(sessionsDir(), `${pid}.json`), 'utf8'));
    if (s.kind && s.kind !== 'interactive') return null;
    if (!s.sessionId) return null;
    return s;
  } catch {
    return null;
  }
}

// The process's command line. Exact on Linux. macOS `ps` joins the arguments
// with spaces, so an argument that itself contains spaces gets split.
async function processArgs(pid) {
  try {
    const raw = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8');
    return raw.split('\0').filter((a, i, all) => a || i < all.length - 1);
  } catch {}
  const cmd = (await run('ps', ['-o', 'command=', '-p', String(pid)])).trim();
  return cmd ? cmd.split(/\s+/) : [];
}

// Which flags take values, from this claude's own `--help`; the built-in table if that fails.
function arityFor(argv) {
  const program = argv.slice(0, programLength(argv));
  const key = program.join('\0');
  if (!helpArity.has(key)) {
    helpArity.set(key, run(program[0], [...program.slice(1), '--help'], 10000)
      .then((help) => parseHelpArity(help) || FALLBACK_ARITY));
  }
  return helpArity.get(key);
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
  try { files = fs.readdirSync(sessionsDir()); } catch {}
  for (const f of files) {
    const m = f.match(/^(\d+)\.json$/);
    if (!m || !isAlive(Number(m[1]))) continue;
    const s = readSessionFile(Number(m[1]));
    if (s) ids.add(s.sessionId);
  }
  return ids;
}

// A snapshot entry counts as running if any live process is on that session,
// or if the same pid is alive and still on it (pids get reused after a reboot).
function stillRunning(entry, live) {
  if (live.has(entry.sessionId)) return true;
  if (!isAlive(entry.pid)) return false;
  const s = readSessionFile(entry.pid);
  return !!s && s.sessionId === entry.sessionId;
}

function transcriptExists(sessionId) {
  try {
    for (const dir of fs.readdirSync(projectsDir())) {
      if (fs.existsSync(path.join(projectsDir(), dir, `${sessionId}.jsonl`))) return true;
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
          flags: carriedFlags(argv, await arityFor(argv)),
        });
      }
    }
    const file = snapshotPath(key);
    const snapshot = { version: 1, takenAt: new Date().toISOString(), window: windowFolders(), sessions };
    fs.mkdirSync(stateDir, { recursive: true });
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

function pendingIn(snap, live) {
  return ((snap && snap.sessions) || []).filter((e) => !stillRunning(e, live) && transcriptExists(e.sessionId));
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
    if (!target) target = vscode.window.createTerminal({ name: displayName(e), cwd: e.cwd });
    used.add(target);
    const cmd = ['claude', '--resume', e.sessionId, ...e.flags].map(shellQuote).join(' ');
    target.sendText(`cd ${shellQuote(e.cwd)} && ${cmd}`, true);
    log(`resumed ${e.sessionId} (${displayName(e)}) in "${target.name}"`);
  }
  if (entries.length) vscode.window.terminals.find((t) => used.has(t))?.show(true);
}

async function maybeRestore(manual) {
  try {
    const key = windowKey();
    const entries = key ? pendingIn(readSnapshot(key), liveSessionIds()) : [];
    if (entries.length === 0) {
      if (manual) vscode.window.showInformationMessage('Claude Restore: nothing to resume, every snapshotted session is still running.');
      return;
    }
    const mode = config().get('mode');
    if (!manual && mode === 'off') return;
    if (!manual && mode === 'ask') {
      // Modal: a plain notification toast hides itself after a few seconds.
      const pick = await vscode.window.showInformationMessage(
        `Resume ${entries.length} Claude session(s) from before the restart?`,
        { modal: true, detail: entries.map(displayName).join(', ') },
        'Resume');
      if (pick !== 'Resume') return;
    }
    await resume(entries);
  } catch (e) {
    log(`restore failed: ${e.stack || e}`);
  } finally {
    restoreDone = true;
  }
}

// Windows whose snapshot still has sessions to resume; for after a reboot when
// VS Code didn't reopen every window by itself.
async function reopenWindows() {
  let files = [];
  try { files = fs.readdirSync(stateDir).filter((f) => f.endsWith('.json')); } catch {}
  const live = liveSessionIds();
  const items = [];
  for (const f of files) {
    let snap;
    try { snap = JSON.parse(fs.readFileSync(path.join(stateDir, f), 'utf8')); } catch { continue; }
    const pending = pendingIn(snap, live);
    const target = snap.window && snap.window.paths && snap.window.paths[0];
    if (!pending.length || !target || !fs.existsSync(target)) continue;
    items.push({ label: path.basename(target), description: `${pending.length} session(s)`, detail: target, picked: true, target });
  }
  if (!items.length) {
    vscode.window.showInformationMessage('Claude Restore: no other window has sessions waiting to be resumed.');
    return;
  }
  const picks = await vscode.window.showQuickPick(items, { canPickMany: true, title: 'Reopen windows with Claude sessions' });
  for (const p of picks || []) {
    await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(p.target), { forceNewWindow: true });
  }
}

// Plain shells come back through VS Code's own persistent terminals, which by
// default don't survive closing VS Code or a reboot. Offer to turn that on once.
async function offerEditorSettings(context) {
  if (context.globalState.get('settingsOffered')) return;
  const wanted = [
    ['terminal.integrated.enablePersistentSessions', true],
    ['terminal.integrated.persistentSessionReviveProcess', 'onExitAndWindowClose'],
    ['window.restoreWindows', 'all'],
  ];
  const missing = wanted.filter(([k, v]) => {
    const [section, ...rest] = k.split('.');
    return vscode.workspace.getConfiguration(section).get(rest.join('.')) !== v;
  });
  if (!missing.length) return;
  const pick = await vscode.window.showInformationMessage(
    'Claude Restore: also bring back your other terminals and windows after VS Code quits or the machine restarts?',
    'Turn on', 'No thanks');
  if (!pick) return; // dismissed: ask again next time
  context.globalState.update('settingsOffered', true);
  if (pick !== 'Turn on') return;
  for (const [k, v] of missing) {
    const [section, ...rest] = k.split('.');
    await vscode.workspace.getConfiguration(section).update(rest.join('.'), v, vscode.ConfigurationTarget.Global);
  }
}

function activate(context) {
  out = vscode.window.createOutputChannel('Claude Session Restore');
  context.subscriptions.push(out);
  if (process.platform === 'win32') {
    log('Windows is not supported (no ps). Use the extension from WSL or a Remote window instead.');
    return;
  }
  stateDir = path.join(context.globalStorageUri.fsPath, 'snapshots');

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
    vscode.commands.registerCommand('claudeRestore.reopenWindows', reopenWindows),
  );

  // Give revived terminals a few seconds to come back before deciding what's missing.
  setTimeout(() => maybeRestore(false), 8000);
  offerEditorSettings(context);

  const seconds = Math.max(15, config().get('intervalSeconds') || 60);
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
    { dispose: () => clearTimeout(debounce) },
  );
}

function deactivate() {}

module.exports = { activate, deactivate };
