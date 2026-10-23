import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {createContext} from '../lib/context.mjs';
import {discover} from '../adapters/keyword-search.mjs';
const args={};for(let i=2;i<process.argv.length;i+=2)args[process.argv[i].replace(/^--/,'')]=process.argv[i+1];
const file=resolve(args.config||'config/rss-keywords.json'),config=JSON.parse(await readFile(file,'utf8'));
const out=resolve(args.out||'reports/source-research/rss-keywords-2026-10-23/keyword-probe');await mkdir(out,{recursive:true});
const ctx=await createContext({workDir:out,retries:0,timeoutMs:20000,maxPages:1});let index=0;const results=[];
const selected=config.sources.filter(s=>!args.ids||args.ids.split(',').includes(s.id));
try {await Promise.all(Array.from({length:4},async()=>{
  while(index<selected.length) {
    const source=selected[index++];
    try {
      const result=await discover(source,ctx),parsed=result.coverage.pagesFetched>0;
      source.enabled=parsed;source.verification={status:parsed?'search_feed_parsed':'unavailable',checkedAt:new Date().toISOString(),
        relevantItems:result.candidates.length,rawItems:result.coverage.itemCount??0,selectedFeed:result.coverage.selectedFeed??null,
        intake:result.coverage.feedIntake,issues:result.issues,samples:result.candidates.slice(0,2).map(c=>({title:c.title,url:c.url,publisher:c.metadata.publisher}))};
      results.push({id:source.id,keyword:source.keywords[0],group:source.keywordGroup,...source.verification});
      console.log(JSON.stringify({keyword:source.keywords[0],status:source.verification.status,items:result.candidates.length}));
    }catch(e){source.enabled=false;source.verification={status:'probe_failed',error:String(e.message)};results.push({id:source.id,...source.verification});}
  }
}));}finally{await ctx.close();}
await writeFile(file,JSON.stringify(config,null,2)+'\n');
await writeFile(join(out,'results.json'),JSON.stringify({observedAt:ctx.now,results},null,2)+'\n');
console.log(JSON.stringify({probed:results.length,parsed:results.filter(r=>r.status==='search_feed_parsed').length,withResults:results.filter(r=>r.relevantItems>0).length,candidateObservations:results.reduce((n,r)=>n+(r.relevantItems||0),0)}));
