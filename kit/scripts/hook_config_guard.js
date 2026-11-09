#!/usr/bin/env node
// ConfigChange hook: block changes to project settings while a lane is active. Exit 2 blocks.
import * as K from './kitlib.js';

const text = (v) => (typeof v === 'string' ? v : '');

export function main() {
  const d = K.readHookInput();
  if (!d || Object.keys(d).length === 0) return 0;
  const lane = K.findLane(text(d.cwd) || '.');
  const source = text(d.source) || text(d.config_type) || text(d.matcher);
  if (lane && ['project_settings', 'local_settings', ''].includes(source)) {
    K.appendEvent(lane.eventsPath, { event: 'blocked', tool: 'ConfigChange', result: 'blocked', summary: `settings change during lane (${source || 'unknown source'})` });
    return K.block('config-guard: settings cannot change while a lane is active. Finish or escalate the lane, then change settings by hand.');
  }
  return 0;
}

if (K.isMain(import.meta.url)) K.runGuard('config-guard', main);
