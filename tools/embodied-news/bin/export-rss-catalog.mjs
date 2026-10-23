import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {createHash} from 'node:crypto';
const args={};for(let i=2;i<process.argv.length;i+=2)args[process.argv[i].replace(/^--/,'')]=process.argv[i+1];
const out=resolve(args.out||'reports/source-research/rss-keywords-2026-10-23');await mkdir(out,{recursive:true});
const json=async path=>JSON.parse(await readFile(path,'utf8'));
const files=['rsshub.json','rss-publishers.json','rss-domestic.json','rss-keywords.json','rss-keywords-international.json'];
const configs=await Promise.all(files.map(f=>json(join('config',f))));
const all=configs.flatMap((c,i)=>c.sources.map(s=>({...s,config:files[i],url:s.route?c.baseUrl.replace(/\/$/,'')+s.route:s.entryUrl})));
const enabled=all.filter(s=>s.enabled),keywords=all.filter(s=>s.adapter==='keyword-search'),direct=all.filter(s=>s.adapter!=='keyword-search');
const rows=all.map(s=>({id:s.id,name:s.name,config:s.config,enabled:s.enabled,type:s.adapter==='keyword-search'?'keyword-discovery':s.route?'rsshub':'native',region:s.region??s.locale??'',role:s.role,groups:s.keywordGroups??[s.keywordGroup].filter(Boolean),keywords:s.keywords??[],url:s.url,fallbackUrls:s.fallbackUrls??[],status:s.verification?.status,checkedAt:s.verification?.checkedAt,items:s.verification?.items??s.verification?.rawItems,relevantItems:s.verification?.relevantItems,error:s.verification?.error??'',originalEvidenceRequired:true}));
const csvCell=v=>'"'+String(Array.isArray(v)?v.join(' | '):v??'').replaceAll('"','""')+'"';
const columns=Object.keys(rows[0]);
await writeFile(join(out,'catalog.json'),JSON.stringify(rows,null,2)+'\n');
await writeFile(join(out,'catalog.csv'),columns.join(',')+'\n'+rows.map(r=>columns.map(c=>csvCell(r[c])).join(',')).join('\n')+'\n');
const library=await json('reports/source-research/keyword-library.json');
const coverage=library.groups.map(group=>({id:group.id,name:group.name,terms:group.terms.map(term=>({term,subscriptions:keywords.filter(s=>s.keywords.includes(term)).map(s=>({id:s.id,locale:s.locale,query:s.searchQuery,url:s.url,fallbackUrls:s.fallbackUrls,enabled:s.enabled,status:s.verification.status,results:s.verification.relevantItems}))}))}));
await writeFile(join(out,'keyword-coverage.json'),JSON.stringify(coverage,null,2)+'\n');
const xml=s=>String(s??'').replaceAll('&','&amp;').replaceAll('"','&quot;').replaceAll('<','&lt;').replaceAll('>','&gt;');
const feeds=ss=>ss.map(s=>`    <outline type="rss" text="${xml(s.name)}" title="${xml(s.name)}" xmlUrl="${xml(s.url)}" htmlUrl="${xml(s.website)}"/>`).join('\n');
const opml=groups=>'<?xml version="1.0" encoding="UTF-8"?>\n<opml version="2.0"><head><title>具身智能日报 RSS 订阅</title></head><body>\n'+groups.map(([name,ss])=>`  <outline text="${xml(name)}">\n${feeds(ss)}\n  </outline>`).join('\n')+'\n</body></opml>\n';
const primary=direct.filter(s=>s.enabled);
await writeFile(join(out,'publishers.opml'),opml([['原生 RSS / Atom',primary.filter(s=>!s.route)],['本机 RSSHub',primary.filter(s=>s.route)]]));
await writeFile(join(out,'keywords.opml'),opml(library.groups.flatMap(g=>['zh-CN','en-US'].map(locale=>[`${g.name??g.id} · ${locale}`,keywords.filter(s=>s.enabled&&s.keywordGroup===g.id&&s.locale===locale)]))));
const observed=new Set();let observations=0,evidenceBatches=0;
for(const dir of ['keyword-probe','complement-probe']){
  let report;try{report=await json(join(out,dir,'results.json'));}catch(error){if(error.code==='ENOENT')continue;throw error;}
  evidenceBatches++;
  for(const r of report.results){if(!r.intake)continue;const p=await json(join(out,dir,r.intake));observations+=p.candidates.length;for(const c of p.candidates)observed.add(c.metadata?.feedIntake?.canonicalUrl??c.url);}
}
const summary={generatedAt:new Date().toISOString(),configHashes:Object.fromEntries(await Promise.all(files.map(async f=>[f,createHash('sha256').update(await readFile(join('config',f))).digest('hex')]))),
  registeredSubscriptions:all.length,enabledSubscriptions:enabled.length,distinctEnabledFeedUrls:new Set(enabled.map(s=>s.url)).size,
  publisherSubscriptionsEnabled:primary.length,nativeEnabled:primary.filter(s=>!s.route).length,rsshubEnabled:primary.filter(s=>s.route).length,
  keywordTerms:coverage.reduce((n,g)=>n+g.terms.length,0),keywordGroups:coverage.length,keywordLanesEnabled:keywords.filter(s=>s.enabled).length,
  keywordDistinctFeedUrls:new Set(keywords.filter(s=>s.enabled).map(s=>s.url)).size,
  chineseLanes:keywords.filter(s=>s.locale==='zh-CN').length,englishLanes:keywords.filter(s=>s.locale==='en-US').length,
  keywordCandidateObservations:evidenceBatches?observations:null,distinctSearchCandidateUrls:evidenceBatches?observed.size:null,searchIntakeEvidenceBatches:evidenceBatches,
  newPublisherEnabled:configs[1].sources.filter(s=>s.enabled).length,newDomesticRsshubEnabled:configs[2].sources.filter(s=>s.enabled).length,
  newPublisherUnavailable:configs[1].sources.filter(s=>!s.enabled).length,newDomesticUnavailable:configs[2].sources.filter(s=>!s.enabled).length,
  userLoginRequired:[],qualification:'Subscription/URL/observation counts are not independent publishers, verified events, or today-only news. Original body and date still require verification.'};
await writeFile(join(out,'summary.json'),JSON.stringify(summary,null,2)+'\n');console.log(JSON.stringify(summary));
