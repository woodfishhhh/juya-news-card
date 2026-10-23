import test from 'node:test';
import assert from 'node:assert/strict';
import { load } from 'cheerio';
import { discover, hydrate } from '../adapters/domestic.mjs';
const GALBOT_PROJECT_URL = 'https://www.wicinternet.org/2025-11/26/c_1143612.htm';
const GALBOT_CCTV_URL = 'https://content-static.cctvnews.cctv.com/story?id=123';

function ctxFor(html, article = {}) {
  return {
    now: '2026-09-30T12:00:00.000Z', maxPages: 3,
    http: { async get(url) { return { text: typeof html === 'function' ? html(url) : html, url, status: 200, headers: { 'content-type': 'text/html' } }; }, async post(url, body) { return { text: typeof html === 'function' ? html(url, body) : html, url, status: 200, headers: { 'content-type': 'application/json' } }; } },
    browser: { async get(url) { return { text: '<html/>', html: '<html/>', url, status: 200, headers: {} }; } },
    html: {
      load,
      text(value) { return String(value ?? '').replace(/<[^>]*>/g, ' '); },
      absolute(value, base) { try { return new URL(value, base).href; } catch { return null; } },
      date(raw) { const m = String(raw).match(/(20\d{2})[-/年](\d{1,2})[-/月](\d{1,2})/); if (/\d{1,2}:\d{2}/.test(raw) && Number.isFinite(Date.parse(raw))) return { publishedAt: new Date(raw).toISOString(), publishedAtRaw: raw, datePrecision: 'second' }; return m ? { publishedAt: new Date(`${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}T00:00:00Z`).toISOString(), publishedAtRaw: raw, datePrecision: 'day' } : { publishedAt: null, publishedAtRaw: raw, datePrecision: 'unknown' }; },
      article() { return { title: article.title || 'Robot article', content: article.content || 'This is a detailed article body about robot learning, experiments, and the conditions under which the demonstration was performed. '.repeat(2), publishedAt: article.publishedAt || null, publishedAtRaw: article.publishedAtRaw || null, datePrecision: article.datePrecision || 'unknown', authors: [], links: [] }; },
    },
  };
}
const source = (id, entryUrl) => ({ id, entryUrl, role: id === 'galbot-news' ? 'COMPANY_INDEX_MIXED_ORIGINS' : 'COMPANY_ORIGINAL_ANNOUNCEMENT' });

test('AGIBOT explicit WAF denial stops discovery without browser or alternate-route retries', async () => {
  const ctx = ctxFor('<html/>'); let browserCalls = 0; const requested = [];
  ctx.http.get = async (url) => { requested.push(url); throw Object.assign(new Error('HTTP 403'), { status: 403, response: { text: '<title>南墙WAF</title>请求存在威胁，已被拦截' } }); };
  ctx.browser.get = async (url) => { browserCalls += 1; return { text: '<html/>', url, status: 200, headers: {} }; };
  const found = await discover(source('agibot-news', 'https://www.agibot.com/news'), ctx);
  assert.equal(found.coverage.pagesFetched, 0);
  assert.equal(found.issues.some(issue => issue.kind === 'page-fetch-blocked' && issue.status === 403), true);
  assert.deepEqual(requested, ['https://www.agibot.com/news']);
  assert.equal(browserCalls, 0);
});

test('AGIBOT article WAF denial is reported without browser fallback', async () => {
  const ctx = ctxFor('<html/>'); let browserCalls = 0;
  ctx.http.get = async () => { throw Object.assign(new Error('HTTP 403'), { status: 403, response: { text: 'Access denied by WAF' } }); };
  ctx.browser.get = async (url) => { browserCalls += 1; return { text: '<html/>', url, status: 200, headers: {} }; };
  const candidate = { id: 'blocked', url: 'https://www.agibot.com/article/231/detail/125.html', title: 'AGIBOT Robot News', publishedAt: '2026-09-30T00:00:00.000Z', publishedAtRaw: '2026-09-30', datePrecision: 'day', metadata: {} };
  await assert.rejects(hydrate(candidate, source('agibot-news'), ctx), /HTTP 403/);
  assert.equal(browserCalls, 0);
});

test('Unitree list extracts original detail URL and visible day-level date', async () => {
  const html = '<ul class="news-list"><li><a href="/news/40">Unitree robot announcement2026-06-01Media Coverage</a></li></ul>';
  const result = await discover(source('unitree-news', 'https://www.unitree.com/news/'), ctxFor(html));
  assert.equal(result.candidates.length, 1);
  assert.equal(result.candidates[0].publishedAt, '2026-06-01T00:00:00.000Z');
  assert.equal(result.candidates[0].url, 'https://www.unitree.com/news/40');
});

test('Unitree official public API retains English and Chinese records with localized URLs and API article bodies', async () => {
  const ctx = ctxFor('<html/>');
  const english = { id: 44, title: 'Welcoming Myanmar President Min Aung Hlaing to Unitree', postTime: '2026-08-05 10:13:45', lang: ['2'] };
  const chinese = { id: 43, title: '欢迎缅甸总统敏昂莱参观宇树科技', postTime: '2026-08-05 18:13:28', lang: ['1'] };
  ctx.http.get = async (url) => {
    if (url === 'https://www.unitree.com/news/') return { text: '<html/>', url, status: 200, headers: {} };
    if (url.includes('/website/news/list?')) return { text: JSON.stringify({ code: 100, data: { count: 2, items: [english, chinese] } }), url, status: 200, headers: {} };
    if (url.includes('/website/news/info?id=43')) return { text: JSON.stringify({ code: 100, data: { article: { title: chinese.title, content: '<p>6月19日端午节，缅甸总统敏昂莱一行到访宇树科技参观，交流最新机器人产品和技术成果。宇树期待和全球更多伙伴一起，推动机器人技术真正走进产业、服务生活。</p>', author: { name: '宇树小编' } } } }), url, status: 200, headers: {} };
    throw new Error(`Unexpected URL ${url}`);
  };
  const found = await discover(source('unitree-news', 'https://www.unitree.com/news/'), ctx);
  assert.equal(found.coverage.entryStatus, 200);
  assert.equal(found.coverage.apiRecordsRead, 2);
  assert.equal(found.coverage.languageCounts['1'], 1);
  assert.equal(found.coverage.languageCounts['2'], 1);
  assert.equal(found.candidates.length, 2);
  assert.deepEqual(found.nextState, { nextPage: 2 });
  assert.equal(found.candidates[0].url, 'https://www.unitree.com/news/44');
  assert.equal(found.candidates[1].url, 'https://www.unitree.com/cn/news/43');
  assert.equal(found.candidates[0].datePrecision, 'second');
  assert.equal(found.candidates[1].publishedAt, '2026-08-05T10:13:28.000Z');
  const itemResult = await hydrate(found.candidates[1], source('unitree-news'), ctx);
  assert.match(itemResult.content, /缅甸总统敏昂莱一行到访宇树科技/);
  assert.equal(itemResult.title, chinese.title);
  assert.equal(itemResult.url, 'https://www.unitree.com/cn/news/43');
  assert.equal(itemResult.raw.mediaType, 'application/json');
});

test('Unitree resumes bounded API pages with head refresh and overlap, and does not advance after a failed page', async () => {
  const ctx = ctxFor('<html/>'); const urls = [];
  ctx.http.get = async (url) => {
    urls.push(url);
    if (url.includes('/website/news/list?')) {
      const page = Number(new URL(url).searchParams.get('page'));
      if (page === 3) throw Object.assign(new Error('temporary listing failure'), { status: 503 });
      const items = Array.from({ length: page === 1 ? 20 : 20 }, (_, i) => ({ id: `${page}-${i}`, title: `Robot report ${page}-${i}`, postTime: '2026-09-01 12:00:00', lang: ['2'] }));
      return { text: JSON.stringify({ code: 100, data: { count: 100, items } }), url, status: 200, headers: {} };
    }
    return { text: '<html/>', url, status: 200, headers: {} };
  };
  const found = await discover(source('unitree-news', 'https://www.unitree.com/news/'), { ...ctx, state: { nextPage: 3 }, maxPages: 3 });
  assert.deepEqual(urls.filter(url => url.includes('/website/news/list?')).map(url => new URL(url).searchParams.get('page')), ['1', '2', '3']);
  assert.equal(found.nextState, undefined);
  assert.equal(found.issues.some(issue => issue.kind === 'api-page-failed'), true);
});

test('Unitree nextPage advances beyond page three and a two-page budget advances on consecutive runs', async () => {
  const ctx = ctxFor('<html/>');
  const makeCtx = (state, maxPages, pages) => ({ ...ctx, state, maxPages, http: { async get(url) {
    if (!url.includes('/website/news/list?')) return { text: '<html/>', url, status: 200, headers: {} };
    const page = Number(new URL(url).searchParams.get('page')); pages.push(page);
    const items = Array.from({ length: 20 }, (_, i) => ({ id: `${page}-${i}`, title: `Robot report ${page}-${i}`, postTime: '2026-09-01 12:00:00', lang: ['2'] }));
    return { text: JSON.stringify({ code: 100, data: { count: 200, items } }), url, status: 200, headers: {} };
  } } });
  const pages1 = []; const first = await discover(source('unitree-news', 'https://www.unitree.com/news/'), makeCtx({}, 3, pages1));
  const pages2 = []; const second = await discover(source('unitree-news', 'https://www.unitree.com/news/'), makeCtx(first.nextState, 3, pages2));
  assert.deepEqual(pages1, [1, 2, 3]);
  assert.deepEqual(first.nextState, { nextPage: 4 });
  assert.deepEqual(pages2, [1, 3, 4]);
  assert.deepEqual(second.nextState, { nextPage: 5 });
  const pages3 = []; const third = await discover(source('unitree-news', 'https://www.unitree.com/news/'), makeCtx(second.nextState, 2, pages3));
  const pages4 = []; const fourth = await discover(source('unitree-news', 'https://www.unitree.com/news/'), makeCtx(third.nextState, 2, pages4));
  assert.deepEqual(pages3, [1, 5]);
  assert.deepEqual(pages4, [1, 6]);
  assert.deepEqual(third.nextState, { nextPage: 6 });
  assert.deepEqual(fourth.nextState, { nextPage: 7 });
  assert.equal(third.coverage.overlapSkippedDueToPageBudget, true);
});

test('LimX list rejects a candidate from hydration when the source date is absent', async () => {
  const html = '<div><a href="/en/news/BK000064">LimX robot release</a></div>';
  const result = await discover(source('limx-news', 'https://www.limxdynamics.com/en/news'), ctxFor(html));
  assert.equal(result.candidates.length, 1);
  assert.equal(result.candidates[0].datePrecision, 'unknown');
  await assert.rejects(hydrate(result.candidates[0], source('limx-news'), ctxFor(html)), /No qualifying publication date/);
});

test('LimX can qualify a publication date from the retrieved original article', async () => {
  const html = '<div><a href="/en/news/BK000064">LimX robot funding article</a></div>';
  const found = await discover(source('limx-news', 'https://www.limxdynamics.com/en/news'), ctxFor(html));
  const c = ctxFor(html, { publishedAt: '2026-07-14T00:45:00.000Z', publishedAtRaw: '2026-07-14T00:45:00', datePrecision: 'second' });
  const item = await hydrate(found.candidates[0], source('limx-news'), c);
  assert.equal(item.publishedAtRaw, '2026-07-14T00:45:00');
  assert.equal(item.publishedAt, '2026-07-13T16:45:00.000Z');
  assert.match(item.content, /detailed article body/);
});

test('LimX official API lists the archive across pages and exposes resumable page state', async () => {
  const ctx = ctxFor('<html/>'); const pages = [];
  ctx.http.post = async (url, body) => {
    pages.push(body.pageNum);
    return { text: JSON.stringify({ code: 200, total: 23, hasNext: body.pageNum < 2, rows: Array.from({ length: body.pageNum === 1 ? 12 : 11 }, (_, i) => ({ blogId: `BK${body.pageNum}${i}`, language: 'en', title: `LimX Robotics report ${body.pageNum}-${i}`, publishTime: '2026-07-14T08:45:00' })) }), url, status: 200, headers: {} };
  };
  const found = await discover(source('limx-news', 'https://www.limxdynamics.com/en/news'), { ...ctx, maxPages: 3 });
  assert.deepEqual(pages, [1, 2]);
  assert.equal(found.candidates.length, 23);
  assert.equal(found.coverage.reportedTotal, 23);
  assert.deepEqual(found.nextState, { nextPage: 2 });
  assert.equal(found.candidates[0].datePrecision, 'second');
  assert.equal(found.candidates[0].publishedAt, '2026-07-14T00:45:00.000Z');
});

test('LimX API page failures do not advance the persisted continuation cursor', async () => {
  const ctx = ctxFor('<html/>');
  ctx.http.post = async (url, body) => {
    if (body.pageNum > 1) throw Object.assign(new Error('page unavailable'), { status: 503 });
    return { text: JSON.stringify({ code: 200, total: 24, hasNext: true, rows: [{ blogId: 'BK000064', language: 'en', title: 'LimX Robotics release', publishTime: '2026-07-14T08:45:00' }] }), url, status: 200, headers: {} };
  };
  const found = await discover(source('limx-news', 'https://www.limxdynamics.com/en/news'), { ...ctx, maxPages: 2, state: { nextPage: 3 } });
  assert.equal(found.nextState, undefined);
  assert.equal(found.issues[0].kind, 'api-page-failed');
});

test('LimX nextPage advances beyond page three and a two-page budget advances on consecutive runs', async () => {
  const base = ctxFor('<html/>');
  const makeCtx = (state, maxPages, pages) => ({ ...base, state, maxPages, http: { ...base.http, async post(url, body) {
    pages.push(body.pageNum);
    return { text: JSON.stringify({ code: 200, total: 120, hasNext: true, rows: Array.from({ length: 12 }, (_, i) => ({ blogId: `BK${body.pageNum}-${i}`, language: 'en', title: `LimX Robotics report ${body.pageNum}-${i}`, publishTime: '2026-07-14T08:45:00' })) }), url, status: 200, headers: {} };
  } } });
  const pages1 = []; const first = await discover(source('limx-news', 'https://www.limxdynamics.com/en/news'), makeCtx({}, 3, pages1));
  const pages2 = []; const second = await discover(source('limx-news', 'https://www.limxdynamics.com/en/news'), makeCtx(first.nextState, 3, pages2));
  assert.deepEqual(pages1, [1, 2, 3]);
  assert.deepEqual(first.nextState, { nextPage: 4 });
  assert.deepEqual(pages2, [1, 3, 4]);
  assert.deepEqual(second.nextState, { nextPage: 5 });
  const pages3 = []; const third = await discover(source('limx-news', 'https://www.limxdynamics.com/en/news'), makeCtx(second.nextState, 2, pages3));
  const pages4 = []; const fourth = await discover(source('limx-news', 'https://www.limxdynamics.com/en/news'), makeCtx(third.nextState, 2, pages4));
  assert.deepEqual(pages3, [1, 5]);
  assert.deepEqual(pages4, [1, 6]);
  assert.deepEqual(third.nextState, { nextPage: 6 });
  assert.deepEqual(fourth.nextState, { nextPage: 7 });
  assert.equal(third.coverage.overlapSkippedDueToPageBudget, true);
});

test('Galbot records actual media publisher and keeps original link as the candidate', async () => {
  const html = '<div class="news-grid"><a class="news-card" href="https://content-static.cctvnews.cctv.com/story?id=123">叠衣服做家务 人形机器人开启赛前冲刺训练 记者探营央视新闻2026年8月16日</a></div>';
  const result = await discover(source('galbot-news', 'https://www.galbot.com/news/'), ctxFor(html));
  assert.equal(result.candidates.length, 1);
  assert.equal(result.candidates[0].url, 'https://content-static.cctvnews.cctv.com/story?id=123');
  assert.equal(result.candidates[0].metadata.publisher, '央视新闻');
  assert.equal(result.candidates[0].publishedAt, '2026-08-16T00:00:00.000Z');
});

test('AGIBOT browser listing keeps the dated article title separate from its date', async () => {
  const html = '<ul class="campaignslist"><li><a href="/article/231/detail/125.html">AGIBOT Robot News 2026-09-30</a></li></ul>';
  const found = await discover(source('agibot-news', 'https://www.agibot.com/news'), ctxFor(html));
  assert.equal(found.candidates.length, 1);
  assert.equal(found.candidates[0].title, 'AGIBOT Robot News');
  assert.equal(found.candidates[0].publishedAtRaw, '2026-09-30');
});

test('AGIBOT rereads the head, overlaps the saved historical cursor, and reaches page four', async () => {
  const urls = [];
  const makePage = (url) => {
    const page = Number(new URL(url).searchParams.get('page') || 1);
    const date = `2026-09-${String(30 - page).padStart(2, '0')}`;
    return `<ul class="campaignslist"><li><a href="/article/231/detail/${page}.html">AGIBOT Robot News ${date}</a></li></ul><a rel="next" href="?page=${page + 1}">Next</a>`;
  };
  const ctx = ctxFor('<html/>');
  ctx.http.get = async (url) => { throw Object.assign(new Error('official server returns 500'), { status: 500 }); };
  ctx.browser.get = async (url) => { urls.push(url); return { text: makePage(url), html: makePage(url), url, status: 200, headers: {} }; };
  const found = await discover(source('agibot-news', 'https://www.agibot.com/news'), { ...ctx, state: { nextPage: 5 }, maxPages: 3 });
  assert.deepEqual(urls.map(url => new URL(url).searchParams.get('page') || '1'), ['1', '4', '5']);
  assert.equal(found.candidates.length, 3);
  assert.deepEqual(found.nextState, { nextPage: 6 });
  assert.equal(found.candidates[0].publishedAtRaw, '2026-09-29');
});

test('AGIBOT with a two-page budget reaches each successive unread page', async () => {
  const urls = [];
  const htmlAt = (url) => {
    const page = Number(new URL(url).searchParams.get('page') || 1);
    return `<ul class="campaignslist"><li><a href="/article/231/detail/${page}.html">AGIBOT Robot News 2026-09-${String(30 - page).padStart(2, '0')}</a></li></ul><a rel="next" href="?page=${page + 1}">Next</a>`;
  };
  const ctx = ctxFor('<html/>');
  ctx.http.get = async (url) => { throw Object.assign(new Error('official server returns 500'), { status: 500 }); };
  ctx.browser.get = async (url) => { urls.push(url); return { text: htmlAt(url), html: htmlAt(url), url, status: 200, headers: {} }; };
  const first = await discover(source('agibot-news', 'https://www.agibot.com/news'), { ...ctx, state: { nextPage: 4 }, maxPages: 2 });
  const second = await discover(source('agibot-news', 'https://www.agibot.com/news'), { ...ctx, state: first.nextState, maxPages: 2 });
  assert.deepEqual(urls.map(url => new URL(url).searchParams.get('page') || '1'), ['1', '4', '1', '5']);
  assert.deepEqual(first.nextState, { nextPage: 5 });
  assert.deepEqual(second.nextState, { nextPage: 6 });
  assert.equal(first.coverage.overlapSkippedDueToPageBudget, true);
  assert.match(first.coverage.paginationNote, /no historical overlap/);
});

test('AGIBOT listing failure preserves checkpoint and records no replacement cursor', async () => {
  const ctx = ctxFor('<html/>');
  ctx.http.get = async (url) => { throw Object.assign(new Error('500'), { status: 500 }); };
  ctx.browser.get = async (url) => {
    if (url.includes('page=3')) throw Object.assign(new Error('browser page failed'), { status: 503 });
    const html = '<ul class="campaignslist"><li><a href="/article/231/detail/1.html">AGIBOT Robot News 2026-09-30</a></li></ul><a rel="next" href="?page=2">Next</a>';
    return { text: html, html, url, status: 200, headers: {} };
  };
  const found = await discover(source('agibot-news', 'https://www.agibot.com/news'), { ...ctx, state: { nextPage: 4 }, maxPages: 3 });
  assert.equal(found.nextState, undefined);
  assert.equal(found.issues.some(issue => issue.kind === 'browser-page-failed'), true);
});

test('Galbot CCTV interview remains pending when only related data-project background is available', async () => {
  const page = GALBOT_CCTV_URL;
  const projectText = 'Galbot presented a synthetic and real data-driven embodied intelligence project. Its pipeline uses large-scale simulation data for pre-training and a smaller amount of real-world data for post-training, with a physics-realistic simulation synthesis system and an integrated model training toolchain. '.repeat(3);
  const ctx = ctxFor('<html/>', { content: `A CCTV interview with Galbot co-founder 张直政 about robot training. ${'Details about the training approach. '.repeat(5)}` });
  ctx.http.get = async (url) => url === GALBOT_CCTV_URL
    ? { text: '<html/>', url, status: 200, headers: { 'content-type': 'text/html' } }
    : { text: `<h1>Galbot Synthetic and Real Data Project</h1><div class="g-content">${projectText}</div>`, url, status: 200, headers: { 'content-type': 'text/html' } };
  const candidate = { id: 'g', url: page, title: 'Home service robot training', publishedAt: '2026-08-16T00:00:00.000Z', publishedAtRaw: '2026-08-16', datePrecision: 'day', channelId: 'primary', metadata: { media: true, publisher: '央视新闻', discoveryUrl: 'https://www.galbot.com/news/' } };
  await assert.rejects(hydrate(candidate, source('galbot-news'), ctx), /pending_evidence: no exact event-specific primary source/);
  assert.equal(candidate.metadata.pendingEvidence.status, 'pending_evidence');
  assert.equal(candidate.metadata.pendingEvidence.supportingUrl, GALBOT_PROJECT_URL);
});

test('Galbot direct Xinhua interview is original reporting with attributed claims and article timestamp', async () => {
  const candidateUrl = 'https://www.xinhuanet.com/digital/20250820/1502ced7a9fd4bc2b6dc4abc318514a6/c.html';
  const title = '银河通用赵于莉：让机器人会思考、能干活，具身智能商业化进程加速';
  const body = '8月3日，2025企业家太阳岛年会在哈尔滨举行。期间，北京银河通用机器人有限公司首席战略官赵于莉接受新华网专访，分享银河通用的具身智能探索。赵于莉介绍，银河通用自研的人形机器人Galbot已经能做到自主决策、精准抓取。赵于莉还指出，银河通用自主研发Sim2Real技术模式，通过合成仿真迭代开发GraspVLA、TrackVLA和商超VLA。';
  const html = `<html><head><meta name="source" content="新华网"><meta name="publishdate" content="2025-08-20"></head><body><h1>${title}</h1><div class="header-time left">2025<br>08/20<br>16:04:55</div><div class="main-left"><div id="detail"><span id="detailContent"><p class="MsoNormal">${body}</p></span></div></div></body></html>`;
  const ctx = ctxFor('<html/>', { title, content: body, publishedAt: '2025-08-20T00:00:00.000Z', publishedAtRaw: '2025-08-20', datePrecision: 'day' });
  const requested = [];
  ctx.http.get = async (url) => { requested.push(url); return { text: html, url, status: 200, headers: { 'content-type': 'text/html' } }; };
  const candidate = { id: 'g-xinhua-interview', url: candidateUrl, title, publishedAt: '2025-08-20T00:00:00.000Z', publishedAtRaw: '2025-08-20', datePrecision: 'day', channelId: 'primary', metadata: { media: true, publisher: '新华网', discoveryUrl: 'https://www.xinhuanet.com/digital/20250820/1502ced7a9fd4bc2b6dc4abc318514a6/c.html' } };
  const item = await hydrate(candidate, source('galbot-news'), ctx);
  assert.deepEqual(requested, [candidateUrl]);
  assert.equal(item.publishedAt, '2025-08-20T08:04:55.000Z');
  assert.equal(item.publishedAtRaw, '2025-08-20 16:04:55');
  assert.equal(item.datePrecision, 'second');
  assert.equal(item.metadata.sourceListPublishedAtRaw, '2025-08-20');
  assert.equal(item.metadata.articleMetaPublishedAtRaw, '2025-08-20');
  assert.equal(item.metadata.sourceRole, 'MEDIA_ORIGINAL');
  assert.equal(item.metadata.reportingType, 'original_reporting');
  assert.equal(item.metadata.reportingFormat, 'firsthand_interview');
  assert.equal(item.metadata.interviewee, '赵于莉');
  assert.equal(item.metadata.claimVerification, 'company_statement_unverified');
  assert.equal(item.evidenceClass, 'independent_reporting');
  assert.equal(item.evidence[0].relation, 'original');
  assert.equal(item.evidence.length, 1);
  assert.match(item.content, /接受新华网专访/);
  assert.doesNotMatch(item.content, /新华网\s*>|字体：|责任编辑/);
});

test('Galbot Xinhua project article without explicit interview attribution remains evidence-gated', async () => {
  const candidateUrl = 'https://www.xinhuanet.com/digital/20250820/project.html';
  const title = '银河通用机器人技术探索';
  const body = '银河通用机器人有限公司介绍了其仿真训练方案和具身智能机器人在商业场景中的应用。该项目涵盖自主决策、精准抓取和零售应用。相关方案还将持续用于支持工业分拣、商品取放和门店服务等工作流程，并逐步完善模型训练和实际部署能力。';
  const html = `<html><head><meta name="source" content="新华网"><meta name="publishdate" content="2025-08-20"></head><body><h1>${title}</h1><div class="header-time left">2025<br>08/20<br>16:04:55</div><div class="main-left"><div id="detail"><span id="detailContent"><p class="MsoNormal">${body}</p></span></div></div></body></html>`;
  const ctx = ctxFor('<html/>', { title, content: body, publishedAt: '2025-08-20T00:00:00.000Z', publishedAtRaw: '2025-08-20', datePrecision: 'day' });
  const requested = [];
  ctx.http.get = async (url) => {
    requested.push(url);
    return { text: html, url, status: 200, headers: { 'content-type': 'text/html' } };
  };
  const candidate = { id: 'g-xinhua-project', url: candidateUrl, title, publishedAt: '2025-08-20T00:00:00.000Z', publishedAtRaw: '2025-08-20', datePrecision: 'day', channelId: 'primary', metadata: { media: true, publisher: '新华网', discoveryUrl: 'https://www.galbot.com/news/' } };
  await assert.rejects(hydrate(candidate, source('galbot-news'), ctx), /pending_evidence: no article-linked first-party or project source/);
  assert.deepEqual(requested, [candidateUrl]);
});

test('WAM-TTT Tencent link challenge stays pending when the official channel only has an unrelated brand-matched video', async () => {
  const candidateUrl = 'https://mp.weixin.qq.com/s/LMtt3FGB6zyB7Boex4S6kg';
  const feedUrl = 'https://www.youtube.com/feeds/videos.xml?channel_id=UCtWK-1gf-HoocxS-DUirRow';
  const description = 'GALBOT AstraTennis demonstrates a robot’s autonomous tennis skills and movement in a staged court setting, with the official video showing the system in action.';
  const xml = `<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom" xmlns:yt="http://www.youtube.com/xml/schemas/2015" xmlns:media="http://search.yahoo.com/mrss/"><entry><id>yt:video:astra-tennis</id><yt:videoId>astra-tennis</yt:videoId><yt:channelId>UCtWK-1gf-HoocxS-DUirRow</yt:channelId><title>AstraTennis: Galbot robot shows off tennis skills | GALBOT</title><link rel="alternate" href="https://www.youtube.com/watch?v=astra-tennis"/><author><name>Galbot</name></author><published>2026-07-19T08:39:40.000Z</published><media:group><media:description><![CDATA[${description}]]></media:description></media:group></entry></feed>`;
  const ctx = ctxFor('<html/>');
  ctx.http.get = async (url) => url === candidateUrl
    ? { text: 'captcha challenge', url: 'https://mp.weixin.qq.com/mp/wappoc_appmsgcaptcha', status: 200, headers: {} }
    : { text: xml, url: feedUrl, status: 200, headers: { 'content-type': 'application/atom+xml' } };
  const candidate = { id: 'g-wam', url: candidateUrl, title: '颠覆后训练范式：银河通用 WAM-TTT 让机器人换厨房不丢手艺', publishedAt: '2026-07-16T00:00:00.000Z', publishedAtRaw: '2026-07-16', datePrecision: 'day', metadata: { media: true, publisher: '腾讯科技', summary: 'GALBOT WAM-TTT Enables Robots to Transfer Their Skills Across Kitchens', discoveryUrl: 'https://www.galbot.com/news/' } };
  await assert.rejects(hydrate(candidate, source('galbot-news'), ctx), /pending_evidence/);
});

test('WAM-TTT exact official channel title can supply the matching original video evidence', async () => {
  const candidateUrl = 'https://mp.weixin.qq.com/s/LMtt3FGB6zyB7Boex4S6kg';
  const feedUrl = 'https://www.youtube.com/feeds/videos.xml?channel_id=UCtWK-1gf-HoocxS-DUirRow';
  const description = 'Galbot introduces WAM-TTT, a test-time training framework that adapts a pretrained robot model to new environments by learning from human videos. The project description explains the frozen backbone, lightweight fast weights, and reported real-world robot evaluations across diverse environments.';
  const xml = `<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom" xmlns:yt="http://www.youtube.com/xml/schemas/2015" xmlns:media="http://search.yahoo.com/mrss/"><entry><id>yt:video:8UVgwer8qNU</id><yt:videoId>8UVgwer8qNU</yt:videoId><yt:channelId>UCtWK-1gf-HoocxS-DUirRow</yt:channelId><title>WAM-TTT: Teaching Robots to Adapt to New Environments | GALBOT AstraBrain</title><link rel="alternate" href="https://www.youtube.com/watch?v=8UVgwer8qNU"/><author><name>Galbot</name></author><published>2026-07-19T08:39:40.000Z</published><media:group><media:description><![CDATA[${description}]]></media:description></media:group></entry></feed>`;
  const ctx = ctxFor('<html/>');
  ctx.http.get = async (url) => url === candidateUrl
    ? { text: 'captcha challenge', url: 'https://mp.weixin.qq.com/mp/wappoc_appmsgcaptcha', status: 200, headers: {} }
    : { text: xml, url: feedUrl, status: 200, headers: { 'content-type': 'application/atom+xml' } };
  const candidate = { id: 'g-wam-match', url: candidateUrl, title: '颠覆后训练范式：银河通用 WAM-TTT 让机器人换厨房不丢手艺', publishedAt: '2026-07-16T00:00:00.000Z', publishedAtRaw: '2026-07-16', datePrecision: 'day', metadata: { media: true, publisher: '腾讯科技', summary: 'GALBOT WAM-TTT Enables Robots to Transfer Their Skills Across Kitchens', discoveryUrl: 'https://www.galbot.com/news/' } };
  const item = await hydrate(candidate, source('galbot-news'), ctx);
  assert.equal(item.url, 'https://www.youtube.com/watch?v=8UVgwer8qNU');
  assert.equal(item.publishedAt, '2026-07-19T08:39:40.000Z');
  assert.equal(item.metadata.sourceListPublishedAtRaw, '2026-07-16');
  assert.equal(item.metadata.unresolvedOriginalEntry.status, 'pending_evidence');
  assert.equal(item.evidence[1].kind, 'official_demo');
  assert.equal(item.evidence[1].relation, 'original');
  assert.match(item.content, /frozen backbone/);
});

test('Galbot media report remains pending evidence when its company project source cannot be retrieved', async () => {
  const ctx = ctxFor('<html/>', { content: `A CCTV interview with Galbot co-founder 张直政. ${'Robot training details. '.repeat(8)}` });
  ctx.http.get = async (url) => ({ text: '<html/>', url, status: 200, headers: {} });
  const candidate = { id: 'g2', url: GALBOT_CCTV_URL, title: 'Home service robot training', publishedAt: '2026-08-16T00:00:00.000Z', publishedAtRaw: '2026-08-16', datePrecision: 'day', metadata: { media: true, publisher: '央视新闻', discoveryUrl: 'https://www.galbot.com/news/' } };
  await assert.rejects(hydrate(candidate, source('galbot-news'), ctx), /pending_evidence: Galbot original project source unavailable/);
  assert.equal(candidate.metadata.pendingEvidence.status, 'pending_evidence');
});

test('hydrate rejects title-only or challenge content without qualifying it', async () => {
  const candidate = { id: 'x', url: 'https://example.test/a', title: 'robot', publishedAt: '2026-09-29T00:00:00.000Z', publishedAtRaw: '2026-09-29', datePrecision: 'day', metadata: {} };
  const c = ctxFor('<html/>', { content: 'Please log in to continue.' });
  await assert.rejects(hydrate(candidate, source('unitree-news'), c), /Article body unavailable/);
});
