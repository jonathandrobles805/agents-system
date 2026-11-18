#!/usr/bin/env node
// CI: decide whether the mutation-score job is blocking. Blocking once the project has merged
// `mutation_blocking_after_features` features (count of ROADMAP rows with status merged). Prints `blocking=true|false`.
import * as K from './kitlib.js';
import * as C from './ci_common.js';
import * as L from './lane.js';
import { isMain } from './kitlib.js';

export function main(argv) {
  const ap = C.makeParser('ci_mutation_gate.js', [{ flag: '--repo', default: '.' }]);
  const a = C.parseArgs(ap, argv);
  const root = K.realResolve(a.repo);
  const { blocking, merged, after } = L.mutationBlocking(root); // one rule, shared with the merge gate (lane.js merge)
  process.stdout.write(`blocking=${blocking ? 'true' : 'false'}\n`);
  process.stderr.write(`# merged features: ${merged}, blocking after: ${after}\n`);
  return 0;
}

if (isMain(import.meta.url)) process.exitCode = main(process.argv.slice(2));
