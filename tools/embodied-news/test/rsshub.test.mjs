import test from 'node:test';
import assert from 'node:assert/strict';
import {resolveSubscriptions} from '../lib/rsshub.mjs';
import {hydrate} from '../adapters/rsshub.mjs';
import * as html from '../lib/html.mjs';
import {evaluateRelevance} from '../adapters/feeds.mjs';
test('RSSHub expands only enabled routes and rejects excluded/unsafe sources',()=>{
  const config={baseUrl:'http://127.0.0.1:1200',excludedSourceIds:['excluded'],sources:[{id:'robot',route:'/github/repo_event/ros2/ros2/release',enabled:true},{id:'later',route:'/pending',enabled:false}]};
  assert.equal(resolveSubscriptions(config).length,1);
  assert.equal(resolveSubscriptions(config)[0].entryUrl,'http://127.0.0.1:1200/github/repo_event/ros2/ros2/release');
  config.sources[0].id='excluded';assert.throws(()=>resolveSubscriptions(config),/Excluded/);
  config.sources[0].id='robot';config.sources[0].route='//other.test/';assert.throws(()=>resolveSubscriptions(config));
});
test('RSSHub release hydration retrieves maintainer body/date and keeps prerelease status',async()=>{
  const url='https://github.com/ros2/ros2/releases/tag/v1';let requested;
  const item=await hydrate({id:'v1',url,metadata:{}},{id:'robot-releases',githubRepo:'ros2/ros2',role:'MAINTAINER_RELEASE'},
    {http:{async get(u){requested=u;return {text:JSON.stringify({tag_name:'v1',html_url:url,published_at:'2026-10-22T12:00:00Z',body:'Actual maintainer release notes',prerelease:true,author:{login:'maintainer'}})};}}});
  assert.equal(requested,'https://api.github.com/repos/ros2/ros2/releases/tags/v1');assert.equal(item.content,'Actual maintainer release notes');assert.equal(item.metadata.releasePrerelease,true);
  assert.equal(item.evidence[0].relation,'original');
});
test('Community/media feed never becomes original evidence just because RSSHub returned it',async()=>{
  await assert.rejects(hydrate({url:'https://community.test/item'}, {role:'COMMUNITY_DISCOVERY'},{}),/distinct original evidence/);
});
test('RSSHub arXiv hydration preserves original publication separately from revision date',async()=>{
  const text='<feed><entry><id>http://arxiv.org/abs/2601.12345v2</id><title>Robot grasping</title><summary>Detailed original abstract for robot manipulation research.</summary><published>2026-01-10T12:00:00Z</published><updated>2026-10-22T12:00:00Z</updated><author><name>Author</name></author></entry></feed>';
  const item=await hydrate({id:'paper',url:'https://arxiv.org/abs/2601.12345v2',metadata:{}},{id:'hub-arxiv-robotics',role:'RESEARCH_PREPRINT'}, {html,http:{async get(){return {text};}}});
  assert.equal(item.publishedAt,'2026-01-10T12:00:00.000Z');assert.equal(item.metadata.arxivUpdatedAt,'2026-10-22T12:00:00Z');
  assert.equal(item.evidenceClass,'preprint');assert.equal(item.content,'Detailed original abstract for robot manipulation research.');
});
test('Only a same-publisher native feed can supply a missing original page date',async()=>{
  const candidate={id:'robot',title:'Robot control',url:'https://lab.example/robot',publishedAt:'2026-10-22T12:00:00Z',publishedAtRaw:'Thu, 22 Oct 2026 12:00:00 GMT',datePrecision:'second',metadata:{}};
  const source={id:'lab-feed',entryUrl:'https://lab.example/feed.xml',website:'https://lab.example',role:'LAB_ORIGINAL_ANNOUNCEMENT'};
  const body='<html><article><h1>Robot control</h1><p>'+('Researchers developed a new robot grasp controller and evaluated manipulation in real hardware. '.repeat(3))+'</p></article></html>';
  const ctx={html,http:{async get(url){return {text:body,url,status:200};}}};
  const item=await hydrate(candidate,source,ctx);
  assert.equal(item.metadata.dateEvidenceBasis,'publisher-native-feed');
  assert.equal(item.metadata.dateEvidenceUrl,source.entryUrl);
  await assert.rejects(hydrate(candidate,{...source,route:'/lab/research'},ctx),/date still needs verification/);
});
test('Engineering author feed does not turn generic neural-network coursework into robotics news',()=>{
  assert.equal(evaluateRelevance('hub-zhuoqing','人工神经网络（2026年秋季学期）：第二次作业要求','本次操作需要使用数据集，作者也参与机器人课程。').eligible,false);
  assert.equal(evaluateRelevance('hub-zhuoqing','智能车比赛：电机速度控制与编码器采样','PID 控制器调参过程').eligible,true);
});
