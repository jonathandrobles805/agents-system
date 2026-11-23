#!/usr/bin/env node
/*
 * validate-docs: reject research files, specs, review reports, and lessons that make
 * untagged or unresolvable claims. See docs/KIT-SPEC.md section 5.
 *
 * Usage:
 *   validate_docs.js PATH [PATH...] [--repo ROOT] [--commit HASH] [--json]
 *   validate_docs.js --changed [--repo ROOT]        validate every changed doc (git status)
 *   validate_docs.js --hook                          read Claude Code hook JSON on stdin
 *
 * Exit codes: 0 = all valid, 2 = violations (blocks in PreToolUse/SubagentStop; feeds back in PostToolUse), 1 = usage error.
 */
import fs from "node:fs";
import path from "node:path";
import * as K from "./kitlib.js";
import { ArgumentParser } from "./args.js";

export const REQUIRED = {
  research: ["findings", "what i could not verify", "confidence", "recommendation", "sources"],
  spec: [
    "summary", "goal", "non-goals", "files to read first", "files to change", "impact analysis",
    "approach", "data changes", "new dependencies", "done-criteria", "assumptions", "open questions",
    "architecture checklist", "approval",
  ],
  review: ["scope", "checklist", "adversarial tests added", "fail list", "verdict"],
};
export const RESEARCH_HEADER = ["question", "slug", "date", "commit"];
export const SPEC_HEADER = ["slug", "date", "commit", "risk", "status"];
/** A lesson's `Enforced by`: one or more of ENFORCERS (parseEnforcedBy), or `text-only` alone. */
export const ENFORCERS = ["ci", "hook", "lint", "test"];
export const ENFORCED_BY = new Set([...ENFORCERS, "text-only"]);
/** The longest note an enforcer may carry in parentheses, `hook (stop runner)`, in code points. */
export const ENFORCER_NOTE_MAX = 80;

/**
 * Read a lesson's `Enforced by` value: one or more of `ci`, `hook`, `lint`, `test`, joined by `and`, `,`, `+` or `/`,
 * each optionally followed by a short note in parentheses (`hook (stop runner) and ci`), or `text-only` alone, which
 * cannot be combined: a lesson is either enforced by a check or it is debt. Case is ignored. Returns the enforcer names
 * (lower case, in order) and an error message, null when the value is valid.
 */
export function parseEnforcedBy(value) {
  const NAME = /^(text-only|hook|lint|test|ci)(?![\p{L}\p{N}_-])/iu;
  const SEP = /^\s*(?:,\s*(?:and\s+)?|\+|\/|and\s+)\s*/i;
  const usage = `must be one or more of ${ENFORCERS.map((x) => `'${x}'`).join(", ")} joined by "and", ",", "+" or "/" ` +
    `(each may add a short note in parentheses), or 'text-only' alone`;
  const names = [];
  let rest = pyStrip(value);
  for (;;) {
    const m = NAME.exec(rest);
    if (!m) return { names, error: `${usage}; got '${pyStrip(value)}'` };
    const name = m[1].toLowerCase();
    if (names.includes(name)) return { names, error: `'${name}' is named twice` };
    names.push(name);
    rest = rest.slice(m[0].length);
    const note = /^\s*\(([^()]*)\)/.exec(rest);
    if (note) {
      const text = pyStrip(note[1]);
      if (!text) return { names, error: `the note after '${name}' is empty` };
      if (pyLen(text) > ENFORCER_NOTE_MAX) return { names, error: `the note after '${name}' is longer than ${ENFORCER_NOTE_MAX} characters; put the detail in Proposed change` };
      rest = rest.slice(note[0].length);
    }
    if (!pyStrip(rest)) break;
    const sep = SEP.exec(rest);
    if (!sep || sep[0].length === 0 || !pyStrip(rest.slice(sep[0].length))) return { names, error: `${usage}; got '${pyStrip(value)}'` };
    rest = rest.slice(sep[0].length);
  }
  if (names.includes("text-only") && names.length > 1) {
    return { names, error: "'text-only' stands alone: a lesson is enforced by a check or it is text-only debt, not both" };
  }
  return { names, error: null };
}

/**
 * The template each document type validate_docs checks is filled from (kit/templates/<name>.md, the file
 * `kit lane template <name>` prints). Its `{{…}}` tokens are that document's own placeholders (placeholderUnfilled).
 */
export const TEMPLATE_OF = { research: "research", spec: "spec", review: "review", lesson: "lesson", goal: "goal" };
const PLACEHOLDER_G = new RegExp(K.PLACEHOLDER.source, "g");
const placeholderKey = (tok) => tok.slice(2, -2).replace(/\s+/g, " ").trim();
const templateTokens = new Map();

/**
 * The `{{…}}` tokens of a document type's template (whitespace inside a token collapsed), read once per process.
 * Null when the type has no template or the template cannot be read: then every `{{…}}` counts as unfilled, wherever
 * it stands (placeholderUnfilled fails closed).
 */
export function templatePlaceholders(kind) {
  if (!Object.hasOwn(TEMPLATE_OF, kind)) return null;
  if (!templateTokens.has(kind)) {
    let set = null;
    try {
      const text = fs.readFileSync(path.join(kitDir(), "templates", `${TEMPLATE_OF[kind]}.md`), "utf8");
      set = new Set([...text.matchAll(PLACEHOLDER_G)].map((m) => placeholderKey(m[0])));
    } catch {
      set = null;
    }
    templateTokens.set(kind, set);
  }
  return templateTokens.get(kind);
}

/**
 * Which character ranges of each line are code: a whole line inside a fenced block (``` or ~~~, closed by a fence of
 * the same character at least as long; the fence lines too), and inline code spans (a run of N backticks closed by the
 * next run of exactly N on the same line; an unclosed run is literal text). Returns one array of [start, end) per line.
 */
export function codeRanges(lines) {
  const out = [];
  let fence = null;
  for (const t of lines) {
    const f = /^\s*(`{3,}|~{3,})/.exec(t);
    if (fence) {
      out.push([[0, t.length]]);
      if (f && f[1][0] === fence[0] && f[1].length >= fence.length && !pyStrip(t.slice(f[0].length))) fence = null;
      continue;
    }
    if (f && !(f[1][0] === "`" && t.slice(f[0].length).includes("`"))) {
      fence = f[1];
      out.push([[0, t.length]]);
      continue;
    }
    const ranges = [];
    const runs = [...t.matchAll(/`+/g)];
    for (let i = 0; i < runs.length; i++) {
      const j = runs.findIndex((r, k) => k > i && r[0].length === runs[i][0].length);
      if (j < 0) continue;
      ranges.push([runs[i].index, runs[j].index + runs[j][0].length]);
      i = j;
    }
    out.push(ranges);
  }
  return out;
}

/**
 * The unfilled placeholders in a document of type `kind`: one of the type's own template placeholders
 * (templatePlaceholders) wherever it stands, inside backticks and fenced blocks too, since the research template itself
 * writes "`{{snippet}}`"; any other `{{…}}` only outside code spans and fenced blocks, so a lesson may quote another
 * file's placeholder (`{{n}}` from progress.md) while a stray `{{x}}` in prose is still caught. Returns
 * [{ line, token }], the first unfilled token of each line, lines numbered from 1.
 */
export function unfilledPlaceholders(kind, lines) {
  const own = templatePlaceholders(kind);
  const code = codeRanges(lines);
  const found = [];
  lines.forEach((t, idx) => {
    for (const m of t.matchAll(PLACEHOLDER_G)) {
      const inCode = code[idx].some(([a, b]) => m.index >= a && m.index + m[0].length <= b);
      if (own === null || own.has(placeholderKey(m[0])) || !inCode) {
        found.push({ line: idx + 1, token: m[0] });
        return;
      }
    }
  });
  return found;
}

// ---------------------------------------------------------------------------
// Python-compatible text helpers (the Python original relied on Unicode-aware str/re behaviour).
// ---------------------------------------------------------------------------

/** Characters for which Python's str.isspace() (and re's \s) is true. */
function isPySpace(c) {
  return (
    (c >= 0x09 && c <= 0x0d) || (c >= 0x1c && c <= 0x20) || c === 0x85 || c === 0xa0 || c === 0x1680 ||
    (c >= 0x2000 && c <= 0x200a) || c === 0x2028 || c === 0x2029 || c === 0x202f || c === 0x205f || c === 0x3000
  );
}
const WS = "\\t-\\r\\x1c-\\x20\\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000";
const S = `[${WS}]`; // Python \s
const NS = `[^${WS}]`; // Python \S
const D = "\\p{Nd}"; // Python \d (Unicode decimal digit); use with the u flag
const WB_START = "(?<![\\p{L}\\p{N}_])"; // Python \b (start of a word); use with the u flag
const WB_END = "(?![\\p{L}\\p{N}_])";

/** Python str.lstrip() with no arguments. */
function pyLstrip(s) {
  let a = 0;
  while (a < s.length && isPySpace(s.charCodeAt(a))) a++;
  return s.slice(a);
}

/** Python str.strip() with no arguments. */
function pyStrip(s) {
  let a = 0;
  let b = s.length;
  while (a < b && isPySpace(s.charCodeAt(a))) a++;
  while (b > a && isPySpace(s.charCodeAt(b - 1))) b--;
  return s.slice(a, b);
}

/** Python str.title() for the ASCII section names used in REQUIRED. */
function pyTitle(s) {
  let out = "";
  let prevCased = false;
  for (const ch of s) {
    const cased = ch.toLowerCase() !== ch.toUpperCase();
    out += cased ? (prevCased ? ch.toLowerCase() : ch.toUpperCase()) : ch;
    prevCased = cased;
  }
  return out;
}

/** sorted() of strings: by code point (JS's default compares UTF-16 units). */
function cpCompare(a, b) {
  const ia = a[Symbol.iterator]();
  const ib = b[Symbol.iterator]();
  for (;;) {
    const x = ia.next();
    const y = ib.next();
    if (x.done || y.done) return x.done === y.done ? 0 : x.done ? -1 : 1;
    const cx = x.value.codePointAt(0);
    const cy = y.value.codePointAt(0);
    if (cx !== cy) return cx < cy ? -1 : 1;
  }
}
const sorted = (items) => [...items].sort(cpCompare);

/** Python len() of a str counts code points; JS .length counts UTF-16 units. */
const pyLen = (s) => [...s].length;

/** pathlib (POSIX) view of a path string: drive-less root ("", "/" or "//") and components without "", "." or ".." handling. */
function pyParts(p) {
  const lead = p.startsWith("//") && !p.startsWith("///") ? "//" : p.startsWith("/") ? "/" : "";
  return { lead, parts: p.split("/").filter((c) => c !== "" && c !== ".") };
}

/** str(Path(p)): collapse "//", "/./" and a trailing "/"; "" becomes ".". */
function pyNorm(p) {
  const { lead, parts } = pyParts(p);
  return parts.length || lead ? lead + parts.join("/") : ".";
}

/** Python truthiness of a JSON value. */
function pyTruthy(v) {
  if (v === null || v === undefined || v === false || v === 0 || v === "") return false;
  if (Array.isArray(v)) return v.length > 0;
  if (typeof v === "object") return Object.keys(v).length > 0;
  return true;
}

/** dict.get(key) on a decoded JSON value; anything but an object raises like Python's AttributeError. */
function pyGet(obj, key) {
  if (obj === null || typeof obj !== "object" || Array.isArray(obj)) {
    throw new TypeError(`'${obj === null ? "NoneType" : Array.isArray(obj) ? "list" : typeof obj}' object has no attribute 'get'`);
  }
  return Object.hasOwn(obj, key) ? obj[key] : null;
}

/** Path(value): only strings are accepted. */
function pyPathArg(v) {
  if (typeof v !== "string") throw new TypeError(`expected str, bytes or os.PathLike object, not ${v === null ? "NoneType" : typeof v}`);
  return v;
}

const globalOf = (re) => new RegExp(re.source, re.flags.includes("g") ? re.flags : re.flags + "g");
const ANY_TAG_G = globalOf(K.ANY_TAG);
const TAG_VERIFIED_LINES_G = globalOf(K.TAG_VERIFIED_LINES);
// a bare `path/to/file.ext:12` or `:12-20`, with or without backticks, as review evidence is written
const BARE_CITATION_G = /`?([A-Za-z0-9_./-]+\.[A-Za-z0-9]{1,5}):(\d+)(?:-(\d+))?`?/g;
const TAG_DOCS_G = globalOf(K.TAG_DOCS);
export const HIGH_RISK_KEYWORDS_SCAN = globalOf(K.HIGH_RISK_KEYWORDS);

const CONFIDENCE_VALUE = new RegExp(`${WB_START}(High|Medium|Low)${WB_END}`, "u");
const DONE_TEST_FILE = /\.(test|spec)\.[a-z]+/;
const APPROVAL_LINE = new RegExp(`Approved by:${S}*(${NS}.*?)${S}+on${S}+(${D}{4}-${D}{2}-${D}{2})${S}+at${S}+([0-9a-f]{7,40})`, "u");
const CHECKLIST_UNANSWERED = new RegExp(`^${S}*-${S}*\\[${S}\\]`, "u");
const FAIL_ID = new RegExp(`^(R${D}+)`, "u");
const FAIL_LOCATION = new RegExp(`\`[^\`]+:${D}+\``, "u");
const LESSON_FIELD = new RegExp(`^-${S}*([A-Za-z ]+):${S}*(.*)$`, "u");
const CITED_SNIPPET = /`([^`]{4,})`/u;

function kitDir() {
  return K.KIT_DIR;
}

export function detectType(p, work = 'docs/specs') {
  const s = pyNorm(p);
  const name = s === "." || s === "/" ? "" : s.slice(s.lastIndexOf("/") + 1);
  if (name === "LESSONS.md") return "lesson";
  if (s.includes("/docs/goals/") || s.startsWith("docs/goals/")) return name.toUpperCase() === "PROJECT.MD" ? null : "goal";
  if (s.includes("/docs/research/") || s.startsWith("docs/research/")) {
    return name.toUpperCase() === "INDEX.MD" ? null : "research";
  }
  if (s.includes(`/${work}/`) || s.startsWith(`${work}/`)) {
    if (name.endsWith(".review.md")) return "review";
    if (name.endsWith(".progress.md") || name.endsWith(".log") || name.endsWith(".jsonl")) return null;
    return "spec";
  }
  return null;
}

export class Validator {
  /** @param {string} root @param {string|null} commit @param {object} kit decoded .claude/kit.json */
  constructor(root, commit, kit) {
    this.root = root;
    this.commit = commit;
    this.kit = kit;
    /** @type {K.Violation[]} */
    this.v = [];
  }

  // ---------- helpers ----------
  add(p, line, rule, msg) {
    // str(path.relative_to(root)) if path.is_absolute() and root in path.parents else str(path)
    const a = pyParts(p);
    const r = pyParts(this.root);
    const inside = a.lead !== "" && a.lead === r.lead && a.parts.length > r.parts.length && r.parts.every((c, i) => c === a.parts[i]);
    this.v.push(new K.Violation(inside ? a.parts.slice(r.parts.length).join("/") : pyNorm(p), line, rule, msg));
  }

  /** A placeholder left unfilled (unfilledPlaceholders: the type's own template tokens anywhere, others outside code). */
  checkPlaceholders(p, lines, kind) {
    for (const { line, token } of unfilledPlaceholders(kind, lines)) {
      this.add(p, line, "template-placeholder", `unfilled template placeholder: ${token}`);
    }
  }

  checkRequired(p, kind, sections) {
    for (const s of REQUIRED[kind]) {
      if (!sections.has(s)) this.add(p, 1, "missing-section", `required section '## ${pyTitle(s)}' not found`);
    }
  }

  checkHeader(p, lines, names) {
    const hdr = K.headerFields(lines);
    for (const n of names) {
      if (!hdr.has(n) || !hdr.get(n)[1]) this.add(p, 1, "missing-header", `header field '${n}' missing or empty`);
    }
  }

  tagsOf(text) {
    return [...text.matchAll(ANY_TAG_G)].map((m) => m[1]);
  }

  checkTaggedBullets(p, sec, allowed, forbidHedge = true) {
    if (!sec) return;
    for (const [n, t] of sec.bullets()) {
      const body = pyStrip(t).slice(2);
      if (!body || ["none", "none.", "—", "-"].includes(body.toLowerCase())) continue;
      const tags = this.tagsOf(body);
      if (tags.length === 0) {
        this.add(p, n, "untagged-claim", "bullet has no provenance tag");
        continue;
      }
      if (tags.length > 1) this.add(p, n, "multiple-tags", `bullet has ${tags.length} tags; use exactly one`);
      for (const tag of tags) {
        if (!allowed.has(tag)) {
          this.add(p, n, "tag-not-allowed", `[${tag}] not allowed in '## ${sec.title}' (allowed: ${sorted(allowed).join(", ")})`);
        }
      }
      if (forbidHedge && !tags.includes("unknown")) {
        const m = K.HEDGE_WORDS.exec(body.replace(ANY_TAG_G, ""));
        if (m) this.add(p, n, "hedge-word", `'${m[0]}' is not evidence; verify it or tag [unknown]`);
      }
      this.resolveCitations(p, n, body);
    }
  }

  /**
   * A bare `path:N` or `path:N-M`, as review evidence is written. Only citations wrapped in
   * `[verified: path:N-M]` were range-checked, so review round 1 of the field run cited a spec at lines 306-308
   * and 92 when the file had 289 lines and the section it named was on line 7, and nothing objected.
   */
  resolveBareCitations(p, n, body) {
    for (const m of body.matchAll(BARE_CITATION_G)) {
      const rel = m[1];
      // only paths that look like this repository's files, so prose and version numbers are not citations
      if (!/\.[a-z0-9]{1,5}$/i.test(rel) || /^https?:/.test(rel)) continue;
      const start = Number(m[2]);
      const end = Number(m[3] ?? m[2]);
      const lines = K.fileLinesAt(this.root, rel, this.commit);
      if (lines === null) continue; // a path this repo does not have is not a citation to range-check
      if (start < 1 || end > lines.length || start > end) {
        this.add(p, n, "citation-out-of-range", `${rel} has ${lines.length} lines; cited ${m[2]}${m[3] ? `-${m[3]}` : ""}`);
      }
    }
  }

  resolveCitations(p, n, body) {
    for (const m of body.matchAll(TAG_VERIFIED_LINES_G)) {
      const rel = m[1];
      const start = BigInt(m[2]);
      const end = BigInt(m[3] ?? m[2]);
      const lines = K.fileLinesAt(this.root, rel, this.commit);
      if (lines === null) {
        this.add(p, n, "citation-missing-file", `${rel} does not exist` + (this.commit ? ` at ${this.commit}` : ""));
        continue;
      }
      if (start < 1n || end > BigInt(lines.length) || start > end) {
        this.add(p, n, "citation-out-of-range", `${rel} has ${lines.length} lines; cited ${start}-${end}`);
        continue;
      }
      const snippet = CITED_SNIPPET.exec(body.slice(m.index + m[0].length));
      if (snippet) {
        const cited = K.normalize(lines.slice(Number(start) - 1, Number(end)).join(" "));
        if (!cited.includes(K.normalize(snippet[1]))) {
          this.add(p, n, "citation-snippet-mismatch", `quoted text not found in ${rel}:${start}-${end}`);
        }
      }
    }
    // a [verified: cmd] tag needs a fenced block; that is checked at section level (checkCmdBlocks)
    for (const m of body.matchAll(TAG_DOCS_G)) {
      const url = m[1];
      const ver = pyStrip(m[2]);
      if (!url.startsWith("http")) this.add(p, n, "docs-url", `[docs] must cite a URL, got '${url}'`);
      if (!ver || ["latest", "current", "?"].includes(ver.toLowerCase())) {
        this.add(p, n, "docs-version", "[docs] must pin a version, not 'latest'");
      }
    }
  }

  /** Every [verified: cmd] bullet must be followed by a fenced block before the next bullet. */
  checkCmdBlocks(p, sec) {
    if (!sec) return;
    const items = sec.lines;
    items.forEach(([n, t], idx) => {
      if (pyLstrip(t).startsWith("- ") && K.TAG_VERIFIED_CMD.test(t)) {
        let found = false;
        for (const [, t2] of items.slice(idx + 1)) {
          if (pyLstrip(t2).startsWith("- ")) break;
          if (pyStrip(t2).startsWith("```")) {
            found = true;
            break;
          }
        }
        if (!found) this.add(p, n, "cmd-without-output", "[verified: cmd] needs a fenced block with the command and its output");
      }
    });
  }

  // ---------- document types ----------
  research(p, lines) {
    const clean = K.stripHtmlComments(lines);
    this.checkPlaceholders(p, clean, "research");
    this.checkHeader(p, clean, RESEARCH_HEADER);
    const sections = K.parseSections(clean);
    this.checkRequired(p, "research", sections);
    this.checkTaggedBullets(p, sections.get("findings"), new Set(["verified", "docs", "inferred"]));
    this.checkCmdBlocks(p, sections.get("findings"));
    const unv = sections.get("what i could not verify");
    if (unv) {
      for (const [n, t] of unv.bullets()) {
        const body = pyStrip(t).slice(2);
        if (["none", "none."].includes(body.toLowerCase())) continue;
        if (!K.TAG_UNKNOWN.test(body)) this.add(p, n, "unknown-untagged", "items here must be tagged [unknown]");
        if (!body.toLowerCase().includes("resolve by:")) this.add(p, n, "unknown-no-method", "each unknown needs 'Resolve by: <method>'");
      }
    }
    const conf = sections.get("confidence");
    if (conf && !CONFIDENCE_VALUE.test(conf.text())) {
      this.add(p, conf.start, "confidence-value", "Confidence must state High, Medium, or Low");
    }
    const fnd = sections.get("findings");
    if (fnd && !fnd.bullets().length) this.add(p, fnd.start, "empty-findings", "Findings has no bullets");
  }

  /**
   * A spec that declares a route must say what the route does with input it cannot parse.
   *
   * In the field run the Approach prescribed `new URL(req.url, 'http://localhost')` and a raw `GET //` threw
   * ERR_INVALID_URL uncaught, killing the server (review round 1, R11). Planning had covered bad PORT values and
   * nothing about bad request input, because nothing required it to.
   *
   * WHY THIS IS NOT A LIST OF RISKY FUNCTIONS. The issue proposed matching `new URL(`, `JSON.parse(` and
   * `decodeURIComponent(` in the Approach. Two things are wrong with that. It is open-ended -- the next entry
   * (`querystring.parse`, a hand-rolled regex, `Buffer.from`) is always the one that was missing -- and it keys on
   * how the work is implemented, which is not what receives malformed input. This keys on what the spec PROMISES:
   * a method-and-path pair is a declared HTTP interface, and anything reachable from outside gets input its author
   * did not choose. The vocabulary is closed -- the HTTP methods are a fixed set defined by the protocol, not by
   * which libraries exist -- so it does not grow.
   *
   * What it is NOT: a proof. "Declares a route" has to be recognised somehow, and this recognises it from a method
   * and a path appearing together. A spec that serves requests without ever writing one down is not detected, and
   * a spec that writes `GET /foo` in prose about something else is. Both are judgement calls a reviewer still has
   * to make; this only makes the common case impossible to forget.
   */
  checkMalformedInput(p, sections) {
    const ROUTE = /\b(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s+\/\S*/;
    let declared = null;
    for (const name of ["summary", "goal", "done-criteria", "files to change", "files to create", "approach"]) {
      const sec = sections.get(name);
      for (const [n, line] of sec?.lines ?? []) {
        const m = ROUTE.exec(line);
        if (m) { declared = { n, what: m[0], where: name }; break; }
      }
      if (declared) break;
    }
    if (!declared) return;
    const dc = sections.get("done-criteria");
    // #34 specifies /malformed|invalid|unparseable/i. Applied to the run that produced the issue, that regex PASSES:
    // the spec's criteria already said "an invalid PORT value is rejected", and the server still died on `GET //`.
    // So "invalid" on its own proves nothing -- a config check satisfies it -- and it counts only when the row also
    // names the surface the request arrives on. "malformed" and "unparseable" describe input that cannot be read and
    // need no qualifier. The vocabulary is #34's; what is added is which of its words carry the claim.
    const SURFACE = /\b(request|input|url|uri|path|target|body|payload|header|query|querystring|method|json|utf-?8)\b/i;
    const covered = (dc?.tableRows() ?? []).some(([, cells]) => {
      const row = cells.join(" ");
      if (/malformed|unparseable/i.test(row)) return true;
      return /\binvalid\b/i.test(row) && SURFACE.test(row);
    });
    if (!covered) {
      this.add(p, dc ? dc.start : declared.n, "unhandled-parse",
        `this spec declares a route ('${declared.what}' in ${declared.where}) but no done-criterion covers input it cannot parse; ` +
        "add one naming what the route returns for a request it cannot parse. This looks for 'malformed' or " +
        "'unparseable' in a criterion, or 'invalid' together with what it is invalid about (request, url, path, body, header, query, json)");
    }
  }

  /**
   * A test command a spec names must be one the kit will actually run. The field run's spec told the tester to run
   * `node --test` before package.json existed; the hook runs `commands.test`, which was `npm test`, so seven
   * exit-254 entries were logged and the real red results never were. Review round 1 failed on it.
   *
   * Only commands recognisable as test runs are compared -- the ones naming a test runner the project has recorded
   * -- so a spec may still show a curl, a migration or a build step without being told it is wrong.
   */
  checkRedRunCommand(p, sections) {
    const kitObj = this.kit && typeof this.kit === "object" && !Array.isArray(this.kit) ? this.kit : {};
    const cmds = kitObj.commands && typeof kitObj.commands === "object" && !Array.isArray(kitObj.commands) ? kitObj.commands : {};
    const known = ["test", "test_affected", "test_file", "coverage", "integration"]
      .map((k) => (typeof cmds[k] === 'string' ? cmds[k].split('{')[0].trim() : ''))
      .filter(Boolean);
    if (!known.length) return;
    const runners = [...new Set(known.map((c) => c.split(/\s+/).slice(0, 2).join(' ')))];
    for (const name of ["red run", "approach", "test plan", "done-criteria"]) {
      const sec = sections.get(name);
      if (!sec) continue;
      for (const [n, line] of sec.lines ?? []) {
        for (const m of line.matchAll(/`([^`]{3,120})`/g)) {
          const cmd = pyStrip(m[1]);
          // It has to be a command before it can be the wrong command: something with an argument, whose first
          // token is a program rather than a path. A backticked `tests/routes.test.ts` is a file, not a run.
          const toks = cmd.split(/\s+/);
          if (toks.length < 2 || toks[0].includes("/") || toks[0].includes(".")) continue;
          const firstTwo = toks.slice(0, 2).join(" ");
          // \b, not \s: the field run's command was `node --test`, where the word is preceded by a hyphen
          if (!/\b(test|tests|spec|vitest|jest|mocha|pytest|unittest)\b/i.test(cmd)) continue;
          if (known.some((k) => cmd.startsWith(k)) || runners.includes(firstTwo)) continue;
          this.add(p, n, "red-run-command", `'${cmd}' is not a command this project runs; the hook runs ${known.map((k) => `'${k}'`).join(' or ')}, so a run of this would never be logged`);
        }
      }
    }
  }

  spec(p, lines) {
    const clean = K.stripHtmlComments(lines);
    this.checkPlaceholders(p, clean, "spec");
    this.checkHeader(p, clean, SPEC_HEADER);
    const hdr = K.headerFields(clean);
    const sections = K.parseSections(clean);
    this.checkRequired(p, "spec", sections);
    // Decisions rest only on verified/docs evidence
    for (const name of ["files to read first", "files to change", "impact analysis", "data changes"]) {
      this.checkTaggedBullets(p, sections.get(name), new Set(["verified", "docs"]));
    }
    this.checkCmdBlocks(p, sections.get("impact analysis"));
    this.checkRedRunCommand(p, sections);
    this.checkMalformedInput(p, sections);
    this.checkTaggedBullets(p, sections.get("assumptions"), new Set(["verified", "docs", "inferred"]));
    // Files to change must be non-empty
    const ftc = sections.get("files to change");
    if (ftc && !ftc.bullets().length) {
      this.add(p, ftc.start, "empty-allow-list", "Files to change is empty; the implementer would have nothing it may edit");
    }
    // Done-criteria: each row needs a test or artifact+checklist
    const dc = sections.get("done-criteria");
    if (dc) {
      const rows = dc.tableRows();
      if (!rows.length) this.add(p, dc.start, "no-done-criteria", "Done-criteria table has no rows");
      for (const [n, cells] of rows) {
        if (cells.length < 3) {
          this.add(p, n, "done-criteria-row", "row needs: #, criterion, test");
          continue;
        }
        const test = cells[2];
        const isTest = test.includes("::") || DONE_TEST_FILE.test(test) || test.includes("test_");
        const isArtifact = test.toLowerCase().includes("artifact:") && test.toLowerCase().includes("checklist");
        if (!(isTest || isArtifact)) {
          this.add(p, n, "done-criteria-no-test", "name a test (file::name) or 'artifact: <path>, checklist: <path>'");
        }
      }
    }
    // Open questions must be empty
    const oq = sections.get("open questions");
    if (oq) {
      const real = oq.bullets().filter(([, b]) => !["none", "none."].includes(pyStrip(pyStrip(b).slice(2)).toLowerCase()));
      if (real.length) this.add(p, oq.start, "open-questions", `${real.length} open question(s); resolve before the spec can be used`);
    }
    // Risk flag
    const computed = this.computeRisk(clean, sections);
    const riskField = hdr.get("risk") ?? [1, ""];
    const declared = riskField[1].toLowerCase();
    if (computed && declared !== "high-risk") {
      this.add(p, riskField[0], "risk-flag", `spec touches high-risk paths/keywords (${computed}); header must say 'Risk: high-risk'`);
    }
    // Approval line when status requires it
    const status = (hdr.get("status") ?? [1, ""])[1].toLowerCase();
    const ap = sections.get("approval");
    if (ap) {
      const m = APPROVAL_LINE.exec(ap.text());
      if (["approved", "building", "in-review", "merged"].includes(status) && !m) {
        this.add(p, ap.start, "approval-line", "status requires 'Approved by: <name> on <YYYY-MM-DD> at <commit>'");
      }
    }
    // Architecture checklist answered
    const ac = sections.get("architecture checklist");
    if (ac) {
      for (const [n, t] of ac.lines) {
        if (CHECKLIST_UNANSWERED.test(t)) this.add(p, n, "checklist-unanswered", "architecture checklist item not answered (use [x] and say how)");
      }
    }
  }

  computeRisk(lines, sections) {
    // self.kit.get("high_risk_paths", DEFAULT): a kit.json that is not an object fails like Python's AttributeError
    const configured = pyGet(this.kit, "high_risk_paths");
    const paths = Object.hasOwn(this.kit, "high_risk_paths") ? pyIter(configured) : K.DEFAULT_HIGH_RISK_PATHS;
    const hits = new Set();
    for (const name of ["files to read first", "files to change", "files to create"]) {
      const sec = sections.get(name);
      if (!sec) continue;
      for (const [, t] of sec.bullets()) {
        for (const q of paths) {
          if (t.toLowerCase().includes(pyLower(q))) hits.add(q);
        }
      }
    }
    const body = lines.join("\n");
    for (const m of body.matchAll(HIGH_RISK_KEYWORDS_SCAN)) hits.add(m[0].toLowerCase());
    return sorted(hits).join(", ");
  }

  review(p, lines) {
    const clean = K.stripHtmlComments(lines);
    this.checkPlaceholders(p, clean, "review");
    const sections = K.parseSections(clean);
    this.checkRequired(p, "review", sections);
    const cl = sections.get("checklist");
    const fails = [];
    if (cl) {
      const rows = cl.tableRows();
      if (!rows.length) this.add(p, cl.start, "empty-checklist", "Checklist has no rows");
      for (const [n, cells] of rows) {
        if (cells.length < 4) {
          this.add(p, n, "checklist-row", "row needs: #, check, result, evidence");
          continue;
        }
        const rid = cells[0];
        const result = cells[2].toUpperCase();
        const evidence = cells[3];
        if (result !== "PASS" && result !== "FAIL") this.add(p, n, "checklist-result", `result must be PASS or FAIL, got '${cells[2]}'`);
        if (!evidence || ["—", "-", "n/a", "N/A"].includes(evidence) || pyLen(evidence) < 6) {
          this.add(p, n, "checklist-no-evidence", `${rid} has no evidence (file:line, log line, or command output)`);
        }
        this.resolveBareCitations(p, n, evidence); // #33: evidence that points past the end of a file is not evidence
        if (result === "FAIL") fails.push(rid);
      }
    }
    const fl = sections.get("fail list");
    const listed = new Set();
    if (fl) {
      for (const [n, t] of fl.bullets()) {
        const body = pyStrip(t).slice(2);
        if (["none", "none."].includes(body.toLowerCase())) continue;
        const m = FAIL_ID.exec(body);
        if (m) listed.add(m[1]);
        if (!body.toLowerCase().includes("rule:") || !body.toLowerCase().includes("passing looks like:") || !FAIL_LOCATION.test(body)) {
          this.add(p, n, "fail-entry", "fail entry needs `file:line`, 'rule:', and 'passing looks like:'");
        }
        this.resolveBareCitations(p, n, body); // #33: the `file:line` a fail entry points at must exist
      }
    }
    for (const rid of fails) {
      if (!listed.has(rid)) this.add(p, cl ? cl.start : 1, "fail-not-listed", `${rid} is FAIL but has no Fail list entry`);
    }
    // R12 must exist in every report (high-risk behind a flag, or risk low)
    if (cl && !cl.tableRows().some(([, c]) => c.length > 0 && pyStrip(c[0]).toUpperCase() === "R12")) {
      this.add(p, cl.start, "checklist-missing-r12", "checklist needs row R12 (high-risk change behind a feature flag, or Risk: low)");
    }
    const vd = sections.get("verdict");
    if (vd) {
      const text = pyStrip(vd.text()).toUpperCase();
      if (fails.length && text.includes("PASS") && !text.includes("FAIL")) {
        this.add(p, vd.start, "verdict-mismatch", "Verdict says PASS but checklist has FAIL rows");
      }
      if (!fails.length && text.includes("FAIL")) {
        this.add(p, vd.start, "verdict-mismatch", "Verdict says FAIL but no checklist row failed");
      }
    }
  }

  /** A goal's classification fields (KIT-SPEC 10.12): a known work type, a known risk and size when present. Absent fields keep the defaults. */
  goal(p, lines) {
    const clean = K.stripHtmlComments(lines);
    this.checkPlaceholders(p, clean, "goal");
    const h = K.headerFields(clean);
    const get = (k) => (h.has(k) ? [h.get(k)[0], pyStrip(h.get(k)[1]).toLowerCase()] : null);
    const wt = get("work type") || get("work_type");
    if (wt) {
      const bare = wt[1].replace(/\s*\(provisional\)\s*$/, "");
      const known = fs.readdirSync(path.join(kitDir(), "workflows")).filter((f) => f.endsWith(".json")).map((f) => f.replace(/\.json$/, ""));
      if (!known.includes(bare)) this.add(p, wt[0], "goal-work-type", `unknown work type '${bare}'; one of ${known.join(", ")}`);
    }
    const risk = get("risk");
    if (risk && !["normal", "high", "low", "medium"].includes(risk[1])) this.add(p, risk[0], "goal-risk", "risk must be normal, high, low or medium");
    const size = get("size");
    if (size && !["s", "m", "l"].includes(size[1])) this.add(p, size[0], "goal-size", "size must be S, M or L");
  }

  lesson(p, lines) {
    const clean = K.stripHtmlComments(lines);
    this.checkPlaceholders(p, clean, "lesson");
    // Each entry starts with '## ' and has the required bullets
    const entries = K.parseSections(clean);
    for (const [key, sec] of entries) {
      if (key === "debt" || key === "text-only debt") continue;
      const fields = new Map();
      for (const [n, t] of sec.bullets()) {
        const m = LESSON_FIELD.exec(pyStrip(t));
        if (m) fields.set(pyStrip(m[1]).toLowerCase(), [n, pyStrip(m[2])]);
      }
      for (const req of ["what went wrong", "root cause", "rule", "enforced by", "proposed change", "status"]) {
        if (!fields.has(req)) this.add(p, sec.start, "lesson-field", `entry '${sec.title}' missing '${req}'`);
      }
      const eb = fields.get("enforced by");
      const enforced = eb ? parseEnforcedBy(eb[1]) : null;
      if (enforced?.error) this.add(p, eb[0], "lesson-enforced-by", enforced.error);
      const textOnly = Boolean(enforced?.names.includes("text-only"));
      if (eb && !textOnly) {
        const pc = fields.get("proposed change");
        if (pc && pc[1].toLowerCase().startsWith("none")) {
          this.add(p, pc[0], "lesson-no-change", "an enforced lesson must name the hook/lint/test change");
        }
      }
      if (eb && textOnly) {
        const pc = fields.get("proposed change");
        if (pc && !pc[1].toLowerCase().includes("reason")) {
          this.add(p, pc[0], "lesson-debt-reason", "text-only lessons must state the reason they cannot be enforced yet");
        }
      }
    }
  }

  run(p, kind = null) {
    kind = kind || detectType(p, K.workRoot(this.root));
    if (kind === null) return;
    if (!K.isFile(p)) {
      this.add(p, 1, "missing-file", "file not found");
      return;
    }
    const lines = K.readLines(p);
    this[kind](p, lines);
  }
}

/** Python str.lower() on a value that must be a str. */
function pyLower(v) {
  if (typeof v !== "string") throw new TypeError(`'${v === null ? "NoneType" : typeof v}' object has no attribute 'lower'`);
  return v.toLowerCase();
}

/** `for x in value` over a decoded JSON value. */
function pyIter(v) {
  if (Array.isArray(v)) return v;
  if (typeof v === "string") return [...v];
  if (v !== null && typeof v === "object") return Object.keys(v);
  throw new TypeError(`'${v === null ? "NoneType" : typeof v}' object is not iterable`);
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const USAGE = [
  "usage: validate_docs.js [-h] [--repo REPO] [--commit COMMIT]",
  "                        [--type {research,spec,review,lesson}] [--changed]",
  "                        [--hook] [--json]",
  "                        [paths ...]",
].join("\n");

const HELP = `validate-docs: reject research files, specs, review reports, and lessons that make
untagged or unresolvable claims. See docs/KIT-SPEC.md section 5.

Usage:
  validate_docs.js PATH [PATH...] [--repo ROOT] [--commit HASH] [--json]
  validate_docs.js --changed [--repo ROOT]        validate every changed doc (git status)
  validate_docs.js --hook                          read Claude Code hook JSON on stdin

Exit codes: 0 = all valid, 2 = violations (blocks in PreToolUse/SubagentStop; feeds back in PostToolUse), 1 = usage error.

positional arguments:
  paths

options:
  -h, --help            show this help message and exit
  --repo REPO           repository root (default: detect from first path or
                        cwd)
  --commit COMMIT       resolve citations at this commit instead of the
                        working tree
  --type {research,spec,review,lesson}
                        force document type
  --changed             validate all changed docs per git status
  --hook                read Claude Code hook JSON on stdin
  --json                machine-readable output`;

/** @param {string[]} [argv] @returns {number} exit code */
export function main(argv = process.argv.slice(2)) {
  const ap = new ArgumentParser({ prog: "validate_docs.js", description: HELP });
  ap.usage = () => USAGE; // argparse-style usage text (args.js prints a simplified one)
  ap.addArgument("paths", { nargs: "*" });
  ap.addArgument("--repo", { help: "repository root (default: detect from first path or cwd)" });
  ap.addArgument("--commit", { help: "resolve citations at this commit instead of the working tree" });
  ap.addArgument("--type", { choices: ["research", "spec", "review", "lesson", "goal"], help: "force document type" });
  ap.addArgument("--changed", { action: "store_true", help: "validate all changed docs per git status" });
  ap.addArgument("--hook", { action: "store_true", help: "read Claude Code hook JSON on stdin" });
  ap.addArgument("--json", { action: "store_true", help: "machine-readable output" });
  const a = ap.parseArgs(argv);

  let paths = [...a.paths];
  let hookEvent = null;
  if (a.hook) {
    const data = K.readHookInput();
    hookEvent = pyGet(data, "hook_event_name");
    const cwdValue = pyGet(data, "cwd");
    const cwd = pyPathArg(pyTruthy(cwdValue) ? cwdValue : ".");
    const toolInput = pyGet(data, "tool_input");
    const fp = pyGet(pyTruthy(toolInput) ? toolInput : {}, "file_path");
    if (pyTruthy(fp)) {
      const f = pyPathArg(fp);
      paths = [path.isAbsolute(f) ? f : pyNorm(`${cwd}/${f}`)];
    } else {
      a.changed = true;
      if (!a.repo) a.repo = cwd;
    }
  }

  const root = a.repo ? K.realResolve(a.repo) : K.repoRoot(K.realResolve(paths.length ? paths[0] : process.cwd()));
  if (a.changed) paths = K.changedDocs(root);
  if (!paths.length) {
    if (a.json) process.stdout.write(K.jsonDumps({ ok: true, violations: [] }) + "\n");
    return 0;
  }

  const v = new Validator(root, a.commit, K.loadKitJson(root));
  for (const p of paths) {
    v.run(K.realResolve(path.isAbsolute(p) ? p : path.join(root, p)), a.type);
  }

  if (a.json) {
    const violations = v.v.map((x) => ({ path: x.path, line: x.line, rule: x.rule, message: x.message }));
    process.stdout.write(K.jsonDumps({ ok: !v.v.length, violations }, { indent: 2 }) + "\n");
  } else {
    for (const x of v.v) process.stderr.write(String(x) + "\n");
    if (!v.v.length && !a.hook) process.stdout.write(`validate-docs: ${paths.length} file(s) valid\n`);
  }
  if (v.v.length) {
    if (a.hook && hookEvent === "PostToolUse") {
      // PostToolUse cannot block; return a decision so Claude must respond to the failures.
      return K.feedbackBlock("validate-docs failed:\n" + v.v.map(String).join("\n"));
    }
    process.stderr.write(`validate-docs: ${v.v.length} violation(s). Fix them before continuing.\n`);
    return 2;
  }
  return 0;
}

if (K.isMain(import.meta.url)) process.exitCode = main(process.argv.slice(2));
