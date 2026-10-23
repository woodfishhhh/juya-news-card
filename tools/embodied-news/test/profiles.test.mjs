import test from 'node:test';
import assert from 'node:assert/strict';
import { channels, discover, hydrate } from '../adapters/profiles.mjs';
import * as html from '../lib/html.mjs';

const source = { id: 'figure-news', topics: ['humanoid'], channelId: 'figure-youtube', entryUrl: 'https://www.youtube.com/@figureai',
  profile: { url: 'https://www.youtube.com/@figureai', ownerEvidence: 'https://www.figure.ai/news' } };
const xml = `<feed xmlns="http://www.w3.org/2005/Atom" xmlns:yt="http://www.youtube.com/xml/schemas/2015" xmlns:media="http://search.yahoo.com/mrss/"><entry><id>tag:youtube.com,2008:video:abc123</id><yt:videoId>abc123</yt:videoId><title>Robot demonstration</title><link rel="alternate" href="https://www.youtube.com/watch?v=abc123"/><published>2026-09-20T12:34:56+00:00</published><media:group><media:description>A robot demonstration description.</media:description></media:group></entry></feed>`;
function ctxFor(responses) { return { maxPages: 3, html, http: { async get(url) { const response = responses[url]; if (response instanceof Error) throw response; if (!response) throw new Error(`Unexpected ${url}`); return response; } } }; }

test('channels keeps every account independently addressable with the declared ownership reference', () => {
  const rows = channels({ id: 'x', officialProfiles: [source.profile, { url: 'https://x.com/UnitreeRobotics', ownerEvidence: 'https://unitree.com/news' }] });
  assert.equal(rows.length, 2);
  assert.notEqual(rows[0].channelId, rows[1].channelId);
  assert.equal(rows[0].ownerEvidence, source.profile.ownerEvidence);
  assert.equal(channels({ id: 'unitree-news', officialProfiles: [source.profile] })[0].channelId, 'profile-1');
  const limx = channels({ id: 'limx-news', officialProfiles: [{ url: 'https://space.bilibili.com/1172054289', ownerEvidence: 'https://www.limxdynamics.com/en/news' }] })[0];
  assert.equal(limx.channelId, 'profile-1');
  assert.equal(limx.ownerEvidence, 'https://www.limxdynamics.com/news');
});

test('YouTube feed parsing yields exact publication time and hydration returns description, never title only', async () => {
  const profilePage = `https://www.youtube.com/@figureai`;
  const feedUrl = 'https://www.youtube.com/feeds/videos.xml?channel_id=UCabc';
  const ctx = ctxFor({ [profilePage]: { text: '<meta itemprop="channelId" content="UCabc">', url: profilePage }, [feedUrl]: { text: xml, url: feedUrl } });
  const found = await discover(source, ctx);
  assert.equal(found.candidates.length, 1);
  assert.equal(found.candidates[0].publishedAt, '2026-09-20T12:34:56.000Z');
  const item = await hydrate(found.candidates[0], source, ctx);
  assert.equal(item.content, 'A robot demonstration description.');
  assert.equal(item.evidenceClass, 'official_demo');
});

test('hydration throws when official video body is missing', async () => {
  const noDescription = xml.replace('<media:description>A robot demonstration description.</media:description>', '<media:description></media:description>');
  const feedUrl = 'https://www.youtube.com/feeds/videos.xml?channel_id=UCabc';
  const candidate = { id: 'abc123', url: 'https://www.youtube.com/watch?v=abc123', title: 'Robot demonstration', publishedAt: '2026-09-20T12:34:56.000Z', channelId: source.channelId,
    metadata: { platform: 'youtube', feedUrl, profileUrl: source.profile.url, ownerEvidenceUrl: source.profile.ownerEvidence } };
  await assert.rejects(hydrate(candidate, source, ctxFor({ [feedUrl]: { text: noDescription, url: feedUrl } })), /lacks public description/);
});

test('missing channel ID and malformed public API data remain failures', async () => {
  const profilePage = source.profile.url;
  await assert.rejects(discover(source, ctxFor({ [profilePage]: { text: '<html>blocked</html>', url: profilePage } })), /without a public channel ID/);
  const bili = { id: 'limx-news', channelId: 'limx-bilibili', entryUrl: 'https://space.bilibili.com/1172054289', profile: { url: 'https://space.bilibili.com/1172054289', ownerEvidence: 'https://limx.example/news' } };
  const nav = 'https://api.bilibili.com/x/web-interface/nav';
  await assert.rejects(discover(bili, ctxFor({ [nav]: { text: '{"code":-101,"message":"not logged in"}', url: nav } })), /WBI key unavailable \(code -101\)/);
});

test('Bilibili public WBI listing parses exact timestamp and hydration requires original description', async () => {
  const bili = { id: 'limx-news', channelId: 'limx-bilibili', entryUrl: 'https://space.bilibili.com/1172054289',
    profile: { url: 'https://space.bilibili.com/1172054289', ownerEvidence: 'https://www.limxdynamics.com/en/news' } };
  const nav = 'https://api.bilibili.com/x/web-interface/nav';
  const key = { code: -101, message: 'not logged in', data: { wbi_img: { img_url: 'https://i0.hdslb.com/bfs/wbi/foo123.png', sub_url: 'https://i0.hdslb.com/bfs/wbi/bar456.png' } } };
  const listing = { code: 0, data: { list: { vlist: [{ bvid: 'BV1234567890', title: 'Robot test', created: 1790000000, description: 'Actual public video description.' }] } } };
  const detail = { code: 0, data: { title: 'Robot test', desc: 'Actual public video description.', pubdate: 1790000000 } };
  const ctx = { maxPages: 3, html, http: { async get(url) {
    if (url === nav) return { text: JSON.stringify(key), url };
    if (url.includes('/x/space/wbi/arc/search?')) return { text: JSON.stringify(listing), url };
    if (url.includes('/x/web-interface/view?bvid=BV1234567890')) return { text: JSON.stringify(detail), url };
    throw new Error(`Unexpected ${url}`);
  } } };
  const found = await discover(bili, ctx);
  assert.equal(found.candidates.length, 1);
  assert.equal(found.candidates[0].publishedAt, '2026-09-21T14:13:20.000Z');
  assert.match(found.candidates[0].metadata.archiveApi, /wbi\/arc\/search/);
  const item = await hydrate(found.candidates[0], bili, ctx);
  assert.equal(item.content, 'Actual public video description.');
});

test('Bilibili account context is used only for Bilibili API and video URLs', async () => {
  const bili = { id: 'limx-news', channelId: 'profile-3', entryUrl: 'https://space.bilibili.com/1172054289',
    profile: { url: 'https://space.bilibili.com/1172054289', ownerEvidence: 'https://www.limxdynamics.com/en/news' } };
  const nav = { code: -101, data: { wbi_img: { img_url: 'https://i0.hdslb.com/bfs/wbi/foo123.png', sub_url: 'https://i0.hdslb.com/bfs/wbi/bar456.png' } } };
  const listing = { code: 0, data: { list: { vlist: [{ bvid: 'BV1234567890', title: 'Robot test', created: 1790000000, description: '' }] } } };
  const detail = { code: 0, data: { title: 'Robot test', desc: 'Hydrated Bilibili description.', pubdate: 1790000000 } };
  const accountUrls = [];
  const ctx = { maxPages: 3, html, accounts: { bilibili: { async get(url) {
    accountUrls.push(url);
    if (url.endsWith('/x/web-interface/nav')) return { text: JSON.stringify(nav), url };
    if (url.includes('/x/space/wbi/arc/search?')) return { text: JSON.stringify(listing), url };
    if (url.includes('/x/web-interface/view?bvid=')) return { text: JSON.stringify(detail), url };
    throw new Error(`Unexpected Bilibili account URL ${url}`);
  } } }, http: { async get(url) {
    if (url === bili.profile.ownerEvidence) return { text: '<a href="https://space.bilibili.com/1172054289">Official account</a>', url };
    throw new Error(`Bilibili credentials must not be sent to ${url}`);
  } } };
  const found = await discover(bili, ctx);
  assert.equal(found.candidates.length, 1);
  assert.equal(found.coverage.ownerEvidenceVerified, true);
  const item = await hydrate(found.candidates[0], bili, ctx);
  assert.equal(item.content, 'Hydrated Bilibili description.');
  assert.equal(accountUrls.length, 3);
  assert.ok(accountUrls.every((url) => ['api.bilibili.com', 'space.bilibili.com', 'www.bilibili.com'].includes(new URL(url).hostname)));
});

test('X public API uses a configured bearer token without exposing it in saved content', async () => {
  const oldToken = process.env.EMBODIED_X_BEARER_TOKEN;
  process.env.EMBODIED_X_BEARER_TOKEN = 'test-token-not-a-credential';
  const xSource = { id: 'unitree-news', channelId: 'profile-2', entryUrl: 'https://x.com/UnitreeRobotics',
    profile: { url: 'https://x.com/UnitreeRobotics', ownerEvidence: 'https://www.unitree.com/news/' } };
  const ctx = { maxPages: 3, html, http: { async get(url, options = {}) {
    if (url.includes('/users/by/username/UnitreeRobotics')) return { text: '{"data":{"id":"42","username":"UnitreeRobotics"}}', url };
    if (url.includes('/users/42/tweets?')) return { text: '{"data":[{"id":"9","text":"New official robot demo.","created_at":"2026-09-21T12:00:00Z"}]}', url };
    if (url.includes('/tweets/9?')) return { text: '{"data":{"id":"9","text":"New official robot demo.","created_at":"2026-09-21T12:00:00Z"}}', url };
    throw new Error(`Unexpected ${url}`);
  } } };
  try {
    const found = await discover(xSource, ctx);
    assert.equal(found.candidates[0].publishedAt, '2026-09-21T12:00:00.000Z');
    const item = await hydrate(found.candidates[0], xSource, ctx);
    assert.equal(item.content, 'New official robot demo.');
    assert.equal(item.publishedAtRaw, '2026-09-21T12:00:00Z');
    assert.equal(JSON.stringify(item).includes('test-token-not-a-credential'), false);
  } finally {
    if (oldToken == null) delete process.env.EMBODIED_X_BEARER_TOKEN;
    else process.env.EMBODIED_X_BEARER_TOKEN = oldToken;
  }
});

function biliFixture() {
  return { id: 'galbot-news', channelId: 'profile-1', entryUrl: 'https://space.bilibili.com/999',
    profile: { url: 'https://space.bilibili.com/999', ownerEvidence: 'https://www.galbot.com/news/' } };
}
const biliKey = { code: 0, data: { wbi_img: { img_url: 'https://i0.hdslb.com/bfs/wbi/foo123.png', sub_url: 'https://i0.hdslb.com/bfs/wbi/bar456.png' } } };
function biliPage(pn, ids, count = 120) {
  return { code: 0, data: { page: { pn, ps: 10, count }, list: { vlist: ids.map((bvid, i) => ({ bvid, title: `Public video ${bvid}`, created: 1790000000 - ((pn - 1) * 10 + i), description: `Body ${bvid}` })) } } };
}

test('Bilibili scans multiple pages, resumes with a head reread and overlaps the prior tail page after insertion', async () => {
  const bili = biliFixture();
  const nav = 'https://api.bilibili.com/x/web-interface/nav';
  const all = Array.from({ length: 40 }, (_, i) => `BV1v${String(i).padStart(8, '0')}`);
  let inserted = false;
  const seen = [];
  const ctx = { maxPages: 3, html, state: {}, accounts: { bilibili: { async get(url) {
    if (url.endsWith('/x/web-interface/nav')) return { text: JSON.stringify(biliKey), url };
    const parsed = new URL(url); const pn = Number(parsed.searchParams.get('pn'));
    seen.push(pn);
    const listing = inserted ? ['BV1new000001', ...all] : all;
    const rows = listing.slice((pn - 1) * 10, pn * 10);
    return { text: JSON.stringify(biliPage(pn, rows)), url };
  } } }, http: { async get(url) { return { text: '<a href="https://space.bilibili.com/999">Galbot</a>', url }; } } };
  const first = await discover(bili, ctx);
  assert.deepEqual(seen, [1, 2, 3]);
  assert.equal(first.coverage.total, 120);
  assert.equal(first.candidates.length, 30);
  assert.equal(first.nextState.completedPage, 3);
  inserted = true; seen.length = 0; ctx.state = first.nextState;
  const second = await discover(bili, ctx);
  assert.deepEqual(seen, [1, 3, 4]);
  assert.equal(second.candidates.some((candidate) => candidate.id === 'BV1new000001'), true, JSON.stringify(second.candidates.map((candidate) => candidate.id)));
  assert.equal(second.candidates.some((candidate) => candidate.id === 'BV1v00000029'), true);
  assert.equal(second.nextState.completedPage, 4);
  const candidate = second.candidates.find((row) => row.id === 'BV1new000001');
  assert.equal(candidate.publishedAt, '2026-09-21T14:13:20.000Z');
  assert.equal(candidate.datePrecision, 'second');
});

test('Bilibili page failure rejects discovery without returning an advanced checkpoint', async () => {
  const bili = biliFixture();
  const nav = 'https://api.bilibili.com/x/web-interface/nav';
  const ctx = { maxPages: 3, html, state: { completedPage: 3, pageSize: 10 }, accounts: { bilibili: { async get(url) {
    if (url.endsWith('/x/web-interface/nav')) return { text: JSON.stringify(biliKey), url };
    const pn = Number(new URL(url).searchParams.get('pn'));
    if (pn === 4) throw new Error('simulated listing failure');
    return { text: JSON.stringify(biliPage(pn, Array.from({ length: 10 }, (_, i) => `BV1p${pn}${String(i).padStart(7, '0')}`))), url };
  } } }, http: { async get(url) { return { text: '<a href="https://space.bilibili.com/999">Galbot</a>', url }; } } };
  await assert.rejects(discover(bili, ctx), /simulated listing failure/);
  assert.equal(ctx.state.completedPage, 3);
});

test('Bilibili maxPages=2 continues beyond page two across runs and preserves checkpoint on next-page failure', async () => {
  const bili = biliFixture();
  const all = Array.from({ length: 70 }, (_, i) => `BV1w${String(i).padStart(8, '0')}`);
  let failPage = null;
  const seen = [];
  const ctx = { maxPages: 2, html, state: {}, accounts: { bilibili: { async get(url) {
    if (url.endsWith('/x/web-interface/nav')) return { text: JSON.stringify(biliKey), url };
    const parsed = new URL(url); const pn = Number(parsed.searchParams.get('pn'));
    seen.push(pn);
    if (pn === failPage) throw new Error(`simulated page ${pn} failure`);
    return { text: JSON.stringify(biliPage(pn, all.slice((pn - 1) * 10, pn * 10), all.length)), url };
  } } }, http: { async get(url) { return { text: '<a href="https://space.bilibili.com/999">Galbot</a>', url }; } } };
  const first = await discover(bili, ctx);
  assert.deepEqual(seen, [1, 2]);
  assert.equal(first.nextState.completedPage, 2);
  assert.equal(first.coverage.overlapApplied, false);
  ctx.state = first.nextState; seen.length = 0;
  const second = await discover(bili, ctx);
  assert.deepEqual(seen, [1, 3]);
  assert.equal(second.candidates.some((candidate) => candidate.id === all[20]), true);
  assert.equal(second.nextState.completedPage, 3);
  assert.equal(second.coverage.overlapApplied, false);
  ctx.state = second.nextState; seen.length = 0; failPage = 4;
  await assert.rejects(discover(bili, ctx), /simulated page 4 failure/);
  assert.deepEqual(seen, [1, 4]);
  assert.equal(ctx.state.completedPage, 3);
});

test('YouTube RSS reports its bounded 15-item window instead of claiming full coverage', async () => {
  const feedUrl = 'https://www.youtube.com/feeds/videos.xml?channel_id=UCabc';
  const entries = Array.from({ length: 15 }, (_, i) => `<entry><yt:videoId>v${i}</yt:videoId><title>Video ${i}</title><link rel="alternate" href="https://www.youtube.com/watch?v=v${i}"/><published>2026-09-20T12:34:56Z</published><media:group><media:description>Description ${i}</media:description></media:group></entry>`).join('');
  const feed = `<feed xmlns="http://www.w3.org/2005/Atom" xmlns:yt="http://www.youtube.com/xml/schemas/2015" xmlns:media="http://search.yahoo.com/mrss/">${entries}</feed>`;
  const ctx = ctxFor({ [source.profile.url]: { text: '<meta itemprop="channelId" content="UCabc">', url: source.profile.url }, [feedUrl]: { text: feed, url: feedUrl } });
  const found = await discover(source, ctx);
  assert.equal(found.candidates.length, 15);
  assert.equal(found.coverage.windowLimited, true);
  assert.match(found.coverage.limitation, /recent 15-item window/);
  assert.equal(found.nextState, undefined);
});

test('YouTube official Data API follows and persists uploads-playlist page tokens with a fresh head read', async () => {
  const oldKey = process.env.EMBODIED_YOUTUBE_API_KEY;
  process.env.EMBODIED_YOUTUBE_API_KEY = 'unit-test-key';
  const api = 'https://www.googleapis.com/youtube/v3';
  const feedUrl = 'https://www.youtube.com/feeds/videos.xml?channel_id=UCabc';
  const calls = [];
  const ctx = { maxPages: 3, state: {}, html, http: { async get(url, options = {}) {
    calls.push({ url, keyHeader: options.headers?.['x-goog-api-key'] });
    if (url === source.profile.url) return { text: '<meta itemprop="channelId" content="UCabc">', url };
    if (url.startsWith(`${api}/channels?`)) return { text: '{"items":[{"contentDetails":{"relatedPlaylists":{"uploads":"UUabc"}}}]}', url };
    if (url.startsWith(`${api}/videos?`)) return { text: JSON.stringify({ items: [{ snippet: { title: 'Older original upload', publishedAt: '2023-02-03T04:05:06Z', description: 'Canonical video description.' } }] }), url };
    if (url.startsWith(`${api}/playlistItems?`)) {
      const parsed = new URL(url);
      if (!parsed.searchParams.has('pageToken')) return { text: JSON.stringify({ items: [{ snippet: { title: 'Head upload', publishedAt: '2026-09-20T12:00:00Z', resourceId: { videoId: 'head' }, description: 'head description' }, contentDetails: { videoId: 'head', videoPublishedAt: '2026-09-19T12:00:00Z' } }], nextPageToken: 'next-1', pageInfo: { totalResults: 101 } }), url };
      const token = parsed.searchParams.get('pageToken');
      const videoId = token === 'next-1' ? 'older' : token === 'next-2' ? 'third' : 'resumed';
      const nextPageToken = token === 'next-1' ? 'next-2' : token === 'next-2' ? 'next-3' : 'next-4';
      return { text: JSON.stringify({ items: [{ snippet: { title: `${videoId} upload`, publishedAt: '2026-09-19T12:00:00Z', resourceId: { videoId }, description: `${videoId} description` } }], nextPageToken, pageInfo: { totalResults: 101 } }), url };
    }
    if (url === feedUrl) throw new Error('RSS must not be used when the official API key exists');
    throw new Error(`Unexpected ${url}`);
  } } };
  try {
    const first = await discover(source, ctx);
    assert.equal(first.coverage.listingMethod, 'youtube-data-api');
    assert.equal(first.coverage.pagesRead, 3);
    assert.deepEqual(first.candidates.map((candidate) => candidate.id), ['head', 'older', 'third']);
    assert.equal(first.nextState.pageToken, 'next-3');
    assert.equal(first.candidates.find((candidate) => candidate.id === 'older').publishedAt, null);
    assert.equal(calls.some((call) => call.keyHeader === 'unit-test-key'), true);
    assert.equal(calls.every((call) => !call.url.includes('unit-test-key')), true);
    const oldVideo = first.candidates.find((candidate) => candidate.id === 'third');
    const fullItem = await hydrate(oldVideo, source, ctx);
    assert.equal(fullItem.content, 'Canonical video description.');
    assert.equal(fullItem.publishedAt, '2023-02-03T04:05:06.000Z');
    assert.equal(fullItem.publishedAtRaw, '2023-02-03T04:05:06Z');
    ctx.state = first.nextState; calls.length = 0;
    const resumed = await discover(source, ctx);
    assert.equal(resumed.candidates[0].id, 'head');
    assert.equal(resumed.nextState.pageToken, 'next-4');
    assert.equal(calls.filter((call) => call.url.startsWith(`${api}/playlistItems?`)).length, 3);
  } finally {
    if (oldKey == null) delete process.env.EMBODIED_YOUTUBE_API_KEY;
    else process.env.EMBODIED_YOUTUBE_API_KEY = oldKey;
  }
});
