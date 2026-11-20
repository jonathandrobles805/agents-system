// The agents' GitHub identity: a short-lived installation token of the kit's GitHub App (hardening plan D1, 0016 E.7).
//
// One layer uses it, `lane.js publish`: pushing a lane or spec branch and opening its PR, on the owner's machine. The
// App's private key stays on that machine, outside every repository; the kit reads it only to sign a ten-minute JWT,
// exchanges the JWT for an installation token limited to one repository and to contents + pull requests, and never
// prints either. GitHub's own documentation of the flow: "Generating an installation access token for a GitHub App".
//
// Configuration (first one found wins):
//   KIT_APP_ID and KIT_APP_PRIVATE_KEY (a path to the .pem) in the environment, or
//   ~/.claude/kit-app.json: { "app_id": 5840689, "private_key": "/path/outside/any/repo/agents-system-bot.pem" }
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const API = 'https://api.github.com';
const UA = 'agents-system-kit';

/** { app_id, private_key } or null with a reason: where the owner configures the App on this machine. */
export function appConfig(env = process.env, home = os.homedir()) {
  if (env.KIT_APP_ID || env.KIT_APP_PRIVATE_KEY) {
    if (!env.KIT_APP_ID || !env.KIT_APP_PRIVATE_KEY) return { config: null, reason: 'set both KIT_APP_ID and KIT_APP_PRIVATE_KEY (a path to the .pem), or neither' };
    return { config: { app_id: String(env.KIT_APP_ID), private_key: env.KIT_APP_PRIVATE_KEY, source: 'environment' }, reason: '' };
  }
  const p = path.join(home, '.claude', 'kit-app.json');
  if (!fs.existsSync(p)) return { config: null, reason: `no GitHub App configured: write ${p} as {"app_id": <id>, "private_key": "<path to the .pem, outside every repository>"} or set KIT_APP_ID and KIT_APP_PRIVATE_KEY` };
  let j;
  try { j = JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { return { config: null, reason: `${p}: not JSON (${e.message})` }; }
  if (!j || typeof j !== 'object' || !j.app_id || typeof j.private_key !== 'string') return { config: null, reason: `${p}: needs "app_id" and "private_key" (a path)` };
  return { config: { app_id: String(j.app_id), private_key: j.private_key, source: p }, reason: '' };
}

const b64url = (buf) => Buffer.from(buf).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');

/** A JWT GitHub accepts as the App itself: RS256, issued a minute ago (clock drift), valid nine minutes (ten is the maximum). */
export function appJwt(appId, privateKeyPem, now = Math.floor(Date.now() / 1000)) {
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const payload = b64url(JSON.stringify({ iat: now - 60, exp: now + 9 * 60, iss: String(appId) }));
  const sig = crypto.sign('RSA-SHA256', Buffer.from(`${header}.${payload}`), privateKeyPem);
  return `${header}.${payload}.${b64url(sig)}`;
}

async function call(fetchFn, url, token, init = {}) {
  const r = await fetchFn(url, { ...init, headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${token}`, 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': UA, ...(init.headers ?? {}) } });
  const text = await r.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = null; }
  return { status: r.status, data, text };
}

/**
 * An installation token for one repository, limited to contents and pull requests (write). Returns
 * { ok, token, expires_at, installation_id, reason }. The token is never logged; callers pass it to git and gh through
 * the environment only. `fetchFn` is injectable for tests.
 */
export async function installationToken({ appId, privateKeyPem, owner, repo, fetchFn = globalThis.fetch, now }) {
  const jwt = appJwt(appId, privateKeyPem, now);
  const inst = await call(fetchFn, `${API}/repos/${owner}/${repo}/installation`, jwt);
  if (inst.status !== 200 || typeof inst.data?.id !== 'number') {
    const why = inst.status === 404 ? `the App is not installed on ${owner}/${repo} (install it from the App's settings page)` : inst.data?.message || `HTTP ${inst.status}`;
    return { ok: false, reason: `could not find the App's installation on ${owner}/${repo}: ${why}` };
  }
  const tok = await call(fetchFn, `${API}/app/installations/${inst.data.id}/access_tokens`, jwt, {
    method: 'POST', body: JSON.stringify({ repositories: [repo], permissions: { contents: 'write', pull_requests: 'write' } }),
  });
  if (tok.status !== 201 || typeof tok.data?.token !== 'string') {
    return { ok: false, reason: `could not create an installation token: ${tok.data?.message || `HTTP ${tok.status}`}` };
  }
  return { ok: true, token: tok.data.token, expires_at: tok.data.expires_at ?? null, installation_id: inst.data.id, reason: '' };
}

/** Read the private key named by the config. Refuses a key inside the repository: it must never be committed. */
export function readPrivateKey(config, repoRoot) {
  const p = path.resolve(config.private_key.startsWith('~/') ? path.join(os.homedir(), config.private_key.slice(2)) : config.private_key);
  if (repoRoot && (p === path.resolve(repoRoot) || p.startsWith(path.resolve(repoRoot) + path.sep))) return { pem: null, reason: `the App's private key ${p} is inside the repository; move it outside (it must never be committed)` };
  if (!fs.existsSync(p)) return { pem: null, reason: `the App's private key ${p} does not exist` };
  const pem = fs.readFileSync(p, 'utf8');
  if (!/-----BEGIN (RSA )?PRIVATE KEY-----/.test(pem)) return { pem: null, reason: `${p} is not a PEM private key` };
  return { pem, reason: '' };
}
