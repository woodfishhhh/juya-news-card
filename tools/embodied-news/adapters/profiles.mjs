import { createHash } from 'node:crypto';
import { loadXObservation } from '../lib/browser-observations.mjs';

const YT_FEED = 'https://www.youtube.com/feeds/videos.xml?channel_id=';
const WBI_MIXIN_PERM = [46,47,18,2,53,8,23,32,15,50,10,31,58,3,45,35,27,43,5,49,33,9,42,19,29,28,14,39,12,38,41,13,37,48,7,16,24,55,40,61,26,17,0,1,60,51,30,4,22,25,54,21,56,59,6,63,57,62,11,36,20,34,44,52];
const PROFILE_CHANNELS = {
  'unitree-news': { youtube: 'profile-1', x: 'profile-2' },
  'limx-news': { bilibili: 'profile-1', youtube: 'profile-2' },
  'galbot-news': { bilibili: 'profile-1', youtube: 'profile-2' },
  'figure-news': { youtube: 'profile-1' },
};
const UA = 'Mozilla/5.0 (compatible; EmbodiedNewsCollector/1.0)';
const PROFILE_OVERLAP_PAGES = 2;

export function channels(source) {
  return (source.officialProfiles ?? []).map((profile) => ({
    channelId: profileChannelId(source, profile),
    url: profile.url,
    ownerEvidence: ownerEvidenceFor(source, profile),
  }));
}

function ownerEvidenceFor(source, profile) {
  if (source.id === 'limx-news' && new URL(profile.url).hostname === 'space.bilibili.com') return 'https://www.limxdynamics.com/news';
  return profile.ownerEvidence;
}
function configuredOwnerEvidenceFor(source, profile) {
  return source.officialProfiles?.find((item) => item.url === profile.url)?.ownerEvidence ?? profile.ownerEvidence;
}

function profileChannelId(source, profile) {
  const url = new URL(profile.url);
  const platform = url.hostname.endsWith('youtube.com') ? 'youtube'
    : url.hostname.endsWith('bilibili.com') ? 'bilibili'
      : url.hostname === 'x.com' || url.hostname === 'twitter.com' ? 'x' : 'other';
  const assigned = PROFILE_CHANNELS[source.id]?.[platform];
  if (assigned) return assigned;
  const slug = `${url.hostname.replace(/^www\./, '').replaceAll('.', '-')}-${url.pathname.replaceAll('/', '-').replace(/^-|-$|@/g, '')}`;
  return `${source.id}-${slug}`;
}

function profileFor(source) {
  const profile = source.profile ?? source.officialProfiles?.find((item) => item.url === source.entryUrl);
  if (!profile?.url || !profile.ownerEvidence) throw new Error(`Official profile or owner evidence missing for ${source.id}`);
  return profile;
}
function channelFor(source, profile) { return source.channelId ?? profileChannelId(source, profile); }
async function inspectOwnership(ctx, profile) {
  try {
    const response = await get(ctx, profile.ownerEvidence, { timeoutMs: 20000 });
    const $ = ctx.html.load(response.text ?? '');
    const target = new URL(profile.url);
    const normalize = (url) => { const parsed = new URL(url); return `${parsed.hostname.toLowerCase().replace(/^www\./, '')}${parsed.pathname.replace(/\/$/, '').toLowerCase()}`; };
    const wanted = normalize(target.href);
    const match = $('a[href]').toArray().some((anchor) => {
      try { return normalize(new URL($(anchor).attr('href'), profile.ownerEvidence).href) === wanted; } catch { return false; }
    });
    return { status: match ? 'profile_link_found_on_owner_evidence_page' : 'profile_link_not_found_on_owner_evidence_page', verified: match };
  } catch (error) {
    return { status: 'owner_evidence_page_unavailable', verified: false, error: error.message };
  }
}
function html(ctx, markup) { return ctx.html.load(markup); }
function plain(ctx, value) { return ctx.html.text(value ?? '').trim(); }
function isoDate(value) {
  if (value == null || value === '') return null;
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? null : date.toISOString();
}
function datePrecision(value) { return value ? 'second' : 'unknown'; }
function videoCandidate({ id, url, title, publishedAt, publishedAtRaw = publishedAt, description = '', channelId, source, metadata = {} }) {
  return { id, url, title, publishedAt, publishedAtRaw: publishedAtRaw ?? null, datePrecision: datePrecision(publishedAt), channelId,
    metadata: { profileUrl: source.profile?.url ?? source.entryUrl, description, ...metadata } };
}

async function get(ctx, url, options = {}) {
  const host = new URL(url).hostname;
  if ((host === 'api.bilibili.com' || host === 'space.bilibili.com' || host === 'www.bilibili.com') && ctx.accounts?.bilibili?.get) {
    return ctx.accounts.bilibili.get(url, options);
  }
  try {
    return await ctx.http.get(url, { headers: { 'user-agent': UA, ...options.headers }, ...options });
  } catch (directError) {
    if (!ctx.browser?.get) throw directError;
    try {
      const result = await ctx.browser.get(url, { timeoutMs: options.timeoutMs ?? 25000 });
      const $ = ctx.html.load(result.text ?? result.html ?? '');
      const pre = $('pre').first().text().trim();
      return { ...result, text: pre || result.text || result.html || '' };
    } catch (browserError) {
      throw new Error(`Anonymous public HTTP failed: ${directError.message}; browser fallback failed: ${browserError.message}`);
    }
  }
}
async function browserGet(ctx, url) {
  if (!ctx.browser?.get) throw new Error('Browser unavailable; no anonymous rendered-page fallback');
  return ctx.browser.get(url, { waitUntil: 'domcontentloaded', timeoutMs: 25000 });
}
function xmlEntries(ctx, xml) {
  const $ = html(ctx, xml);
  return $('entry').toArray().map((entry) => {
    const e = $(entry);
    const videoUrl = e.find('link[rel="alternate"]').attr('href') ?? e.find('link').attr('href');
    const id = e.find('yt\\:videoId, videoId').first().text().trim() || videoUrl?.match(/[?&]v=([^&]+)/)?.[1];
    const title = e.find('title').first().text().trim();
    const publishedAtRaw = e.find('published').first().text().trim();
    const publishedAt = isoDate(publishedAtRaw);
    const description = e.find('media\\:description, description').first().text().trim();
    return { id, url: videoUrl, title, publishedAt, publishedAtRaw, description };
  }).filter((entry) => entry.id && entry.url && entry.title);
}
function youtubeChannelId(ctx, markup) {
  const $ = html(ctx, markup);
  return $('meta[itemprop="channelId"]').attr('content')
    ?? $('link[rel="canonical"]').attr('href')?.match(/youtube\.com\/channel\/(UC[\w-]+)/)?.[1]
    ?? markup.match(/"channelId":"(UC[\w-]+)"/)?.[1];
}
async function discoverYoutube(source, profile, ctx, channelId) {
  let channel = profile.url.match(/youtube\.com\/channel\/(UC[\w-]+)/)?.[1];
  let discoveryUrl = profile.url;
  if (!channel) {
    const response = await get(ctx, profile.url, { timeoutMs: 25000 });
    channel = youtubeChannelId(ctx, response.text);
    discoveryUrl = response.url ?? profile.url;
    if (!channel) throw new Error('YouTube page returned without a public channel ID');
  }
  const apiKey = process.env.EMBODIED_YOUTUBE_API_KEY;
  const feedUrl = `${YT_FEED}${encodeURIComponent(channel)}`;
  let entries; let listingUrl = feedUrl; let pagesRead = 0; let total = null; let hasMore = false; let method = 'rss'; let nextState;
  if (apiKey) {
    method = 'youtube-data-api';
    const apiBase = 'https://www.googleapis.com/youtube/v3';
    let uploadsPlaylistId = ctx.state?.uploadsPlaylistId;
    if (!uploadsPlaylistId) {
      const channelUrl = `${apiBase}/channels?part=contentDetails&id=${encodeURIComponent(channel)}`;
      const channelResponse = await get(ctx, channelUrl, { timeoutMs: 25000, headers: { 'x-goog-api-key': apiKey } });
      uploadsPlaylistId = JSON.parse(channelResponse.text)?.items?.[0]?.contentDetails?.relatedPlaylists?.uploads;
      if (!uploadsPlaylistId) throw new Error('YouTube Data API did not return the public uploads playlist');
    }
    // Re-read the head on every invocation. Page tokens from a successful prior invocation
    // resume history, while an overlapping prior token protects against inserts at the head.
    const pages = [];
    const savedToken = ctx.state?.pageToken ?? null;
    let headNextToken = null;
    let pageToken = null;
    let responsePayload;
    const targetPages = Math.max(1, Number(ctx.maxPages) || 3);
    for (let page = 0; page < targetPages; page++) {
      const params = new URLSearchParams({ part: 'snippet,contentDetails', playlistId: uploadsPlaylistId, maxResults: '50' });
      const tokenForPage = page === 0 ? null : page === 1 ? (savedToken ?? headNextToken) : pageToken;
      if (tokenForPage) params.set('pageToken', tokenForPage);
      const url = `${apiBase}/playlistItems?${params}`;
      const response = await get(ctx, url, { timeoutMs: 25000, headers: { 'x-goog-api-key': apiKey } });
      responsePayload = JSON.parse(response.text);
      if (responsePayload.error) throw new Error(`YouTube Data API error: ${responsePayload.error.message ?? 'unknown'}`);
      pages.push(responsePayload);
      pagesRead++;
      pageToken = responsePayload.nextPageToken ?? '';
      if (page === 0) headNextToken = pageToken || null;
      if (!pageToken) break;
    }
    entries = pages.flatMap((payload) => (payload.items ?? []).map((item) => {
      const videoId = item.contentDetails?.videoId ?? item.snippet?.resourceId?.videoId;
      const snippet = item.snippet ?? {};
      return { id: videoId, url: videoId ? `https://www.youtube.com/watch?v=${videoId}` : '', title: snippet.title?.trim(),
        publishedAtRaw: item.contentDetails?.videoPublishedAt ?? null,
        publishedAt: isoDate(item.contentDetails?.videoPublishedAt), description: snippet.description?.trim() ?? '' };
    })).filter((entry) => entry.id && entry.url && entry.title);
    total = responsePayload?.pageInfo?.totalResults ?? null;
    hasMore = Boolean(pageToken);
    listingUrl = `${apiBase}/playlistItems (uploads playlist ${uploadsPlaylistId})`;
    nextState = { uploadsPlaylistId, pageToken: pageToken || null,
      pagesRead: (ctx.state?.pagesRead ?? 0) + pagesRead, overlapPages: PROFILE_OVERLAP_PAGES,
      headVideoIds: entries.slice(0, 100).map((entry) => entry.id) };
  } else {
    const response = await get(ctx, feedUrl, { timeoutMs: 25000 });
    entries = xmlEntries(ctx, response.text);
    pagesRead = 1;
    hasMore = entries.length >= 15;
  }
  const candidates = entries.map((entry) => videoCandidate({ ...entry, source, channelId,
    metadata: { platform: 'youtube', profileUrl: profile.url, ownerEvidenceUrl: profile.ownerEvidence,
      configuredOwnerEvidenceUrl: configuredOwnerEvidenceFor(source, profile), discoveryUrl, feedUrl,
      listingMethod: method } }));
  return { candidates, issues: candidates.length ? [] : [{ url: feedUrl, error: 'Public channel feed returned no parseable videos' }],
    ...(nextState ? { nextState } : {}),
    coverage: { channelId: channel, feedUrl, listingMethod: method, pagesRead, total, hasMore,
      windowLimited: method === 'rss' && hasMore, limitation: method === 'rss' && hasMore ? 'RSS feed exposes only its recent 15-item window; set EMBODIED_YOUTUBE_API_KEY for official paginated uploads playlist reads' : undefined } };
}
function extractBiliItems(json) {
  const vlist = json?.data?.list?.vlist ?? json?.data?.list?.vlist?.vlist ?? [];
  return vlist.map((v) => ({ id: v.bvid ?? String(v.aid ?? ''), url: v.bvid ? `https://www.bilibili.com/video/${v.bvid}/` : '',
    title: String(v.title ?? '').replace(/<[^>]*>/g, '').trim(), publishedAt: isoDate(Number(v.created) * 1000), publishedAtRaw: String(v.created ?? ''),
    description: String(v.description ?? v.desc ?? '').trim() })).filter((v) => v.id && v.url && v.title);
}
function wbiMixinKey(imgUrl, subUrl) {
  const keyFrom = (value) => new URL(value).pathname.split('/').pop().replace(/\.[^.]+$/, '');
  const raw = keyFrom(imgUrl) + keyFrom(subUrl);
  return WBI_MIXIN_PERM.map((index) => raw[index] ?? '').join('').slice(0, 32);
}
function signWbi(params, mixinKey) {
  const values = { ...params };
  values.wts = Math.floor(Date.now() / 1000);
  const query = Object.keys(values).sort().map((key) => `${encodeURIComponent(key)}=${encodeURIComponent(String(values[key]).replace(/[!'()*]/g, ''))}`).join('&');
  values.w_rid = createHash('md5').update(query + mixinKey).digest('hex');
  return new URLSearchParams(values).toString();
}
async function discoverBilibili(source, profile, ctx, channelId) {
  const mid = new URL(profile.url).pathname.match(/^\/(\d+)\/?$/)?.[1];
  if (!mid) throw new Error('Cannot resolve Bilibili numeric account ID from profile URL');
  let entries = []; let listingUrl; let via = 'wbi'; let apiError; let total = null; let pageSize = 30; let pagesRead = 0; let hasMore = false; let nextState;
  try {
    const navUrl = 'https://api.bilibili.com/x/web-interface/nav';
    const navResponse = await get(ctx, navUrl, { timeoutMs: 25000, headers: { referer: profile.url } });
    const nav = JSON.parse(navResponse.text);
    const imgUrl = nav?.data?.wbi_img?.img_url;
    const subUrl = nav?.data?.wbi_img?.sub_url;
    if (!imgUrl || !subUrl) throw new Error(`Bilibili public WBI key unavailable (code ${nav.code ?? 'missing'})`);
    const mixinKey = wbiMixinKey(imgUrl, subUrl);
    const maxPages = Math.max(1, Number(ctx.maxPages) || 3);
    const committedPage = Math.max(0, Number(ctx.state?.completedPage) || 0);
    // With three or more requests, replay the previous tail page. A two-request
    // run spends one request on the mandatory head refresh, so it continues directly
    // at the next historical page and reports that no tail overlap was available.
    const overlap = committedPage && maxPages >= 3 ? 1 : 0;
    const startPage = committedPage ? committedPage + 1 - overlap : 1;
    const scanSlots = committedPage ? Math.max(0, maxPages - 1) : maxPages;
    const endPage = startPage + scanSlots - 1;
    let highestCompletedPage = committedPage;
    for (let pn = 1; pn <= Math.max(1, endPage); pn++) {
      if (pn > 1 && pn < startPage) continue;
      if (pn > 1 && total != null && pn > Math.ceil(total / pageSize)) break;
      const params = new URLSearchParams(signWbi({ mid, ps: pageSize, pn, order: 'pubdate', web_location: 333.788 }, mixinKey));
      const url = `https://api.bilibili.com/x/space/wbi/arc/search?${params}`;
      const response = await get(ctx, url, { timeoutMs: 25000, headers: { referer: profile.url } });
      const payload = JSON.parse(response.text);
      if (payload.code !== 0) throw new Error(`Bilibili public archive API returned code ${payload.code}: ${payload.message ?? 'unknown'}`);
      const pageData = payload.data ?? {};
      const reportedTotal = Number(pageData.page?.count ?? pageData.list?.page?.count ?? pageData.list?.vlist?.count);
      if (Number.isFinite(reportedTotal)) total = reportedTotal;
      const actualPageSize = Number(pageData.page?.ps ?? pageData.list?.page?.ps);
      if (Number.isFinite(actualPageSize) && actualPageSize > 0) pageSize = actualPageSize;
      if (pn === 1) {
        hasMore = total == null ? extractBiliItems(payload).length >= pageSize : pn * pageSize < total;
      }
      if (pn === 1 || pn >= startPage) entries.push(...extractBiliItems(payload));
      pagesRead++;
      if (pn >= startPage) highestCompletedPage = pn;
      if (total != null && pn * pageSize >= total) break;
      if (!hasMore && pn >= startPage) break;
    }
    const lastPage = total == null ? null : Math.ceil(total / pageSize);
    if (lastPage != null) hasMore = highestCompletedPage < lastPage;
    nextState = { completedPage: lastPage == null ? highestCompletedPage : Math.min(highestCompletedPage, lastPage), pageSize, total,
      overlapPages: overlap, headIds: entries.slice(0, pageSize * overlap).map((entry) => entry.id) };
    listingUrl = `https://api.bilibili.com/x/space/wbi/arc/search (mid ${mid})`;
  } catch (error) {
    apiError = error.message;
    via = 'anonymous-space-page';
    let page;
    try { page = await browserGet(ctx, profile.url); }
    catch (browserError) { throw new Error(`${apiError}; anonymous official-space page fallback failed: ${browserError.message}`); }
    const $ = html(ctx, page.text);
    const links = new Map();
    $('a[href*="/video/"]').each((_, anchor) => {
      const el = $(anchor); const href = el.attr('href') ?? '';
      const bvid = href.match(/\/video\/(BV[\w]+)/i)?.[1];
      const title = (el.attr('title') || el.attr('aria-label') || el.text()).trim();
      if (!bvid || !title) return;
      const timeRaw = el.find('time[datetime]').attr('datetime') || el.attr('data-pubdate') || el.attr('data-pub-time');
      const publishedAt = isoDate(timeRaw);
      links.set(bvid, { id: bvid, url: `https://www.bilibili.com/video/${bvid}/`, title, publishedAt,
        publishedAtRaw: timeRaw ?? null, description: '' });
    });
    entries = [...links.values()];
    listingUrl = profile.url;
    if (!entries.length) throw new Error(`${apiError}; anonymous official space page returned HTTP ${page.status} with no public video links (login prompt present: ${/登录|login/i.test($.text())})`);
  }
  const candidates = entries.map((entry) => videoCandidate({ ...entry, source, channelId,
    metadata: { platform: 'bilibili', profileUrl: profile.url, ownerEvidenceUrl: profile.ownerEvidence,
      configuredOwnerEvidenceUrl: configuredOwnerEvidenceFor(source, profile),
      archiveApi: via === 'wbi' ? listingUrl : null, listingUrl, listingMethod: via } }));
  return { candidates, issues: candidates.length ? [] : [{ url: listingUrl, error: apiError ?? 'Public archive returned no videos' }],
    ...(via === 'wbi' ? { nextState } : {}),
    coverage: { archiveUrl: listingUrl, listingMethod: via, apiError, pagesRead, total, pageSize, startPage: via === 'wbi' ? Math.max(1, (Number(ctx.state?.completedPage) || 0) + 1 - (Number(nextState?.overlapPages) || 0)) : 1,
      overlapApplied: via === 'wbi' && Number(nextState?.overlapPages) > 0,
      overlapLimitation: via === 'wbi' && Number(ctx.state?.completedPage) > 0 && !Number(nextState?.overlapPages)
        ? 'ctx.maxPages leaves one request after mandatory head refresh; continuing without prior-tail overlap' : undefined,
      hasMore, windowLimited: via !== 'wbi' && hasMore } };
}
function twitterCandidates(ctx, markup, source, profile, channelId) {
  const $ = html(ctx, markup);
  const found = new Map();
  $('article').each((_, article) => {
    const card = $(article);
    const permalink = card.find('a[href*="/status/"]').attr('href');
    const id = permalink?.match(/\/status\/(\d+)/)?.[1];
    const time = card.find('time').attr('datetime');
    const text = card.find('[data-testid="tweetText"]').text().trim();
    if (!id || !time || !text) return;
    const url = new URL(permalink, 'https://x.com').href;
    found.set(id, videoCandidate({ id, url, title: text.slice(0, 180), publishedAt: isoDate(time), description: text, source, channelId,
    metadata: { platform: 'x', profileUrl: profile.url, ownerEvidenceUrl: profile.ownerEvidence, itemKind: 'post' } }));
  });
  return [...found.values()];
}
async function discoverX(source, profile, ctx, channelId) {
  if (process.env.EMBODIED_X_OBSERVATION_FILE) {
    const observation = await loadXObservation(process.env.EMBODIED_X_OBSERVATION_FILE, profile.url);
    if (ctx.state?.lastObservationDigest === observation.digest || Math.min(...observation.posts.map(post=>Date.parse(post.detailVerifiedAt))) <= Date.parse(ctx.state?.lastObservationAt || '')) throw new Error('Capture a new live browser observation before another collection run');
    const candidates = observation.posts.map(post => videoCandidate({ id: post.url.split('/').at(-1), url: post.url,
      title: post.text.trim().slice(0,180), publishedAt: post.publishedAt, publishedAtRaw: post.publishedAt,
      description: post.text, source, channelId, metadata: { platform: 'x', publicDomObservation: true,
        observationDigest: observation.digest, observedAt: observation.capturedAt, itemKind: 'post' } }));
    return { candidates, issues: [], nextState: { ...ctx.state, oldestObservedId: observation.posts.at(-1).url.split('/').at(-1),
      headIds: candidates.map(c=>c.id), lastObservationAt: observation.capturedAt, lastObservationDigest: observation.digest },
      coverage: { profileUrl: profile.url, method: observation.method, pagesRead: observation.pagesRead || 1,
        hasMore: observation.hasMore !== false, windowLimited: observation.hasMore !== false,
        observationDigest: observation.digest, capturedAt: observation.capturedAt,
        limitation: 'Public DOM snapshot via supported cloud browser; no X API access or full-history claim' } };
  }
  const token = process.env.EMBODIED_X_BEARER_TOKEN;
  if (token) return discoverXApi(source, profile, ctx, channelId, token);
  if (ctx.state?.lastObservationDigest) throw new Error('Fresh supported-cloud-browser observation missing; reuse the protected session instead of anonymous login fallback');
  let response;
  try { response = await get(ctx, profile.url, { timeoutMs: 25000 }); }
  catch (directError) {
    try { response = await browserGet(ctx, profile.url); }
    catch (browserError) { throw new Error(`X public read unavailable: ${directError.message}; anonymous browser fallback: ${browserError.message}`); }
  }
  const candidates = twitterCandidates(ctx, response.text ?? response.html ?? '', source, profile, channelId);
  if (!candidates.length) throw new Error('Anonymous X profile returned no public post text and precise timestamp; set EMBODIED_X_BEARER_TOKEN with public posts read permission');
  return { candidates, issues: [], coverage: { profileUrl: profile.url, pagesRead: 1, hasMore: true } };
}
async function discoverXApi(source, profile, ctx, channelId, token) {
  const username = new URL(profile.url).pathname.split('/').filter(Boolean)[0];
  const headers = { authorization: `Bearer ${token}` };
  const userUrl = `https://api.x.com/2/users/by/username/${encodeURIComponent(username)}?user.fields=id,username`;
  const userResponse = await get(ctx, userUrl, { timeoutMs: 25000, headers });
  const userData = JSON.parse(userResponse.text)?.data;
  if (!userData?.id) throw new Error('X API did not return a public account ID; verify bearer token and user lookup permission');
  const candidates = []; let pagesRead = 0; let nextToken; let total = null;
  const maxPages = Math.max(1, Number(ctx.maxPages) || 3);
  const savedToken = ctx.state?.nextToken ?? null;
  for (let page = 0; page < maxPages; page++) {
    // Always refresh the head; then resume the last committed API window when available.
    const tokenForPage = page === 0 ? null : (page === 1 ? (savedToken ?? nextToken) : nextToken);
    if (page > 1 && !tokenForPage) break;
    const params = new URLSearchParams({ max_results: '100', 'tweet.fields': 'created_at,text' });
    if (tokenForPage) params.set('pagination_token', tokenForPage);
    const postsUrl = `https://api.x.com/2/users/${encodeURIComponent(userData.id)}/tweets?${params}`;
    const postsResponse = await get(ctx, postsUrl, { timeoutMs: 25000, headers });
    const payload = JSON.parse(postsResponse.text);
    if (payload.errors?.length && !payload.data) throw new Error(`X API listing failed: ${payload.errors[0].detail ?? payload.errors[0].title ?? 'unknown'}`);
    const pageCandidates = (payload.data ?? []).filter((post) => post.id && post.created_at && post.text?.trim()).map((post) => videoCandidate({
      id: post.id, url: `https://x.com/${username}/status/${post.id}`, title: post.text.trim().slice(0, 180), description: post.text.trim(),
      publishedAt: isoDate(post.created_at), publishedAtRaw: post.created_at, source, channelId,
      metadata: { platform: 'x', profileUrl: profile.url, ownerEvidenceUrl: profile.ownerEvidence,
        configuredOwnerEvidenceUrl: configuredOwnerEvidenceFor(source, profile), apiRead: true },
    }));
    candidates.push(...pageCandidates); pagesRead++;
    total = payload.meta?.result_count ?? total;
    nextToken = payload.meta?.next_token ?? null;
    if (!nextToken) break;
  }
  if (!candidates.length) throw new Error('X API returned no public posts with text and precise created_at timestamps');
  return { candidates, issues: [], nextState: { userId: userData.id, nextToken: nextToken ?? savedToken,
      pagesRead: (ctx.state?.pagesRead ?? 0) + pagesRead,
      headIds: candidates.slice(0, 100).map((candidate) => candidate.id) },
    coverage: { userLookupUrl: userUrl, pagesRead, total, hasMore: Boolean(nextToken), windowLimited: Boolean(nextToken) } };
}

export async function discover(source, ctx) {
  const profile = profileFor(source);
  const channelId = channelFor(source, profile);
  const host = new URL(profile.url).hostname;
  const ownership = await inspectOwnership(ctx, profile);
  let result;
  try {
    if (host.endsWith('youtube.com')) result = await discoverYoutube(source, profile, ctx, channelId);
    else if (host.endsWith('bilibili.com')) result = await discoverBilibili(source, profile, ctx, channelId);
    else if (host === 'x.com' || host === 'twitter.com') result = await discoverX(source, profile, ctx, channelId);
    else throw new Error(`Unsupported official profile platform: ${host}`);
  } catch (error) {
    error.ownerEvidenceStatus = ownership.status;
    error.ownerEvidenceVerified = ownership.verified;
    throw error;
  }
  result.coverage = { ...result.coverage, ownerEvidenceStatus: ownership.status, ownerEvidenceVerified: ownership.verified };
  if (ownership.error) result.issues.push({ url: profile.ownerEvidence, error: ownership.error });
  for (const candidate of result.candidates) {
    candidate.metadata.ownerEvidenceStatus = ownership.status;
    candidate.metadata.ownerEvidenceVerified = ownership.verified;
    candidate.metadata.configuredOwnerEvidenceUrl = configuredOwnerEvidenceFor(source, profile);
  }
  return result;
}

async function hydrateYoutube(candidate, profile, ctx) {
  if (candidate.metadata.listingMethod === 'youtube-data-api') {
    const apiKey = process.env.EMBODIED_YOUTUBE_API_KEY;
    if (!apiKey) throw new Error('YouTube API listing candidate requires EMBODIED_YOUTUBE_API_KEY for original publication date and video description');
    const url = `https://www.googleapis.com/youtube/v3/videos?part=snippet&id=${encodeURIComponent(candidate.id)}`;
    const response = await get(ctx, url, { timeoutMs: 25000, headers: { 'x-goog-api-key': apiKey } });
    const item = JSON.parse(response.text)?.items?.[0];
    const publishedAtRaw = item?.snippet?.publishedAt;
    const publishedAt = isoDate(publishedAtRaw);
    const content = String(item?.snippet?.description ?? '').trim();
    if (!publishedAt || !content) throw new Error(`YouTube Data API video ${candidate.id} lacks original publication time or description`);
    return { item: { title: item.snippet.title ?? candidate.title, url: candidate.url, publishedAt, publishedAtRaw }, content };
  }
  const response = await get(ctx, candidate.metadata.feedUrl, { timeoutMs: 25000 });
  const item = xmlEntries(ctx, response.text).find((entry) => entry.id === candidate.id);
  const description = item?.description?.trim() || candidate.metadata.description?.trim();
  if (!item?.publishedAt || !description) throw new Error(`YouTube item ${candidate.id} lacks public description or exact publication time`);
  return { item, content: description };
}
async function hydrateBilibili(candidate, ctx) {
  const listingDescription = String(candidate.metadata.description ?? '').trim();
  if (listingDescription && candidate.publishedAt && candidate.datePrecision === 'second') {
    return { item: { title: candidate.title, url: candidate.url, publishedAt: candidate.publishedAt,
      publishedAtRaw: candidate.publishedAtRaw }, content: listingDescription };
  }
  const url = `https://api.bilibili.com/x/web-interface/view?bvid=${encodeURIComponent(candidate.id)}`;
  let data = null;
  let apiError = null;
  try {
    const response = await get(ctx, url, { timeoutMs: 25000 });
    const payload = JSON.parse(response.text);
    data = payload.code === 0 ? payload.data : null;
    if (!data) apiError = `Bilibili public video API returned code ${payload.code ?? 'missing'}: ${payload.message ?? 'unknown'}`;
  } catch (error) { apiError = error.message; }
  let htmlTitle = '';
  let htmlContent = '';
  let htmlDate = '';
  if (!data) {
    const page = await browserGet(ctx, candidate.url);
    const $ = html(ctx, page.text);
    htmlTitle = String($('meta[property="og:title"]').attr('content') || $('h1').first().text() || '').trim();
    htmlContent = String($('meta[property="og:description"]').attr('content') || $('meta[name="description"]').attr('content') || '').trim();
    htmlDate = String($('meta[property="article:published_time"]').attr('content') || $('meta[itemprop="datePublished"]').attr('content') || $('time[datetime]').first().attr('datetime') || '').trim();
  }
  const publishedAt = data ? isoDate(Number(data.pubdate) * 1000) : isoDate(htmlDate);
  const content = String(data?.desc ?? htmlContent).trim();
  if (!publishedAt || !content) throw new Error(`Bilibili video ${candidate.id} lacks description or exact publication time${apiError ? `; API: ${apiError}` : ''}`);
  return { item: { title: data?.title ?? htmlTitle, url: candidate.url, publishedAt,
    publishedAtRaw: data ? String(data.pubdate) : htmlDate }, content };
}
async function hydrateX(candidate, profile, ctx) {
  if (candidate.metadata.publicDomObservation) {
    if (!process.env.EMBODIED_X_OBSERVATION_FILE) throw new Error('Current supported-browser observation file is required');
    const observation = await loadXObservation(process.env.EMBODIED_X_OBSERVATION_FILE, profile.url);
    if (candidate.metadata.observationDigest !== observation.digest || candidate.metadata.observedAt !== observation.capturedAt) throw new Error('Browser observation changed between discovery and hydration');
    const post = observation.posts.find(p=>p.url===candidate.url);
    if (!post) throw new Error('Post was not freshly observed; retain it in the retry queue');
    return { item: { title: post.text.trim().slice(0,180), url: post.url, publishedAt: post.publishedAt,
      publishedAtRaw: post.publishedAt }, content: post.text.trim(), publicDomObservation: {
      method: observation.method, capturedAt: observation.capturedAt, digest: observation.digest },
      raw: { url: post.url, mediaType: 'application/json', content: JSON.stringify(post) } };
  }
  const token = process.env.EMBODIED_X_BEARER_TOKEN;
  if (candidate.metadata.apiRead && token) {
    const url = `https://api.x.com/2/tweets/${encodeURIComponent(candidate.id)}?tweet.fields=created_at,text`;
    const response = await get(ctx, url, { timeoutMs: 25000, headers: { authorization: `Bearer ${token}` } });
    const tweet = JSON.parse(response.text)?.data;
    const content = String(tweet?.text ?? '').trim();
    const publishedAt = isoDate(tweet?.created_at);
    if (!content || !publishedAt) throw new Error('X API post hydration lacks text or exact created_at');
    return { item: { title: content.slice(0, 180), url: candidate.url, publishedAt, publishedAtRaw: tweet.created_at }, content };
  }
  let response;
  try { response = await get(ctx, candidate.url, { timeoutMs: 25000 }); }
  catch (directError) {
    try { response = await browserGet(ctx, candidate.url); }
    catch (browserError) { throw new Error(`X post unavailable without login/API permission: ${directError.message}; ${browserError.message}`); }
  }
  const $ = html(ctx, response.text ?? response.html ?? '');
  const content = $('[data-testid="tweetText"]').first().text().trim();
  const publishedAt = isoDate($('time').first().attr('datetime'));
  if (!content || !publishedAt) throw new Error('X post does not expose text and precise date anonymously');
  return { item: { title: content.slice(0, 180), url: candidate.url, publishedAt }, content };
}

export async function hydrate(candidate, source, ctx) {
  const profile = profileFor(source);
  const host = new URL(profile.url).hostname;
  let hydrated;
  if (host.endsWith('youtube.com')) hydrated = await hydrateYoutube(candidate, profile, ctx);
  else if (host.endsWith('bilibili.com')) hydrated = await hydrateBilibili(candidate, ctx);
  else if (host === 'x.com' || host === 'twitter.com') hydrated = await hydrateX(candidate, profile, ctx);
  else throw new Error(`Unsupported official profile platform: ${host}`);
  const publishedAt = hydrated.item.publishedAt;
  const content = hydrated.content?.trim();
  if (!publishedAt || !content) throw new Error('Official profile item requires an exact date and actual body text');
  const evidenceKind = candidate.metadata.platform === 'x' ? 'official_announcement' : 'official_demo';
  return { sourceId: source.id, channelId: channelFor(source, profile), sourceItemId: candidate.id,
    title: hydrated.item.title ?? candidate.title, url: hydrated.item.url ?? candidate.url, publishedAt,
    publishedAtRaw: hydrated.item.publishedAtRaw ?? candidate.publishedAtRaw ?? publishedAt, datePrecision: 'second', content, contentFormat: 'text', evidenceClass: evidenceKind,
    evidence: [{ url: candidate.url, kind: evidenceKind, relation: 'original', title: hydrated.item.title ?? candidate.title },
      { url: profile.ownerEvidence, kind: 'official_announcement', relation: 'supporting', title: 'Official company page cited as account ownership evidence' }],
    authors: [], topics: source.topics ?? [], metadata: { platform: candidate.metadata.platform, profileUrl: profile.url,
      ...(hydrated.publicDomObservation ? {publicDomObservation:hydrated.publicDomObservation}:{}),
      accountOwnerEvidenceUrl: profile.ownerEvidence, ownershipEvidenceStatus: candidate.metadata.ownerEvidenceStatus ?? 'not_checked',
      configuredOwnerEvidenceUrl: candidate.metadata.configuredOwnerEvidenceUrl ?? configuredOwnerEvidenceFor(source, profile),
      ownershipVerifiedAgainstEntryPage: candidate.metadata.ownerEvidenceVerified === true },
      raw: hydrated.raw ?? { url: candidate.url, mediaType: 'text/plain', content } };
}
