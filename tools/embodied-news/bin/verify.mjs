import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join,resolve } from 'node:path';
import assert from 'node:assert/strict';
import { Pool } from '../lib/pool.mjs';
const data=resolve(process.argv[2] || 'data');
const src=new Pool(data); const samples=src.export();
const checkpoints=new Map(samples.map(s=>[`${s.sourceId}\n${s.channelId}`,src.state({id:s.sourceId,channelId:s.channelId})]));src.close();
const dir=await mkdtemp(join(tmpdir(),'embodied-verify-')); const p=new Pool(dir);
const result={verifiedAt:new Date().toISOString(),verificationVersion:2,mode:'captured-real-items-controlled-replay-update-recovery',sampleCount:samples.length,checks:[]};
try {
  for(const sample of samples) {
    const source={id:sample.sourceId,channelId:sample.channelId}; const c={id:sample.sourceItemId,url:sample.url,title:sample.title,publishedAt:sample.publishedAt,metadata:sample.metadata?.roundupSegment ? {roundupSegment:true,segmentUrl:sample.metadata.segmentUrl} : {}};
    const raw={...sample.raw,content:await readFile(join(data,sample.raw.snapshotPath),'utf8')};
    const item={...sample,raw}; const now=new Date().toISOString();
    const checkpoint=checkpoints.get(`${source.id}\n${source.channelId}`);
    p.discover(source,[c],now,checkpoint); const key=p.candidateKey(source,c); assert.equal(p.accept(item,key,now).action,'inserted');
    p.discover(source,[c],now); assert.equal(p.accept(item,key,now).action,'unchanged');
    assert.equal(p.accept({...item,content:item.content+'\n[Controlled verification correction; not a publisher update.]'},key,now).action,'updated');
    assert.equal(p.export().find(x=>x.itemId===key).revision,2);
    const failed={...c,id:c.id+'-failure-probe',url:c.url+(c.url.includes('?') ? '&' : '?')+'verification_probe=1'}; p.discover(source,[failed],now); const failureKey=p.candidateKey(source,failed); p.fail('verify',source,failureKey,'hydrate',new Error('Controlled transient failure'),now);
    assert.ok(p.queue(source,{force:true,limit:100000}).some(x=>x.key===failureKey));
    // The probes are isolated synthetic identities. Keep self-referencing raw and
    // evidence URLs consistent without altering distinct external primary sources.
    const probeItem=probe=>({...item,sourceItemId:probe.id,url:probe.url,raw:{...item.raw,url:item.raw.url===item.url?probe.url:item.raw.url},evidence:item.evidence.map(e=>e.url===item.url?{...e,url:probe.url}:e)});
    const recoveredItem=probeItem(failed);
    assert.equal(p.accept(recoveredItem,failureKey,now).action,'inserted');
    const recovered=p.db.prepare('SELECT status,error,next_attempt_at FROM candidates WHERE key=?').get(failureKey);
    assert.equal(recovered.status,'accepted');assert.equal(recovered.error,null);assert.equal(recovered.next_attempt_at,null);
    assert.equal(p.accept(recoveredItem,failureKey,now).action,'unchanged');
    assert.ok(!p.queue(source,{force:true,retryOnly:true,limit:100000}).some(x=>x.key===failureKey));
    const interrupted={...c,id:c.id+'-interruption-probe',url:c.url+(c.url.includes('?')?'&':'?')+'verification_interruption=1'};
    p.discover(source,[interrupted],now);const interruptionKey=p.candidateKey(source,interrupted);
    p.db.prepare("UPDATE candidates SET status='processing' WHERE key=?").run(interruptionKey);
    const resumed=new Pool(dir,{recover:true});
    try{
      assert.equal(resumed.db.prepare('SELECT status FROM candidates WHERE key=?').get(interruptionKey).status,'pending');
      assert.deepEqual(resumed.state(source),checkpoint);
      assert.equal(resumed.accept(probeItem(interrupted),interruptionKey,now).action,'inserted');
      assert.equal(resumed.db.prepare('SELECT status FROM candidates WHERE key=?').get(interruptionKey).status,'accepted');
    }finally{resumed.close();}
    result.checks.push({sourceId:sample.sourceId,channelId:sample.channelId,itemId:sample.itemId,revision:sample.revision,contentHash:sample.contentHash,replay:'pass',update:'pass',retry:'pass',retryRecovery:'pass',interruptedRecovery:'pass',checkpoint:'pass'});
  }
  result.status=samples.length ? 'pass' : 'no-samples';
  await writeFile(join(data,'verification.json'),JSON.stringify(result,null,2)+'\n'); console.log(JSON.stringify({status:result.status,samples:samples.length}));
} finally { p.close(); await rm(dir,{recursive:true,force:true}); }
