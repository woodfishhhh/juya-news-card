import test from 'node:test';
import assert from 'node:assert/strict';
import { discover, hydrate } from '../adapters/research-media.mjs';
import * as html from '../lib/html.mjs';

const source = (id, entryUrl = 'https://example.test/') => ({ id, entryUrl });
function fakeContext(routes, overrides = {}) {
  return {
    now: '2026-09-30T00:00:00.000Z', maxPages: 3, limit: 5, html,
    http: { async get(url) { const val = routes[url]; if (val instanceof Error) throw val; if (!val) throw new Error(`No fixture for ${url}`); return { text: val, url, status: 200, headers: {} }; } },
    browser: { async get(url) { const val = routes[url]; if (typeof val === 'string') return { text: val, html: val, url, status: 200, headers: {} }; throw new Error('Unexpected browser fallback'); } },
    ...overrides,
  };
}

test('CoRL discovery filters unrelated submissions and keeps publication and conference dates distinct', async () => {
  const apiUrl = 'https://api2.openreview.net/notes?content.venueid=robot-learning.org/CoRL/2026/Conference&limit=1000&offset=0';
  const ctx = fakeContext({
    'https://2026.corl.org/': '<html><h1>CoRL 2026</h1></html>',
    'https://2026.corl.org/contributions/instruction-for-authors': '<html>Decision notifications are released on September 4, 2026.</html>',
    [apiUrl]: JSON.stringify({ notes: [
      { id: 'paper1', pdate: Date.parse('2026-09-04T12:00:00.000Z'), content: { title: { value: 'Robot manipulation with visual feedback' }, abstract: { value: 'We study robotic manipulation with a learned policy.' }, authors: { value: ['A. Researcher'] } } },
      { id: 'paper2', content: { title: { value: 'Text only language model for chat' }, abstract: { value: 'A general NLP model.' } } },
    ] }),
  });
  const result = await discover(source('corl-2026', 'https://2026.corl.org/'), ctx);
  assert.equal(result.candidates.length, 1);
  assert.equal(result.candidates[0].publishedAt.slice(0, 10), '2026-09-04');
  assert.equal(result.candidates[0].metadata.conferenceDates, '2026-11-09/2026-11-12');
  assert.equal(result.coverage.filteredOut, 1);
});

test('CoRL dated announcement hydrates its official target body and keeps conference dates separate', async () => {
  const url = 'https://2026.corl.org/contributions/call-for-demos';
  const body = '<html><h1>Search this site</h1><div class="tyJCtd"><h2>Call for Demos</h2><p>CoRL 2026 invites robotics research demonstrations from accepted papers and the wider community. Demonstrations are held during the main conference.</p></div></html>';
  const item = { id: 'announcement-1', title: 'Call for Demos posted!', url, publishedAt: '2026-08-06T00:00:00.000Z', publishedAtRaw: '08/06 (dated announcement on official CoRL 2026 homepage)', datePrecision: 'day', metadata: { itemKind: 'official_announcement', dateSemantics: 'official_dated_announcement', dateSource: 'https://2026.corl.org/', dateEvidenceText: '08/06 - Call for Demos posted!', conferenceDates: '2026-11-09/2026-11-12' } };
  const result = await hydrate(item, source('corl-2026', 'https://2026.corl.org/'), fakeContext({ [url]: body }));
  assert.match(result.content, /CoRL 2026 invites robotics research demonstrations/);
  assert.doesNotMatch(result.content, /Search this site/);
  assert.equal(result.publishedAt, '2026-08-06T00:00:00.000Z');
  assert.equal(result.metadata.conferenceDates, '2026-11-09/2026-11-12');
  assert.equal(result.evidence[0].url, url);
  assert.equal(result.evidence[0].relation, 'original');
  assert.equal(result.evidenceClass, 'official_announcement');
});

test('CoRL marks accepted-paper discovery skipped when the page budget excludes OpenReview', async () => {
  const ctx = fakeContext({
    'https://2026.corl.org/': '<html><li>08/06 - Call for Demos posted! <a href="/contributions/call-for-demos">Call for Demos</a></li></html>',
    'https://2026.corl.org/contributions/instruction-for-authors': '<html>Decisions will be announced on September 4, 2026.</html>',
  }, { maxPages: 2 });
  const result = await discover(source('corl-2026', 'https://2026.corl.org/'), ctx);
  assert.equal(result.candidates.length, 1);
  assert.equal(result.coverage.announcementPaginationComplete, true);
  assert.equal(result.coverage.acceptedPaperDiscovery.status, 'SKIPPED_PAGE_BUDGET');
  assert.equal(result.coverage.acceptedPaperDiscovery.noteCount, null);
  assert.equal(result.coverage.paginationComplete, false);
  assert.match(result.coverage.paginationIncompleteReason, /before the OpenReview accepted-paper listing/);
});

test('hydrate rejects publication dates that are only unknown precision', async () => {
  const ctx = fakeContext({});
  await assert.rejects(() => hydrate({ id: 'pending', title: 'A media story', url: 'https://example.test/paper', publishedAt: null, publishedAtRaw: null, datePrecision: 'unknown', metadata: {} }, source('robot-report-feed'), ctx), /explicit qualifying publication date/);
});

test('Robot Report discovery preserves a failed original feed and reports inaccessible alternatives', async () => {
  const ctx = fakeContext({
    'https://www.therobotreport.com/feed/': new Error('HTTP 403: feed'),
    'https://www.therobotreport.com/category/robotics/feed/': new Error('HTTP 403: category feed'),
    'https://www.therobotreport.com/robots.txt': 'User-agent: *',
    'https://www.therobotreport.com/wp-json/wp/v2/posts?per_page=20&_fields=date,link,title,excerpt,content': new Error('HTTP 403: API'),
  });
  const result = await discover(source('robot-report-feed', 'https://www.therobotreport.com/feed/'), ctx);
  assert.equal(result.candidates.length, 0);
  assert.match(result.coverage.originalEntryFailure.error, /403/);
  assert.match(result.coverage.apiFailure, /403/);
  await assert.rejects(() => hydrate({ id: 'story', title: 'Robot update', url: 'https://www.therobotreport.com/story', publishedAt: '2026-09-01T00:00:00.000Z', publishedAtRaw: '2026-09-01', datePrecision: 'day', metadata: {} }, source('robot-report-feed'), fakeContext({ 'https://www.therobotreport.com/story': '<html><article>A story with enough text to count as an article, but with no links to the original paper, product, project, model card, repository, demo, or official announcement.</article></html>' })), /original.*evidence/);
});

test('Robot Report discovery does not count its own publisher name as a robotics topic', async () => {
  const feed = `<?xml version="1.0"?><rss version="2.0"><channel><title>The Robot Report</title>
    <item><guid>https://www.therobotreport.com/ai-for-engineers/</guid><title>The Robot Report parent Arrowfly launches AI for Engineers platform</title><link>https://www.therobotreport.com/ai-for-engineers/</link><pubDate>Wed, 30 Sep 2026 14:03:31 GMT</pubDate><description><![CDATA[The initiative for engineers includes a news desk, a conference, research, and an advisory board, grounded in trusted editorial brands. The post The Robot Report parent Arrowfly launches an AI resource.]]></description></item>
    <item><guid>https://www.therobotreport.com/motion-capture-lab/</guid><title>Innodata opens motion-capture lab to help humanoids move more like people</title><link>https://www.therobotreport.com/motion-capture-lab/</link><pubDate>Wed, 30 Sep 2026 12:59:12 GMT</pubDate><description><![CDATA[The lab uses Vicon cameras to measure movements and collect real-world training data for robots.]]></description></item>
    </channel></rss>`;
  const ctx = fakeContext({
    'https://www.therobotreport.com/feed/': feed,
    'https://www.therobotreport.com/wp-json/wp/v2/posts?per_page=20&_fields=date,link,title,excerpt,content': new Error('HTTP 403: API'),
  });
  const result = await discover(source('robot-report-feed', 'https://www.therobotreport.com/feed/'), ctx);
  assert.equal(result.candidates.length, 1);
  assert.match(result.candidates[0].title, /motion-capture lab/i);
  assert.equal(result.coverage.filteredOut, 1);
});

test('Robot Report hydration rejects an article whose only robotics signal is the publisher brand', async () => {
  const candidate = { id: 'ai-resource', title: 'The Robot Report parent Arrowfly launches AI for Engineers platform', url: 'https://www.therobotreport.com/ai-for-engineers/', publishedAt: '2026-09-30T14:03:31.000Z', publishedAtRaw: '2026-09-30T14:03:31Z', datePrecision: 'second', metadata: { summary: 'The initiative for engineers includes a news desk, a conference, research, and an advisory board.' } };
  await assert.rejects(() => hydrate(candidate, source('robot-report-feed', 'https://www.therobotreport.com/feed/'), fakeContext({})), /not robotics-related beyond its publisher brand/);
});

test('Robot Report can fall back to the publisher feed body and discovers a concrete branded project page', async () => {
  const storyUrl = 'https://www.therobotreport.com/tackling-construction-labor-shortages-asi-softbank-partner-autonomous-fleets/';
  const sourceFeedUrl = 'https://www.therobotreport.com/feed/';
  const brandedProjectUrl = 'https://asirobots.com/mobius/';
  const publisherBody = '<article><p>Autonomous Solutions Inc. and SoftBank announced a joint venture to commercialize brand-agnostic autonomous heavy equipment for construction fleets. The companies describe their Mobius platform and its capabilities for coordinating autonomous heavy machinery.</p><p>Project: <a href="https://asirobots.com/mobius/">Mobius</a></p></article>';
  const candidate = { id: 'robot-asi', title: 'Tackling construction labor shortages: ASI and SoftBank partner on autonomous fleets', url: storyUrl, publishedAt: '2026-09-29T17:00:00.000Z', publishedAtRaw: '2026-09-29T17:00:00Z', datePrecision: 'second', metadata: { feedUrl: sourceFeedUrl, publisherFeedBodyHtml: publisherBody, publisherFeedBodyText: 'Autonomous Solutions Inc. and SoftBank announced a joint venture to commercialize brand-agnostic autonomous heavy equipment for construction fleets. The companies describe their Mobius platform and its capabilities for coordinating autonomous heavy machinery. Project: Mobius', publisherFeedLinks: [{ title: 'Mobius', url: brandedProjectUrl }] } };
  const ctx = fakeContext({
    [storyUrl]: '<html><title>Verify you are human</title><p>Enable JavaScript to continue.</p></html>',
    [sourceFeedUrl]: '<rss><channel><title>The Robot Report</title></channel></rss>',
    [brandedProjectUrl]: '<html><title>Mobius | Autonomous Solutions</title><article><p>Mobius is the official autonomous fleet management platform from Autonomous Solutions Inc. It coordinates mixed fleets of autonomous heavy equipment, dispatches work across job sites, and provides telemetry and remote supervision tools for construction, mining, and industrial operators.</p></article></html>',
  });
  const result = await hydrate(candidate, source('robot-report-feed', 'https://www.therobotreport.com/feed/'), ctx);
  assert.equal(result.metadata.contentSource, 'publisher_official_feed_item');
  assert.match(result.metadata.articlePageFetchFailure, /Unavailable|blocked/i);
  assert.equal(result.evidence[0].url, brandedProjectUrl);
  assert.equal(result.evidence[0].kind, 'project');
  assert.equal(result.evidence[0].relation, 'original');
  assert.equal(result.evidence.at(-1).url, storyUrl);
  assert.match(result.metadata.originalEvidenceSnapshots[0].content, /autonomous fleet management platform/i);
  assert.equal(result.raw.mediaType, 'application/rss+xml');
});

test('Robot Report follows a branded homepage link to a concrete product page without accepting the homepage', async () => {
  const storyUrl = 'https://www.therobotreport.com/forcen-humanoid-sensors/';
  const homeUrl = 'https://www.forcen.tech/';
  const productUrl = 'https://www.forcen.tech/technology';
  const publisherBody = '<article><p>ForceN will discuss force and torque sensors for humanoid robots. Its robotics sensing technology supports contact, manipulation, and control applications.</p><a href="https://www.forcen.tech/">ForceN</a></article>';
  const candidate = { id: 'robot-forcen', title: 'ForceN to give a crash course on force and torque sensing for humanoids', url: storyUrl, publishedAt: '2026-09-29T10:00:00.000Z', publishedAtRaw: '2026-09-29T10:00:00Z', datePrecision: 'second', metadata: { feedUrl: 'https://www.therobotreport.com/feed/', publisherFeedBodyHtml: publisherBody, publisherFeedBodyText: 'ForceN will discuss force and torque sensors for humanoid robots. Its robotics sensing technology supports contact, manipulation, and control applications.', publisherFeedLinks: [{ title: 'ForceN', url: homeUrl }] } };
  const ctx = fakeContext({
    [storyUrl]: '<html><title>Verify you are human</title><p>Enable JavaScript to continue.</p></html>',
    [homeUrl]: '<html><title>Robotic Force-Torque Sensors | ForceN</title><nav><a href="/technology">Technology</a></nav><p>ForceN robotics sensors.</p></html>',
    [productUrl]: '<html><title>Advanced Force-Torque Sensing Technology | ForceN</title><article><p>ForceN designs force and torque sensors for humanoid, surgical, and logistics robotics. Its sealed transducer and edge intelligence system supports accurate sensing for manipulation and control.</p></article></html>',
  });
  const result = await hydrate(candidate, source('robot-report-feed', 'https://www.therobotreport.com/feed/'), ctx);
  assert.equal(result.evidence[0].url, productUrl);
  assert.equal(result.metadata.originalEvidenceSnapshots[0].sourceAnchorText, 'ForceN');
  assert.equal(result.metadata.originalEvidenceSnapshots[0].followedAnchorText, 'Technology');
  assert.doesNotMatch(JSON.stringify(result.evidence), /forcen\.tech\/"/i);
});

test('Robot Report keeps a general entertainment application page supporting-only for a robotics news story', async () => {
  const storyUrl = 'https://www.therobotreport.com/innodata-opens-motion-capture-lab/';
  const viconUrl = 'https://www.vicon.com/applications/entertainment/';
  const publisherBody = `<article><p>Innodata opened a motion capture lab to collect training data for humanoid robots.</p><a href="${viconUrl}">Vicon motion capture</a></article>`;
  const candidate = { id: 'innodata-lab', title: 'Innodata opens a motion-capture lab to help humanoids', url: storyUrl, publishedAt: '2026-09-30T12:59:12.000Z', publishedAtRaw: '2026-09-30T12:59:12Z', datePrecision: 'second', metadata: { feedUrl: 'https://www.therobotreport.com/feed/', publisherFeedBodyHtml: publisherBody, publisherFeedBodyText: 'Innodata opened a motion capture lab to collect training data for humanoid robots.', publisherFeedLinks: [{ title: 'Vicon motion capture', url: viconUrl }] } };
  const entertainmentPage = '<html><title>Motion Capture for VFX and Entertainment | Vicon</title><article><p>Vicon motion capture for the entertainment industry, television, film, and games. The technology can also be used for research and robotics applications.</p><p>Systems capture performer movement for animation production.</p></article></html>';
  await assert.rejects(() => hydrate(candidate, source('robot-report-feed', 'https://www.therobotreport.com/feed/'), fakeContext({ [storyUrl]: '<html><title>Verify you are human</title><p>Enable JavaScript to continue.</p></html>', [viconUrl]: entertainmentPage })), /original robotics\/company evidence/);
});

test('Robot Report rejects a branded official page when only its stale title matches and its body is unrelated', async () => {
  const storyUrl = 'https://www.therobotreport.com/gecko-story/';
  const sourceUrl = 'https://nvidianews.nvidia.com/news/open-agent-security-platform';
  const candidate = { id: 'robot-stale-link', title: 'Gecko Robotics adopts NVIDIA Open Agent Safety Platform', url: storyUrl, publishedAt: '2026-09-28T17:41:32.000Z', publishedAtRaw: '2026-09-28T17:41:32Z', datePrecision: 'second', metadata: { feedUrl: 'https://www.therobotreport.com/feed/', publisherFeedBodyHtml: `<article><p>Gecko Robotics uses the NVIDIA Open Agent Safety Platform to protect robot inspection agents.</p><a href="${sourceUrl}">NVIDIA Open Agent Safety Platform</a></article>`, publisherFeedBodyText: 'Gecko Robotics uses the NVIDIA Open Agent Safety Platform to protect robot inspection agents.' , publisherFeedLinks: [{ title: 'NVIDIA Open Agent Safety Platform', url: sourceUrl }] } };
  const ctx = fakeContext({
    [storyUrl]: '<html><title>Verify you are human</title><p>Enable JavaScript to continue.</p></html>',
    [sourceUrl]: '<html><title>NVIDIA Open Agent Safety Platform</title><article><p>NVIDIA announced a $150 billion share repurchase authorization increase. This corporate financial announcement describes the company capital return plan and contains no robotics or agent platform information.</p></article></html>',
  });
  await assert.rejects(() => hydrate(candidate, source('robot-report-feed', 'https://www.therobotreport.com/feed/'), ctx), /original robotics\/company evidence/);
});

test('Robot Report does not treat an industry-category homepage link as evidence for a named robot product', async () => {
  const storyUrl = 'https://www.therobotreport.com/flourish-one/';
  const sourceUrl = 'https://www.automatedwarehouseonline.com/';
  const body = '<article><p>Flourish One is a wheeled home humanoid built for household chores and trained from smartphone demonstrations.</p><a href="https://www.automatedwarehouseonline.com">warehouse</a></article>';
  const candidate = { id: 'flourish-1', title: 'Meet Flourish One, the Raspberry Pi-powered humanoid built for busy parents', url: storyUrl, publishedAt: '2026-09-29T14:00:00.000Z', publishedAtRaw: '2026-09-29T14:00:00Z', datePrecision: 'second', metadata: { feedUrl: 'https://www.therobotreport.com/feed/', publisherFeedBodyHtml: body, publisherFeedBodyText: 'Flourish One is a wheeled home humanoid built for household chores and trained from smartphone demonstrations.', publisherFeedLinks: [{ title: 'warehouse', url: sourceUrl }] } };
  const ctx = fakeContext({
    [storyUrl]: '<html><title>Verify you are human</title><p>Enable JavaScript to continue.</p></html>',
    [sourceUrl]: '<html><title>Automated Warehouse</title><nav><a href="/category/asrs/">Automated storage and retrieval systems (ASRS)</a></nav><p>Warehouse software and automated storage systems for logistics operations and material handling.</p></html>',
    'https://www.automatedwarehouseonline.com/category/asrs/': '<html><title>Automated storage and retrieval systems (ASRS) Archives - Automated Warehouse</title><article><p>Industrial storage machinery, sorters, warehouse lifts and inventory systems.</p></article></html>',
  });
  await assert.rejects(() => hydrate(candidate, source('robot-report-feed', 'https://www.therobotreport.com/feed/'), ctx), /original robotics\/company evidence/);
});

test('Jiqizhixin article indexing does not pass a JavaScript shell as article content', async () => {
  const ctx = fakeContext({
    'https://www.jiqizhixin.com/articles': '<html><title>文章库</title><div id="app"></div></html>',
    'https://www.jiqizhixin.com/articles/rlark-1': '<html><title>RLark具身机器人平台</title><div id="app"></div></html>',
    'https://www.jiqizhixin.com/api/v1/articles?page=1&per_page=20': new Error('HTTP 404'),
    'https://www.jiqizhixin.com/api/articles?page=1&per_page=20': new Error('HTTP 404'),
    'https://www.jiqizhixin.com/articles.json?page=1': new Error('HTTP 404'),
  });
  const result = await discover(source('jiqizhixin-library', 'https://www.jiqizhixin.com/articles'), ctx);
  assert.equal(result.candidates.length, 0);
  assert.equal(result.coverage.paginationComplete, false);
  await assert.rejects(() => hydrate({ id: 'shell', title: '机器人新闻', url: 'https://www.jiqizhixin.com/articles/shell', publishedAt: '2026-09-01T00:00:00.000Z', publishedAtRaw: '2026-09-01', datePrecision: 'day', metadata: { originalEvidence: [] } }, source('jiqizhixin-library'), fakeContext({ 'https://www.jiqizhixin.com/articles/shell': '<html><div id="app"></div></html>' })), /Actual page body|original evidence/);
});

test('Jiqizhixin search API redirect to a public HTML page is recorded without browser retry', async () => {
  const indexUrl = 'https://www.jiqizhixin.com/articles';
  const htmlIndex = `<html><title>Articles</title>${'<p>Public article archive landing page</p>'.repeat(60)}</html>`;
  const ctx = fakeContext({ [indexUrl]: htmlIndex }, { maxPages: 1 });
  const originalGet = ctx.http.get.bind(ctx.http);
  ctx.http.get = async (url, options) => {
    if (url.includes('/api/v1/search/base?')) return { text: '<html><title>Data service</title></html>', url: 'https://www.jiqizhixin.com/data-service', status: 200, headers: { 'content-type': 'text/html' } };
    return originalGet(url, options);
  };
  let browserCalls = 0;
  ctx.browser.get = async () => { browserCalls++; throw new Error('Browser fallback should not run'); };
  const result = await discover(source('jiqizhixin-library', indexUrl), ctx);
  assert.equal(result.candidates.length, 0);
  assert.equal(browserCalls, 0);
  assert.match(result.coverage.apiAttempts[0].error, /redirected to a non-JSON page/);
  assert.match(result.coverage.apiAttempts[0].error, /\/data-service/);
});

test('Jiqizhixin public search and detail APIs preserve China timestamps and verify cited project bodies', async () => {
  const articleId = 'rlark-1';
  const searchUrl = 'https://www.jiqizhixin.com/api/v1/search/base?keywords=%E5%85%B7%E8%BA%AB%E6%99%BA%E8%83%BD';
  const apiRows = { articles: { nodes: [
    { id: articleId, title: '清华发布具身机器人训练平台 RLark', path: 'https://www.jiqizhixin.com/articles/rlark-1', published_at: '2026/09/24 13:27', content: '官方文章介绍具身机器人训练、部署与真机验证平台。' },
    { id: 'general-ai', title: 'LLM assistant update', path: 'https://www.jiqizhixin.com/articles/ai-1', published_at: '2026/09/24 13:27', content: 'A general language model announcement.' },
  ] } };
  const detailUrl = `https://www.jiqizhixin.com/api/article_library/articles/${articleId}.json`;
  const routes = {
    'https://www.jiqizhixin.com/articles': '<html><title>文章库</title><div id="app"></div></html>',
    'https://www.jiqizhixin.com/articles/rlark-1': '<html><title>RLark具身机器人平台</title><div id="app"></div></html>',
    [searchUrl]: JSON.stringify(apiRows),
    'https://www.jiqizhixin.com/api/v1/search/base?keywords=%E6%9C%BA%E5%99%A8%E4%BA%BA': JSON.stringify({ articles: { nodes: [] } }),
    'https://www.jiqizhixin.com/api/v1/search/base?keywords=VLA': JSON.stringify({ articles: { nodes: [] } }),
    [detailUrl]: JSON.stringify({ title: '清华发布具身机器人训练平台 RLark', published_at: '2026-09-24 13:27:59', author: { name: '机器之心' }, content: '<article><p>清华团队公布一个具身机器人训练和管理平台，支持真实机器人采集、训练、评估及部署。该平台提供跨地域任务编排、设备接入、数据同步和安全执行能力，帮助研究人员在真实机器人上进行策略训练和验证。</p><p>报道还介绍，机器人任务可在云端集群与现场设备之间协同执行。团队完成了任务调度、状态观测、资源管理和具身设备运行时的贯通验证，并说明了真实环境中的测试步骤、部署条件以及平台支持的后续开发方式。</p><p>项目源码：<a href="https://github.com/RLinf/RLark">RLark repository</a></p></article>' }),
    'https://github.com/RLinf/RLark': '<html><main><h1>RLinf/RLark</h1><p>Cross-cluster embodied intelligence cloud-native platform with documentation, source code, deployment instructions and support for robot workloads across real devices.</p></main></html>',
  };
  const result = await discover(source('jiqizhixin-library', 'https://www.jiqizhixin.com/articles'), fakeContext(routes));
  assert.equal(result.candidates.length, 1);
  assert.equal(result.candidates[0].title.includes('具身机器人'), true);
  assert.equal(result.candidates[0].publishedAt, '2026-09-24T05:27:00.000Z');
  const hydrated = await hydrate(result.candidates[0], source('jiqizhixin-library', 'https://www.jiqizhixin.com/articles'), fakeContext(routes));
  assert.equal(hydrated.publishedAt, '2026-09-24T05:27:59.000Z');
  assert.equal(hydrated.evidence[0].url, 'https://github.com/RLinf/RLark');
  assert.equal(hydrated.evidence[0].relation, 'original');
  assert.equal(hydrated.evidence.at(-1).relation, 'discovery');
  assert.match(hydrated.metadata.originalEvidenceSnapshots[0].content, /Cross-cluster embodied intelligence/);
});
