#!/usr/bin/env node
/**
 * Drives the dashboard server for the planted-fault suite (which is synchronous): serves --repo ROOT on a free port,
 * sends the requests in the JSON array on stdin, prints the status of each as a JSON array.
 * A request is {method, path, headers}; "{port}" inside a header value becomes the server's port.
 */
import http from 'node:http';
import { once } from 'node:events';
import { ArgumentParser } from '../kit/scripts/args.js';
import * as S from '../kit/dashboard/server.js';

function send(port, r) {
  const headers = Object.fromEntries(Object.entries(r.headers ?? {}).map(([k, v]) => [k, String(v).replaceAll('{port}', port)]));
  return new Promise((resolve) => {
    const req = http.request({ host: '127.0.0.1', port, path: r.path, method: r.method ?? 'GET', headers, agent: false, timeout: 5000 }, (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode));
    });
    req.on('error', () => resolve(0));
    req.on('timeout', () => req.destroy());
    req.end();
  });
}

async function main() {
  const p = new ArgumentParser();
  p.addArgument('--repo');
  const a = p.parseArgs(process.argv.slice(2));
  process.env.KIT_STATUS_NO_GH = '1';
  let input = '';
  for await (const c of process.stdin) input += c;
  const httpd = S.serve([a.repo], 0, false, 0.2);
  await once(httpd, 'listening');
  const { port } = httpd.address();
  const out = [];
  for (const r of JSON.parse(input)) out.push(await send(port, r));
  process.stdout.write(JSON.stringify(out) + '\n');
  httpd.close();
}
main();
