// Structural checks on the agent definitions: frontmatter, line cap, and that every hook command points at a real kit script.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { splitlines, isFile } from '../kitlib.js';

const KIT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const AGENTS_DIR = path.join(KIT, 'agents');
const AGENTS = fs
  .readdirSync(AGENTS_DIR)
  .filter((f) => f.endsWith('.md'))
  .map((f) => path.join(AGENTS_DIR, f))
  .sort();
const stem = (p) => path.basename(p, '.md');
const read = (p) => fs.readFileSync(p, 'utf8');
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const EXPECTED = new Set(['researcher', 'planner', 'spec-critic', 'tester', 'implementer', 'reviewer', 'retro', 'debugger']);

function frontmatter(text) {
  const m = /^---\n([\s\S]*?)\n---\n/.exec(text);
  assert.ok(m, 'missing frontmatter');
  return m[1];
}

test('all core agents exist', () => {
  assert.deepEqual(new Set(AGENTS.map(stem)), EXPECTED);
});

test('frontmatter fields and line cap', () => {
  for (const p of AGENTS) {
    const text = read(p);
    const fm = frontmatter(text);
    assert.match(fm, new RegExp(`^name:\\s*${escapeRe(stem(p))}\\s*$`, 'm'), p);
    assert.match(fm, /^description:\s*\S/m, p);
    assert.match(fm, /^tools:\s*\S/m, p);
    assert.match(fm, /^model:\s*\S/m, p);
    assert.ok(splitlines(text).length <= 120, `${p} ${splitlines(text).length}`);
  }
});

test('hook commands reference existing scripts', () => {
  for (const p of AGENTS) {
    const fm = frontmatter(read(p));
    for (const m of fm.matchAll(/command:\s*node\s+"\$HOME\/\.claude\/kit\/scripts\/([a-z_]+\.js)"/g)) {
      assert.ok(isFile(path.join(KIT, 'scripts', m[1])), `${path.basename(p)} ${m[1]}`);
    }
    // every 'command:' line must match the pattern above (no stray shell)
    for (const line of splitlines(fm)) {
      if (line.trim().startsWith('command:')) {
        assert.ok(line.includes('$HOME/.claude/kit/scripts/'), `${path.basename(p)} ${line}`);
        assert.match(line, /command:\s*node\s+"\$HOME\/\.claude\/kit\/scripts\/[a-z_]+\.js"/, `${path.basename(p)} ${line}`);
      }
    }
  }
});

test('read only agents cannot edit source', () => {
  for (const name of ['researcher', 'planner', 'reviewer', 'retro', 'spec-critic']) {
    const fm = frontmatter(read(path.join(KIT, 'agents', `${name}.md`)));
    const tools = /^tools:\s*(.+)$/m.exec(fm)[1];
    assert.ok(!tools.includes('MultiEdit'), name);
    if (['researcher', 'planner', 'reviewer', 'retro'].includes(name)) {
      assert.ok(!tools.replaceAll('MultiEdit', '').includes('Edit'), name);
    }
  }
});

test('implementer has all guard hooks', () => {
  const fm = frontmatter(read(path.join(KIT, 'agents', 'implementer.md')));
  for (const script of [
    'hook_guard_edit.js', 'hook_guard_read.js', 'hook_guard_bash.js', 'hook_read_log.js',
    'hook_post_edit_check.js', 'hook_event_log.js', 'hook_budget_check.js', 'hook_done_check.js',
  ]) {
    assert.ok(fm.includes(script), script);
  }
});

test('writing agents validate on stop', () => {
  for (const name of ['researcher', 'planner', 'reviewer']) {
    const fm = frontmatter(read(path.join(KIT, 'agents', `${name}.md`)));
    assert.ok(fm.includes('SubagentStop') && fm.includes('validate_docs.js'), name);
  }
});

test('tester cannot write app code', () => {
  const fm = frontmatter(read(path.join(KIT, 'agents', 'tester.md')));
  assert.ok(fm.includes('hook_guard_tests_only.js') && fm.includes('hook_guard_edit.js') && fm.includes('hook_post_edit_check.js'));
});
