import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { createContext } from '../lib/context.mjs';
import { Pool } from '../lib/pool.mjs';
import { redact } from '../lib/sanitize.mjs';
import lockfile from 'proper-lockfile';
import {configuredSources} from '../lib/rsshub.mjs';

const args = {};
for (let i=2;i<process.argv.length;i+=2) { if (!process.argv[i]?.startsWith('--') || process.argv[i+1] === undefined) throw new Error('Arguments use --name value'); args[process.argv[i].slice(2)] = process.argv[i+1]; }
const config = JSON.parse(await readFile(resolve(args.config || 'config/sources.json'),'utf8'));
config.sources = await configuredSources(config,resolve(args.config || 'config/sources.json'));
const data = resolve(args.data || 'data');
await mkdir(data,{recursive:true});
const releaseLock=await lockfile.lock(data,{lockfilePath:join(data,'collector.mutex'),realpath:false,stale:60000,update:10000,retries:0});

async function run() {
  const pool = new Pool(data,{recover:true});
  pool.revalidate();
  const runId = new Date().toISOString().replace(/[:.]/g,'-');
  const ctx = await createContext({workDir:join(data,'runs',runId),cacheDir:join(data,'http-cache'),maxPages:Number(args.pages || 5),limit:Number(args.limit || 50),timeoutMs:Number(args.timeout || 25000),retries:Number(args.retries ?? 2),forceRefresh:args['refresh-only']==='true' || args.force==='true'});
  const report = {runId,startedAt:ctx.now,before:pool.stats(),channels:[]};
  pool.db.prepare('INSERT INTO runs VALUES(?,?,NULL,?)').run(runId,ctx.now,JSON.stringify(report));
  try {
    for (const base of config.sources.filter(s=>!args.sources || args.sources.split(',').includes(s.id))) {
      const profilesAdapter=(base.officialProfiles || []).length ? await import('../adapters/profiles.mjs') : null;
      const resolvedProfiles=profilesAdapter ? profilesAdapter.channels(base) : [];
      const channels = [{...base,channelId:'primary'},...(base.officialProfiles || []).map((profile,i)=>({...base,adapter:'profiles',entryUrl:profile.url,channelId:`profile-${i+1}`,profile:{...profile,ownerEvidence:resolvedProfiles[i]?.ownerEvidence || profile.ownerEvidence}}))];
      for (const source of channels.filter(s=>!args.channels || args.channels.split(',').includes(s.channelId))) {
        const row = {sourceId:source.id,channelId:source.channelId,entryUrl:source.entryUrl,discovered:0,inserted:0,updated:0,unchanged:0,failed:0,issues:[],coverage:{},outcomes:[]};
        try {
          const adapter = await import(`../adapters/${source.adapter}.mjs`);
          const state=pool.state(source);
          const capture=ctx.publicDomCapture?.sourceId===source.id ? ctx.publicDomCapture : null;
          if(capture && Date.parse(capture.oldestObservedAt)<=Date.parse(state.publicDomLastCaptureAt || '')) throw new Error('Fresh public DOM collection required; a prior bundle cannot prove a second network read');
          const sourceCtx={...ctx.forSource(source.id),state,feedWindow:args.since || args.until ? {since:args.since,until:args.until} : undefined};
          const result = await adapter.discover(source,sourceCtx);
          row.discovered = result.candidates.length; row.issues=result.issues || []; row.coverage=result.coverage || {};
          const nextState=capture ? {...state,...(result.nextState || {}),publicDomLastCaptureAt:capture.capturedAt,publicDomLastDigest:capture.digest} : result.nextState;
          if(capture)row.coverage={...row.coverage,transport:capture.method,capturedAt:capture.capturedAt,observationDigest:capture.digest,httpStatusNotObserved:true};
          pool.discover(source,result.candidates,new Date().toISOString(),nextState);
          const jobs = pool.queue(source,{limit:ctx.limit,force:args.force === 'true',refreshOnly:args['refresh-only'] === 'true',retryOnly:args['retry-only']==='true',candidateUrl:args['candidate-url'] || null});
          for (const job of (source.discoveryOnly ? [] : jobs)) {
            pool.db.prepare("UPDATE candidates SET status='processing' WHERE key=?").run(job.key);
            try { const item = await adapter.hydrate(JSON.parse(job.payload),source,sourceCtx); item.sourceId=source.id; item.channelId=source.channelId; const outcome=pool.accept(item,job.key,new Date().toISOString()); row[outcome.action]++;row.outcomes.push({...outcome,url:item.url}); }
            catch(e) { row.failed++; pool.fail(runId,source,job.key,'hydrate',e,new Date().toISOString()); }
          }
        } catch(e) { row.issues.push({stage:'discover',error:e.message}); pool.fail(runId,source,null,'discover',e,new Date().toISOString()); }
        row.accepted=row.inserted+row.updated+row.unchanged;
        row.pending=pool.db.prepare("SELECT count(*) n FROM candidates WHERE source_id=? AND channel_id=? AND status!='accepted' AND status!='filtered'").get(source.id,source.channelId).n;
        row.status=source.discoveryOnly && row.coverage.pagesFetched>0 ? (row.discovered ? 'discovery_ready' : 'discovery_empty') : row.accepted ? (row.failed || row.issues.length ? 'degraded' : 'sample_verified') : 'blocked';
        Object.assign(row,redact(row));pool.health(source,row,new Date().toISOString()); report.channels.push(row);
        console.log(JSON.stringify(row));
      }
    }
    report.after=pool.stats(); report.finishedAt=new Date().toISOString();
    pool.db.prepare('UPDATE runs SET finished_at=?,payload=? WHERE id=?').run(report.finishedAt,JSON.stringify(report),runId);
    await writeFile(join(data,'runs',runId,'report.json'),JSON.stringify(report,null,2)+'\n');
    await writeFile(join(data,'pool.jsonl'),pool.export().map(i=>JSON.stringify(i)).join('\n')+'\n');
    await writeFile(join(data,'latest-run.json'),JSON.stringify(report,null,2)+'\n');
    return report;
  } finally { await ctx.close(); pool.close(); }
}
try {
  do { await run(); if(args.watch !== 'true') break; await new Promise(r=>setTimeout(r,Number(args.interval || 7200)*1000)); } while(true);
} finally { await releaseLock(); }
