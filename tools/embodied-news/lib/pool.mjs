import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync, renameSync,readFileSync } from 'node:fs';
import { join } from 'node:path';
import { redact } from './sanitize.mjs';
import { evaluateRelevance, FOCUSED_BROAD_FEEDS } from '../adapters/feeds.mjs';

export const hash = value => createHash('sha256').update(value).digest('hex');
function contentIdentity(item) {
  const fields={title:item.title,publishedAt:item.publishedAt,publishedAtRaw:item.publishedAtRaw,datePrecision:item.datePrecision,content:item.content,evidenceClass:item.evidenceClass,evidence:item.evidence};
  // A new paper/release version can retain its abstract/body. Track publisher
  // update times without treating scrape times or signed URLs as revisions.
  const versionSignals={};
  const arxivUpdated=item.metadata?.latestVersionUpdatedAt ?? item.metadata?.arxivUpdatedAt;
  if(arxivUpdated)versionSignals.arxivUpdatedAt=arxivUpdated;
  if(item.metadata?.releaseUpdatedAt)versionSignals.releaseUpdatedAt=item.metadata.releaseUpdatedAt;
  if(Object.keys(versionSignals).length)fields.versionSignals=versionSignals;
  return fields;
}
function candidateIdentity(candidate) {
  const m=candidate.metadata || {};
  return JSON.stringify({title:candidate.title,publishedAt:candidate.publishedAt,publishedAtRaw:candidate.publishedAtRaw,datePrecision:candidate.datePrecision,summary:m.summary,updatedAt:m.arxivUpdatedAt ?? m.latestVersionUpdatedAt ?? m.releaseUpdatedAt});
}
export function canonicalUrl(value) {
  const url = new URL(value);
  if (!['https:', 'http:'].includes(url.protocol)) throw new Error('Non-public link scheme');
  url.hash = '';
  for (const key of [...url.searchParams.keys()]) if (/^(utm_|ref$|fbclid$|gclid$)/i.test(key)) url.searchParams.delete(key);
  if (/arxiv\.org$/.test(url.hostname)) { url.protocol = 'https:'; url.hostname = 'arxiv.org'; url.pathname = url.pathname.replace('/pdf/', '/abs/').replace(/v\d+(?:\.pdf)?$/, '').replace(/\.pdf$/, ''); }
  if (url.pathname !== '/') url.pathname = url.pathname.replace(/\/$/, '');
  return url.href;
}
export function validateItem(item) {
  for (const field of ['sourceId', 'sourceItemId', 'title', 'url', 'publishedAt', 'content', 'evidenceClass']) if (typeof item[field] !== 'string' || !item[field].trim()) throw new Error(`Missing ${field}`);
  canonicalUrl(item.url);
  if (!Number.isFinite(Date.parse(item.publishedAt))) throw new Error('Invalid publication date');
  if (!['day', 'second'].includes(item.datePrecision)) throw new Error(`Insufficient publication precision: ${item.datePrecision}`);
  if (Date.parse(item.publishedAt) > Date.now() + 86400000) throw new Error('Future publication date');
  const minimum=/[\u3400-\u9fff]/.test(item.content) ? 40 : 60;
  if (item.content.trim().length < minimum || item.content.trim() === item.title.trim()) throw new Error('Missing substantive body');
  if (/verify you are human|vercel security checkpoint|checking your browser|access denied|请完成安全验证/i.test(item.content)) throw new Error('Challenge page is not content');
  if(['deepmind-feed','nvidia-developer-feed','qbitai-feed','jiqizhixin-library'].includes(item.sourceId) && !/robot|embodi|humanoid|locomot|teleoperat|dexter|\bVLA\b|physical intelligence|physical ai|isaac|gr00t|lerobot|机器人|具身|机械臂|灵巧手|人形|运动控制/i.test(`${item.title} ${item.content}`)) throw new Error('Body is unrelated to embodied intelligence');
  if (['deepmind-feed','nvidia-developer-feed','hub-zhuoqing'].includes(item.sourceId) || FOCUSED_BROAD_FEEDS.has(item.sourceId)) {
    const relevance = evaluateRelevance(item.sourceId,item.title,item.content);
    if (!relevance.eligible) throw new Error('Not an embodied robotics item: ' + relevance.reason);
  }
  if (!Array.isArray(item.evidence) || !item.evidence.some(e => e.relation === 'original')) throw new Error('Missing original evidence');
  for (const e of item.evidence) canonicalUrl(e.url);
  const officialAlternative=item.sourceId==='galbot-news' && item.metadata?.alternativeType==='official-channel-video' && item.metadata?.officialChannelId==='UCtWK-1gf-HoocxS-DUirRow';
  const media = ['ieee-robotics-feed','qbitai-feed','robot-report-feed','jiqizhixin-library'].includes(item.sourceId) || (item.sourceId==='galbot-news' && item.metadata?.media === true && !officialAlternative);
  const firsthandInterview = item.sourceId==='galbot-news'
    && item.evidenceClass==='independent_reporting'
    && item.metadata?.sourceRole==='MEDIA_ORIGINAL'
    && item.metadata?.reportingFormat==='firsthand_interview'
    && item.metadata?.reportingType==='original_reporting'
    && item.metadata?.claimVerification==='company_statement_unverified'
    && item.metadata?.interviewee==='赵于莉'
    && /(?:^|\.)xinhuanet\.com$|(?:^|\.)news\.cn$/.test(new URL(item.url).hostname)
    && canonicalUrl(item.raw?.url || item.url)===canonicalUrl(item.url)
    && /北京银河通用机器人有限公司.{0,40}赵于莉.{0,20}接受新华网专访/.test(item.content.split(/\n\s*\n/)[0].replace(/\s+/g,''))
    && item.evidence.some(e=>e.relation==='original' && e.kind==='independent_reporting' && canonicalUrl(e.url)===canonicalUrl(item.url));
  if (media && !firsthandInterview && !item.evidence.some(e=>e.relation==='original' && canonicalUrl(e.url)!==canonicalUrl(item.url) && e.kind!=='independent_reporting')) throw new Error('Media discovery still needs a distinct retrieved primary evidence source');
  if (!item.raw?.content) throw new Error('Missing content snapshot');
  if (item.channelId?.startsWith('profile-') && item.metadata?.ownershipVerifiedAgainstEntryPage !== true) throw new Error('Official account ownership not verified against an official page');
  return item;
}
function eventKeys(item) {
  const originals = item.evidence.filter(e => e.relation === 'original' && !['repository', 'unknown'].includes(e.kind));
  const keys = originals.map(e => `url:${canonicalUrl(e.url)}`).filter(key => new URL(key.slice(4)).pathname !== '/');
  if(!item.metadata?.roundupSegment)keys.push(`url:${canonicalUrl(item.url)}`);
  // Exact title/date is conservative: don't merge different demos based on shared marketing words.
  const title = item.title.normalize('NFKC').toLowerCase().replace(/[\p{P}\p{Z}\s]+/gu, '');
  if (title.length >= 20 && !item.metadata?.roundupSegment) keys.push(`title:${item.publishedAt.slice(0, 10)}:${title}`);
  if(!keys.length)keys.push(`url:${canonicalUrl(item.url)}`);
  return [...new Set(keys)];
}

export class Pool {
  constructor(directory,{recover=false}={}) {
    this.directory = directory;
    mkdirSync(join(directory, 'snapshots'), { recursive: true });
    this.db = new DatabaseSync(join(directory, 'pool.sqlite'));
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS candidates(key TEXT PRIMARY KEY, source_id TEXT, channel_id TEXT, payload TEXT, discovered_at TEXT, last_seen_at TEXT, status TEXT DEFAULT 'pending', attempts INTEGER DEFAULT 0, next_attempt_at TEXT, error TEXT);
      CREATE TABLE IF NOT EXISTS events(id TEXT PRIMARY KEY, first_discovered_at TEXT);
      CREATE TABLE IF NOT EXISTS event_keys(key TEXT PRIMARY KEY, event_id TEXT REFERENCES events(id));
      CREATE TABLE IF NOT EXISTS items(id TEXT PRIMARY KEY, source_id TEXT, channel_id TEXT, source_item_id TEXT, event_id TEXT REFERENCES events(id), canonical_url TEXT, title TEXT, published_at TEXT, first_discovered_at TEXT, last_seen_at TEXT, revision INTEGER, content_hash TEXT, payload TEXT);
      CREATE TABLE IF NOT EXISTS versions(item_id TEXT REFERENCES items(id), revision INTEGER, content_hash TEXT, collected_at TEXT, snapshot_path TEXT, payload TEXT, PRIMARY KEY(item_id,revision));
      CREATE TABLE IF NOT EXISTS runs(id TEXT PRIMARY KEY, started_at TEXT, finished_at TEXT, payload TEXT);
      CREATE TABLE IF NOT EXISTS health(source_id TEXT, channel_id TEXT, last_attempt_at TEXT, last_success_at TEXT, failures INTEGER DEFAULT 0, status TEXT, payload TEXT, PRIMARY KEY(source_id,channel_id));
      CREATE TABLE IF NOT EXISTS failures(id INTEGER PRIMARY KEY, run_id TEXT, source_id TEXT, channel_id TEXT, candidate_key TEXT, at TEXT, stage TEXT, error TEXT);
      CREATE TABLE IF NOT EXISTS quarantine(item_id TEXT PRIMARY KEY REFERENCES items(id), reason TEXT, at TEXT);
      CREATE TABLE IF NOT EXISTS source_state(source_id TEXT,channel_id TEXT,payload TEXT,updated_at TEXT,PRIMARY KEY(source_id,channel_id));
    `);
    if(recover)this.db.prepare("UPDATE candidates SET status='pending' WHERE status='processing'").run();
  }
  candidateKey(source, candidate) {
    let url;try{url=canonicalUrl(candidate.url);}catch{url=`invalid:${candidate.id || candidate.title || hash(JSON.stringify(candidate))}`;}
    const segment=candidate.metadata?.roundupSegment ? `\nsegment:${canonicalUrl(candidate.metadata.segmentUrl)}` : '';
    return hash(`${source.id}\n${candidate.channelId || source.channelId || 'primary'}\n${url}${segment}`);
  }
  state(source) {const row=this.db.prepare('SELECT payload FROM source_state WHERE source_id=? AND channel_id=?').get(source.id,source.channelId || 'primary');return row?JSON.parse(row.payload):{};}
  discover(source, candidates, now,nextState) {
    const q = this.db.prepare(`INSERT INTO candidates(key,source_id,channel_id,payload,discovered_at,last_seen_at,status) VALUES(?,?,?,?,?,?,'pending') ON CONFLICT(key) DO UPDATE SET payload=excluded.payload,last_seen_at=excluded.last_seen_at`);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      for (const c of candidates) {
        const key=this.candidateKey(source,c);
        const previous=this.db.prepare('SELECT payload,status FROM candidates WHERE key=?').get(key);
        q.run(key,source.id,c.channelId || source.channelId || 'primary',JSON.stringify(c),now,now);
        if(previous?.status==='accepted' && candidateIdentity(JSON.parse(previous.payload))!==candidateIdentity(c))this.db.prepare("UPDATE candidates SET status='pending',next_attempt_at=NULL,error=NULL WHERE key=?").run(key);
        if (String(c.metadata?.eligibility || '').startsWith('excluded_')) this.db.prepare("UPDATE candidates SET status='filtered',error=? WHERE key=?").run(c.metadata.reason || c.metadata.eligibility,key);
        else this.db.prepare("UPDATE candidates SET status='pending',error=NULL WHERE key=? AND status='filtered'").run(key);
      }
      if(nextState!==undefined)this.db.prepare('INSERT OR REPLACE INTO source_state VALUES(?,?,?,?)').run(source.id,source.channelId || 'primary',JSON.stringify(nextState),now);
      this.db.exec('COMMIT');
    } catch(e) { this.db.exec('ROLLBACK'); throw e; }
  }
  queue(source, { limit = 50, force = false, refreshOnly = false,retryOnly=false,candidateUrl=null } = {}) {
    return this.db.prepare(`SELECT * FROM candidates WHERE source_id=? AND channel_id=? AND (? IS NULL OR json_extract(payload,'$.url')=?) AND status!='filtered' AND (?=0 OR (EXISTS (SELECT 1 FROM items WHERE items.id=candidates.key) AND NOT EXISTS (SELECT 1 FROM quarantine WHERE quarantine.item_id=candidates.key))) AND (?=0 OR status='failed') AND (? OR next_attempt_at IS NULL OR next_attempt_at<=?) ORDER BY CASE WHEN status IN ('pending','processing') THEN 0 WHEN status='failed' THEN 1 ELSE 2 END, last_seen_at DESC, COALESCE(json_extract(payload,'$.metadata.arxivUpdatedAt'),json_extract(payload,'$.metadata.latestVersionUpdatedAt'),json_extract(payload,'$.metadata.releaseUpdatedAt'),json_extract(payload,'$.publishedAt')) DESC LIMIT ?`).all(source.id,source.channelId || 'primary',candidateUrl,candidateUrl,refreshOnly ? 1 : 0,retryOnly ? 1 : 0,force ? 1 : 0,new Date().toISOString(),limit);
  }
  accept(item, candidateKey, now) {
    validateItem(item);
    const candidate = this.db.prepare('SELECT * FROM candidates WHERE key=?').get(candidateKey);
    if (!candidate) throw new Error('Candidate must be durably discovered before hydration');
    const id = candidateKey;
    const old = this.db.prepare('SELECT * FROM items WHERE id=?').get(id);
    const calculatedHash = hash(JSON.stringify(contentIdentity(item)));
    const oldPayload=old ? JSON.parse(old.payload) : null;
    const changed = !old || hash(JSON.stringify(contentIdentity(oldPayload))) !== calculatedHash;
    // Legacy hashes omitted version signals. Compare semantic content during
    // refresh and retain the historical hash until a genuine revision occurs.
    const contentHash = changed ? calculatedHash : old.content_hash;
    const revision = old ? old.revision + (changed ? 1 : 0) : 1;
    const snapshotPath = `snapshots/${hash(item.raw.content)}.txt`;
    const temp = join(this.directory, snapshotPath + '.tmp');
    writeFileSync(temp,item.raw.content,'utf8'); renameSync(temp,join(this.directory,snapshotPath));
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const keys = eventKeys(item);
      let eventId = old?.event_id;
      if (!eventId) for (const key of keys) { const match = this.db.prepare('SELECT event_id FROM event_keys WHERE key=?').get(key); if (match) { eventId = match.event_id; break; } }
      if (!eventId) { eventId = hash(keys[0]); this.db.prepare('INSERT OR IGNORE INTO events VALUES(?,?)').run(eventId,candidate.discovered_at); }
      for (const key of keys) this.db.prepare('INSERT OR IGNORE INTO event_keys VALUES(?,?)').run(key,eventId);
      const payload = { ...item, raw: { url:item.raw.url, mediaType:item.raw.mediaType, snapshotPath }, itemId:id,eventId,firstDiscoveredAt:candidate.discovered_at,collectedAt:now,revision,contentHash };
      this.db.prepare(`INSERT INTO items VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET title=excluded.title,published_at=excluded.published_at,last_seen_at=excluded.last_seen_at,revision=excluded.revision,content_hash=excluded.content_hash,payload=excluded.payload`).run(id,item.sourceId,item.channelId || 'primary',item.sourceItemId,eventId,canonicalUrl(item.url),item.title,item.publishedAt,candidate.discovered_at,now,revision,contentHash,JSON.stringify(payload));
      if (changed) this.db.prepare('INSERT INTO versions VALUES(?,?,?,?,?,?)').run(id,revision,contentHash,now,snapshotPath,JSON.stringify(payload));
      this.db.prepare("UPDATE candidates SET status='accepted',error=NULL,next_attempt_at=NULL WHERE key=?").run(candidateKey);
      this.db.prepare('DELETE FROM quarantine WHERE item_id=?').run(id);
      this.db.exec('COMMIT');
      return { action: !old ? 'inserted' : changed ? 'updated' : 'unchanged', eventId,itemId:id,revision };
    } catch(e) { this.db.exec('ROLLBACK'); throw e; }
  }
  fail(runId, source, key, stage, error, now) {
    const message = redact(error?.message || String(error));
    this.db.prepare('INSERT INTO failures(run_id,source_id,channel_id,candidate_key,at,stage,error) VALUES(?,?,?,?,?,?,?)').run(runId,source.id,source.channelId || 'primary',key || null,now,stage,message);
    if (key) { const c = this.db.prepare('SELECT attempts FROM candidates WHERE key=?').get(key); const seconds = Math.min(86400,60 * 2 ** Math.min(c?.attempts || 0,10)); const next=Math.max(Date.parse(now)+seconds*1000,Number.isFinite(Date.parse(error?.retryAt))?Date.parse(error.retryAt):0);this.db.prepare("UPDATE candidates SET status='failed',attempts=attempts+1,error=?,next_attempt_at=? WHERE key=?").run(message,new Date(next).toISOString(),key); }
  }
  health(source, payload, now) {
    const old = this.db.prepare('SELECT * FROM health WHERE source_id=? AND channel_id=?').get(source.id,source.channelId || 'primary');
    const success = payload.accepted > 0 || (source.discoveryOnly === true && payload.coverage?.pagesFetched > 0 && ['discovery_ready','discovery_empty'].includes(payload.status));
    this.db.prepare(`INSERT OR REPLACE INTO health VALUES(?,?,?,?,?,?,?)`).run(source.id,source.channelId || 'primary',now,success ? now : old?.last_success_at || null,success ? 0 : (old?.failures || 0)+1,payload.status,JSON.stringify(payload));
  }
  revalidate() {
    const failures=[];
    for (const row of this.db.prepare('SELECT id,payload FROM items').all()) {
      const item=JSON.parse(row.payload);
      try { const content=readFileSync(join(this.directory,item.raw.snapshotPath),'utf8');if(!item.raw.snapshotPath.includes(hash(content)))throw new Error('Raw snapshot hash mismatch');validateItem({...item,raw:{...item.raw,content}}); }
      catch(e) {this.db.prepare('INSERT OR REPLACE INTO quarantine VALUES(?,?,?)').run(row.id,e.message,new Date().toISOString());this.db.prepare("UPDATE candidates SET status='failed',error=?,next_attempt_at=NULL WHERE key=?").run(e.message,row.id);failures.push({itemId:row.id,error:e.message});}
    }
    return failures;
  }
  reindexEvents() {
    const rows=this.db.prepare('SELECT id,payload FROM items WHERE id NOT IN (SELECT item_id FROM quarantine) ORDER BY first_discovered_at,id').all();
    const parents=rows.map((_,i)=>i);const find=i=>parents[i]===i?i:(parents[i]=find(parents[i]));const owners=new Map();
    const sets=rows.map(r=>eventKeys(JSON.parse(r.payload)));
    sets.forEach((keys,i)=>{for(const key of keys){if(owners.has(key)){const a=find(i),b=find(owners.get(key));if(a!==b)parents[a]=b;}else owners.set(key,i);}});
    const groups=new Map();rows.forEach((r,i)=>{const root=find(i);if(!groups.has(root))groups.set(root,[]);groups.get(root).push(i);});
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.exec('DELETE FROM event_keys');
      for(const indexes of groups.values()){
        const keys=[...new Set(indexes.flatMap(i=>sets[i]))].sort();const eventId=hash(keys[0]);const first=indexes.map(i=>JSON.parse(rows[i].payload).firstDiscoveredAt).sort()[0];
        this.db.prepare('INSERT OR IGNORE INTO events VALUES(?,?)').run(eventId,first);
        for(const key of keys)this.db.prepare('INSERT OR REPLACE INTO event_keys VALUES(?,?)').run(key,eventId);
        for(const i of indexes){const item=JSON.parse(rows[i].payload);item.eventId=eventId;this.db.prepare('UPDATE items SET event_id=?,payload=? WHERE id=?').run(eventId,JSON.stringify(item),rows[i].id);}
      }
      this.db.exec('COMMIT');return groups.size;
    }catch(e){this.db.exec('ROLLBACK');throw e;}
  }
  stats() { const stats=Object.fromEntries(['items','events','versions','candidates','failures','quarantine'].map(t=>[t,this.db.prepare(`SELECT count(*) AS n FROM ${t}`).get().n]));stats.totalItems=stats.items;stats.items-=stats.quarantine;stats.events=this.db.prepare('SELECT count(DISTINCT event_id) n FROM items WHERE id NOT IN (SELECT item_id FROM quarantine)').get().n;return stats; }
  export() { return this.db.prepare('SELECT payload FROM items WHERE id NOT IN (SELECT item_id FROM quarantine) ORDER BY published_at DESC').all().map(r=>JSON.parse(r.payload)); }
  close() { this.db.close(); }
}
