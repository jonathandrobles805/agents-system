// arch_live: facts about the architecture that depend on the machine, not only on the files in the kit:
// git state of the kit repository, the history of one component, and how one project's installation compares with the kit.
// Every value is read from git or from files; nothing is asked of an agent.
import fs from 'node:fs';
import path from 'node:path';
import * as K from './kitlib.js';
import { hookTarget, settingsHooks } from './arch_manifest.js';

const byText = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

function gitOut(args, cwd) {
  try {
    return K.git(args, cwd).replace(/\r?\n$/, '');
  } catch {
    return null;
  }
}

/** https URL of a GitHub remote without credentials, or null for anything else. */
export function githubUrl(remote) {
  if (typeof remote !== 'string') return null;
  const ssh = /^(?:ssh:\/\/)?git@github\.com[:/]([^/\s]+\/[^/\s]+?)(?:\.git)?\/?$/.exec(remote.trim());
  if (ssh) return `https://github.com/${ssh[1]}`;
  try {
    const u = new URL(remote.trim());
    if (u.protocol !== 'https:' || u.hostname !== 'github.com') return null;
    const m = /^\/([^/]+\/[^/]+?)(?:\.git)?\/?$/.exec(u.pathname);
    return m ? `https://github.com/${m[1]}` : null;
  } catch {
    return null;
  }
}

/**
 * Git facts about the repository that holds the kit: {repo_url, branch, commit, modified: [paths relative to the kit's parent]}.
 * `base` is the directory that contains kit/. Everything is null/empty when it is not a git checkout.
 */
export function gitInfo(base) {
  const top = gitOut(['rev-parse', '--show-toplevel'], base);
  if (top === null) return { repo_url: null, branch: null, commit: null, modified: [] };
  const prefix = path.relative(K.realResolve(top), K.realResolve(base)).split(path.sep).join('/');
  const status = gitOut(['status', '--porcelain=v1', '-uall', '--', '.'], base) ?? '';
  const modified = [];
  for (const line of status.split('\n')) {
    if (line.length < 4) continue;
    let p = line.slice(3);
    if (p.includes(' -> ')) p = p.slice(p.indexOf(' -> ') + 4);
    p = p.replace(/^"|"$/g, '');
    if (prefix) {
      if (!p.startsWith(`${prefix}/`)) continue;
      p = p.slice(prefix.length + 1);
    }
    modified.push(p);
  }
  return {
    repo_url: githubUrl(gitOut(['config', '--get', 'remote.origin.url'], base)),
    branch: gitOut(['rev-parse', '--abbrev-ref', 'HEAD'], base),
    commit: gitOut(['rev-parse', '--short', 'HEAD'], base),
    modified: modified.sort(byText),
  };
}

/** The last `limit` commits that touched `relPath`: [{sha, author, date, subject}]. `relPath` must come from the manifest. */
export function fileHistory(base, relPath, limit = 15) {
  const out = gitOut(['log', `-n${limit}`, '--format=%h%x09%an%x09%ad%x09%s', '--date=short', '--', relPath], base);
  if (!out) return [];
  return out.split('\n').map((line) => {
    const [sha, author, date, ...subject] = line.split('\t');
    return { sha, author, date, subject: subject.join('\t') };
  });
}

/**
 * How one project's installation compares with the kit's own settings fragment.
 * `manifest` is the kit's manifest; `repo` the project root. Missing, stale and extra hooks are listed by event, matcher and script.
 */
export function projectOverlay(manifest, kitDir, repo) {
  const settingsPath = path.join(repo, '.claude', 'settings.json');
  const kit = K.loadKitJson(repo);
  const expected = manifest.edges
    .filter((e) => e.from === 'settings:project' && e.kind === 'hook')
    .map((e) => ({ event: e.event, matcher: e.matcher ?? '', node: e.to }));
  const idOfFile = new Map(manifest.nodes.filter((n) => ['hook', 'ci', 'script'].includes(n.kind)).map((n) => [path.basename(n.path), n.id]));
  const out = {
    kit_version: { project: typeof kit.kit_version === 'string' ? kit.kit_version : null, kit: manifest.kit_version },
    settings: false,
    hooks: { expected: expected.length, installed: 0, missing: [], stale: [], extra: [] },
    installed_nodes: [],
  };
  const text = K.isFile(settingsPath) ? fs.readFileSync(settingsPath, 'utf8') : null;
  if (text === null) {
    out.hooks.missing = expected.map((e) => ({ event: e.event, matcher: e.matcher, node: e.node }));
    return out;
  }
  const entries = settingsHooks(text);
  if (entries === null) {
    out.settings = 'invalid';
    out.hooks.missing = expected.map((e) => ({ event: e.event, matcher: e.matcher, node: e.node }));
    return out;
  }
  out.settings = true;
  const key = (event, matcher, node) => `${event}|${matcher}|${node}`;
  const have = new Map();
  for (const h of entries) {
    const t = hookTarget(h.command);
    const node = t ? idOfFile.get(t.file) : undefined;
    if (node) have.set(key(h.event, h.matcher, node), { event: h.event, matcher: h.matcher, node });
  }
  const want = new Set(expected.map((e) => key(e.event, e.matcher, e.node)));
  out.hooks.missing = expected.filter((e) => !have.has(key(e.event, e.matcher, e.node))).map((e) => ({ event: e.event, matcher: e.matcher, node: e.node }));
  out.hooks.extra = [...have.entries()].filter(([k]) => !want.has(k)).map(([, v]) => v);
  out.hooks.installed = expected.length - out.hooks.missing.length;
  out.hooks.stale = K.staleHookScripts(JSON.parse(text), kitDir); // kit scripts the project's hooks name that the kit no longer has
  out.installed_nodes = [...new Set([...have.values()].map((v) => v.node))].sort(byText);
  return out;
}
