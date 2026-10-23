import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {discover} from '../adapters/feeds.mjs';
import {replayFeedIntake,publicFeedUrl} from '../lib/feed-intake.mjs';
import * as html from '../lib/html.mjs';

test('RSS intake labels window, retains undated leads, records canonical duplicates and replays offline',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'feed-intake-'));
  const item=(id,url,date)=>`<item><guid>${id}</guid><title>Robot manipulation ${id}</title><link>${url}</link>${date?`<pubDate>${date}</pubDate>`:''}<description>Robot grasp control research</description></item>`;
  const xml=`<rss version="2.0"><channel><title>Robotics</title>${item('a','https://example.org/r?utm_source=x','Fri, 23 Oct 2026 01:00:00 GMT')}${item('b','https://example.org/r','Fri, 23 Oct 2026 01:00:00 GMT')}${item('c','https://example.org/c','')}${item('d','https://example.org/old','Mon, 19 Oct 2026 01:00:00 GMT')}</channel></rss>`;
  try {
    const r=await discover({id:'robot-feed',entryUrl:'https://example.org/rss'}, {workDir:dir,now:'2026-10-23T10:00:00Z',html,maxPages:1,http:{async get(url){return {text:xml,url,status:200,headers:{'set-cookie':'do-not-save'}};}}});
    assert.equal(r.candidates.length,4);
    assert.deepEqual(r.candidates.map(c=>c.metadata.feedIntake.windowStatus),['in_window','in_window','date_needs_verification','before_window']);
    assert.equal(r.candidates[1].metadata.feedIntake.duplicateOf,r.candidates[0].id);
    const file=join(dir,r.coverage.feedIntake),pack=JSON.parse(await readFile(file,'utf8'));
    assert.ok(!JSON.stringify(pack).includes('do-not-save'));
    assert.equal((await replayFeedIntake(file,html,discover)).candidates,4);
    await writeFile(join(file,'..',pack.responses[0].file),'tampered');
    await assert.rejects(replayFeedIntake(file,html,discover),/hash mismatch/);
  } finally {await rm(dir,{recursive:true,force:true});}
});
test('RSSHub URLs cannot carry credentials',()=>{
  assert.throws(()=>publicFeedUrl('https://rsshub.test/a?api_key=secret'));
  assert.throws(()=>publicFeedUrl('https://name:password@rsshub.test/a'));
  assert.equal(publicFeedUrl('http://localhost:1200/github/issue/ros2/ros2'),'http://localhost:1200/github/issue/ros2/ros2');
});
