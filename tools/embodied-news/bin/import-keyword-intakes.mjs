import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {resolve,join,relative,isAbsolute} from 'node:path';
import lockfile from 'proper-lockfile';
import {Pool} from '../lib/pool.mjs';
import {replayFeedIntake} from '../lib/feed-intake.mjs';
import {discover} from '../adapters/keyword-search.mjs';
import * as html from '../lib/html.mjs';
const args={};for(let i=2;i<process.argv.length;i+=2)args[process.argv[i].replace(/^--/,'')]=process.argv[i+1];
if(!args.probe||!args.config)throw new Error('Usage: --probe PROBE_DIR --config SUBSCRIPTIONS.json [--data DATA_DIR]');
const folder=resolve(args.probe),config=JSON.parse(await readFile(args.config,'utf8')),registered=new Map(config.sources.filter(s=>s.enabled).map(s=>[s.id,s]));
const data=resolve(args.data||'data/live');await mkdir(data,{recursive:true});
const release=await lockfile.lock(data,{lockfilePath:join(data,'collector.mutex'),realpath:false,stale:60000,update:10000,retries:0});
const pool=new Pool(data),before=pool.stats(),sources=[],urls=new Set();
try {
  const report=JSON.parse(await readFile(join(folder,'results.json'),'utf8'));
  for(const row of report.results) {
    const source=registered.get(row.id);if(!source||!row.intake)continue;
    const file=resolve(folder,row.intake);const rel=relative(folder,file);if(rel.startsWith('..')||isAbsolute(rel))throw new Error('Unsafe intake path');
    const pack=JSON.parse(await readFile(file,'utf8'));
    if(pack.source.id!==source.id||pack.source.searchQuery!==source.searchQuery||pack.source.entryUrl!==source.entryUrl)throw new Error('Intake no longer matches configured search');
    await replayFeedIntake(file,html,discover);
    pool.discover({...source,channelId:'primary'},pack.candidates,pack.observedAt);
    pack.candidates.forEach(c=>urls.add(c.url));
    sources.push({sourceId:source.id,keyword:source.keywords[0],locale:source.locale,observedAt:pack.observedAt,candidates:pack.candidates.length,intake:row.intake});
  }
  const receipt={status:'captured_search_intakes_imported',importedAt:new Date().toISOString(),networkPerformed:false,
    originalEvidenceVerified:false,qualifiedArticlesAdded:0,sourceCount:sources.length,distinctCandidateUrls:urls.size,
    before,after:pool.stats(),sources};
  await writeFile(join(folder,'pool-import.json'),JSON.stringify(receipt,null,2)+'\n');
  console.log(JSON.stringify({status:receipt.status,sources:sources.length,distinctUrls:urls.size,addedCandidates:receipt.after.candidates-before.candidates,qualifiedArticlesAdded:0}));
}finally{pool.close();await release();}
