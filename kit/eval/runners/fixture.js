// Fixture runner (KIT-SPEC 11A): replays a recorded outcome for a task. Used by the kit's own tests and on machines
// without an API key. Never a source for a baseline: every outcome it returns is marked runner: "fixture".
//
// Recorded outcomes live in kit/eval/fixtures/<task-id>/<variant>.json. The variant is selected by
// KIT_EVAL_FIXTURE_VARIANT (default "good"); a task may also pin one with task.fixture_variant. The kit's planted
// faults use variants such as "skips-red-run" or "quality-drop" to prove the harness catches them.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const EVAL_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

export const name = 'fixture';

export function available() {
  return { ok: true, why: 'replays recorded outcomes' };
}

/** @returns {{ runner: string, variant: string, files: object, setup_state?: object, events: object[], setup_events: object[], git: object, judge: object, test_commands: string[], output: string, ms: number }} */
export async function run(task, { variant = process.env.KIT_EVAL_FIXTURE_VARIANT || task.fixture_variant || 'good', attempt = 0 } = {}) {
  // a variant models one fault for the tasks it applies to; tasks without that variant replay their good outcome
  let p = path.join(EVAL_DIR, 'fixtures', task.id, `${variant}.json`);
  if (!fs.existsSync(p) && variant !== 'good') {
    p = path.join(EVAL_DIR, 'fixtures', task.id, 'good.json');
    variant = 'good';
  }
  if (!fs.existsSync(p)) throw new Error(`no fixture for ${task.id}/${variant} (${path.relative(process.cwd(), p)})`);
  const rec = JSON.parse(fs.readFileSync(p, 'utf8'));
  // a recorded "judge" per attempt lets a fixture model run-to-run variance for the regression statistics
  const judge = Array.isArray(rec.judge_by_attempt) ? rec.judge_by_attempt[attempt % rec.judge_by_attempt.length] : rec.judge ?? {};
  return { runner: name, variant, files: rec.files ?? {}, ...(rec.setup_state ? { setup_state: rec.setup_state } : {}), events: rec.events ?? [], setup_events: rec.setup_events ?? [], ...(Number.isInteger(rec.lane_log_lines) ? { lane_log_lines: rec.lane_log_lines } : {}), git: rec.git ?? {}, judge, test_commands: rec.test_commands ?? [], output: rec.output ?? '', ms: rec.ms ?? 0 };
}
