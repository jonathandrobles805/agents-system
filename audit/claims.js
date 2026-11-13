#!/usr/bin/env node
/**
 * Claim grader: KIT-SPEC's normative sentences, each checked against this repository by a resolver.
 *
 * WHY THIS IS NOT A CHECKLIST
 * Nothing here knows which claims are wrong. The grader extracts every normative sentence from the spec text it is
 * given, then offers each sentence to resolvers that understand one KIND of claim (a permission rule, a tool's
 * flags, what a tool acts on, an option a claim depends on without naming it). A resolver fires on shape, so a claim
 * nobody has looked at yet is graded the same as one that has. The acceptance test for that is in bypass.test.js:
 * the grader is pointed at `git show <commit>:docs/KIT-SPEC.md` for three spec versions whose claims were later
 * found overstated, and must flag them without being told what to look for.
 *
 * Verdicts (assigned by a resolver, never by hand):
 *   FALSIFIED   the code contradicts the claim; evidence names what is missing or what omits it
 *   UNSUPPORTED a resolver applies and found no evidence either way
 *   SUPPORTED   a resolver applies and the code backs the claim
 *   UNGRADED    no resolver understands this claim's shape; it rests on review alone
 *
 * Usage: node audit/claims.js [--spec PATH] [--at COMMIT] [--json] [--quiet]
 * Exit 1 when anything is FALSIFIED, else 0. UNGRADED is reported, not failed: the spec is mostly prose, and
 * failing on prose would mean deleting prose to go green.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ArgumentParser } from '../kit/scripts/args.js';
import * as K from '../kit/scripts/kitlib.js';

const ROOT = path.dirname(path.dirname(K.realResolve(fileURLToPath(import.meta.url))));
const KIT = path.join(ROOT, 'kit');
const SPEC_REL = 'docs/KIT-SPEC.md';

const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
const readIf = (p) => (K.isFile(p) ? fs.readFileSync(p, 'utf8') : '');

// --- the spec text -------------------------------------------------------------------------------------------

/** The spec as of a commit, or from the working tree. Lets the grader be aimed at history it has never seen. */
export function specText({ spec = path.join(ROOT, SPEC_REL), at = null } = {}) {
  if (!at) return fs.readFileSync(spec, 'utf8');
  const rel = path.relative(ROOT, spec).split(path.sep).join('/');
  const r = spawnSync('git', ['show', `${at}:${rel}`], { cwd: ROOT, encoding: 'utf8', maxBuffer: 1 << 28 });
  if (r.status !== 0) throw new Error(`cannot read ${rel} at ${at}: ${(r.stderr ?? '').trim()}`);
  return r.stdout;
}

// A sentence is normative when it says what the system DOES or MUST do, rather than describing or suggesting.
// Hedges are excluded on purpose: a sentence that hedges is not making a claim to grade.
const NORMATIVE = /\b(must|never|always|every|only|cannot|can't|refuses?|refused|denies|denied|blocks?|blocked|requires?|required|enforces?|enforced|reverts?|guarantees?|is not allowed|are not allowed|fails|runs|re-runs|stamps|writes|resolves)\b/i;
// A counterfactual ("an unconditional X would stop a lane") discusses a rule without asserting it, so it is not a
// claim to grade. Dropping these is what keeps the grader from flagging the sentence that explains a design.
const HEDGE = /\b(should|probably|likely|may|might|could|would|typically|usually|by design|intended|instead of|rather than)\b/i;

/** Normative sentences, each with the section heading it sits under. Pure. */
export function claims(text) {
  const out = [];
  let section = '(preamble)';
  let heading = '';
  const lines = K.splitlines(text);
  lines.forEach((line, i) => {
    const h = /^(#{2,4})\s+(.+?)\s*$/.exec(line);
    if (h) {
      heading = h[2];
      section = h[2].replace(/`/g, '');
      return;
    }
    if (!line.trim() || /^[|>]/.test(line) || /^\s*```/.test(line)) return;
    const raw = line.replace(/^\s*[-*]\s+/, '').trim();
    // A bullet whose label is a config key ("`deny`: `Read(.env)`, ...") asserts its contents with no verb, and it
    // has to be kept whole: splitting on the colon put the label in one fragment and the rules in another, which is
    // exactly how the pre-fix 10.1 deny list went ungraded. The label is the assertion.
    const label = /^`?(deny|allow|ask)`?:/.exec(raw);
    if (label) {
      out.push({ section, heading, line: i + 1, text: raw, kind: label[1] });
      return;
    }
    // otherwise split on sentence ends
    for (const s of raw.split(/(?<=[.:])\s+(?=[A-Z`/*-])/)) {
      const t = s.trim();
      if (t.length < 20 || !NORMATIVE.test(t) || HEDGE.test(t)) continue;
      out.push({ section, heading, line: i + 1, text: t });
    }
  });
  return out;
}

// --- what the repository actually contains -------------------------------------------------------------------

/** Every deny/allow rule the kit ships, from the floor and the generated settings fragment. */
export function shippedRules() {
  const floor = readJson(path.join(KIT, 'security', 'floor.json'));
  const frag = readJson(path.join(KIT, 'hooks', 'settings.project.json'));
  const perms = frag.permissions ?? {};
  return {
    deny: [...(floor.deny ?? []), ...(perms.deny ?? [])],
    allow: [...(perms.allow ?? [])],
  };
}

/**
 * Executables a claim can name, each with the words a spec sentence might call it by. Discovered, not listed:
 * the scripts on disk, the tools package.json runs, and the slash commands in the kit.
 */
export function executables() {
  const out = [];
  const add = (file, ...aliases) => {
    if (!K.isFile(path.join(ROOT, file))) return;
    const base = path.basename(file).replace(/\.(js|md)$/, '');
    out.push({ file, aliases: [...new Set([base, base.replace(/_/g, '-'), ...aliases])] });
  };
  for (const n of fs.readdirSync(path.join(KIT, 'scripts')).filter((x) => x.endsWith('.js'))) add(`kit/scripts/${n}`);
  const pkg = readJson(path.join(ROOT, 'package.json'));
  for (const [name, cmd] of Object.entries(pkg.scripts ?? {})) {
    const m = /(?:^|\s)((?:\w|[./-])+\.js)/.exec(cmd);
    if (m) add(m[1], name);
  }
  // A slash command is a Markdown file, not a parser; it is an ALIAS for whatever script it runs, so `/bootstrap`
  // grades against bootstrap.js. Without this a claim about a command would be checked against prose.
  for (const n of fs.readdirSync(path.join(KIT, 'commands')).filter((x) => x.endsWith('.md'))) {
    const body = readIf(path.join(KIT, 'commands', n));
    const m = /kit\/scripts\/([\w.-]+\.js)/.exec(body);
    const target = m ? out.find((t) => t.file === `kit/scripts/${m[1]}`) : null;
    if (target) target.aliases.push(`/${n.replace(/\.md$/, '')}`, n.replace(/\.md$/, ''));
  }
  return out;
}

/** Normalized form for matching a spec's words against a tool name: letters only, trailing plural dropped. */
const norm = (s) => s.toLowerCase().replace(/[^a-z]/g, '').replace(/s$/, '');

/** The executable a sentence (or its heading) names, or null. */
export function namedTool(text, heading, tools) {
  const hay = norm(`${text} ${heading}`);
  let best = null;
  for (const t of tools) {
    for (const a of t.aliases) {
      const n = norm(a);
      if (n.length >= 5 && hay.includes(n) && (!best || n.length > best.n.length)) best = { t, n };
    }
  }
  return best ? best.t : null;
}

/** Option flags a tool's own parser accepts, and the help text of each. */
export function toolOptions(file) {
  const src = readIf(path.join(ROOT, file));
  const opts = new Map();
  for (const m of src.matchAll(/flag:\s*'(--[\w-]+)'/g)) opts.set(m[1], '');
  for (const m of src.matchAll(/addArgument\('(--[\w-]+)'(?:,\s*\{[^}]*help:\s*'([^']*)')?/g)) opts.set(m[1], m[2] ?? opts.get(m[1]) ?? '');
  // the usage/help block names options too, with their description on the same line
  for (const m of src.matchAll(/^\s*(--[\w-]+)(?:\s+[A-Z_]+)?\s{2,}(.+)$/gm)) {
    if (!opts.has(m[1]) || !opts.get(m[1])) opts.set(m[1], m[2].trim());
  }
  return opts;
}

/** True when the tool takes a repository or project to act on. */
export function takesProject(file) {
  const opts = toolOptions(file);
  if ([...opts.keys()].some((f) => /^--(repo|project|root|dir)$/.test(f))) return true;
  const src = readIf(path.join(ROOT, file));
  return /addArgument\('(repo|project|path|paths)'/.test(src); // a positional
}

/** Where the kit itself invokes a tool: the hooks it installs, its CI, its commands and its agents. */
export function invocations(file) {
  const base = path.basename(file);
  const out = [];
  const scan = (rel) => {
    const txt = readIf(path.join(ROOT, rel));
    for (const line of K.splitlines(txt)) if (line.includes(base)) out.push({ rel, line: line.trim() });
  };
  scan('kit/hooks/settings.project.json');
  for (const dir of ['kit/ci', 'kit/commands', 'kit/agents']) {
    const d = path.join(ROOT, dir);
    if (!fs.existsSync(d)) continue;
    for (const n of fs.readdirSync(d)) scan(`${dir}/${n}`);
  }
  return out;
}

// --- resolvers -----------------------------------------------------------------------------------------------
// Each takes a claim and returns a verdict, or null when it does not understand the claim's shape.

const RULE_IN_TEXT = /`((?:Bash|Read|Edit|Write|Glob|NotebookEdit|WebFetch)\([^`]*\))`/g;
const STOP = new Set(['this', 'that', 'with', 'from', 'into', 'when', 'then', 'than', 'each', 'every', 'which',
  'what', 'where', 'instead', 'other', 'their', 'there', 'these', 'those', 'runs', 'file', 'files', 'line', 'lines',
  'path', 'paths', 'name', 'text', 'claim', 'rule', 'rules', 'project', 'lane', 'kit', 'spec', 'code', 'present']);

/** A sentence that names permission rules and says they are denied: each named rule must be in a shipped deny list. */
export function resolveRuleClaim(claim, ctx) {
  const named = [...claim.text.matchAll(RULE_IN_TEXT)].map((m) => m[1]).filter((r) => !r.includes('(...)'));
  if (!named.length) return null;
  // Which list a claim is about comes from its own label when it has one. Reading it from a deny-ish word anywhere
  // in the sentence made the allow bullet ("...refuses to write any rule that overlaps the floor's deny list")
  // grade against the deny list and fail.
  const kind = claim.kind ?? (/\b(deny|denied|denies|refus|block)/i.test(claim.text) ? 'deny' : null);
  if (kind === 'deny') {
    const missing = named.filter((r) => !ctx.rules.deny.includes(r));
    if (missing.length) return { verdict: 'FALSIFIED', by: 'rule', evidence: `${missing.join(', ')} not in kit/security/floor.json or the settings fragment deny list` };
    return { verdict: 'SUPPORTED', by: 'rule', evidence: `${named.join(', ')} present in the shipped deny lists` };
  }
  if (kind === 'allow') {
    // An allow rule is either shipped in the fragment or produced per project from kit.json commands, and the
    // generator's output shape is `Bash(<command> *)`. So a Bash wildcard rule can only be checked for shape --
    // weaker than the deny side, and said here rather than left to look stronger than it is.
    const missing = named.filter((r) => !ctx.rules.allow.includes(r) && !/^Bash\(.+ \*\)$/.test(r));
    if (missing.length) return { verdict: 'FALSIFIED', by: 'rule', evidence: `${missing.join(', ')} not in the settings fragment allow list and not a shape the command generator produces` };
    return { verdict: 'SUPPORTED', by: 'rule', evidence: `${named.join(', ')} shipped in the fragment or producible from kit.json commands` };
  }
  return null;
}

/** A sentence that names a tool and a flag: the tool's parser must accept the flag. */
export function resolveFlagClaim(claim, ctx) {
  const tool = namedTool(claim.text, claim.heading, ctx.tools);
  if (!tool) return null;
  // Only flags the sentence attaches to THIS tool, and the attachment has to be positive. A flag inside a
  // backticked command naming another program (`git reset --hard`, `Bash(npx tsc --noEmit)`) belongs to that
  // program; stripping those spans was not enough, because a sentence split can leave a span unbalanced.
  const flags = new Set();
  const mine = (prog) => tool.aliases.some((a) => norm(a).length >= 5 && norm(prog).includes(norm(a)));
  for (const span of claim.text.match(/`[^`]*`/g) ?? []) {
    const prog = /^`\s*(?:node\s+)?["']?([\w./$-]+)/.exec(span)?.[1] ?? '';
    if (mine(prog)) for (const m of span.matchAll(/(--[a-z][\w-]+)/g)) flags.add(m[1]);
  }
  for (const m of claim.text.matchAll(/(--[a-z][\w-]+)/g)) {
    const before = claim.text.slice(Math.max(0, m.index - 40), m.index);
    if (!before.includes('`') && mine(before)) flags.add(m[1]); // bare, right after the tool's name
  }
  if (!flags.size) return null;
  const opts = toolOptions(tool.file);
  if (!opts.size) return null;
  const missing = [...flags].filter((f) => !opts.has(f));
  if (missing.length) return { verdict: 'FALSIFIED', by: 'flag', evidence: `${tool.file} has no ${missing.join(', ')} (accepts ${[...opts.keys()].join(' ') || 'nothing'})` };
  return { verdict: 'SUPPORTED', by: 'flag', evidence: `${tool.file} accepts ${[...flags].join(' ')}` };
}

/** A sentence that says a tool acts on a project: the tool must be able to take one. */
export function resolveTargetClaim(claim, ctx) {
  if (!/\b(against|on|for|into)\s+(the|a|each|every)\s+project('s)?\b/i.test(claim.text)) return null;
  const tool = namedTool(claim.text, claim.heading, ctx.tools);
  if (!tool) return null;
  if (takesProject(tool.file)) return { verdict: 'SUPPORTED', by: 'target', evidence: `${tool.file} takes a project to act on` };
  return { verdict: 'FALSIFIED', by: 'target', evidence: `${tool.file} cannot be aimed at a project: its parser accepts ${[...toolOptions(tool.file).keys()].join(' ') || 'no options'} and no repo positional` };
}

/**
 * A sentence that states behaviour a tool only has when called with an option it does not name. The claim reads as
 * unconditional; if the kit's own invocations omit the option, it is not. Claims that name the option are left to
 * resolveFlagClaim: naming it is what makes a claim conditional out loud.
 */
export function resolveInvocationClaim(claim, ctx) {
  if (/`?--[a-z]/.test(claim.text)) return null;
  // Graded only where the spec is DESCRIBING this tool -- its heading names it. A tool mentioned inside a list
  // ("jobs on every PR: ... validate-docs") is not the subject of the sentence, and grading those made the
  // resolver fire on any sentence that happened to share a word with an option.
  const tool = namedTool('', claim.heading, ctx.tools);
  if (!tool) return null;
  const words = new Set(claim.text.toLowerCase().match(/[a-z]{4,}/g) ?? []);
  for (const [flag, help] of toolOptions(tool.file)) {
    if (!help) continue;
    // The claim must name the option's own subject -- the flag's name as a word ("the recorded commit" for
    // `--commit`). Token overlap with the help text alone matched almost anything, which made the resolver noise.
    const subject = flag.replace(/^--/, '').replace(/-/g, '');
    if (subject.length < 5 || STOP.has(subject) || !words.has(subject)) continue;
    const calls = invocations(tool.file);
    if (!calls.length) continue;
    const without = calls.filter((c) => !c.line.includes(flag));
    if (without.length === calls.length) {
      return {
        verdict: 'FALSIFIED',
        by: 'invocation',
        evidence: `holds only with ${flag} (${help}); all ${calls.length} kit invocation(s) omit it, e.g. ${without[0].rel}: ${without[0].line.slice(0, 90)}`,
      };
    }
  }
  return null;
}

export const RESOLVERS = [resolveRuleClaim, resolveFlagClaim, resolveTargetClaim, resolveInvocationClaim];

/** Grade every normative claim in `text`. Pure apart from reading the repository. */
export function grade(text) {
  const ctx = { rules: shippedRules(), tools: executables() };
  return claims(text).map((c) => {
    for (const r of RESOLVERS) {
      const v = r(c, ctx);
      if (v) return { ...c, ...v };
    }
    return { ...c, verdict: 'UNGRADED', by: null, evidence: 'no resolver understands this claim shape' };
  });
}

export function main(argv) {
  const ap = new ArgumentParser({ prog: 'claims.js', description: "options:\n  -h, --help  show this help message and exit\n  --spec SPEC\n  --at AT\n  --json\n  --quiet" });
  ap.usage = () => 'usage: claims.js [-h] [--spec SPEC] [--at AT] [--json] [--quiet]';
  ap.addArgument('--spec', { help: 'spec file to grade (default docs/KIT-SPEC.md)' });
  ap.addArgument('--at', { help: 'grade the spec as of this commit instead of the working tree' });
  ap.addArgument('--json', { action: 'store_true' });
  ap.addArgument('--quiet', { action: 'store_true' });
  const a = ap.parseArgs(argv);
  const graded = grade(specText({ spec: a.spec ? K.realResolve(a.spec) : undefined, at: a.at ?? null }));
  const bad = graded.filter((g) => g.verdict === 'FALSIFIED');
  const unsup = graded.filter((g) => g.verdict === 'UNSUPPORTED');
  if (a.json) {
    process.stdout.write(K.jsonDumps(graded, { indent: 2 }) + '\n');
  } else if (!a.quiet) {
    for (const g of [...bad, ...unsup]) {
      process.stdout.write(`[${g.verdict}] §${g.section} (line ${g.line}, by ${g.by})\n  claim: ${g.text.slice(0, 160)}\n  evidence: ${g.evidence}\n`);
    }
    const tally = ['FALSIFIED', 'UNSUPPORTED', 'SUPPORTED', 'UNGRADED'].map((v) => `${v}: ${graded.filter((g) => g.verdict === v).length}`).join(', ');
    process.stdout.write(`\nclaims${a.at ? ` at ${a.at}` : ''}: ${graded.length} normative sentences → {${tally}}\n`);
  }
  return bad.length ? 1 : 0;
}

if (K.isMain(import.meta.url)) process.exitCode = main(process.argv.slice(2));
