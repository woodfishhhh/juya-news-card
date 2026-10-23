import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {Pool} from '../lib/pool.mjs';

test('the evidence verifier completes failed and interrupted jobs in an isolated pool without changing captured data',()=>{
  const dir=mkdtempSync(join(tmpdir(),'embodied-verifier-test-'));
  const source={id:'test',channelId:'primary'};
  const candidate={id:'sample',url:'https://example.org/robot',title:'Robot manipulation evaluation',publishedAt:'2026-09-29T00:00:00Z'};
  const item={sourceId:source.id,channelId:'primary',sourceItemId:candidate.id,title:candidate.title,url:candidate.url,publishedAt:candidate.publishedAt,publishedAtRaw:'2026-09-29',datePrecision:'day',content:'This robot manipulation report describes a real experiment with its task, measurements, hardware and limitations.',evidenceClass:'official_announcement',evidence:[{url:candidate.url,kind:'official_announcement',relation:'original'}],metadata:{},raw:{url:candidate.url,mediaType:'text/plain',content:'Original robot experiment snapshot.'}};
  try{
    const p=new Pool(dir);p.discover(source,[candidate],'2026-09-30T00:00:00Z',{nextPage:4});p.accept(item,p.candidateKey(source,candidate),'2026-09-30T00:00:00Z');const before=p.stats();p.close();
    const env=Object.fromEntries(['SystemRoot','WINDIR','TEMP','TMP'].filter(k=>process.env[k]).map(k=>[k,process.env[k]]));
    const run=spawnSync(process.execPath,['bin/verify.mjs',dir],{cwd:new URL('..',import.meta.url),env,encoding:'utf8'});
    assert.equal(run.status,0,run.stderr);
    const proof=JSON.parse(readFileSync(join(dir,'verification.json'),'utf8'));
    assert.equal(proof.verificationVersion,2);assert.equal(proof.sampleCount,1);
    for(const field of ['replay','update','retryRecovery','interruptedRecovery','checkpoint'])assert.equal(proof.checks[0][field],'pass');
    const after=new Pool(dir);try{assert.deepEqual(after.stats(),before);assert.deepEqual(after.state(source),{nextPage:4});assert.equal(after.export()[0].revision,1);}finally{after.close();}
    // A current real-replay outcome alone must not make stale recovery evidence
    // pass after the captured item has changed to a different revision.
    const config=join(dir,'fixture-config.json');
    writeFileSync(config,JSON.stringify({column:{name:'Fixture column'},sources:[{id:'test',name:'Fixture source',entryUrl:'https://example.org'}]}),'utf8');
    const captured=new Pool(dir);const key=captured.candidateKey(source,candidate);
    const addReplay=(id)=>{
      const outcome=captured.accept({...item,content:captured.export()[0].content},key,'2026-09-30T00:00:00Z');
      const payload={runId:id,finishedAt:'2026-09-30T00:00:00Z',channels:[{sourceId:'test',channelId:'primary',accepted:1,outcomes:[outcome],coverage:{},issues:[]}]};
      captured.db.prepare('INSERT INTO runs VALUES(?,?,?,?)').run(id,'2026-09-30T00:00:00Z','2026-09-30T00:00:00Z',JSON.stringify(payload));
    };
    addReplay('fixture-before');
    const report=()=>{
      const run=spawnSync(process.execPath,['bin/report.mjs','--data',dir,'--config',config],{cwd:new URL('..',import.meta.url),env,encoding:'utf8'});
      assert.equal(run.status,0,run.stderr);return JSON.parse(readFileSync(join(dir,'acceptance.json'),'utf8'));
    };
    try{
      const acceptedReport=report();assert.equal(acceptedReport.channels[0].status,'accepted');assert.equal(acceptedReport.allAccepted,true);assert.deepEqual(acceptedReport.scope,{sourceGroups:1,channels:1});
      const fixture=JSON.parse(readFileSync(config,'utf8'));fixture.excludedSources=[{id:'retired',name:'Retired source',exclusionReason:'User removed'}];writeFileSync(config,JSON.stringify(fixture));
      const excludedReport=report();assert.equal(excludedReport.allAccepted,true);assert.equal(excludedReport.channels.length,1);assert.equal(excludedReport.excludedSources[0].sourceId,'retired');
      captured.accept({...item,content:item.content+' A documented publisher correction changes the result.'},key,'2026-09-30T00:00:00Z');
      addReplay('fixture-after');
      const stale=report().channels[0];assert.equal(stale.realReplay,true);assert.equal(stale.controlledUpdateRecovery,false);
      assert.equal(stale.status,'needs_replay_or_verification');assert.equal(report().allAccepted,false);
      writeFileSync(config,JSON.stringify({column:{name:'Empty scope'},sources:[]}));assert.equal(report().allAccepted,false);
    }finally{captured.close();}
  }finally{rmSync(dir,{recursive:true,force:true});}
});


test('controlled recovery keeps a firsthand interview self-reference consistent',()=>{
 const dir=mkdtempSync(join(tmpdir(),'embodied-interview-verifier-'));
 const source={id:'galbot-news',channelId:'primary'};
 const url='https://www.xinhuanet.com/digital/20250820/interview/c.html';
 const c={id:'interview',url,title:'银河通用赵于莉专访',publishedAt:'2025-08-20T08:04:55Z'};
 const item={sourceId:source.id,channelId:'primary',sourceItemId:c.id,title:c.title,url,publishedAt:c.publishedAt,publishedAtRaw:'2025-08-20 16:04:55',datePrecision:'second',content:'期间，北京银河通用机器人有限公司首席战略官赵于莉接受新华网专访，分享了公司在具身智能领域的探索和实践。\n\n她介绍了公司对机器人技术和商业化应用的观点。',evidenceClass:'independent_reporting',evidence:[{url,kind:'independent_reporting',relation:'original'}],metadata:{media:true,sourceRole:'MEDIA_ORIGINAL',reportingType:'original_reporting',reportingFormat:'firsthand_interview',claimVerification:'company_statement_unverified',interviewee:'赵于莉'},raw:{url,mediaType:'text/html',content:'<article>Original interview snapshot.</article>'}};
 try{
  const p=new Pool(dir);p.discover(source,[c],'2026-09-30T00:00:00Z');p.accept(item,p.candidateKey(source,c),'2026-09-30T00:00:00Z');const before=p.stats();p.close();
  const run=spawnSync(process.execPath,['bin/verify.mjs',dir],{cwd:new URL('..',import.meta.url),encoding:'utf8'});assert.equal(run.status,0,run.stderr);
  const proof=JSON.parse(readFileSync(join(dir,'verification.json'),'utf8'));assert.equal(proof.checks[0].retryRecovery,'pass');assert.equal(proof.checks[0].interruptedRecovery,'pass');
  const after=new Pool(dir);try{assert.deepEqual(after.stats(),before);}finally{after.close();}
 }finally{rmSync(dir,{recursive:true,force:true});}
});
