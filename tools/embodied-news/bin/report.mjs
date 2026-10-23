import {configuredSources} from '../lib/rsshub.mjs';
import { readFile,writeFile,mkdir } from 'node:fs/promises';
import { resolve,join } from 'node:path';
import { Pool } from '../lib/pool.mjs';
import { redact } from '../lib/sanitize.mjs';
const args={};for(let i=2;i<process.argv.length;i+=2)args[process.argv[i].slice(2)]=process.argv[i+1];
const config=JSON.parse(await readFile(resolve(args.config || 'config/sources.json'),'utf8'));
config.sources=await configuredSources(config,resolve(args.config || 'config/sources.json'));
const data=resolve(args.data || 'data');const output=resolve(args.output || data);await mkdir(output,{recursive:true});
const pool=new Pool(data);
try {
  const history=pool.db.prepare('SELECT payload FROM runs WHERE finished_at IS NOT NULL ORDER BY started_at').all().map(r=>JSON.parse(r.payload));
  let verification={checks:[]};try {verification=JSON.parse(await readFile(join(data,'verification.json'),'utf8'));}catch(e){if(e.code!=='ENOENT')throw e;}
  const items=pool.export();
  const report={generatedAt:new Date().toISOString(),column:config.column.name,stats:pool.stats(),channels:[],sources:[],verificationMode:verification.mode || 'not_run',allAccepted:false,scope:{sourceGroups:config.sources.length,channels:config.sources.reduce((n,s)=>n+1+(s.officialProfiles || []).length,0)},excludedSources:(config.excludedSources || []).map(s=>({sourceId:s.id,name:s.name,excludedAt:s.excludedAt,reason:s.exclusionReason}))};
  for(const source of config.sources){
    const channels=[{channelId:'primary',url:source.entryUrl},...(source.officialProfiles || []).map((p,i)=>({channelId:`profile-${i+1}`,url:p.url,ownerEvidence:p.ownerEvidence}))];
    for(const channel of channels){
      const runs=history.flatMap(r=>r.channels.filter(c=>c.sourceId===source.id && c.channelId===channel.channelId).map(c=>({...c,runId:r.runId,at:r.finishedAt})));
      const samples=items.filter(i=>i.sourceId===source.id && i.channelId===channel.channelId);
      const checks=verification.checks.filter(c=>c.sourceId===source.id && c.channelId===channel.channelId);
      const currentRevisions=new Map(samples.map(s=>[s.itemId,s.revision]));
      const currentHashes=new Map(samples.map(s=>[s.itemId,s.contentHash]));
      const currentChecks=checks.filter(c=>currentRevisions.get(c.itemId)===c.revision && currentHashes.get(c.itemId)===c.contentHash);
      const repeated=runs.some(r=>(r.outcomes || []).some(o=>o.action==='unchanged' && currentRevisions.get(o.itemId)===o.revision));
      const recoveryVerified=currentChecks.some(c=>c.retryRecovery==='pass' && c.interruptedRecovery==='pass' && c.checkpoint==='pass');
      const validated=samples.length>0 && repeated && currentChecks.some(c=>c.replay==='pass' && c.update==='pass' && c.retry==='pass' && c.retryRecovery==='pass' && c.interruptedRecovery==='pass' && c.checkpoint==='pass');
      const failures=pool.db.prepare('SELECT at,stage,error FROM failures WHERE source_id=? AND channel_id=? ORDER BY id DESC LIMIT 10').all(source.id,channel.channelId);
      const pending=pool.db.prepare("SELECT status,count(*) n FROM candidates WHERE source_id=? AND channel_id=? GROUP BY status").all(source.id,channel.channelId);
      const latest=runs.at(-1);
      report.channels.push({sourceId:source.id,name:source.name,...channel,status:validated ? latest?.accepted>0 ? 'accepted' : 'degraded_requires_recovery' : samples.length?'needs_replay_or_verification':'blocked',acceptedItems:samples.length,realReplay:repeated,controlledUpdateRecovery:recoveryVerified && currentChecks.some(c=>c.update==='pass'),candidateStates:pending,discoveryCheckpoint:pool.state({...source,channelId:channel.channelId}),latestRun:latest || null,failures,sample:samples[0]?{itemId:samples[0].itemId,title:samples[0].title,url:samples[0].url,publishedAt:samples[0].publishedAt,publishedAtRaw:samples[0].publishedAtRaw,datePrecision:samples[0].datePrecision,firstDiscoveredAt:samples[0].firstDiscoveredAt,bodyCharacters:samples[0].content.length,bodyExcerpt:samples[0].content.slice(0,450),evidence:samples[0].evidence,metadata:samples[0].metadata,snapshotPath:join(data,samples[0].raw.snapshotPath)}:null});
    }
    const rows=report.channels.filter(c=>c.sourceId===source.id);report.sources.push({sourceId:source.id,name:source.name,status:rows.every(c=>c.status==='accepted')?'accepted':'incomplete',passedChannels:rows.filter(c=>c.status==='accepted').length,totalChannels:rows.length});
  }
  report.allAccepted=report.sources.length>0 && report.sources.length===config.sources.length && report.channels.length===report.scope.channels && report.sources.every(s=>s.status==='accepted');
  Object.assign(report,redact(report));
  await writeFile(join(output,'acceptance.json'),JSON.stringify(report,null,2)+'\n');
  const lines=[`具身智能日报逐源验收 ${report.generatedAt}`,`全部完成：${report.allAccepted ? '是':'否'}`,`当前范围：${report.scope.sourceGroups} 组来源、${report.scope.channels} 个入口；用户移除 ${report.excludedSources.length} 组`,`消息 ${report.stats.items}；事件 ${report.stats.events}；候选 ${report.stats.candidates}；版本 ${report.stats.versions}`,`更新及恢复验证：${report.verificationMode}（受控变更不代表发布者实际更新）`,'','来源 | 状态 | 通过入口/总入口'];
  for(const row of report.sources)lines.push(`${row.name} | ${row.status} | ${row.passedChannels}/${row.totalChannels}`);
  for(const row of report.channels){lines.push('',`${row.name} / ${row.channelId}: ${row.status}`,`入口：${row.url}`,`入库 ${row.acceptedItems}；真实重采 ${row.realReplay}；受控更新恢复 ${row.controlledUpdateRecovery}`);if(row.sample)lines.push(`样本：${row.sample.title}`,`原文：${row.sample.url}`,`日期：${row.sample.publishedAtRaw}（${row.sample.datePrecision}）`,`正文长度：${row.sample.bodyCharacters}`,`正文快照：${row.sample.snapshotPath}`);if(row.latestRun)lines.push(`覆盖：${JSON.stringify(row.latestRun.coverage)}`,`入口问题：${JSON.stringify(row.latestRun.issues)}`);if(row.failures.length)lines.push(`近期失败：${JSON.stringify(row.failures)}`);}
  await writeFile(join(output,'acceptance.txt'),lines.join('\n')+'\n');
  await writeFile(join(output,'samples.jsonl'),report.channels.filter(c=>c.sample).map(c=>JSON.stringify({sourceId:c.sourceId,channelId:c.channelId,...c.sample})).join('\n')+'\n');
  console.log(JSON.stringify({allAccepted:report.allAccepted,sourcesAccepted:report.sources.filter(s=>s.status==='accepted').length,channelsAccepted:report.channels.filter(c=>c.status==='accepted').length,stats:report.stats}));
}finally{pool.close();}
