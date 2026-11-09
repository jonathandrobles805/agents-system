#!/usr/bin/env node
// arch_manifest: describe the kit as a graph of components, derived only from files in the repository.
//
//   arch_manifest.js [--kit DIR] [--json] [--out FILE] [--check FILE]
//
// Observed side: every agent, command, hook, CI script, core script, test, template and CI job is a node; every place one
// of them names, imports, runs, spawns or tests another is an edge, with the file and line that says so. Nothing in the
// graph comes from an agent's summary and nothing from a file name alone.
// Declared side: kit/manifest.json says what each component is for. A component that exists but is not declared, or is
// declared but does not exist, is a violation, so the map cannot drift from the code unnoticed.
// The output is deterministic: the same files give the same manifest and the same digest.
//
//   --json         print the full manifest (with line numbers and derived impact) instead of the summary
//   --out FILE     write the committed snapshot (no line numbers, no counts) to FILE
//   --check FILE   exit 1 when FILE is not the snapshot of the current repository, or when a violation of severity "error" exists
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ArgumentParser } from './args.js';
import * as K from './kitlib.js';

export const SCHEMA = 1;
/** Kinds that kit/manifest.json must declare, one entry each. Other kinds are observed only. */
export const DECLARED_KINDS = ['command', 'agent', 'hook', 'ci', 'script', 'ci-job'];
export const DECLARED_FILE = 'manifest.json';
export const SNAPSHOT_FILE = 'architecture.json';
/** Edge kinds that mean "the source needs the target to work" (a test covering a script does not make the script used). */
const USE_KINDS = new Set(['hook', 'runs', 'imports', 'spawns', 'follows', 'uses', 'reads']);

const read = (p) => fs.readFileSync(p, 'utf8');
const splitLines = (text) => text.split(/\r?\n/);
const byText = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const rel = (base, p) => path.relative(base, p).split(path.sep).join('/');
const unquote = (s) => (/^(["']).*\1$/.test(s) ? s.slice(1, -1) : s);
function list(dir, keep) {
  try {
    return fs.readdirSync(dir).filter(keep).sort(byText);
  } catch {
    return [];
  }
}
const readIf = (p) => (K.isFile(p) ? read(p) : null);

// ---------------------------------------------------------------------------------------------- graph

class Graph {
  constructor() {
    this.nodes = new Map();
    this.edges = new Map();
    this.problems = [];
    this.fileToId = new Map(); // absolute path -> node id
    this.scriptByFile = new Map(); // "lane.js" -> node id (everything under kit/scripts, plus the dashboard server)
  }

  node(n) {
    this.nodes.set(n.id, { attrs: {}, stats: {}, ...n });
    if (n.abs) this.fileToId.set(n.abs, n.id);
    return n.id;
  }

  edge(from, to, kind, evidence, extra = {}) {
    if (from === to) return;
    const key = [from, to, kind, extra.event ?? '', extra.matcher ?? '', extra.step ?? ''].join('|');
    const seen = this.edges.get(key);
    if (seen) seen.count += 1;
    else this.edges.set(key, { from, to, kind, ...extra, evidence, count: 1 });
  }

  problem(id, severity, component, message, evidence = null) {
    this.problems.push({ id, severity, component, message, ...(evidence ? { evidence } : {}) });
  }
}

// ---------------------------------------------------------------------------------------------- parsing helpers

/** Front matter of a markdown file: top-level `key: value` lines, and where the header ends (`close` is the closing --- line index). */
export function frontmatter(lines) {
  if (lines[0] !== '---') return { fields: {}, close: -1 };
  const close = lines.indexOf('---', 1);
  if (close < 0) return { fields: {}, close: -1 };
  const fields = {};
  for (let i = 1; i < close; i++) {
    const m = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(lines[i]);
    if (m) fields[m[1]] = m[2].trim();
  }
  return { fields, close };
}

const csv = (s) => (s ? s.split(',').map((x) => x.trim()).filter(Boolean) : []);

/** Hook commands declared in an agent's front matter: [{event, matcher, command, timeout?, line}]. */
export function agentHooks(lines, close) {
  const out = [];
  let inHooks = false;
  let event = null;
  let matcher = '';
  for (let i = 1; i < close; i++) {
    const t = lines[i];
    if (/^hooks:\s*$/.test(t)) {
      inHooks = true;
      continue;
    }
    if (!inHooks) continue;
    if (/^\S/.test(t)) {
      inHooks = false;
      continue;
    }
    let m;
    if ((m = /^ {2}([A-Za-z]+):\s*$/.exec(t))) {
      event = m[1];
      matcher = '';
    } else if ((m = /^ {4}-\s+matcher:\s*(.*?)\s*$/.exec(t))) {
      matcher = unquote(m[1]);
    } else if (/^ {4}-\s+hooks:\s*$/.test(t)) {
      matcher = '';
    } else if ((m = /^\s+command:\s*(.*?)\s*$/.exec(t)) && event) {
      out.push({ event, matcher, command: unquote(m[1]), line: i + 1 });
    } else if ((m = /^\s+timeout:\s*(\d+)/.exec(t)) && out.length) {
      out[out.length - 1].timeout = Number(m[1]);
    }
  }
  return out;
}

/** Hook commands of a Claude Code settings document: [{event, matcher, command, timeout?, line}] in document order. */
export function settingsHooks(text) {
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    return null;
  }
  const lines = splitLines(text);
  const out = [];
  let from = 0; // each command is searched for from the line after the previous one: good enough for one command per line
  const hooks = data && typeof data === 'object' && data.hooks && typeof data.hooks === 'object' ? data.hooks : {};
  for (const [event, groups] of Object.entries(hooks)) {
    for (const group of Array.isArray(groups) ? groups : []) {
      for (const h of Array.isArray(group?.hooks) ? group.hooks : []) {
        if (typeof h?.command !== 'string') continue;
        const target = /scripts\/([A-Za-z0-9_]+\.js)/.exec(h.command);
        let line = 0;
        if (target) {
          const at = lines.findIndex((l, i) => i >= from && l.includes(`scripts/${target[1]}`));
          if (at >= 0) {
            line = at + 1;
            from = at + 1;
          }
        }
        out.push({ event, matcher: typeof group.matcher === 'string' ? group.matcher : '', command: h.command, ...(typeof h.timeout === 'number' ? { timeout: h.timeout } : {}), line });
      }
    }
  }
  return out;
}

/** The kit script file a hook command runs, and the arguments after it: {file: "x.js", args: "--hook"} or null. */
export function hookTarget(command) {
  const m = /scripts\/([A-Za-z0-9_]+\.js)["']?(.*)$/.exec(command);
  return m ? { file: m[1], args: m[2].trim() } : null;
}

/** Jobs of a GitHub Actions workflow, found by indentation only: [{key, name, line, end}] (lines are 0-based, end exclusive). */
export function workflowJobs(lines) {
  const start = lines.findIndex((l) => /^jobs:\s*$/.test(l));
  if (start < 0) return [];
  const jobs = [];
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^\S/.test(lines[i]) && !/^#/.test(lines[i])) {
      end = i;
      break;
    }
    const m = /^ {2}([A-Za-z0-9_-]+):\s*$/.exec(lines[i]);
    if (m) jobs.push({ key: m[1], name: null, line: i, end: lines.length });
  }
  jobs.forEach((j, n) => {
    j.end = n + 1 < jobs.length ? jobs[n + 1].line : end;
    for (let i = j.line + 1; i < j.end; i++) {
      const m = /^ {4}name:\s*(.+?)\s*$/.exec(lines[i]);
      if (m) {
        j.name = unquote(m[1]);
        break;
      }
    }
  });
  return jobs;
}

// ---------------------------------------------------------------------------------------------- scanning text for references

const SCRIPT_REF = /scripts\/([A-Za-z0-9_]+\.js)/g;
const DASHBOARD_REF = /dashboard\/server\.js/g;
const TOOL_REFS = [
  ['tool:planted-faults', /planted-faults\/run\.js/g, 'planted-faults/run.js'],
  ['tool:audit', /audit\/boards\.js/g, 'audit/boards.js'],
];
const TEMPLATE_REF = /templates\/([a-z0-9-]+)\.md/g;
const SETTINGS_REF = /hooks\/settings\.project\.json/g;
const SPAWN_REFS = [/[Ss]pawn(?:\s+(?:the|a|an|all))*\s+`([a-z][a-z-]*)`/g, /`([a-z][a-z-]*)`\s+agent\b/g];
const FOLLOW_REF = /`\/([a-z][a-z-]*)\b[^`]*`/g;

function* matches(re, line) {
  re.lastIndex = 0;
  let m;
  while ((m = re.exec(line)) !== null) yield m;
}

/**
 * Add the edges that the lines `from..to` of one markdown/yaml/shell source make, using the references above.
 * `kind` is the edge kind for scripts it runs; agents and commands also get spawn / follow / uses edges.
 */
function scanLines(g, ctx, id, filePath, lines, first, last, opts = {}) {
  const { kinds = {}, stepAt = () => undefined } = opts;
  const at = (i) => ({ file: filePath, line: i + 1 });
  for (let i = first; i < Math.min(last, lines.length); i++) {
    const line = lines[i];
    const step = stepAt(i);
    const extra = step ? { step } : {};
    for (const m of matches(SCRIPT_REF, line)) {
      const target = g.scriptByFile.get(m[1]);
      if (target) g.edge(id, target, 'runs', at(i), extra);
      else g.problem('dangling-reference', 'error', id, `${filePath}:${i + 1} runs scripts/${m[1]}, which does not exist`, at(i));
    }
    for (const m of matches(DASHBOARD_REF, line)) {
      if (g.nodes.has('script:dashboard/server')) g.edge(id, 'script:dashboard/server', 'runs', at(i), extra);
      else g.problem('dangling-reference', 'error', id, `${filePath}:${i + 1} runs dashboard/server.js, which does not exist`, at(i));
    }
    for (const [toolId, re, name] of TOOL_REFS) {
      for (const m of matches(re, line)) {
        void m;
        if (g.nodes.has(toolId)) g.edge(id, toolId, 'runs', at(i), extra);
        else g.problem('dangling-reference', 'error', id, `${filePath}:${i + 1} runs ${name}, which does not exist`, at(i));
      }
    }
    for (const m of matches(SETTINGS_REF, line)) {
      void m;
      if (g.nodes.has('settings:project')) g.edge(id, 'settings:project', 'reads', at(i), extra);
    }
    for (const m of matches(TEMPLATE_REF, line)) {
      if (g.nodes.has(`template:${m[1]}`)) g.edge(id, `template:${m[1]}`, 'uses', at(i));
      else g.problem('dangling-reference', 'error', id, `${filePath}:${i + 1} uses templates/${m[1]}.md, which does not exist`, at(i));
    }
    if (kinds.spawns) {
      for (const re of SPAWN_REFS) {
        for (const m of matches(re, line)) if (ctx.agents.has(m[1])) g.edge(id, `agent:${m[1]}`, 'spawns', at(i));
      }
    }
    if (kinds.follows) {
      for (const m of matches(FOLLOW_REF, line)) if (ctx.commands.has(m[1])) g.edge(id, `command:${m[1]}`, 'follows', at(i));
    }
    if (kinds.npm) {
      for (const m of matches(/\bnpm\s+(?:run\s+)?([A-Za-z0-9:_-]+)/g, line)) {
        const cmd = ctx.npmScripts[m[1]];
        if (typeof cmd !== 'string') continue;
        for (const tid of ctx.tests) g.edge(id, tid, 'runs', { ...at(i), via: `package.json scripts.${m[1]}` }, extra);
        for (const [toolId, re] of TOOL_REFS) {
          re.lastIndex = 0;
          if (re.test(cmd) && g.nodes.has(toolId)) g.edge(id, toolId, 'runs', { ...at(i), via: `package.json scripts.${m[1]}` }, extra);
        }
      }
    }
  }
}

/** Relative imports of a JS source: [{spec, line}] for `from './x.js'`, `import('./x.js')` and `import './x.js'`. */
export function jsImports(lines) {
  const out = [];
  const res = [/\bfrom\s*['"](\.[^'"]+)['"]/g, /\bimport\(\s*['"](\.[^'"]+)['"]/g, /^\s*import\s+['"](\.[^'"]+)['"]/g];
  lines.forEach((line, i) => {
    if (/^\s*(\/\/|\/\*|\*)/.test(line)) return; // comments describe imports, they do not make them
    for (const re of res) for (const m of matches(re, line)) out.push({ spec: m[1], line: i + 1 });
  });
  return out;
}

// ---------------------------------------------------------------------------------------------- building the graph

const TEST_CASE = /^\s*(?:test|it)(?:\.(?:skip|only|todo))?\(/gm;

function labelFor(kind, file) {
  const stem = file.replace(/\.js$/, '');
  if (kind === 'hook') return stem.replace(/^hook_/, '').replaceAll('_', '-');
  if (kind === 'ci') return stem.replace(/^ci_/, '').replaceAll('_', '-');
  return file;
}

function addScripts(g, base, kitDir) {
  const dir = path.join(kitDir, 'scripts');
  for (const file of list(dir, (n) => n.endsWith('.js'))) {
    // ci_common.js is the library the CI checks share, not a check itself
    const kind = file.startsWith('hook_') ? 'hook' : file.startsWith('ci_') && file !== 'ci_common.js' ? 'ci' : 'script';
    const stem = file.replace(/\.js$/, '');
    const abs = path.join(dir, file);
    const id = g.node({
      id: `${kind}:${kind === 'hook' ? stem.replace(/^hook_/, '') : kind === 'ci' ? stem.replace(/^ci_/, '') : stem}`,
      kind, label: labelFor(kind, file), path: rel(base, abs), abs, stats: { lines: splitLines(read(abs)).length },
    });
    g.scriptByFile.set(file, id);
  }
  const server = path.join(kitDir, 'dashboard', 'server.js');
  if (K.isFile(server)) {
    const id = g.node({ id: 'script:dashboard/server', kind: 'script', label: 'dashboard/server.js', path: rel(base, server), abs: server, stats: { lines: splitLines(read(server)).length } });
    g.scriptByFile.set('server.js', id);
  }
}

function addTests(g, base, kitDir) {
  const dir = path.join(kitDir, 'scripts', 'tests');
  for (const file of list(dir, (n) => n.endsWith('.test.js'))) {
    const abs = path.join(dir, file);
    const text = read(abs);
    g.node({ id: `test:${file.replace(/\.test\.js$/, '')}`, kind: 'test', label: file, path: rel(base, abs), abs, stats: { lines: splitLines(text).length, cases: (text.match(TEST_CASE) ?? []).length } });
  }
}

function addMarkdown(g, base, dir, kind, ctx) {
  const set = kind === 'agent' ? ctx.agents : ctx.commands;
  for (const file of list(dir, (n) => n.endsWith('.md'))) {
    const abs = path.join(dir, file);
    const name = file.replace(/\.md$/, '');
    const lines = splitLines(read(abs));
    const fm = frontmatter(lines);
    const attrs = { description: fm.fields.description ?? '' };
    if (kind === 'agent') {
      Object.assign(attrs, { tools: csv(fm.fields.tools), model: fm.fields.model ?? '' });
      if (fm.fields.name && fm.fields.name !== name) g.problem('agent-name-mismatch', 'error', `agent:${name}`, `${rel(base, abs)} declares name "${fm.fields.name}" but the file is ${file}`);
    } else {
      Object.assign(attrs, { argument_hint: fm.fields['argument-hint'] ?? '', allowed_tools: csv(fm.fields['allowed-tools']) });
    }
    g.node({ id: `${kind}:${name}`, kind, label: name, path: rel(base, abs), abs, attrs, stats: { lines: lines.length }, lines, close: fm.close });
    set.add(name);
  }
}

function addTemplates(g, base, kitDir) {
  const dir = path.join(kitDir, 'templates');
  for (const file of list(dir, (n) => n.endsWith('.md'))) {
    const abs = path.join(dir, file);
    g.node({ id: `template:${file.replace(/\.md$/, '')}`, kind: 'template', label: file, path: rel(base, abs), abs });
  }
}

function addExtras(g, base, kitDir) {
  const settings = path.join(kitDir, 'hooks', 'settings.project.json');
  if (K.isFile(settings)) {
    let deny = 0;
    try {
      deny = (JSON.parse(read(settings)).permissions?.deny ?? []).length;
    } catch {
      // reported as a problem when the hooks are read
    }
    g.node({ id: 'settings:project', kind: 'settings', label: 'settings.project.json', path: rel(base, settings), abs: settings, attrs: { deny_rules: deny } });
  }
  for (const [id, file] of [['tool:planted-faults', 'planted-faults/run.js'], ['tool:audit', 'audit/boards.js']]) {
    const abs = path.join(base, file);
    if (K.isFile(abs)) g.node({ id, kind: 'tool', label: file, path: file, abs, stats: { lines: splitLines(read(abs)).length } });
  }
  for (const file of ['install.sh', 'release.sh']) {
    const abs = path.join(base, file);
    if (K.isFile(abs)) g.node({ id: `shell:${file}`, kind: 'shell', label: file, path: file, abs });
  }
}

function addWorkflows(g, base, kitDir) {
  const sources = [
    ['template', path.join(kitDir, 'ci', 'github.yml'), 'the project CI that /bootstrap installs (kit/ci/github.yml)'],
    ['kit', path.join(base, '.github', 'workflows', 'kit.yml'), "this repository's own CI (.github/workflows/kit.yml)"],
  ];
  const out = [];
  for (const [tag, abs, what] of sources) {
    if (!K.isFile(abs)) continue;
    const lines = splitLines(read(abs));
    for (const job of workflowJobs(lines)) {
      const id = `ci-job:${tag}/${job.key}`;
      const steps = lines.slice(job.line, job.end).filter((l) => /^\s+-\s+name:/.test(l)).length;
      g.node({ id, kind: 'ci-job', label: job.key, path: rel(base, abs), abs, attrs: { pipeline: what, display_name: job.name ?? job.key, steps }, stats: { lines: job.end - job.line } });
      out.push({ id, abs, lines, job });
    }
  }
  return out;
}

/**
 * Stages in the table of the /run command, in order: [{id, line, agents, commands, pause}].
 * `agents` are the agents the row names plus those spawned by the commands it tells /run to follow (`spawnsOf(command)`).
 */
export function runStages(lines, agentNames, commandNames, spawnsOf = () => []) {
  const head = lines.findIndex((l) => /^\|\s*stage\s*\|/.test(l));
  if (head < 0) return [];
  const out = [];
  for (let i = head + 2; i < lines.length && lines[i].startsWith('|'); i++) {
    const m = /^\|\s*`([a-z-]+)`\s*\|(.*)$/.exec(lines[i]);
    if (!m) continue;
    const text = m[2];
    const named = [...agentNames].filter((a) => new RegExp(`(^|[^A-Za-z-])${a}([^A-Za-z-]|$)`).test(text));
    const commands = [...new Set([...matches(FOLLOW_REF, text)].map((x) => x[1]).filter((c) => commandNames.has(c)))].sort(byText);
    const agents = [...new Set([...named, ...commands.flatMap((c) => spawnsOf(c))])].sort(byText);
    const pause = /\*\*Pause (\d)/.exec(text);
    out.push({ id: m[1], line: i + 1, agents, commands, pause: pause ? Number(pause[1]) : null });
  }
  return out;
}

/** Stage names `lane.js next-step` can answer, read from the source of nextStep(). */
export function laneStages(laneText) {
  const at = laneText.indexOf('export async function nextStep');
  if (at < 0) return null;
  const end = laneText.indexOf('\n}\n', at);
  const body = laneText.slice(at, end < 0 ? undefined : end);
  const stages = new Set();
  for (const m of matches(/stage:\s*([^,}]+)/g, body)) for (const q of matches(/'([a-z-]+)'/g, m[1])) stages.add(q[1]);
  return [...stages].sort(byText);
}

function loadDeclared(kitDir) {
  const text = readIf(path.join(kitDir, DECLARED_FILE));
  if (text === null) return { exists: false, components: {} };
  try {
    const data = JSON.parse(text);
    return { exists: true, components: data && typeof data.components === 'object' && data.components ? data.components : {} };
  } catch (e) {
    return { exists: true, components: {}, error: String(e.message ?? e) };
  }
}

/** Reverse closure over edges: every node that needs `id`, directly or through others. */
function dependentsOf(id, incoming) {
  const seen = new Set();
  const todo = [id];
  while (todo.length) {
    for (const from of incoming.get(todo.pop()) ?? []) {
      if (!seen.has(from) && from !== id) {
        seen.add(from);
        todo.push(from);
      }
    }
  }
  return [...seen].sort(byText);
}

/**
 * Build the manifest of the kit in `kitDir` (the kit/ directory of a repository, or ~/.claude/kit).
 * Pure function of the files: no clock, no git, no absolute paths in the result.
 */
export function buildManifest(kitDirIn) {
  const kitDir = K.realResolve(kitDirIn);
  const base = path.dirname(kitDir);
  const g = new Graph();
  const ctx = { agents: new Set(), commands: new Set(), tests: [], npmScripts: {} };

  addScripts(g, base, kitDir);
  addTests(g, base, kitDir);
  addMarkdown(g, base, path.join(kitDir, 'agents'), 'agent', ctx);
  addMarkdown(g, base, path.join(kitDir, 'commands'), 'command', ctx);
  addTemplates(g, base, kitDir);
  addExtras(g, base, kitDir);
  const jobs = addWorkflows(g, base, kitDir);
  ctx.tests = [...g.nodes.values()].filter((n) => n.kind === 'test').map((n) => n.id).sort(byText);
  try {
    ctx.npmScripts = JSON.parse(readIf(path.join(base, 'package.json')) ?? '{}').scripts ?? {};
  } catch {
    ctx.npmScripts = {};
  }

  // hooks: agent front matter and the project settings fragment
  const hookEdge = (from, filePath, h) => {
    const t = hookTarget(h.command);
    const evidence = { file: filePath, line: h.line };
    const extra = { event: h.event, ...(h.matcher ? { matcher: h.matcher } : {}), ...(h.timeout ? { timeout: h.timeout } : {}), ...(t && t.args ? { args: t.args } : {}) };
    if (!t) return g.problem('dangling-reference', 'error', from, `${filePath}:${h.line} hook command does not run a kit script: ${h.command}`, evidence);
    const target = g.scriptByFile.get(t.file);
    if (!target) return g.problem('dangling-reference', 'error', from, `${filePath}:${h.line} hook runs scripts/${t.file}, which does not exist`, evidence);
    g.edge(from, target, 'hook', evidence, extra);
  };
  for (const n of [...g.nodes.values()].filter((x) => x.kind === 'agent')) {
    for (const h of agentHooks(n.lines, n.close)) hookEdge(n.id, n.path, h);
  }
  const settings = g.nodes.get('settings:project');
  if (settings) {
    const hooks = settingsHooks(read(settings.abs));
    if (hooks === null) g.problem('invalid-settings', 'error', settings.id, `${settings.path} is not valid JSON`);
    else for (const h of hooks) hookEdge(settings.id, settings.path, h);
  }

  // agents and commands: scripts they run, agents they spawn, commands they follow, templates they use
  for (const n of [...g.nodes.values()].filter((x) => x.kind === 'agent' || x.kind === 'command')) {
    scanLines(g, ctx, n.id, n.path, n.lines, n.close + 1, n.lines.length, { kinds: { spawns: true, follows: n.kind === 'command' } });
  }

  // CI jobs and shell scripts
  for (const { id, abs, lines, job } of jobs) {
    const stepAt = (i) => {
      for (let j = i; j >= job.line; j--) {
        const m = /^\s+-\s+name:\s*(.+?)\s*$/.exec(lines[j]);
        if (m) return unquote(m[1]);
      }
      return undefined;
    };
    scanLines(g, ctx, id, rel(base, abs), lines, job.line, job.end, { kinds: { npm: true }, stepAt });
  }
  for (const n of [...g.nodes.values()].filter((x) => x.kind === 'shell')) {
    scanLines(g, ctx, n.id, n.path, splitLines(read(n.abs)), 0, Infinity, { kinds: { npm: true } });
  }

  // JS sources: imports (and, for tests and tools, scripts named by a string)
  const jsSources = [...g.nodes.values()].filter((x) => ['script', 'hook', 'ci', 'test', 'tool'].includes(x.kind));
  for (const n of jsSources) {
    const lines = splitLines(read(n.abs));
    const kind = n.kind === 'test' ? 'tests' : 'imports';
    for (const { spec, line } of jsImports(lines)) {
      const target = path.resolve(path.dirname(n.abs), spec);
      const to = g.fileToId.get(target);
      if (to) g.edge(n.id, to, kind, { file: n.path, line });
      else if (['script', 'hook', 'ci'].includes(n.kind) && spec.endsWith('.js') && !K.isFile(target)) g.problem('dangling-import', 'error', n.id, `${n.path}:${line} imports ${spec}, which does not exist`, { file: n.path, line });
    }
    if (n.kind === 'test' || n.kind === 'tool') {
      lines.forEach((text, i) => {
        for (const m of matches(/['"`]([A-Za-z0-9_]+\.js)['"`]/g, text)) {
          const to = g.scriptByFile.get(m[1]);
          if (to) g.edge(n.id, to, n.kind === 'test' ? 'tests' : 'runs', { file: n.path, line: i + 1 });
        }
      });
    }
  }

  // decision 0005: an agent carries its own guards, so it is guarded in a repository that was never bootstrapped
  const GUARDS = [['Bash', 'hook:guard_bash'], ['Read', 'hook:guard_read']];
  for (const a of [...g.nodes.values()].filter((x) => x.kind === 'agent')) {
    for (const [tool, guard] of GUARDS) {
      const guarded = [...g.edges.values()].some((e) => e.from === a.id && e.to === guard && e.kind === 'hook' && e.event === 'PreToolUse' && (e.matcher ?? '').split('|').includes(tool));
      if (a.attrs.tools.includes(tool) && !guarded) {
        g.problem('unguarded-tool', 'error', a.id, `${a.path} has the ${tool} tool but no PreToolUse ${tool} hook running ${guard.slice(5)} (decision 0005)`);
      }
    }
  }

  // pipeline: the stages of /run, checked against the stages lane.js can answer
  const run = g.nodes.get('command:run');
  const spawnsOf = (command) => [...g.edges.values()].filter((e) => e.from === `command:${command}` && e.kind === 'spawns').map((e) => e.to.slice('agent:'.length));
  const pipeline = run ? runStages(run.lines, ctx.agents, ctx.commands, spawnsOf) : [];
  const lane = g.nodes.get('script:lane');
  const fromLane = lane ? laneStages(read(lane.abs)) : null;
  if (run && fromLane) {
    const documented = pipeline.map((s) => s.id).sort(byText);
    const missingInRun = fromLane.filter((s) => !documented.includes(s));
    const missingInLane = documented.filter((s) => !fromLane.includes(s));
    if (missingInRun.length || missingInLane.length) {
      g.problem('stage-mismatch', 'error', 'command:run', `stages of lane.js next-step and of the /run table differ: only in lane.js [${missingInRun.join(', ')}], only in /run [${missingInLane.join(', ')}]`);
    }
  }

  // events seen by each hook script, from the hook edges
  for (const e of g.edges.values()) {
    if (e.kind !== 'hook') continue;
    const target = g.nodes.get(e.to);
    target.attrs.events = [...new Set([...(target.attrs.events ?? []), e.event])].sort(byText);
  }

  // declared side
  const declared = loadDeclared(kitDir);
  if (declared.error) g.problem('invalid-declaration', 'error', null, `${DECLARED_FILE} is not valid JSON: ${declared.error}`);
  for (const n of g.nodes.values()) {
    if (!DECLARED_KINDS.includes(n.kind)) continue;
    const d = declared.components[n.id];
    n.declared = d !== undefined;
    if (d && typeof d.purpose === 'string') n.purpose = d.purpose;
    if (d && typeof d.writes === 'string') n.writes = d.writes;
    if (!n.declared) g.problem('undeclared', 'error', n.id, `${n.path} exists but ${DECLARED_FILE} does not declare ${n.id}`);
  }
  for (const id of Object.keys(declared.components).sort(byText)) {
    if (!g.nodes.has(id)) g.problem('declared-missing', 'error', id, `${DECLARED_FILE} declares ${id}, but no such component exists`);
  }

  // incoming edges, usage and coverage warnings
  const incoming = new Map();
  const used = new Set();
  const testedBy = new Map();
  for (const e of g.edges.values()) {
    if (!incoming.has(e.to)) incoming.set(e.to, []);
    incoming.get(e.to).push(e.from);
    if (USE_KINDS.has(e.kind)) used.add(e.to);
    if (e.kind === 'tests') testedBy.set(e.to, [...(testedBy.get(e.to) ?? []), e.from]);
  }
  for (const n of g.nodes.values()) {
    if (!['hook', 'ci', 'script'].includes(n.kind)) continue;
    if (!used.has(n.id)) g.problem('unreferenced', 'warn', n.id, `nothing runs, imports or registers ${n.path}`);
    if (!testedBy.has(n.id)) g.problem('untested', 'warn', n.id, `no test file imports or names ${n.path}`);
  }

  // derived impact: what a change to each component reaches
  const nodes = [...g.nodes.values()].sort((a, b) => byText(a.id, b.id));
  for (const n of nodes) {
    const dependents = dependentsOf(n.id, incoming);
    const testIds = dependents.filter((d) => g.nodes.get(d).kind === 'test');
    n.derived = {
      dependents,
      tests: testIds,
      jobs: dependents.filter((d) => g.nodes.get(d).kind === 'ci-job'),
      direct_tests: (testedBy.get(n.id) ?? []).sort(byText),
      cases: testIds.reduce((sum, t) => sum + (g.nodes.get(t).stats.cases ?? 0), 0),
    };
  }

  const edges = [...g.edges.values()].sort((a, b) => byText(`${a.from}|${a.to}|${a.kind}|${a.event ?? ''}|${a.matcher ?? ''}|${a.step ?? ''}`, `${b.from}|${b.to}|${b.kind}|${b.event ?? ''}|${b.matcher ?? ''}|${b.step ?? ''}`));
  const problems = g.problems.sort((a, b) => byText(`${a.severity}|${a.id}|${a.component ?? ''}|${a.message}`, `${b.severity}|${b.id}|${b.component ?? ''}|${b.message}`));
  const clean = nodes.map(({ abs, lines, close, ...n }) => n);
  const manifest = {
    schema: SCHEMA,
    kit_version: (readIf(path.join(base, 'VERSION')) ?? '').trim() || null,
    declared_file: declared.exists,
    nodes: clean,
    edges,
    pipeline,
    problems,
  };
  manifest.digest = digestOf(manifest);
  return manifest;
}

// ---------------------------------------------------------------------------------------------- snapshot

/** The committed form: no line numbers, no counts, no derived data. A PR that changes it changed the architecture. */
export function snapshotOf(m) {
  return {
    schema: m.schema,
    kit_version: m.kit_version,
    nodes: m.nodes.map(({ id, kind, label, path: p, declared, purpose, writes, attrs }) => ({ id, kind, label, path: p, ...(declared === undefined ? {} : { declared }), ...(purpose ? { purpose } : {}), ...(writes ? { writes } : {}), attrs })),
    edges: m.edges.map(({ from, to, kind, event, matcher, step, args, timeout, via, evidence }) => ({ from, to, kind, ...(event ? { event } : {}), ...(matcher ? { matcher } : {}), ...(step ? { step } : {}), ...(args ? { args } : {}), ...(timeout ? { timeout } : {}), ...(via ? { via } : {}), file: evidence.file })),
    pipeline: m.pipeline.map(({ id, agents, commands, pause }) => ({ id, agents, commands, pause })),
    problems: m.problems.map(({ id, severity, component, message }) => ({ id, severity, component, message })),
  };
}

export const snapshotText = (m) => `${K.jsonDumps(snapshotOf(m), { indent: 2, ensureAscii: false, sortKeys: true })}\n`;

function digestOf(m) {
  return crypto.createHash('sha256').update(K.jsonDumps(snapshotOf(m), { sortKeys: true })).digest('hex').slice(0, 16);
}

/** Human summary of how two snapshots differ: what was added and removed. */
export function diffSnapshots(oldSnap, newSnap) {
  const out = [];
  const keyN = (n) => n.id;
  const keyE = (e) => `${e.from} -[${e.kind}${e.event ? ' ' + e.event : ''}${e.matcher ? ' ' + e.matcher : ''}]-> ${e.to}`;
  const keyP = (p) => `${p.severity} ${p.id} ${p.component ?? ''}`;
  for (const [label, a, b, key] of [['component', oldSnap.nodes, newSnap.nodes, keyN], ['edge', oldSnap.edges, newSnap.edges, keyE], ['violation', oldSnap.problems, newSnap.problems, keyP]]) {
    const before = new Set((a ?? []).map(key));
    const after = new Set((b ?? []).map(key));
    for (const k of [...after].sort(byText)) if (!before.has(k)) out.push(`+ ${label} ${k}`);
    for (const k of [...before].sort(byText)) if (!after.has(k)) out.push(`- ${label} ${k}`);
  }
  if (!out.length && K.jsonDumps(oldSnap, { sortKeys: true }) !== K.jsonDumps(newSnap, { sortKeys: true })) out.push('~ details changed (attributes, purposes, or order)');
  return out;
}

// ---------------------------------------------------------------------------------------------- CLI

function summary(m) {
  const count = (kind) => m.nodes.filter((n) => n.kind === kind).length;
  const errors = m.problems.filter((p) => p.severity === 'error');
  const warns = m.problems.filter((p) => p.severity === 'warn');
  const out = [
    `kit ${m.kit_version ?? '?'} · digest ${m.digest}`,
    `components: ${m.nodes.length} (${DECLARED_KINDS.map((k) => `${count(k)} ${k}`).join(', ')}), ${count('test')} test files, ${m.edges.length} edges`,
    `violations: ${errors.length} error, ${warns.length} warning`,
  ];
  for (const p of [...errors, ...warns]) out.push(`  ${p.severity === 'error' ? 'ERROR' : 'warn '} ${p.id}: ${p.message}`);
  return out.join('\n');
}

export function main(argv = process.argv.slice(2)) {
  const ap = new ArgumentParser({ prog: 'arch_manifest.js', description: 'Describe the kit as a graph of components, derived from the repository.' });
  ap.addArgument('--kit', { help: 'kit directory (default: the kit this script belongs to)' });
  ap.addArgument('--json', { action: 'store_true' });
  ap.addArgument('--out', { help: 'write the committed snapshot here' });
  ap.addArgument('--check', { help: 'fail when this snapshot is stale' });
  const a = ap.parseArgs(argv);
  const kitDir = a.kit ?? path.resolve(path.dirname(K.realResolve(fileURLToPath(import.meta.url))), '..');
  if (!K.isDir(kitDir)) {
    process.stderr.write(`arch_manifest: ${kitDir} is not a directory\n`);
    return 2;
  }
  const m = buildManifest(kitDir);
  if (a.out) fs.writeFileSync(a.out, snapshotText(m));
  if (a.json) process.stdout.write(`${K.jsonDumps(m, { indent: 2, ensureAscii: false })}\n`);
  else process.stdout.write(`${summary(m)}\n`);
  let code = m.problems.some((p) => p.severity === 'error') ? 1 : 0;
  if (a.check) {
    const current = snapshotText(m);
    const committed = readIf(a.check);
    if (committed === null) {
      process.stderr.write(`arch_manifest: ${a.check} does not exist; create it with: node kit/scripts/arch_manifest.js --out ${a.check}\n`);
      code = 1;
    } else if (committed !== current) {
      let changes;
      try {
        changes = diffSnapshots(JSON.parse(committed), snapshotOf(m));
      } catch {
        changes = ['~ the committed file is not valid JSON'];
      }
      process.stderr.write(`arch_manifest: ${a.check} is stale. The architecture changed:\n${changes.map((c) => `  ${c}`).join('\n')}\nReview the change, then run: node kit/scripts/arch_manifest.js --out ${a.check}\n`);
      code = 1;
    }
  }
  return code;
}

if (K.isMain(import.meta.url)) process.exitCode = main();
