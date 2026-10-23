import test from 'node:test';
import assert from 'node:assert/strict';
import { discover, hydrate } from '../adapters/international.mjs';
import * as html from '../lib/html.mjs';

const source = (id, entryUrl) => ({ id, entryUrl, role: 'COMPANY_ORIGINAL_ANNOUNCEMENT' });
function ctx({ pages = {}, jsonRows = {}, article = {} } = {}) {
  return {
    now: '2026-09-30T12:00:00.000Z', maxPages: 2,
    http: { async get(url) {
      if (pages[url]) return { text: pages[url], url, status: 200, headers: { 'content-type': 'text/html' } };
      if (jsonRows[url]) return { text: JSON.stringify(jsonRows[url]), url, status: 200, headers: { 'content-type': 'application/json' } };
      if (url.endsWith('/feed/')) return { text: '<rss><channel><title>Boston Dynamics</title></channel></rss>', url, status: 200, headers: { 'content-type': 'application/rss+xml' } };
      if (article[url]) return { text: article[url], url, status: 200, headers: { 'content-type': 'text/html' } };
      throw new Error(`fixture missing: ${url}`);
    } },
    browser: { async get(url) { return { text: '<title>Vercel Security Checkpoint</title><body>Security Checkpoint</body>', html: '<title>Vercel Security Checkpoint</title><body>Security Checkpoint</body>', url, status: 200, headers: {} }; } },
    html,
  };
}

test('Physical Intelligence explicit access denial stops without browser fallback', async () => {
  const s = source('physical-intelligence-blog', 'https://www.pi.website/blog');
  const c = ctx(); let browserCalls = 0;
  c.http.get = async () => { throw Object.assign(new Error('HTTP 403'), { status: 403, response: { text: 'Forbidden' } }); };
  c.browser.get = async (url) => { browserCalls += 1; return { text: '<html/>', html: '<html/>', url, status: 200, headers: {} }; };
  const found = await discover(s, c);
  assert.equal(found.coverage.blocked, true);
  assert.match(found.coverage.entryError, /403/);
  assert.equal(browserCalls, 0);
  const item = { id: 'blocked', url: 'https://www.pi.website/blog/robot-update', title: 'Robot update', metadata: {} };
  await assert.rejects(hydrate(item, s, c), /HTTP 403/);
  assert.equal(browserCalls, 0);
});

test('Figure discovery preserves source dates; hydrate requires real dated body and tags company evidence', async () => {
  const entry = 'https://www.figure.ai/news';
  const listing = '<a href="/news/helix"><time datetime="2026-09-17T13:00:00.000Z">September 17, 2026</time>Helix 2.5 Zero-Shot Generalization</a>';
  const articleUrl = 'https://www.figure.ai/news/helix';
  const page = `<h1>Helix 2.5</h1><script type="application/ld+json">{"@type":"Article","headline":"Helix 2.5","datePublished":"2026-09-17T13:00:00.000Z"}</script><article>${'Company reports robot generalization in home environments. '.repeat(6)}</article>`;
  const result = await discover(source('figure-news', entry), ctx({ pages: { [entry]: listing, [`${entry}?page=2`]: listing } }));
  assert.equal(result.candidates.length, 1);
  assert.equal(result.candidates[0].title, 'Helix 2.5 Zero-Shot Generalization');
  assert.equal(result.candidates[0].publishedAt, '2026-09-17T13:00:00.000Z');
  const item = await hydrate(result.candidates[0], source('figure-news', entry), ctx({ article: { [articleUrl]: page } }));
  assert.match(item.content, /robot generalization/);
  assert.equal(item.evidence[0].kind, 'official_announcement');
  assert.equal(item.metadata.independentValidation, 'not established by official announcement');
});

test('international date-only text stays UTC-stable and unzoned times remain unknown', async () => {
  const entry = 'https://www.figure.ai/news';
  const listing = '<a href="/news/date-only"><time datetime="September 17, 2026">September 17, 2026</time>Robot update</a><a href="/news/local-time"><time datetime="2026-09-17T13:00:00">2026-09-17T13:00:00</time>Robot timing</a>';
  const result = await discover(source('figure-news', entry), ctx({ pages: { [entry]: listing, [`${entry}?page=2`]: listing } }));
  const dateOnly = result.candidates.find(item => item.url.endsWith('/date-only'));
  const localTime = result.candidates.find(item => item.url.endsWith('/local-time'));
  assert.equal(dateOnly.publishedAt, '2026-09-17T00:00:00.000Z');
  assert.equal(dateOnly.datePrecision, 'day');
  assert.equal(localTime.publishedAt, null);
  assert.equal(localTime.datePrecision, 'unknown');
});

test('Boston REST discovery is an explicit fallback for the valid but empty official feed', async () => {
  const api = 'https://bostondynamics.com/wp-json/wp/v2/blog?per_page=20&page=1&_fields=date%2Cdate_gmt%2Clink%2Ctitle%2Cexcerpt%2Ccontent';
  const rows = [{ date: '2026-05-18T11:45:00', date_gmt: '2026-05-18T11:45:00', link: 'https://bostondynamics.com/blog/training-a-humanoid-robot-for-hard-work/', title: { rendered: 'Training a Humanoid Robot for Hard Work' }, excerpt: { rendered: 'Atlas robot learns hard work.' }, content: { rendered: 'Atlas robot coordinated whole-body behavior in the lab.' } }];
  const result = await discover(source('boston-dynamics-blog', 'https://bostondynamics.com/blog/'), ctx({ jsonRows: { [api]: rows } }));
  assert.equal(result.coverage.originalFeed.itemCount, 0);
  assert.match(result.coverage.pagesRequested[0], /wp-json\/wp\/v2\/blog/);
  assert.equal(result.candidates[0].publishedAtRaw, '2026-05-18T11:45:00Z');
  assert.equal(result.candidates[0].publishedAt, '2026-05-18T11:45:00.000Z');
});

test('Boston REST refreshes its head while continuing past the saved page, and preserves checkpoint on failure', async () => {
  const s = source('boston-dynamics-blog', 'https://bostondynamics.com/blog/');
  const make = (state, failPage) => {
    const calls = [];
    const c = ctx(); c.state = state; c.maxPages = 2;
    c.http.get = async url => {
      if (url.endsWith('/feed/')) return {text:'<rss><channel/></rss>',url,status:200,headers:{}};
      const page = Number(new URL(url).searchParams.get('page')); calls.push(page);
      if (page === failPage) throw new Error('Controlled failed page');
      const rows = Array.from({length:20},(_,i)=>({link:`https://bostondynamics.com/blog/robot-${page}-${i}/`,title:{rendered:'Atlas robot update'},date_gmt:'2026-09-01T10:00:00'}));
      return {text:JSON.stringify(rows),url,status:200,headers:{'x-wp-totalpages':'6'}};
    };
    return {c,calls};
  };
  const a = make({nextPage:3}); const first = await discover(s,a.c);
  assert.deepEqual(a.calls,[1,3]); assert.equal(first.nextState.nextPage,4);
  const b = make(first.nextState); const second = await discover(s,b.c);
  assert.deepEqual(b.calls,[1,4]); assert.equal(second.nextState.nextPage,5);
  const failed = make(second.nextState,5); const retry = await discover(s,failed.c);
  assert.deepEqual(failed.calls,[1,5]); assert.equal(retry.nextState,undefined);
  assert.equal(retry.coverage.paginationComplete,false);
  assert.equal(retry.candidates.length,20);
  assert.match(retry.issues.at(-1).error,/failed page/);
});

test('Physical Intelligence challenge is reported and never mistaken for blog content', async () => {
  const s = source('physical-intelligence-blog', 'https://www.pi.website/blog');
  const c = ctx();
  c.http.get = async (url) => ({ text: '<title>Vercel Security Checkpoint</title><body>Security Checkpoint</body>', url, status: 200, headers: {} });
  const result = await discover(s, c);
  assert.equal(result.coverage.blocked, true);
  assert.match(result.issues.at(-1).error, /checkpoint|challenge|blocked/i);
  const pending = { id: 'pi07', url: 'https://www.pi.website/blog/pi07', title: 'A Steerable Model', publishedAt: '2026-04-16T00:00:00Z', publishedAtRaw: 'April 16, 2026', datePrecision: 'day', metadata: {} };
  await assert.rejects(hydrate(pending, s, c), /challenge\/blocked/i);
});

test('hydrate rejects an official page with a body but no source publication date', async () => {
  const s = source('figure-news', 'https://www.figure.ai/news');
  const item = { id: 'undated', url: 'https://www.figure.ai/news/undated', title: 'Robot update', publishedAt: '2026-09-17T00:00:00Z', publishedAtRaw: '2026-09-17', datePrecision: 'day', metadata: {} };
  const html = `<h1>Robot update</h1><article>${'Official robot update body. '.repeat(8)}</article>`;
  await assert.rejects(hydrate(item, s, ctx({ article: { [item.url]: html } })), /no qualifying publication date/);
});
