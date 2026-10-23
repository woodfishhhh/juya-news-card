import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createContext } from '../lib/context.mjs';
test('429 is retried and logged, HTTP 403 stays an explicit failure, snapshots survive',async()=>{
  let hits=0;
  const server=createServer((req,res)=>{ if(req.url==='/forbidden'){res.writeHead(403);res.end('Forbidden');return;} hits++; if(hits===1){res.writeHead(429,{'retry-after':'0'});res.end('Busy');}else{res.writeHead(200);res.end('robotics article body');} });
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const dir=await mkdtemp(join(tmpdir(),'embodied-http-'));const ctx=await createContext({workDir:dir,retries:1,timeoutMs:1000});
  try { const base=`http://127.0.0.1:${server.address().port}`; const response=await ctx.http.get(base); assert.equal(hits,2);assert.equal(response.text,'robotics article body');assert.ok(response.snapshotPath);await assert.rejects(ctx.http.get(base+'/forbidden'),/HTTP 403/); assert.ok(ctx.requests.some(r=>r.status===429)); } finally {await ctx.close();await new Promise(r=>server.close(r));await rm(dir,{recursive:true,force:true});}
});
test('public GET cache persists across runs, refresh-only forces a real network read, and auth is never cached',async()=>{
  let hits=0;const server=createServer((req,res)=>{hits++;res.end(`Body ${hits}`);});await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const dir=await mkdtemp(join(tmpdir(),'embodied-cache-'));const url=`http://127.0.0.1:${server.address().port}`;const options={workDir:dir,cacheDir:join(dir,'shared-cache'),retries:0};
  try{let ctx=await createContext(options);assert.equal((await ctx.http.get(url,{cacheMs:86400000})).text,'Body 1');await ctx.close();
    ctx=await createContext(options);assert.equal((await ctx.http.get(url,{cacheMs:86400000})).text,'Body 1');assert.equal(hits,1);assert.equal(ctx.requests[0].cache,true);await ctx.close();
    ctx=await createContext({...options,forceRefresh:true});assert.equal((await ctx.http.get(url,{cacheMs:86400000})).text,'Body 2');await ctx.close();
    ctx=await createContext(options);await ctx.http.get(url,{cacheMs:86400000,headers:{authorization:'Bearer test'}});await ctx.http.get(url,{cacheMs:86400000,headers:{authorization:'Bearer test'}});assert.equal(hits,4);await ctx.close();
  }finally{await new Promise(r=>server.close(r));await rm(dir,{recursive:true,force:true});}
});
test('long Retry-After is kept as a resumable retry date rather than retried too early',async()=>{
  let hits=0;const server=createServer((req,res)=>{hits++;res.writeHead(429,{'retry-after':'120'});res.end('Please wait');});await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const dir=await mkdtemp(join(tmpdir(),'embodied-retryafter-'));const ctx=await createContext({workDir:dir,retries:2});
  try{await assert.rejects(ctx.http.get(`http://127.0.0.1:${server.address().port}`),e=>e.status===429 && Date.parse(e.retryAt)>Date.now()+110000);assert.equal(hits,1);}finally{await ctx.close();await new Promise(r=>server.close(r));await rm(dir,{recursive:true,force:true});}
});


test('public cached response metadata excludes credential-bearing headers',async()=>{
 const server=createServer((req,res)=>{res.writeHead(200,{'set-cookie':'session=fixture-only','content-type':'text/plain'});res.end('Public robot article');});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));const dir=await mkdtemp(join(tmpdir(),'embodied-private-headers-'));
 const ctx=await createContext({workDir:dir,retries:0});
 try{const r=await ctx.http.get(`http://127.0.0.1:${server.address().port}`,{cacheMs:1000});assert.equal(r.headers['set-cookie'],undefined);assert.equal(r.headers['content-type'],'text/plain');}
 finally{await ctx.close();await new Promise(r=>server.close(r));await rm(dir,{recursive:true,force:true});}
});

test('GitHub-style 403 quota reset prevents further same-host network attempts within the run',async()=>{
 let hits=0;const reset=Math.ceil(Date.now()/1000)+120;const server=createServer((req,res)=>{hits++;res.writeHead(403,{'x-ratelimit-remaining':'0','x-ratelimit-reset':String(reset)});res.end('API rate limit exceeded');});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));const dir=await mkdtemp(join(tmpdir(),'embodied-quota-'));const ctx=await createContext({workDir:dir,retries:0});const base=`http://127.0.0.1:${server.address().port}`;
 try{await assert.rejects(ctx.http.get(base+'/first'),e=>e.rateLimited && Date.parse(e.retryAt)===reset*1000);await assert.rejects(ctx.http.get(base+'/second'),e=>e.rateLimited===true);assert.equal(hits,1);assert.equal(ctx.requests.at(-1).networkAttempt,false);}
 finally{await ctx.close();await new Promise(r=>server.close(r));await rm(dir,{recursive:true,force:true});}
});

 test('configured policy-blocked hosts fail before any transport request',async()=>{const previous=process.env.EMBODIED_BLOCKED_HOSTS;process.env.EMBODIED_BLOCKED_HOSTS='blocked.example';const dir=await mkdtemp(join(tmpdir(),'embodied-policy-'));let ctx;try{ctx=await createContext({workDir:dir,retries:0});await assert.rejects(ctx.http.get('https://blocked.example/article'),/blocked by the current cloud network policy/);assert.equal(ctx.requests[0].networkAttempt,false);assert.equal(ctx.requests[0].policyBlocked,true);await assert.rejects(ctx.browser.get('https://sub.blocked.example/article'),/blocked by the current cloud network policy/);}finally{if(ctx)await ctx.close();if(previous===undefined)delete process.env.EMBODIED_BLOCKED_HOSTS;else process.env.EMBODIED_BLOCKED_HOSTS=previous;await rm(dir,{recursive:true,force:true});}});
