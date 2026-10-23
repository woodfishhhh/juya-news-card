import { writeFile,mkdir,readFile } from 'node:fs/promises';
import { resolve,join } from 'node:path';
import { Pool } from '../lib/pool.mjs';
import { redact } from '../lib/sanitize.mjs';
const data=resolve(process.argv[2] || 'data');const output=resolve(process.argv[3] || join(data,'report'));await mkdir(output,{recursive:true});
const p=new Pool(data);
try{
  const runs=p.db.prepare('SELECT payload FROM runs ORDER BY started_at').all().map(r=>redact(JSON.parse(r.payload)));
  const failures=p.db.prepare('SELECT * FROM failures ORDER BY id').all().map(redact);
  const candidates=p.db.prepare('SELECT * FROM candidates ORDER BY source_id,channel_id,discovered_at').all().map(r=>{const c=JSON.parse(r.payload);return redact({key:r.key,sourceId:r.source_id,channelId:r.channel_id,title:c.title,url:c.url,publishedAt:c.publishedAt,discoveredAt:r.discovered_at,lastSeenAt:r.last_seen_at,status:r.status,attempts:r.attempts,nextAttemptAt:r.next_attempt_at,error:r.error});});
  const quarantine=p.db.prepare('SELECT q.*,i.source_id,i.channel_id,i.title,i.canonical_url FROM quarantine q JOIN items i ON q.item_id=i.id').all().map(redact);
  const checkpoints=p.db.prepare('SELECT * FROM source_state ORDER BY source_id,channel_id').all().map(r=>redact({sourceId:r.source_id,channelId:r.channel_id,state:JSON.parse(r.payload),updatedAt:r.updated_at}));
  for(const [name,rows] of [['run-records',runs],['failures',failures],['candidate-state',candidates],['quarantine',quarantine],['source-checkpoints',checkpoints]])await writeFile(join(output,name+'.jsonl'),rows.map(r=>JSON.stringify(r)).join('\n')+'\n');
  const verification=JSON.parse(await readFile(join(data,'verification.json'),'utf8'));await writeFile(join(output,'verification.json'),JSON.stringify(verification,null,2)+'\n');
  console.log(JSON.stringify({runs:runs.length,failures:failures.length,candidates:candidates.length,quarantine:quarantine.length,checkpoints:checkpoints.length}));
}finally{p.close();}
