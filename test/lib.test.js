const test = require('node:test');
const assert = require('node:assert');
const { carriedFlags, parseHelpArity, displayName, shellQuote } = require('../lib');

test('keeps plain flags, drops the session pick', () => {
  assert.deepStrictEqual(
    carriedFlags(['claude', '--resume', 'abc', '--dangerously-skip-permissions']),
    ['--dangerously-skip-permissions']);
});

test('npm install: node and script path are not flags', () => {
  assert.deepStrictEqual(
    carriedFlags(['node', '/usr/local/bin/claude', '--model', 'opus']),
    ['--model', 'opus']);
});

test('initial prompt is not sent again', () => {
  assert.deepStrictEqual(carriedFlags(['claude', 'fix the bug', '--chrome']), ['--chrome']);
  assert.deepStrictEqual(carriedFlags(['claude', '--model', 'opus', 'fix']), ['--model', 'opus']);
});

test('bare --resume does not swallow the next flag', () => {
  assert.deepStrictEqual(carriedFlags(['claude', '-r', '--verbose']), ['--verbose']);
});

test('flags that would fork or move the session are dropped', () => {
  assert.deepStrictEqual(
    carriedFlags(['claude', '--fork-session', '-w', 'feat', '--bg', '-c', '--effort', 'high']),
    ['--effort', 'high']);
});

test('variadic and = forms', () => {
  assert.deepStrictEqual(
    carriedFlags(['claude', '--add-dir', 'a', 'b', '--session-id=x', '--model=opus']),
    ['--add-dir', 'a', 'b', '--model=opus']);
});

test('arity is read from --help', () => {
  const help = [
    'Options:',
    '  --add-dir <directories...>            More directories',
    '  --allowedTools, --allowed-tools <tools...>',
    '  -r, --resume [value]                  Resume',
    '  --new-flag <thing>                    Something new',
    '  --verbose                             Override',
    '                                        --resume <session-id>, continues that',
  ].join('\n');
  const a = parseHelpArity(help);
  assert.strictEqual(a['--add-dir'], 'many');
  assert.strictEqual(a['--allowed-tools'], 'many');
  assert.strictEqual(a['-r'], 'opt');
  assert.strictEqual(a['--new-flag'], 'one');
  assert.strictEqual(a['--verbose'], undefined);
  assert.deepStrictEqual(carriedFlags(['claude', '--new-flag', 'x', 'prompt'], a), ['--new-flag', 'x']);
});

test('display name strips status glyph and version titles', () => {
  assert.strictEqual(displayName({ terminalName: '✳ Fix login' }), 'Fix login');
  assert.strictEqual(displayName({ terminalName: '2.1.328', sessionName: 'api' }), 'api');
  assert.strictEqual(displayName({ terminalName: '' }), 'claude');
});

test('shell quoting', () => {
  assert.strictEqual(shellQuote('/a/b'), '/a/b');
  assert.strictEqual(shellQuote("it's here"), `'it'\\''s here'`);
});
