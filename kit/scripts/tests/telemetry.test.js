// Telemetry (KIT-SPEC 9.4, decision 0010): the collector stores OTLP/HTTP JSON records with their lane tags; metrics.js
// reads the store and nothing else; a lane without records is null and flagged, never estimated; kit_status shows the
// same figure the exporter sent, to the cent.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { anyValue, append, attrs, createServer, flattenLogs, flattenMetrics, storeFile } from '../../telemetry/collector.js';
import { MISSING, SOURCE, aggregate, laneMetrics, projectMetrics, readStore } from '../metrics.js';
import { telemetryEnv, sandboxConfig } from '../sandbox.js';
import { runScript, tmpPath } from './helpers.js';
import { project } from './testdata.js';

const ns = (d) => String(BigInt(d.getTime()) * 1000000n);
const kv = (k, v) => ({ key: k, value: typeof v === 'number' ? (Number.isInteger(v) ? { intValue: String(v) } : { doubleValue: v }) : typeof v === 'boolean' ? { boolValue: v } : { stringValue: String(v) } });
const resource = (project, lane, extra = {}) => ({ attributes: [kv('service.name', 'claude-code'), kv('kit.project', project), kv('kit.lane', lane), kv('kit.stage', 'build'), ...Object.entries(extra).map(([k, v]) => kv(k, v))] });

/** One OTLP logs payload with the given Claude Code events. */
function logsPayload(project, lane, events) {
  return {
    resourceLogs: [{
      resource: resource(project, lane),
      scopeLogs: [{ scope: { name: 'com.anthropic.claude_code' }, logRecords: events.map((e, i) => ({
        timeUnixNano: ns(new Date(Date.UTC(2026, 10, 10, 12, 0, i))), severityText: 'INFO', body: { stringValue: e.name },
        attributes: [kv('event.name', e.name), kv('session.id', e.session ?? 's1'), ...Object.entries(e.attrs ?? {}).map(([k, v]) => kv(k, v))],
      })) }],
    }],
  };
}

async function withServer(dir, fn) {
  const server = createServer({ dir });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    return await fn(base);
  } finally {
    await new Promise((r) => server.close(r));
  }
}

test('anyValue and attrs decode OTLP shapes', () => {
  assert.equal(anyValue({ stringValue: 'x' }), 'x');
  assert.equal(anyValue({ intValue: '42' }), 42);
  assert.equal(anyValue({ doubleValue: 0.5 }), 0.5);
  assert.equal(anyValue({ boolValue: false }), false);
  assert.deepEqual(anyValue({ arrayValue: { values: [{ intValue: '1' }, { stringValue: 'a' }] } }), [1, 'a']);
  assert.deepEqual(attrs([kv('a', 1), kv('b', 'c'), { key: 7 }]), { a: 1, b: 'c' });
});

test('collector over HTTP: logs, metrics and traces land in the monthly store with resource tags; bad JSON is 400; unknown route 404', async (t) => {
  const dir = path.join(tmpPath(t), 'store');
  await withServer(dir, async (base) => {
    const post = (route, body) => fetch(base + route, { method: 'POST', headers: { 'content-type': 'application/json' }, body: typeof body === 'string' ? body : JSON.stringify(body) });
    let r = await post('/v1/logs', logsPayload('hya', 'refund-route', [
      { name: 'claude_code.api_request', attrs: { model: 'claude-x', cost_usd: 0.25, input_tokens: 1000, output_tokens: 200, cache_read_tokens: 50, cache_creation_tokens: 0, duration_ms: 1200 } },
      { name: 'claude_code.tool_result', attrs: { tool_name: 'Read', success: true, duration_ms: 20 } },
    ]));
    assert.equal(r.status, 200);
    r = await post('/v1/metrics', { resourceMetrics: [{ resource: resource('hya', 'refund-route'), scopeMetrics: [{ metrics: [{ name: 'claude_code.cost.usage', unit: 'USD', sum: { aggregationTemporality: 1, dataPoints: [{ timeUnixNano: ns(new Date()), asDouble: 0.25, attributes: [kv('model', 'claude-x')] }] } }] }] }] });
    assert.equal(r.status, 200);
    r = await post('/v1/traces', { resourceSpans: [{ resource: resource('hya', 'refund-route'), scopeSpans: [{ spans: [{ name: 'claude_code.interaction', traceId: 'ab', spanId: 'cd', startTimeUnixNano: ns(new Date()), endTimeUnixNano: ns(new Date()) }] }] }] });
    assert.equal(r.status, 200);
    assert.equal((await post('/v1/logs', '{not json')).status, 400);
    assert.equal((await post('/v1/other', {})).status, 404);
    const h = await (await fetch(base + '/healthz')).json();
    assert.equal(h.records, 4);
  });
  const { records, files, bad } = readStore(dir);
  assert.equal(files, 1);
  assert.equal(bad, 0);
  assert.equal(records.length, 4);
  assert.deepEqual(records.map((r) => r.signal), ['log', 'log', 'metric', 'span']);
  assert.equal(records[0].resource['kit.lane'], 'refund-route');
  assert.equal(records[0].event, 'claude_code.api_request');
  assert.equal(records[0].attributes.cost_usd, 0.25);
  assert.equal(records[2].metric, 'claude_code.cost.usage');
  assert.ok(fs.existsSync(storeFile(dir)));
});

test('flattenLogs/flattenMetrics are pure and tolerate empty payloads', () => {
  assert.deepEqual(flattenLogs({}), []);
  assert.deepEqual(flattenMetrics({ resourceMetrics: [{}] }), []);
});

test('aggregate: cost to the cent from api_request only; tokens, errors, tools, models, sessions, range', () => {
  const recs = flattenLogs(logsPayload('hya', 'refund-route', [
    { name: 'claude_code.api_request', session: 's1', attrs: { model: 'm1', cost_usd: 0.101, input_tokens: 10, output_tokens: 5 } },
    { name: 'claude_code.api_request', session: 's2', attrs: { model: 'm2', cost_usd: 0.204, input_tokens: 20, output_tokens: 7, cache_read_tokens: 3 } },
    { name: 'claude_code.api_error', session: 's2', attrs: { status_code: 529 } },
    { name: 'claude_code.tool_result', session: 's2', attrs: { tool_name: 'Edit', success: true } },
    { name: 'claude_code.tool_result', session: 's2', attrs: { tool_name: 'Edit', success: false } },
    { name: 'claude_code.user_prompt', session: 's2', attrs: { cost_usd: 99 } }, // not an api_request: its cost_usd is ignored
  ]));
  const a = aggregate(recs);
  assert.equal(a.source, SOURCE);
  assert.equal(a.cost_usd, 0.31);
  assert.deepEqual(a.tokens, { input: 30, output: 12, cache_read: 3, cache_creation: 0 });
  assert.equal(a.api_requests, 2);
  assert.equal(a.api_errors, 1);
  assert.deepEqual(a.tool_calls, { Edit: { ok: 1, failed: 1 } });
  assert.deepEqual(a.models, { m1: 1, m2: 1 });
  assert.equal(a.sessions, 2);
  assert.ok(a.first < a.last);
});

test('laneMetrics / projectMetrics: the right lane, the right project, and null with telemetry-missing otherwise (fault 28)', (t) => {
  const dir = path.join(tmpPath(t), 'store');
  // no store at all
  const none = laneMetrics('refund-route', { dir });
  assert.equal(none.source, MISSING);
  assert.equal(none.cost_usd, null);
  assert.ok(none.why.includes('exporter off'));
  // a store with other lanes only
  append(dir, flattenLogs(logsPayload('hya', 'other', [{ name: 'claude_code.api_request', attrs: { cost_usd: 1.5 } }])));
  append(dir, flattenLogs(logsPayload('basic', 'refund-route', [{ name: 'claude_code.api_request', attrs: { cost_usd: 0.7 } }])));
  const miss = laneMetrics('refund-route', { project: 'hya', dir });
  assert.equal(miss.source, MISSING);
  assert.equal(miss.cost_usd, null);
  // records for this lane and project
  append(dir, flattenLogs(logsPayload('hya', 'refund-route', [{ name: 'claude_code.api_request', attrs: { cost_usd: 0.42, input_tokens: 5 } }])));
  const got = laneMetrics('refund-route', { project: 'hya', dir });
  assert.equal(got.cost_usd, 0.42);
  const proj = projectMetrics('hya', { dir });
  assert.equal(proj.cost_usd, 1.92);
  assert.deepEqual(Object.keys(proj.lanes).sort(), ['other', 'refund-route']);
  assert.equal(proj.lanes['refund-route'].cost_usd, 0.42);
  // CLI
  const r = runScript('metrics.js', ['lane', 'refund-route', '--project', 'hya', '--dir', dir, '--json']);
  assert.equal(r.returncode, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).cost_usd, 0.42);
  const text = runScript('metrics.js', ['lane', 'nope', '--dir', dir]).stdout;
  assert.ok(text.includes('cost n/a') && text.includes(MISSING));
});

test('telemetryEnv turns the exporter on and tags the lane; the sandbox allowlist admits the collector', (t) => {
  const env = telemetryEnv({ project: 'hya', slug: 'refund-route', stage: 'build', port: 4318 });
  assert.equal(env.CLAUDE_CODE_ENABLE_TELEMETRY, '1');
  assert.equal(env.OTEL_LOGS_EXPORTER, 'otlp');
  assert.equal(env.OTEL_METRICS_EXPORTER, 'otlp');
  assert.equal(env.OTEL_EXPORTER_OTLP_PROTOCOL, 'http/json');
  assert.equal(env.OTEL_EXPORTER_OTLP_ENDPOINT, 'http://127.0.0.1:4318');
  assert.equal(env.OTEL_RESOURCE_ATTRIBUTES, 'kit.project=hya,kit.lane=refund-route,kit.stage=build');
  const { root } = project(t);
  const cfg = sandboxConfig({ root, wt: root, slug: 'refund-route', env: { ...process.env, KIT_SANDBOX_RUNTIME: 'srt' } });
  assert.ok(cfg.allowedDomains.includes('127.0.0.1:4318'));
});

test('kit_status shows the exporter\'s cost to the cent, and flags a lane without telemetry (faults 28, 29)', (t) => {
  const { root } = project(t);
  const home = process.env.CLAUDE_HOME; // the test home; the store lives under it
  const dir = path.join(home, 'kit-telemetry');
  const out = JSON.parse(runScript('lane.js', ['start', 'refund-route', '--repo', root]).stdout);
  assert.ok(out.worktree);
  // cost display is optional and off by default (KIT-SPEC 9.4)
  let status0 = JSON.parse(runScript('kit_status.js', ['--repo', root, '--json']).stdout);
  assert.equal(status0.lanes.find((l) => l.slug === 'refund-route').cost, null);
  const kjPath = path.join(root, '.claude', 'kit.json');
  const kj = JSON.parse(fs.readFileSync(kjPath, 'utf8'));
  kj.telemetry = { show_cost: true };
  fs.writeFileSync(kjPath, JSON.stringify(kj, null, 2));
  const projectName = kj.project;
  let status = JSON.parse(runScript('kit_status.js', ['--repo', root, '--json']).stdout);
  let lane = status.lanes.find((l) => l.slug === 'refund-route');
  assert.equal(lane.cost.usd, null);
  assert.equal(lane.cost.source, MISSING);
  append(dir, flattenLogs(logsPayload(projectName, 'refund-route', [
    { name: 'claude_code.api_request', attrs: { cost_usd: 0.333, model: 'm' } },
    { name: 'claude_code.api_request', attrs: { cost_usd: 0.1, model: 'm' } },
  ])));
  status = JSON.parse(runScript('kit_status.js', ['--repo', root, '--json']).stdout);
  lane = status.lanes.find((l) => l.slug === 'refund-route');
  assert.equal(lane.cost.usd, 0.43);
  assert.equal(lane.cost.source, SOURCE);
  assert.equal(lane.cost.basis, 'api-equivalent');
  assert.equal(lane.cost.api_requests, 2);
  fs.rmSync(dir, { recursive: true, force: true });
});
