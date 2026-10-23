import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {keywordSources,complementaryKeywordSources,articleUrl,excludedPublisher,keywordRelevant} from '../lib/keyword-feeds.mjs';
import {configuredSources} from '../lib/rsshub.mjs';
import {discover,hydrate} from '../adapters/keyword-search.mjs';
import {discover as discoverFeed,evaluateSourceRelevance} from '../adapters/feeds.mjs';
import {replayFeedIntake} from '../lib/feed-intake.mjs';
import * as html from '../lib/html.mjs';
import {Pool,validateItem} from '../lib/pool.mjs';
const readJson=async path=>JSON.parse(await readFile(path,'utf8'));
test('A successfully parsed discovery feed is healthy without manufacturing accepted news',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'keyword-health-')),pool=new Pool(dir);
  try{
    const source={id:'keyword-health',channelId:'primary',discoveryOnly:true};
    pool.health(source,{accepted:0,status:'discovery_ready',coverage:{pagesFetched:1}},'2026-10-23T10:00:00Z');
    const row=pool.db.prepare('SELECT * FROM health WHERE source_id=?').get(source.id);
    assert.equal(row.failures,0);assert.equal(row.last_success_at,'2026-10-23T10:00:00Z');
    assert.equal(pool.stats().items,0);
  }finally{pool.close();await rm(dir,{recursive:true,force:true});}
});
test('All saved user keywords have one Chinese and one English discovery lane',async()=>{
  const library=await readJson('reports/source-research/keyword-library.json');
  const sources=keywordSources(library),other=complementaryKeywordSources(library,await readJson('config/keyword-translations.en.json'));
  assert.equal(sources.length,150);assert.equal(new Set([...sources,...other].map(s=>s.id)).size,300);
  for(const source of sources){const pair=other.find(s=>s.keywords[0]===source.keywords[0]);assert.notEqual(pair.locale,source.locale);assert.equal(pair.discoveryOnly,true);}
  const config=await readJson('config/sources.json'),enabled=await configuredSources(config,'config/sources.json');
  assert.equal(enabled.filter(s=>s.adapter==='keyword-search'&&s.discoveryOnly).length,300);
  assert.ok(!enabled.some(s=>['jiqizhixin-library','limx-news','physical-intelligence-blog'].includes(s.id)));
});
test('Search links preserve exclusions and reject unrelated same-name news',()=>{
  assert.equal(articleUrl('https://www.bing.com/news/apiclick.aspx?url=https%3A%2F%2Flab.test%2Frobot'),'https://lab.test/robot');
  assert.equal(excludedPublisher('https://www.jiqizhixin.com/articles/x'),true);
  assert.equal(excludedPublisher('https://news.google.com/rss/articles/x','逐际动力'),true);
  assert.equal(keywordRelevant('Figure skating medal','Sport competition',{keywordGroup:'companies_capital'}),false);
  assert.equal(keywordRelevant('New motor encoder','PCB firmware',{keywordGroup:'hardware'}),true);
});
test('Search fallback is archived and replayed; it cannot qualify an article',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'keyword-feed-'));
  const source={id:'keyword-test',keywords:['robot'],keywordGroup:'technology',searchQuery:'robot',entryUrl:'https://search.test/a',fallbackUrls:['https://search.test/b']};
  const xml='<rss version="2.0"><channel><title>Search</title><item><title>New robot hand</title><link>https://lab.test/hand</link><pubDate>Fri, 23 Oct 2026 01:00:00 GMT</pubDate><description>Robot manipulation research</description></item></channel></rss>';
  try {
    const result=await discover(source,{workDir:dir,now:'2026-10-23T10:00:00Z',html,http:{async get(url){if(url.endsWith('/a'))throw new Error('HTTP 503');return {url,status:200,text:xml};}}});
    assert.equal(result.candidates.length,1);assert.equal(result.coverage.selectedFeed,source.fallbackUrls[0]);
    assert.equal(result.candidates[0].metadata.originalEvidenceRequired,true);
    assert.equal(result.candidates[0].metadata.feedIntake.dateVerified,false);
    assert.equal((await replayFeedIntake(join(dir,result.coverage.feedIntake),html,discover)).candidates,1);
    await assert.rejects(hydrate(),/original article/);
  }finally{await rm(dir,{recursive:true,force:true});}
});
test('Only explicitly scoped engineering publishers admit hardware-only items',()=>{
  assert.equal(evaluateSourceRelevance({id:'hardware',topicScope:'engineering'},'New encoder and motor controller','PCB').eligible,true);
  assert.equal(evaluateSourceRelevance({id:'general'},'New encoder and motor controller','PCB').eligible,false);
  assert.equal(evaluateSourceRelevance({id:'hub-zhuoqing'},'人工神经网络课程作业','机器人课程操作').eligible,false);
});
test('Whole-site research feeds reject incidental robot mentions in generic AI or surgery news',()=>{
  for(const [id,title] of [['publisher-amazon-science','New PyTorch backend for Trainium'],['publisher-mit-news','Surgical stitching like applying a sticky note'],['publisher-nvidia-blog','Kazakhstan AI compute ecosystem']]) {
    const content='A general technology announcement mentioning robotics simulation at the end. '.repeat(3);
    assert.equal(evaluateSourceRelevance({id},title,content).eligible,false);
    assert.throws(()=>validateItem({sourceId:id,sourceItemId:'a',title,url:'https://lab.test/a',publishedAt:'2026-10-22T12:00:00Z',datePrecision:'second',content,evidenceClass:'company_announcement'}),/not a robotics event/);
  }
  assert.equal(evaluateSourceRelevance({id:'publisher-nsf'},'Can prosthetic limbs feel touch? Haptic feedback','').eligible,true);
});
test('Generated government midnight timestamps retain day precision',async()=>{
  const r=await discoverFeed({id:'government',entryUrl:'https://gov.test/rss',feedDatePrecision:'day'}, {now:'2026-10-23T10:00:00Z',html,http:{async get(url){return {url,status:200,text:'<rss version="2.0"><channel><title>Government</title><item><title>Robot standards</title><link>https://gov.test/policy</link><pubDate>Fri, 23 Oct 2026 00:00:00 GMT</pubDate></item></channel></rss>'};}}});
  assert.equal(r.candidates[0].datePrecision,'day');assert.equal(r.candidates[0].metadata.feedIntake.windowStatus,'date_needs_verification');
});
