#!/usr/bin/env node
// ConfigChange hook: block changes to project settings while a lane is active. Exit 2 blocks.
import * as K from './kitlib.js';

const text = (v) => (typeof v === 'string' ? v : '');

export function main() {
  const d = K.readHookInput();
  if (!d || Object.keys(d).length === 0) return 0;
  // This gate protects `.claude/settings.json`, which lives in the MAIN repo -- the one directory where resolving
  // the lane from cwd found no lane. So it blocked from a worktree, where the file is not, and waved the change
  // through from main, where it is. Ambiguity blocks: any open lane is reason enough to refuse a settings change.
  const r = K.laneForHook(d);
  const lane = r.lane;
  const source = text(d.source) || text(d.config_type) || text(d.matcher);
  if (r.via === 'ambiguous' && ['project_settings', 'local_settings', ''].includes(source)) {
    return K.block(`config-guard: ${r.slugs.length} lanes are open (${r.slugs.join(', ')}); settings cannot change while any lane is active.`);
  }
  if (lane && ['project_settings', 'local_settings', ''].includes(source)) {
    K.appendEvent(lane.eventLogPath, { event: 'blocked', tool: 'ConfigChange', result: 'blocked', summary: `settings change during lane (${source || 'unknown source'})` });
    return K.block('config-guard: settings cannot change while a lane is active. Finish or escalate the lane, then change settings by hand.');
  }
  return 0;
}

if (K.isMain(import.meta.url)) K.runGuard('config-guard', main);
