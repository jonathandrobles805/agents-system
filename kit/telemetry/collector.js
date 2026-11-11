#!/usr/bin/env node
// Kit telemetry collector (KIT-SPEC 9.4, decision 0010): an OTLP/HTTP JSON receiver with no dependencies.
//
// Accepts POST /v1/logs, /v1/metrics, /v1/traces from Claude Code's OpenTelemetry exporter, flattens every record with
// its resource attributes (kit.project, kit.lane, kit.stage, session.id, ...) and appends one JSON line per record to
// $CLAUDE_HOME/kit-telemetry/<YYYY-MM>.jsonl. It stores; it never interprets. metrics.js reads the store.
//
//   node kit/telemetry/collector.js [--port 4318] [--host 127.0.0.1] [--dir <store dir>]
//   GET /healthz → {"ok":true,"records":N}
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const DEFAULT_PORT = 4318;
export const DEFAULT_HOST = '127.0.0.1';

export function storeDir(env = process.env) {
  return path.join(env.CLAUDE_HOME || path.join(os.homedir(), '.claude'), 'kit-telemetry');
}

export function storeFile(dir, when = new Date()) {
  return path.join(dir, `${when.toISOString().slice(0, 7)}.jsonl`);
}

/** OTLP AnyValue → plain JS value. */
export function anyValue(v) {
  if (v == null || typeof v !== 'object') return v ?? null;
  if ('stringValue' in v) return v.stringValue;
  if ('intValue' in v) return Number(v.intValue);
  if ('doubleValue' in v) return v.doubleValue;
  if ('boolValue' in v) return v.boolValue;
  if ('arrayValue' in v) return (v.arrayValue?.values ?? []).map(anyValue);
  if ('kvlistValue' in v) return attrs(v.kvlistValue?.values ?? []);
  if ('bytesValue' in v) return v.bytesValue;
  return null;
}

/** OTLP KeyValue[] → object. */
export function attrs(list) {
  const out = {};
  for (const kv of Array.isArray(list) ? list : []) {
    if (kv && typeof kv.key === 'string') out[kv.key] = anyValue(kv.value);
  }
  return out;
}

const nanoToIso = (n) => {
  const ms = Number(BigInt(String(n ?? 0)) / 1000000n);
  return ms ? new Date(ms).toISOString() : null;
};

/** Flatten an OTLP logs payload into records. */
export function flattenLogs(body) {
  const out = [];
  for (const rl of body?.resourceLogs ?? []) {
    const resource = attrs(rl.resource?.attributes);
    for (const sl of rl.scopeLogs ?? []) {
      for (const rec of sl.logRecords ?? []) {
        const a = attrs(rec.attributes);
        out.push({
          signal: 'log',
          ts: nanoToIso(rec.timeUnixNano ?? rec.observedTimeUnixNano),
          event: a['event.name'] ?? a.event_name ?? (typeof anyValue(rec.body) === 'string' ? anyValue(rec.body) : null),
          body: anyValue(rec.body),
          severity: rec.severityText ?? null,
          resource,
          attributes: a,
        });
      }
    }
  }
  return out;
}

/** Flatten an OTLP metrics payload into one record per data point. */
export function flattenMetrics(body) {
  const out = [];
  for (const rm of body?.resourceMetrics ?? []) {
    const resource = attrs(rm.resource?.attributes);
    for (const sm of rm.scopeMetrics ?? []) {
      for (const m of sm.metrics ?? []) {
        const points = m.sum?.dataPoints ?? m.gauge?.dataPoints ?? m.histogram?.dataPoints ?? [];
        for (const dp of points) {
          out.push({
            signal: 'metric',
            ts: nanoToIso(dp.timeUnixNano),
            metric: m.name,
            unit: m.unit ?? null,
            value: dp.asDouble ?? (dp.asInt != null ? Number(dp.asInt) : dp.sum ?? null),
            temporality: m.sum?.aggregationTemporality ?? null,
            resource,
            attributes: attrs(dp.attributes),
          });
        }
      }
    }
  }
  return out;
}

/** Flatten an OTLP traces payload into one record per span. */
export function flattenTraces(body) {
  const out = [];
  for (const rs of body?.resourceSpans ?? []) {
    const resource = attrs(rs.resource?.attributes);
    for (const ss of rs.scopeSpans ?? []) {
      for (const sp of ss.spans ?? []) {
        out.push({
          signal: 'span', ts: nanoToIso(sp.startTimeUnixNano), name: sp.name, trace_id: sp.traceId ?? null, span_id: sp.spanId ?? null,
          parent_span_id: sp.parentSpanId ?? null, end: nanoToIso(sp.endTimeUnixNano), resource, attributes: attrs(sp.attributes),
        });
      }
    }
  }
  return out;
}

export function flatten(route, body) {
  if (route === '/v1/logs') return flattenLogs(body);
  if (route === '/v1/metrics') return flattenMetrics(body);
  if (route === '/v1/traces') return flattenTraces(body);
  return null;
}

/** Append records to the store; returns how many were written. */
export function append(dir, records, when = new Date()) {
  if (!records.length) return 0;
  fs.mkdirSync(dir, { recursive: true });
  const received = when.toISOString();
  fs.appendFileSync(storeFile(dir, when), records.map((r) => JSON.stringify({ received, ...r })).join('\n') + '\n');
  return records.length;
}

/** Create (not yet listening) the HTTP server. */
export function createServer({ dir = storeDir(), maxBody = 16 * 1024 * 1024, onRecords = null } = {}) {
  let total = 0;
  return http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/healthz') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, records: total, dir }));
      return;
    }
    const route = (req.url ?? '').split('?')[0];
    if (req.method !== 'POST' || !['/v1/logs', '/v1/metrics', '/v1/traces'].includes(route)) {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end('{"error":"not found"}');
      return;
    }
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > maxBody) {
        res.writeHead(413);
        res.end();
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      let body;
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
      } catch {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end('{"error":"invalid json (the kit collector accepts OTLP/HTTP JSON; set OTEL_EXPORTER_OTLP_PROTOCOL=http/json)"}');
        return;
      }
      const records = flatten(route, body) ?? [];
      const n = append(dir, records);
      total += n;
      if (onRecords) onRecords(records);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{}'); // an empty ExportServiceResponse means "all accepted"
    });
  });
}

export function main(argv = process.argv.slice(2)) {
  const opt = (flag, dflt) => {
    const i = argv.indexOf(flag);
    return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt;
  };
  const port = Number(opt('--port', process.env.KIT_TELEMETRY_PORT || DEFAULT_PORT));
  const host = opt('--host', DEFAULT_HOST);
  const dir = opt('--dir', storeDir());
  const server = createServer({ dir });
  server.listen(port, host, () => {
    process.stdout.write(`kit telemetry collector: http://${host}:${port} → ${dir}\n`);
  });
  server.on('error', (e) => {
    process.stderr.write(`collector: ${e.code === 'EADDRINUSE' ? `port ${port} is in use (another collector running?)` : e.message}\n`);
    process.exitCode = 1;
  });
  return server;
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url))) main();
