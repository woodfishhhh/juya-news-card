import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Pool, canonicalUrl, validateItem, hash } from '../lib/pool.mjs';

const source = {id:'test',channelId:'primary'};
const candidate = {id:'one',url:'https://example.org/article',title:'Robot manipulation study',publishedAt:'2026-09-29T00:00:00.000Z'};
const item = {sourceId:'test',sourceItemId:'one',channelId:'primary',title:candidate.title,url:candidate.url,publishedAt:candidate.publishedAt,publishedAtRaw:'2026-09-29',datePrecision:'day',content:'This is a substantive robotics experiment description and its documented limitations.',evidenceClass:'official_announcement',evidence:[{url:candidate.url,kind:'official_announcement',relation:'original'}],raw:{url:candidate.url,mediaType:'text/html',content:'<article>Documented robotics evidence.</article>'}};
function withPool(fn) { const dir=mkdtempSync(join(tmpdir(),'embodied-pool-')); const pool=new Pool(dir); try { fn(pool,dir); } finally { pool.close();rmSync(dir,{recursive:true,force:true}); } }
test('repeated discoveries and bodies do not duplicate items or revisions; changed body adds a revision',()=>withPool((p,dir)=>{
  p.discover(source,[candidate], '2026-09-30T00:00:00.000Z'); const key=p.candidateKey(source,candidate);
  assert.equal(p.accept(item,key,'2026-09-30T01:00:00.000Z').action,'inserted');
  p.discover(source,[candidate], '2026-09-30T02:00:00.000Z');
  assert.equal(p.accept(item,key,'2026-09-30T02:00:00.000Z').action,'unchanged');
  assert.equal(p.accept({...item,content:item.content+' A later correction documents an additional limitation.'},key,'2026-09-30T03:00:00.000Z').action,'updated');
  assert.equal(p.stats().items,1); assert.equal(p.stats().versions,2);
  const out=p.export()[0]; assert.equal(out.firstDiscoveredAt,'2026-09-30T00:00:00.000Z'); assert.equal(out.revision,2);
  assert.equal(readFileSync(join(dir,out.raw.snapshotPath),'utf8'),item.raw.content);
}));
test('a source version changes even with an unchanged abstract, while legacy hashes and scrape metadata do not create false revisions',()=>withPool(p=>{
  const paper={...item,metadata:{latestVersionUpdatedAt:'2026-09-29T00:00:00Z'}};
  p.discover(source,[candidate],'2026-09-30T00:00:00Z');const key=p.candidateKey(source,candidate);
  p.accept(paper,key,'2026-09-30T01:00:00Z');
  const legacyHash=hash(JSON.stringify({title:paper.title,publishedAt:paper.publishedAt,publishedAtRaw:paper.publishedAtRaw,datePrecision:paper.datePrecision,content:paper.content,evidenceClass:paper.evidenceClass,evidence:paper.evidence}));
  const legacyPayload={...p.export()[0],contentHash:legacyHash};
  p.db.prepare('UPDATE items SET content_hash=?,payload=? WHERE id=?').run(legacyHash,JSON.stringify(legacyPayload),key);
  p.db.prepare('UPDATE versions SET content_hash=?,payload=? WHERE item_id=? AND revision=1').run(legacyHash,JSON.stringify(legacyPayload),key);
  assert.equal(p.accept({...paper,metadata:{...paper.metadata,scrapedAt:'later',signedUrl:'ephemeral'}},key,'2026-09-30T02:00:00Z').action,'unchanged');
  assert.equal(p.stats().versions,1);assert.equal(p.export()[0].contentHash,legacyHash);
  const newVersion={...paper,metadata:{latestVersionUpdatedAt:'2026-09-30T03:00:00Z'}};
  assert.equal(p.accept(newVersion,key,'2026-09-30T04:00:00Z').action,'updated');
  assert.equal(p.export()[0].revision,2);assert.equal(p.stats().versions,2);
  assert.equal(p.accept(newVersion,key,'2026-09-30T05:00:00Z').action,'unchanged');
  assert.equal(p.db.prepare('SELECT content_hash FROM versions WHERE item_id=? AND revision=1').get(key).content_hash,legacyHash);
}));

test('discovery requeues a changed publisher version and prioritizes an updated old paper over older pending publications',()=>withPool(p=>{
  const old={...candidate,publishedAt:'2026-04-09T00:00:00Z',metadata:{arxivUpdatedAt:'2026-09-01T00:00:00Z'}};
  p.discover(source,[old],'2026-09-30T00:00:00Z');const key=p.candidateKey(source,old);
  p.accept({...item,publishedAt:old.publishedAt},key,'2026-09-30T00:00:00Z');
  p.discover(source,[{...old,metadata:{...old.metadata,discoveryUrl:'https://example.org/list?page=2'}}],'2026-09-30T01:00:00Z');
  assert.equal(p.db.prepare('SELECT status FROM candidates WHERE key=?').get(key).status,'accepted');
  const updated={...old,metadata:{arxivUpdatedAt:'2026-09-30T00:00:00Z'}};
  p.discover(source,[{...candidate,url:'https://example.org/new'},updated],'2026-09-30T02:00:00Z');
  assert.equal(p.db.prepare('SELECT status FROM candidates WHERE key=?').get(key).status,'pending');
  assert.equal(p.queue(source,{limit:1})[0].key,key);
  assert.equal(p.stats().items,1);
}));

test('failed and interrupted candidates remain retryable; discovery never marks unhydrated candidates seen',()=>withPool((p)=>{
  p.discover(source,[candidate,{...candidate,id:'two',url:'https://example.org/second'}],'2026-09-30T00:00:00.000Z');
  const key=p.candidateKey(source,candidate); p.fail('test-run',source,key,'hydrate',new Error('temporary timeout'),'2026-09-30T00:00:00.000Z');
  assert.equal(p.queue(source,{force:true}).length,2); assert.equal(p.stats().items,0);
  p.db.prepare("UPDATE candidates SET status='processing' WHERE key=?").run(key);
  const observer=new Pool(p.directory);assert.equal(observer.db.prepare('SELECT status FROM candidates WHERE key=?').get(key).status,'processing');observer.close();
  const recovery=new Pool(p.directory,{recover:true});assert.equal(recovery.db.prepare('SELECT status FROM candidates WHERE key=?').get(key).status,'pending');recovery.close();
  assert.equal(p.queue(source,{force:true}).length,2);
}));
test('different discovery sources with the same original paper join one event and keep both provenance records',()=>withPool(p=>{
  p.discover(source,[candidate],'2026-09-30T00:00:00.000Z'); p.accept(item,p.candidateKey(source,candidate),'2026-09-30T01:00:00.000Z');
  const media={id:'media',channelId:'primary'}; const c={...candidate,id:'media-one',url:'https://media.example.org/report'};
  p.discover(media,[c],'2026-09-30T02:00:00.000Z'); p.accept({...item,sourceId:'media',sourceItemId:c.id,url:c.url,evidence:[...item.evidence,{url:c.url,kind:'independent_reporting',relation:'discovery'}]},p.candidateKey(media,c),'2026-09-30T02:00:00.000Z');
  assert.equal(p.stats().events,1);assert.equal(p.stats().items,2);
}));
test('rejects title-only bodies, absent dates and challenge pages',()=>{
  assert.throws(()=>validateItem({...item,content:item.title}),/body/);
  assert.throws(()=>validateItem({...item,publishedAt:null}),/publishedAt/);
  assert.throws(()=>validateItem({...item,content:'Vercel Security Checkpoint '.repeat(5)}),/Challenge/);
  assert.throws(()=>validateItem({...item,sourceId:'qbitai-feed',title:'New chat app',content:'A language model chat application includes software navigation and automation features for office tasks.'}),/unrelated/);
});
test('arxiv versions and tracking URLs canonicalize without dropping meaningful query parameters',()=>{
  assert.equal(canonicalUrl('https://arxiv.org/pdf/2609.12345v2.pdf'),'https://arxiv.org/abs/2609.12345');
  assert.equal(canonicalUrl('https://a.example/news?utm_source=x&id=3#top'),'https://a.example/news?id=3');
});
test('multiple projects in one media roundup remain separate candidates and events',()=>withPool(p=>{
  const first={...candidate,metadata:{roundupSegment:true,segmentUrl:'https://project.example.org/one'}};
  const second={...candidate,id:'two',metadata:{roundupSegment:true,segmentUrl:'https://project.example.org/two'}};
  p.discover(source,[first,second],'2026-09-30T00:00:00.000Z');assert.equal(p.stats().candidates,2);
  for(const c of [first,second])p.accept({...item,metadata:c.metadata,evidence:[{url:c.metadata.segmentUrl,kind:'project',relation:'original'}]},p.candidateKey(source,c),'2026-09-30T01:00:00.000Z');
  assert.equal(p.stats().items,2);assert.equal(p.stats().events,2);
  const old=p.export()[0].eventId;p.db.prepare('UPDATE items SET event_id=?').run(old);
  assert.equal(p.stats().events,1);assert.equal(p.reindexEvents(),2);assert.equal(p.stats().events,2);
}));
test('one malformed discovered link does not erase valid pending candidates',()=>withPool(p=>{
  p.discover(source,[candidate,{id:'invalid',title:'Missing link'}],'2026-09-30T00:00:00.000Z');
  assert.equal(p.stats().candidates,2);assert.equal(p.queue(source,{force:true}).length,2);
}));
test('discovery checkpoint and candidates commit atomically; interrupted checkpoints cannot skip a page',()=>withPool(p=>{
  p.discover(source,[candidate],'2026-09-30T00:00:00.000Z',{resumePage:2});
  assert.equal(p.state(source).resumePage,2);
  assert.throws(()=>p.discover(source,[{...candidate,id:'failed',metadata:{roundupSegment:true,segmentUrl:'invalid'}}],'2026-09-30T01:00:00.000Z',{resumePage:3}));
  assert.equal(p.state(source).resumePage,2);assert.equal(p.stats().candidates,1);
  p.discover(source,[{...candidate,id:'next',url:'https://example.org/next'}],'2026-09-30T02:00:00.000Z',{resumePage:3});
  assert.equal(p.state(source).resumePage,3);assert.equal(p.stats().candidates,2);
}));


test('refresh-only still refreshes an existing item requeued by changed discovery metadata',()=>withPool(p=>{
 p.discover(source,[candidate],'2026-09-30T00:00:00Z');const key=p.candidateKey(source,candidate);p.accept(item,key,'2026-09-30T01:00:00Z');
 p.discover(source,[{...candidate,title:'Updated robot manipulation study'}],'2026-09-30T02:00:00Z');
 assert.equal(p.db.prepare('SELECT status FROM candidates WHERE key=?').get(key).status,'pending');
 assert.ok(p.queue(source,{refreshOnly:true}).some(r=>r.key===key));
 const unseen={...candidate,id:'unseen',url:'https://example.org/unseen'};p.discover(source,[unseen],'2026-09-30T02:00:00Z');
 assert.ok(!p.queue(source,{refreshOnly:true}).some(r=>r.key===p.candidateKey(source,unseen)));
 p.db.prepare('INSERT INTO quarantine VALUES(?,?,?)').run(key,'controlled invalid evidence','2026-09-30T02:01:00Z');
 assert.ok(!p.queue(source,{refreshOnly:true}).some(r=>r.key===key));
}));

test('exact candidate targeting preserves unrelated pending work and source boundaries',()=>withPool(p=>{
  const other={...candidate,id:'two',url:'https://example.org/second'};
  p.discover(source,[candidate,other],'2026-09-30T00:00:00Z');
  p.discover({...source,id:'another'},[other],'2026-09-30T00:00:00Z');
  const jobs=p.queue(source,{limit:1,candidateUrl:other.url});
  assert.equal(jobs.length,1);assert.equal(JSON.parse(jobs[0].payload).url,other.url);assert.equal(jobs[0].source_id,source.id);
  assert.equal(p.queue(source,{candidateUrl:'https://example.org/absent'}).length,0);
  assert.equal(p.queue(source).length,2);
}));

test('a directly attributed Xinhua interview is original reporting, not independent technical validation',()=>{
 const url='https://www.xinhuanet.com/digital/20250820/interview/c.html';
 const report={...item,sourceId:'galbot-news',url,content:'期间，北京银河通用机器人有限公司首席战略官赵于莉接受新华网专访，分享了公司在具身智能领域的探索和实践。\n\n赵于莉介绍了其公司对机器人技术和商业化应用的观点。',evidenceClass:'independent_reporting',evidence:[{url,kind:'independent_reporting',relation:'original'}],raw:{url,mediaType:'text/html',content:'<article>Original interview snapshot</article>'},metadata:{media:true,sourceRole:'MEDIA_ORIGINAL',reportingType:'original_reporting',reportingFormat:'firsthand_interview',claimVerification:'company_statement_unverified',interviewee:'赵于莉'}};
 assert.equal(validateItem(report),report);
 assert.throws(()=>validateItem({...report,content:'An ordinary robotics product article with a substantive body but without direct interview attribution.'}),/distinct retrieved primary/);
 assert.throws(()=>validateItem({...report,metadata:{...report.metadata,claimVerification:'independent_validation'}}),/distinct retrieved primary/);
 assert.throws(()=>validateItem({...report,url:'https://example.org/repost'}),/distinct retrieved primary/);
});
