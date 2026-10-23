import {configuredSources} from '../lib/rsshub.mjs';
import { readFile, writeFile, mkdir, copyFile } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import lockfile from 'proper-lockfile';
import { Pool } from '../lib/pool.mjs';
import { buildDigest } from '../lib/digest.mjs';
import { redact } from '../lib/sanitize.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
process.chdir(root);
const args = {};
const names = ['--data', '--output', '--config', '--limit', '--pages', '--timeout', '--retries', '--sources', '--skip-collect'];
for (let i = 2; i < process.argv.length; i += 2) {
  if (!names.includes(process.argv[i]) || process.argv[i + 1] === undefined) throw new Error('Unknown argument or missing value: ' + process.argv[i]);
  args[process.argv[i].slice(2)] = process.argv[i + 1];
}
const data = resolve(args.data || 'data/live');
const output = resolve(args.output || 'reports/daily');
const configPath = resolve(args.config || 'config/sources.json');
await mkdir(data, { recursive: true });
await mkdir(output, { recursive: true });
const runId = new Date().toISOString().replace(/[:.]/g, '-');
const logDir = join(data, 'daily-runs', runId);
await mkdir(logDir, { recursive: true });
const release = await lockfile.lock(join(data, 'daily-runs'), { lockfilePath: join(data, 'daily.mutex'), realpath: false, stale: 60000, update: 10000, retries: 0 });
let child;
let releaseData;
let cancelled = false;
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { cancelled = true; child?.kill(signal); });
async function run(script, parameters, label) {
  if (cancelled) throw new Error('Daily run cancelled');
  const log = createWriteStream(join(logDir, label + '.log'), { encoding: 'utf8' });
  child = spawn(process.execPath, [script, ...parameters], { cwd: root, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
  for (const input of [child.stdout, child.stderr]) {
    const reader = createInterface({ input });
    reader.on('line', line => {
      log.write(redact(line) + '\n');
      try {
        const row = JSON.parse(line);
        if (row.sourceId) console.log(`${row.sourceId}/${row.channelId}: ${row.status}; accepted=${row.accepted}; failed=${row.failed}`);
        else console.log(redact(line));
      } catch { if (label !== 'report') console.log(redact(line)); }
    });
  }
  let code;
  try { [code] = await once(child, 'close'); }
  finally { child = null; log.end(); await once(log, 'finish'); }
  if (cancelled) throw new Error('Daily run cancelled');
  if (code !== 0) throw new Error(`${label} exited with code ${code}; see ${join(logDir, label + '.log')}`);
}
try {
  const startedAt = new Date().toISOString();
  const collect = args['skip-collect'] !== 'true';
  if (collect) {
    const params = ['--data', data, '--config', configPath, '--limit', args.limit || '5', '--pages', args.pages || '2', '--timeout', args.timeout || '20000', '--retries', args.retries || '1'];
    if (args.sources) params.push('--sources', args.sources);
    await run('bin/collect.mjs', params, 'collection');
  }
  releaseData = await lockfile.lock(data, { lockfilePath: join(data, 'collector.mutex'), realpath: false, stale: 60000, update: 10000, retries: 0 });
  const pool = new Pool(data);
  let items;
  let revalidation;
  try { revalidation = pool.revalidate(); items = pool.export(); await writeFile(join(data, 'pool.jsonl'), items.map(item => JSON.stringify(item)).join('\n') + '\n', 'utf8'); }
  finally { pool.close(); }
  const config = JSON.parse(await readFile(configPath, 'utf8'));
  config.sources=await configuredSources(config,configPath);
  let latestRun = null;
  try { latestRun = JSON.parse(await readFile(join(data, 'latest-run.json'), 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const currentRun = collect && latestRun?.startedAt >= startedAt ? latestRun : null;
  const digest = buildDigest({ items, config, run: collect ? currentRun : latestRun, collectedThisRun: Boolean(currentRun) });
  const markdownPath = join(output, digest.data.date + '.md');
  const jsonPath = join(output, digest.data.date + '.json');
  await writeFile(markdownPath, digest.markdown, 'utf8');
  await writeFile(jsonPath, JSON.stringify(digest.data, null, 2) + '\n', 'utf8');
  await copyFile(markdownPath, join(output, 'latest.md'));
  await copyFile(jsonPath, join(output, 'latest.json'));
  await run('bin/verify.mjs', [data], 'verification');
  await run('bin/report.mjs', ['--data', data, '--config', configPath, '--output', join(output, '..', 'current')], 'report');
  const problems = digest.data.sourceHealth.filter(row => row.status !== 'sample_verified');
  const result = { runId, startedAt, finishedAt: new Date().toISOString(), collectionPerformed: Boolean(currentRun), status: collect ? problems.length ? 'completed_with_source_gaps' : 'complete' : 'report_only', qualifiedItems: items.length, freshEvents: digest.data.freshEvents, selectedEvents: digest.data.selectedEvents, sourceGaps: problems.map(row => ({ sourceId: row.sourceId, channelId: row.channelId, status: row.status })), revalidation, markdownPath, jsonPath, logDir };
  await writeFile(join(logDir, 'result.json'), JSON.stringify(result, null, 2) + '\n', 'utf8');
  await writeFile(join(output, 'last-run.json'), JSON.stringify(result, null, 2) + '\n', 'utf8');
  console.log(JSON.stringify(result));
  if (collect && (!currentRun || currentRun.channels.every(row => row.accepted === 0))) process.exitCode = 2;
} finally {
  try { if (releaseData) await releaseData(); }
  finally { await release(); }
}
