import test from 'node:test';
import assert from 'node:assert/strict';
import { redact } from '../lib/sanitize.mjs';
test('failure logs redact challenge tokens and credential headers while preserving ordinary evidence links',()=>{
  const value=redact({error:'redirect https://mp.weixin.qq.com/challenge?poc_token=secret&target_url=public',headers:{authorization:'Bearer secret'},url:'https://arxiv.org/abs/2609.12345'});
  assert.ok(!JSON.stringify(value).includes('secret'));assert.equal(value.url,'https://arxiv.org/abs/2609.12345');
});

test('Playwright verbose error headers cannot leak session cookies or authorization',()=>{
 const value=redact('request failed\nCall log:\n\u001b[2m  - cookie: SESSDATA=fixture-secret; session=another-secret\u001b[22m\n  - Authorization: Bearer fixture-secret\n  - referer: https://www.bilibili.com/');
 assert.ok(!value.includes('fixture-secret'));assert.ok(!value.includes('another-secret'));assert.ok(value.includes('referer: https://www.bilibili.com/'));
});
