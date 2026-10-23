import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import lockfile from 'proper-lockfile';
import { Pool } from '../lib/pool.mjs';

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'embodied-daily-test-'));
  const data = join(root, 'pool');
  const output = join(root, 'daily');
  const config = join(root, 'config.json');
  writeFileSync(config, JSON.stringify({ column: { name: 'Test daily' }, sources: [{ id: 'test', name: 'Test source', entryUrl: 'https://example.org' }] }));
  const source = { id: 'test', channelId: 'primary' };
  const candidate = { id: 'one', title: 'Robot experiment', url: 'https://example.org/robot', publishedAt: '2026-09-29T00:00:00Z' };
  const item = { ...candidate, sourceId: 'test', sourceItemId: 'one', channelId: 'primary', publishedAtRaw: '2026-09-29', datePrecision: 'day', content: 'The robot experiment documents the manipulation task, measured results and its limitations.', evidenceClass: 'official_announcement', evidence: [{ url: candidate.url, relation: 'original', kind: 'official_announcement' }], raw: { url: candidate.url, content: 'Captured public source evidence.' } };
  const pool = new Pool(data);
  pool.discover(source, [candidate], '2026-09-30T00:00:00Z');
  pool.accept(item, pool.candidateKey(source, candidate), '2026-09-30T00:00:00Z');
  pool.close();
  const run = () => spawnSync(process.execPath, ['bin/daily.mjs', '--skip-collect', 'true', '--data', data, '--output', output, '--config', config], { cwd: new URL('..', import.meta.url), encoding: 'utf8' });
  return { root, data, output, run, close: () => rmSync(root, { recursive: true, force: true }) };
}

test('the offline daily command creates real reports and verification without claiming collection', () => {
  const f = fixture();
  try {
    const result = f.run();
    assert.equal(result.status, 0, result.stderr);
    const status = JSON.parse(readFileSync(join(f.output, 'last-run.json'), 'utf8'));
    assert.equal(status.status, 'report_only');
    assert.equal(status.collectionPerformed, false);
    assert.equal(status.qualifiedItems, 1);
    assert.equal(JSON.parse(readFileSync(join(f.data, 'verification.json'), 'utf8')).status, 'pass');
    assert.ok(existsSync(join(f.root, 'current', 'acceptance.json')));
    assert.match(readFileSync(join(f.output, 'latest.md'), 'utf8'), /未重新联网采集/);
    assert.ok(!existsSync(join(f.data, 'daily.mutex')));
    assert.ok(!existsSync(join(f.data, 'collector.mutex')));
  } finally { f.close(); }
});

test('daily generation respects both the daily-round lease and an independent collector lease', async () => {
  const f = fixture();
  try {
    for (const name of ['daily.mutex', 'collector.mutex']) {
      const release = await lockfile.lock(f.data, { realpath: false, lockfilePath: join(f.data, name) });
      try {
        const result = f.run();
        assert.notEqual(result.status, 0);
        assert.match(result.stderr, /lock/i);
        assert.ok(!existsSync(join(f.output, 'last-run.json')));
      } finally { await release(); }
    }
    assert.equal(f.run().status, 0);
  } finally { f.close(); }
});
