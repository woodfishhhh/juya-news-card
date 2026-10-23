import {createHash} from 'node:crypto';
import {mkdir, readFile, writeFile} from 'node:fs/promises';
import {join, resolve, relative, isAbsolute} from 'node:path';
import {redact} from './sanitize.mjs';

const sha = text => createHash('sha256').update(text).digest('hex');
export function publicFeedUrl(value) {
  const u = new URL(value);
  if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password ||
      [...u.searchParams.keys()].some(k => /token|secret|signature|password|api.?key|auth/i.test(k)))
    throw new Error('Use a public RSS/Atom/RSSHub URL without credentials');
  return u.href;
}
export function feedCanonical(value) {
  const u = new URL(publicFeedUrl(value)); u.hash = '';
  for (const k of [...u.searchParams.keys()]) if (/^utm_|^(fbclid|gclid)$/i.test(k)) u.searchParams.delete(k);
  u.searchParams.sort(); return u.href;
}
export function intakeWindow(now, window) {
  const until = new Date(window?.until ?? now);
  const since = new Date(window?.since ?? until.valueOf() - 86400000);
  if (!Number.isFinite(since.valueOf()) || !Number.isFinite(until.valueOf()) || since >= until)
    throw new Error('Invalid feed intake window');
  return {since: since.toISOString(), until: until.toISOString()};
}
export async function withFeedIntake(source, ctx, discover) {
  // Preserve all candidates for the durable pool; a window label is not an editorial verdict.
  const window = intakeWindow(ctx.now, ctx.feedWindow), responses = [];
  const scoped = {...ctx, http: {...ctx.http, async get(url, options) {
    publicFeedUrl(url);
    const observedAt = new Date().toISOString();
    try {
      const r = await ctx.http.get(url, options);
      const headers = Object.fromEntries(Object.entries(r.headers ?? {}).filter(([k]) => ['link', 'content-type', 'etag', 'last-modified'].includes(k.toLowerCase())));
      responses.push({url, observedAt, response: {text: r.text, url: publicFeedUrl(r.url ?? url), status: r.status, headers}});
      return r;
    } catch (error) {
      responses.push({url, observedAt, error: redact(String(error.message ?? error)), status: error.status ?? null});
      throw error;
    }
  }}};
  const result = await discover(source, scoped), seen = new Map();
  const candidates = result.candidates.map(c => {
    let canonicalUrl;
    try { canonicalUrl = feedCanonical(c.url); } catch { canonicalUrl = null; }
    // IEEE roundup segments share a discovery URL but are distinct events.
    const key = (canonicalUrl ?? c.id) + (c.metadata?.segmentUrl ? '#' + feedCanonical(c.metadata.segmentUrl) : '');
    const duplicateOf = seen.get(key) ?? null;
    if (!duplicateOf) seen.set(key, c.id);
    const time = Date.parse(c.publishedAt), precise = c.datePrecision === 'second' && Number.isFinite(time);
    const windowStatus = !precise ? 'date_needs_verification' : time < Date.parse(window.since) ? 'before_window' : time >= Date.parse(window.until) ? 'after_window' : 'in_window';
    return {...c, metadata: {...c.metadata, feedIntake: {canonicalUrl, duplicateOf, windowStatus, dateVerified: false}}};
  });
  result.candidates = candidates;
  if (!ctx.workDir) return result; // In-memory adapter callers still get date/dedup labels.
  const id = sha(source.id + '/' + (source.channelId ?? 'primary')).slice(0, 16);
  const folder = join(ctx.workDir, 'feed-intake', id);
  await mkdir(join(folder, 'responses'), {recursive: true});
  const receipts = [];
  for (const row of responses) {
    if (!row.response) { receipts.push(row); continue; }
    // Public response bodies only; never archive request/cookie/authentication headers.
    const text = redact(row.response.text), digest = sha(text), file = `responses/${digest}.txt`;
    await writeFile(join(folder, file), text, 'utf8');
    receipts.push({url: row.url, observedAt: row.observedAt, finalUrl: row.response.url, status: row.response.status, headers: row.response.headers, file, sha256: digest, redacted: text !== row.response.text});
  }
  const pack = {schemaVersion: 1, source, observedAt: ctx.now, window,
    discoveryOptions: {maxPages: ctx.maxPages ?? 3, state: ctx.state ?? {}},
    responses: receipts, candidates, issues: result.issues, coverage: result.coverage, nextState: result.nextState,
    qualification: 'Feed discovery only; original body and date must pass normal hydration'};
  const serialized = JSON.stringify(redact(pack), null, 2) + '\n';
  const file = `intake-${sha(serialized).slice(0, 16)}.json`;
  await writeFile(join(folder, file), serialized, {encoding: 'utf8', flag: 'wx'});
  result.coverage.feedIntake = relative(ctx.workDir, join(folder, file)).replaceAll('\\', '/');
  result.coverage.intakeWindow = window;
  return result;
}
export async function replayFeedIntake(file, html, discover) {
  const pack = JSON.parse(await readFile(file, 'utf8')), folder = resolve(file, '..');
  const queues = new Map();
  for (const row of pack.responses) {
    if (row.redacted) throw new Error('Redacted intake cannot prove exact replay');
    let text;
    if (row.file) {
      const path = resolve(folder, row.file), rel = relative(folder, path);
      if (rel.startsWith('..') || isAbsolute(rel)) throw new Error('Unsafe intake response path');
      text = await readFile(path, 'utf8');
      if (sha(text) !== row.sha256) throw new Error('Feed snapshot hash mismatch');
    }
    if (!queues.has(row.url)) queues.set(row.url, []);
    queues.get(row.url).push({...row, text});
  }
  const result = await discover(pack.source, {now: pack.observedAt, ...pack.discoveryOptions, feedWindow: pack.window, html,
    http: {async get(url) {
      const row = queues.get(url)?.shift();
      if (!row) throw new Error('Offline intake has no response for ' + url);
      if (row.error) throw Object.assign(new Error(row.error), {status: row.status});
      return {text: row.text, url: row.finalUrl, status: row.status, headers: row.headers ?? {}};
    }}});
  if (JSON.stringify(result.candidates) !== JSON.stringify(pack.candidates)) throw new Error('Feed replay candidates changed');
  return {status: 'offline_feed_replay_passed', candidates: result.candidates.length, window: pack.window};
}
