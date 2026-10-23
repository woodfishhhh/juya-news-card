import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import Parser from 'rss-parser';
import {createContext} from '../lib/context.mjs';
import {publicFeedUrl} from '../lib/feed-intake.mjs';
import {evaluateSourceRelevance} from '../adapters/feeds.mjs';
const args={};for(let i=2;i<process.argv.length;i+=2)args[process.argv[i].replace(/^--/,'')]=process.argv[i+1];
const configPath=resolve(args.config||'config/rsshub.json'),config=JSON.parse(await readFile(configPath,'utf8'));
const out=resolve(args.out||'reports/source-research/rsshub-2026-10-23');await mkdir(out,{recursive:true});
const ctx=await createContext({workDir:out,retries:Number(args.retries??1),timeoutMs:Number(args.timeout??25000)}),parser=new Parser();
const sources=config.sources.filter(s=>!args.ids || args.ids.split(',').includes(s.id)).filter(s=>args.kind==='native'?!s.route:args.kind==='rsshub'?!!s.route:true);
let index=0;const results=[];
try {
  await Promise.all(Array.from({length:3},async()=>{
    while(index<sources.length){const s=sources[index++];const url=publicFeedUrl(s.route?config.baseUrl.replace(/\/$/,'')+s.route:s.entryUrl);
      const v={checkedAt:new Date().toISOString(),url};
      try {
        const r=await ctx.http.get(url),feed=await parser.parseString(r.text);v.status='feed_parsed';v.httpStatus=r.status;v.title=feed.title;
        v.items=feed.items.length;v.snapshotPath=r.snapshotPath;
        v.relevantItems=feed.items.filter(i=>evaluateSourceRelevance(s,i.title,i.contentSnippet||i.content||'').eligible).length;
        v.samples=feed.items.slice(0,3).map(i=>({title:i.title,url:i.link,publishedAt:i.isoDate||i.pubDate||null}));
        if(args.activate==='true')s.enabled=true;
      }catch(e){v.status='unavailable';v.error=String(e.message).split('\n')[0];}
      s.verification={...s.verification,...v};results.push({id:s.id,...v});
      console.log(JSON.stringify({id:s.id,status:v.status,items:v.items,relevantItems:v.relevantItems,error:v.error}));
    }
  }));
}finally{await ctx.close();}
await writeFile(join(out,'feed-probes.json'),JSON.stringify({observedAt:ctx.now,results},null,2)+'\n');
await writeFile(configPath,JSON.stringify(config,null,2)+'\n');
console.log(JSON.stringify({probed:results.length,parsed:results.filter(r=>r.status==='feed_parsed').length,withRelevantItems:results.filter(r=>r.relevantItems>0).length}));
