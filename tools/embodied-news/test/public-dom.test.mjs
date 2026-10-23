import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {loadPublicDomBundle} from '../lib/public-dom.mjs';
import {createContext} from '../lib/context.mjs';
test('public DOM bridge is source-scoped, fresh, read-only and never invents HTTP 200',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'embodied-public-dom-'));const file=join(dir,'bundle.json');const at=new Date().toISOString();
 const base={schemaVersion:1,method:'supported-cloud-browser-public-dom-html',sourceId:'agibot-news',capturedAt:at,pages:[{url:'https://www.agibot.com/news',observedAt:at,html:'<main><h1>Official robotics news</h1><a href="/article/231/detail/123.html">Robot deployment</a></main>'}]};
 const previous=process.env.EMBODIED_PUBLIC_DOM_BUNDLE;
 try{
  await writeFile(file,JSON.stringify(base));const bundle=await loadPublicDomBundle(file);
  const r=bundle.get(base.pages[0].url);assert.equal(r.status,0);assert.equal(r.publicDom,true);assert.equal(bundle.oldestObservedAt,at);assert.match(r.text,/Robot deployment/);
  assert.throws(()=>bundle.get('https://www.agibot.com/article/231/detail/999.html'),/fresh supported-browser capture/);
  assert.throws(()=>bundle.get('https://secret:token@www.agibot.com/news'),/outside/);
  assert.throws(()=>bundle.get('https://www.agibot.com/admin'),/outside/);
  assert.throws(()=>bundle.get('https://www.agibot.com/news?auth=private'),/outside/);
  assert.throws(()=>bundle.get('https://www.agibot.com/news?page=2&page=3'),/outside/);
  await assert.rejects(loadPublicDomBundle(file,{now:Date.now()+600001}),/Fresh supported-browser/);
  process.env.EMBODIED_PUBLIC_DOM_BUNDLE=file;
  const ctx=await createContext({workDir:join(dir,'run'),retries:0});
  try{
   await assert.rejects(ctx.http.get(base.pages[0].url),/active collector source/);
   const wrong=ctx.forSource('other-source');
   await assert.rejects(wrong.http.get(base.pages[0].url),/active collector source/);
   const scoped=ctx.forSource('agibot-news');assert.equal(scoped.forSource,undefined);
   const captured=await scoped.http.get(base.pages[0].url);assert.equal(captured.status,0);assert.equal(ctx.requests[0].networkAttempt,false);await assert.rejects(scoped.http.post(base.pages[0].url,{}),/read-only/);}finally{await ctx.close();}
 }finally{if(previous===undefined)delete process.env.EMBODIED_PUBLIC_DOM_BUNDLE;else process.env.EMBODIED_PUBLIC_DOM_BUNDLE=previous;await rm(dir,{recursive:true,force:true});}
});
