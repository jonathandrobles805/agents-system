// Minimal argparse-compatible command line parser for the kit scripts (Node >= 20, zero dependencies).
// Mirrors the subset of Python's argparse the Python kit used: options with values, store_true/store_false/append/count,
// positionals with nargs '?', '*', '+' or an integer, choices, type conversion, required options, subparsers.
// Errors print "usage: ..." and "<prog>: error: <message>" to stderr and exit with code 2, like argparse.
// Option names are exposed with '-' turned into '_' (args.dry_run), exactly like argparse's dest.

const destOf = (flag) => flag.replace(/^-+/, '').replace(/-/g, '_');

export class ArgumentError extends Error {}

export class ArgumentParser {
  constructor({ prog = 'script', description = '' } = {}) {
    this.prog = prog;
    this.description = description;
    this.options = []; // { flags, dest, action, type, choices, required, default, nargs }
    this.positionals = [];
    this.subparsers = null; // { dest, required, parsers: Map<string, ArgumentParser> }
  }

  addArgument(...rest) {
    const spec = typeof rest[rest.length - 1] === 'object' ? rest.pop() : {};
    const names = rest;
    const isOption = names[0].startsWith('-');
    const arg = {
      flags: names,
      dest: spec.dest ?? destOf(isOption ? (names.find((n) => n.startsWith('--')) ?? names[0]) : names[0]),
      action: spec.action ?? 'store',
      type: spec.type,
      choices: spec.choices,
      required: spec.required ?? (!isOption && spec.nargs !== '?' && spec.nargs !== '*'),
      nargs: spec.nargs,
      default: 'default' in spec ? spec.default : spec.action === 'store_true' ? false : spec.action === 'store_false' ? true : spec.action === 'append' ? null : spec.action === 'count' ? null : null,
      help: spec.help,
    };
    (isOption ? this.options : this.positionals).push(arg);
    return this;
  }

  addSubparsers({ dest = 'cmd', required = false } = {}) {
    this.subparsers = { dest, required, parsers: new Map() };
    const self = this;
    return {
      addParser(name) {
        const p = new ArgumentParser({ prog: `${self.prog} ${name}` });
        self.subparsers.parsers.set(name, p);
        return p;
      },
    };
  }

  usage() {
    const opts = this.options.map((o) => `[${o.flags[0]}${['store', 'append'].includes(o.action) ? ' ' + o.dest.toUpperCase() : ''}]`);
    const pos = this.positionals.map((p) => (p.nargs === '?' ? `[${p.dest}]` : p.dest));
    const sub = this.subparsers ? ` {${[...this.subparsers.parsers.keys()].join(',')}} ...` : '';
    return `usage: ${this.prog} ${[...opts, ...pos].join(' ')}${sub}`.replace(/\s+$/, '');
  }

  fail(message) {
    process.stderr.write(`${this.usage()}\n${this.prog}: error: ${message}\n`);
    process.exit(2);
  }

  convert(arg, raw, label) {
    let v = raw;
    if (arg.type) {
      if (arg.type === Number || arg.type === parseInt) {
        if (!/^\s*[+-]?\d+\s*$/.test(raw)) this.fail(`argument ${label}: invalid int value: '${raw}'`);
        v = parseInt(raw, 10);
      } else if (arg.type === parseFloat) {
        if (Number.isNaN(parseFloat(raw)) || !/^\s*[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?\s*$/.test(raw)) this.fail(`argument ${label}: invalid float value: '${raw}'`);
        v = parseFloat(raw);
      } else {
        v = arg.type(raw);
      }
    }
    if (arg.choices && !arg.choices.includes(v)) {
      this.fail(`argument ${label}: invalid choice: '${v}' (choose from ${arg.choices.map((c) => `'${c}'`).join(', ')})`);
    }
    return v;
  }

  /** @param {string[]} argv arguments without node and script path. Returns a plain object of dest -> value. */
  parseArgs(argv) {
    const [ns, rest] = this.parseKnown(argv);
    if (rest.length) this.fail(`unrecognized arguments: ${rest.join(' ')}`);
    return ns;
  }

  parseKnown(argv) {
    const ns = {};
    for (const o of this.options) ns[o.dest] = o.default;
    for (const p of this.positionals) ns[p.dest] = p.nargs === '*' || p.nargs === '+' ? (p.nargs === '*' ? [] : null) : p.default;
    if (this.subparsers) ns[this.subparsers.dest] = null;

    const seen = new Set();
    const positionalsRaw = [];
    const unknown = [];
    let i = 0;
    let onlyPositional = false;
    let subName = null;
    let subRest = [];

    while (i < argv.length) {
      const tok = argv[i];
      if (!onlyPositional && tok === '--') {
        onlyPositional = true;
        i++;
        continue;
      }
      const isNumber = /^-\d+(\.\d+)?$/.test(tok);
      if (!onlyPositional && tok.startsWith('-') && tok !== '-' && !isNumber) {
        let flag = tok;
        let inline = null;
        const eq = tok.startsWith('--') ? tok.indexOf('=') : -1;
        if (eq !== -1) {
          flag = tok.slice(0, eq);
          inline = tok.slice(eq + 1);
        }
        if (flag === '-h' || flag === '--help') {
          process.stdout.write(`${this.usage()}\n${this.description ? '\n' + this.description + '\n' : ''}`);
          process.exit(0);
        }
        const opt = this.options.find((o) => o.flags.includes(flag));
        if (!opt) {
          unknown.push(tok);
          i++;
          continue;
        }
        seen.add(opt.dest);
        const label = opt.flags.join('/');
        if (opt.action === 'store_true') ns[opt.dest] = true;
        else if (opt.action === 'store_false') ns[opt.dest] = false;
        else if (opt.action === 'count') ns[opt.dest] = (ns[opt.dest] ?? 0) + 1;
        else {
          let raw = inline;
          if (raw === null) {
            const next = argv[i + 1];
            if (next === undefined || (next.startsWith('-') && next !== '-' && !/^-\d+(\.\d+)?$/.test(next))) this.fail(`argument ${label}: expected one argument`);
            raw = next;
            i++;
          }
          const v = this.convert(opt, raw, label);
          if (opt.action === 'append') ns[opt.dest] = [...(ns[opt.dest] ?? []), v];
          else ns[opt.dest] = v;
        }
        i++;
        continue;
      }
      // positional token
      if (this.subparsers && positionalsRaw.length >= this.positionals.length) {
        subName = tok;
        subRest = argv.slice(i + 1);
        break;
      }
      positionalsRaw.push(tok);
      i++;
    }

    // assign positionals
    let k = 0;
    for (const p of this.positionals) {
      const label = p.dest;
      if (p.nargs === '?') {
        if (k < positionalsRaw.length) ns[p.dest] = this.convert(p, positionalsRaw[k++], label);
      } else if (p.nargs === '*' || p.nargs === '+') {
        const vals = positionalsRaw.slice(k).map((v) => this.convert(p, v, label));
        k = positionalsRaw.length;
        if (p.nargs === '+' && vals.length === 0) this.fail(`the following arguments are required: ${label}`);
        ns[p.dest] = vals;
      } else if (Number.isInteger(p.nargs)) {
        ns[p.dest] = positionalsRaw.slice(k, k + p.nargs).map((v) => this.convert(p, v, label));
        k += p.nargs;
      } else if (k < positionalsRaw.length) {
        ns[p.dest] = this.convert(p, positionalsRaw[k++], label);
      } else if (p.required) {
        const missing = this.positionals.filter((q) => q.required && ns[q.dest] === null && !['*', '?'].includes(q.nargs)).map((q) => q.dest);
        this.fail(`the following arguments are required: ${missing.join(', ')}`);
      }
    }
    const leftover = positionalsRaw.slice(k);

    const missingOpts = this.options.filter((o) => o.required && !seen.has(o.dest)).map((o) => o.flags.join('/'));
    if (missingOpts.length) this.fail(`the following arguments are required: ${missingOpts.join(', ')}`);

    if (this.subparsers) {
      if (subName === null) {
        if (this.subparsers.required) this.fail(`the following arguments are required: ${this.subparsers.dest}`);
      } else {
        const sp = this.subparsers.parsers.get(subName);
        if (!sp) this.fail(`argument ${this.subparsers.dest}: invalid choice: '${subName}' (choose from ${[...this.subparsers.parsers.keys()].map((c) => `'${c}'`).join(', ')})`);
        ns[this.subparsers.dest] = subName;
        const sub = sp.parseArgs(subRest);
        Object.assign(ns, sub);
      }
    }
    return [ns, [...leftover, ...unknown]];
  }
}
