import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, writeFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {loadXObservation} from '../lib/browser-observations.mjs';

test('public browser observations require fresh expanded original posts from the configured owner', async()=>{
 const dir=await mkdtemp(join(tmpdir(),'embodied-dom-'));const file=join(dir,'obs.json');
 const now=Date.parse('2026-09-30T16:00:00Z');
 const base={schemaVersion:1,method:'supported-cloud-browser-public-dom',profileUrl:'https://x.com/UnitreeRobotics',originalText:true,capturedAt:new Date(now).toISOString(),posts:[{url:'https://x.com/UnitreeRobotics/status/123',author:'/UnitreeRobotics',originalText:true,expanded:true,publishedAt:'2026-09-29T12:00:00Z',detailVerifiedAt:new Date(now).toISOString(),text:'Original official robot demonstration with enough substantive text.'}]};
 try{
  const put=async obj=>writeFile(file,JSON.stringify(obj));await put(base);
  assert.equal((await loadXObservation(file,base.profileUrl,{now})).posts.length,1);
  await assert.rejects(loadXObservation(file,base.profileUrl,{now:now+600001}),/Fresh cloud/);
  await put({...base,posts:[{...base.posts[0],author:'/someoneElse'}]});
  await assert.rejects(loadXObservation(file,base.profileUrl,{now}),/configured official/);
  await put({...base,posts:[{...base.posts[0],expanded:false}]});
  await assert.rejects(loadXObservation(file,base.profileUrl,{now}),/expanded original/);
  await put({...base,posts:[{...base.posts[0],publishedAt:'2026-10-01T00:00:00Z'}]});
  await assert.rejects(loadXObservation(file,base.profileUrl,{now}),/Publication time/);
  await put({...base,posts:[{...base.posts[0],publishedAt:'2026-02-30T08:00:00Z'}]});
  await assert.rejects(loadXObservation(file,base.profileUrl,{now}),/second-precision/);
  await put({...base,posts:[{...base.posts[0],publishedAt:'2026-09-29'}]});
  await assert.rejects(loadXObservation(file,base.profileUrl,{now}),/second-precision/);
  await put({...base,posts:[{...base.posts[0],publishedAt:'2026-09-29T12:00:00'}]});
  await assert.rejects(loadXObservation(file,base.profileUrl,{now}),/second-precision/);
  await put({...base,posts:[{...base.posts[0],url:'https://user:fixture@x.com/UnitreeRobotics/status/123'}]});
  await assert.rejects(loadXObservation(file,base.profileUrl,{now}),/configured official/);
  await put({...base,posts:[{...base.posts[0],url:'https://x.com/UnitreeRobotics/status/123?token=fixture'}]});
  await assert.rejects(loadXObservation(file,base.profileUrl,{now}),/configured official/);
  await put({...base,posts:[{...base.posts[0],cookie:'fixture-only'}]});
  await assert.rejects(loadXObservation(file,base.profileUrl,{now}),/non-public-schema/);
  await put({...base,posts:[{...base.posts[0],detailVerifiedAt:new Date(now+1000).toISOString()}]});
  await assert.rejects(loadXObservation(file,base.profileUrl,{now}),/detail verification/);
  await put({...base,posts:[{...base.posts[0],detailVerifiedAt:'invalid'}]});
  await assert.rejects(loadXObservation(file,base.profileUrl,{now}),/second-precision timestamps/);
 } finally{await rm(dir,{recursive:true,force:true});}
});

test('X collection rejects reusing the same capture as a second live run', async()=>{
 const dir=await mkdtemp(join(tmpdir(),'embodied-dom-replay-'));const file=join(dir,'obs.json');
 const at=new Date().toISOString();
 const observation={schemaVersion:1,method:'supported-cloud-browser-public-dom',profileUrl:'https://x.com/UnitreeRobotics',originalText:true,capturedAt:at,posts:[{url:'https://x.com/UnitreeRobotics/status/123',author:'/UnitreeRobotics',originalText:true,expanded:true,publishedAt:'2026-09-29T12:00:00Z',detailVerifiedAt:at,text:'Unitree official demonstration of a new humanoid robot control system.'}]};
 const previous=process.env.EMBODIED_X_OBSERVATION_FILE;
 try{
  await writeFile(file,JSON.stringify(observation));process.env.EMBODIED_X_OBSERVATION_FILE=file;
  const adapter=await import('../adapters/profiles.mjs');const html=await import('../lib/html.mjs');
  const source={id:'unitree-news',channelId:'profile-2',entryUrl:observation.profileUrl,profile:{url:observation.profileUrl,ownerEvidence:'https://www.unitree.com/news/'}};
  const ctx={html,state:{},http:{get:async()=>({text:'<a href="https://x.com/UnitreeRobotics">X</a>',url:'https://www.unitree.com/news/',status:200})}};
  const discovery=await adapter.discover(source,ctx);
  assert.equal(discovery.candidates.length,1);assert.equal(discovery.coverage.ownerEvidenceVerified,true);
  const item=await adapter.hydrate(discovery.candidates[0],source,ctx);assert.equal(item.raw.mediaType,'application/json');
  await assert.rejects(adapter.discover(source,{...ctx,state:discovery.nextState}),/new live browser observation/);
  await assert.rejects(adapter.discover(source,{...ctx,state:{lastObservationDigest:'later-different-digest',lastObservationAt:new Date(Date.parse(at)+1000).toISOString()}}),/new live browser observation/);
  await writeFile(file,JSON.stringify({...observation,capturedAt:new Date(Date.parse(at)+1000).toISOString()}));
  await assert.rejects(adapter.discover(source,{...ctx,state:discovery.nextState}),/new live browser observation/);
  await writeFile(file,JSON.stringify({...observation,posts:[{...observation.posts[0],text:'Different public body text recorded after the discovery step.'}]}));
  await assert.rejects(adapter.hydrate(discovery.candidates[0],source,ctx),/changed between discovery/);
 }finally{if(previous===undefined)delete process.env.EMBODIED_X_OBSERVATION_FILE;else process.env.EMBODIED_X_OBSERVATION_FILE=previous;await rm(dir,{recursive:true,force:true});}
});
