import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createContext } from '../lib/context.mjs';

test('EGO-only collection rejects browser fallbacks and account launches before accessing pages or profiles', async () => {
  const previousTransport = process.env.EMBODIED_BROWSER_TRANSPORT;
  const previousProfile = process.env.EMBODIED_BILIBILI_PROFILE_DIR;
  const directory = await mkdtemp(join(tmpdir(), 'embodied-ego-'));
  let ctx;
  try {
    process.env.EMBODIED_BROWSER_TRANSPORT = 'ego-only';
    process.env.EMBODIED_BILIBILI_PROFILE_DIR = join(directory, 'must-not-be-created');
    ctx = await createContext({ workDir: directory });
    await assert.rejects(ctx.browser.get('https://example.invalid/'), /requires EGO lite/);
    await assert.rejects(ctx.forSource('unitree-news').browser.get('https://example.invalid/'), /requires EGO lite/);
    await assert.rejects(ctx.accounts.bilibili.get('https://api.bilibili.com/'), /requires EGO lite/);
    assert.deepEqual(ctx.requests, []);
  } finally {
    if (ctx) await ctx.close();
    if (previousTransport === undefined) delete process.env.EMBODIED_BROWSER_TRANSPORT;
    else process.env.EMBODIED_BROWSER_TRANSPORT = previousTransport;
    if (previousProfile === undefined) delete process.env.EMBODIED_BILIBILI_PROFILE_DIR;
    else process.env.EMBODIED_BILIBILI_PROFILE_DIR = previousProfile;
    await rm(directory, { recursive: true, force: true });
  }
});
