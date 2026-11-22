// Pure helpers, no `vscode` import, so they can be unit tested with `node --test`.

const path = require('path');

// Flags that pick or create a session, or start a different kind of run. A
// resumed session must not get them again: `--fork-session` would fork it on
// every restore, `-w` would make a new worktree, `-p` would not be interactive.
const DROPPED = new Set([
  '--resume', '-r', '--continue', '-c', '--session-id', '--fork-session',
  '--from-pr', '--teleport', '-w', '--worktree', '--tmux', '--bg', '--background',
  '--cloud', '--desktop', '-p', '--print', '-h', '--help', '-v', '--version',
]);

// Used when `claude --help` can't be run: how many values each flag takes.
// 'one' = <x>, 'many' = <x...>, 'opt' = [x]. Flags not listed take none.
const FALLBACK_ARITY = {
  '--add-dir': 'many', '--agent': 'one', '--agents': 'one', '--allowedTools': 'many',
  '--allowed-tools': 'many', '--append-system-prompt': 'one', '--autocompact': 'one',
  '--betas': 'many', '--cloud': 'opt', '-d': 'opt', '--debug': 'opt', '--debug-file': 'one',
  '--disallowedTools': 'many', '--disallowed-tools': 'many', '--effort': 'one',
  '--environment': 'one', '--fallback-model': 'one', '--file': 'many', '--from-pr': 'opt',
  '--input-format': 'one', '--json-schema': 'one', '--max-budget-usd': 'one',
  '--mcp-config': 'many', '--model': 'one', '-n': 'one', '--name': 'one',
  '--output-format': 'one', '--permission-mode': 'one', '--permission-prompts': 'one',
  '--plugin-dir': 'one', '--plugin-url': 'one', '--prompt-suggestions': 'opt',
  '--remote-control': 'opt', '--remote-control-session-name-prefix': 'one', '-r': 'opt',
  '--resume': 'opt', '--session-id': 'one', '--setting-sources': 'one', '--settings': 'one',
  '--system-prompt': 'one', '--system-prompt-snapshot': 'one', '--teleport': 'opt',
  '--tools': 'many', '-w': 'opt', '--worktree': 'opt',
};

// Reads flag arity from `claude --help` output, so new CLI flags are handled
// without a release of this extension.
function parseHelpArity(help) {
  const arity = {};
  for (const line of help.split('\n')) {
    const m = line.match(/^\s{1,4}(-[^\s<[,]+(?:,\s*-[^\s<[,]+)*)(?:\s+(<[^>]*>|\[[^\]]*\]))?/);
    if (!m) continue;
    const kind = !m[2] ? null : m[2].startsWith('[') ? 'opt' : m[2].includes('...') ? 'many' : 'one';
    for (const flag of m[1].split(',').map((s) => s.trim())) {
      if (kind) arity[flag] = kind;
    }
  }
  return Object.keys(arity).length ? arity : null;
}

// The program part of a `claude` command line: `claude ...`, or
// `node /path/to/claude ...` for an npm install.
function programLength(argv) {
  const base = path.basename(argv[0] || '');
  return /^(node|bun|deno)(\.exe)?$/.test(base) && argv.length > 1 ? 2 : 1;
}

// Flags to pass to `claude --resume <id>`, from the original command line.
// Positional arguments (an initial prompt) and session-picking flags are left out.
function carriedFlags(argv, arity = FALLBACK_ARITY) {
  const flags = [];
  let i = programLength(argv);
  while (i < argv.length) {
    const a = argv[i++];
    if (!a.startsWith('-') || a === '-' || a === '--') continue; // positional: initial prompt
    const name = a.includes('=') ? a.slice(0, a.indexOf('=')) : a;
    const kind = a.includes('=') ? null : arity[name];
    const values = [];
    if (kind === 'one' && i < argv.length) values.push(argv[i++]);
    if (kind === 'opt' && i < argv.length && !argv[i].startsWith('-')) values.push(argv[i++]);
    if (kind === 'many') while (i < argv.length && !argv[i].startsWith('-')) values.push(argv[i++]);
    if (!DROPPED.has(name)) flags.push(a, ...values);
  }
  return flags;
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

module.exports = { carriedFlags, parseHelpArity, programLength, displayName, shellQuote, FALLBACK_ARITY };
