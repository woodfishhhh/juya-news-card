import Parser from 'rss-parser';

const DEFAULTS = {
  'unitree-news': 'https://www.unitree.com/news/',
  'limx-news': 'https://www.limxdynamics.com/en/news',
  'galbot-news': 'https://www.galbot.com/news/',
  'agibot-news': 'https://www.agibot.com/news',
};

const ROBOTICS = /robot|robotic|embodi|vla|manipulat|humanoid|locomot|teleoperat|grasp|dexter|具身|机器人|机械臂|灵巧手|人形|操作|仿真|运动控制|银河|智元/i;
const DATE_TIME = /(?:20\d{2})\s*(?:年|[-/.])\s*\d{1,2}\s*(?:月|[-/.])\s*\d{1,2}\s*日?(?:\s+\d{1,2}:\d{2}(?::\d{2})?)?/;
const GALBOT_PROJECT_URL = 'https://www.wicinternet.org/2025-11/26/c_1143612.htm';

function normalizedDate(ctx, raw) {
  const original = String(raw ?? '').trim();
  const hasExplicitZone = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(original);
  const localTimestamp = /^\d{4}(?:-|\/|年)\d{1,2}(?:-|\/|月)\d{1,2}日?(?:[T\s]\d{1,2}:\d{2}(?::\d{2}(?:\.\d+)?)?)?$/.test(original);
  const hasTime = /[T\s]\d{1,2}:\d{2}/.test(original);
  const parseValue = localTimestamp && hasTime && !hasExplicitZone ? `${original.replace(/年|\//g, '-').replace(/月/g, '-').replace(/日/g, '')}+08:00` : original;
  const d = ctx.html.date(parseValue);
  return { publishedAt: d.publishedAt, publishedAtRaw: original || null, datePrecision: d.datePrecision };
}
function plain(ctx, s) { return ctx.html.text(s).replace(/\s+/g, ' ').trim(); }
function cardDate(ctx, value) {
  const match = String(value).match(DATE_TIME);
  return match?.[0]?.trim() ?? '';
}
function confirmedAccessRestriction(error) {
  const status = error.status ?? error.response?.status;
  if (![403, 429].includes(status)) return false;
  const body = String(error.response?.text ?? '').slice(0, 20000);
  return /(?:南墙|waf|禁止访问|请求存在威胁|已被拦截|access denied|forbidden|security checkpoint|verify you are human|captcha|too many requests|rate limit|频繁|请求过快)/i.test(body);
}
function pageCandidates(source, html, pageUrl, ctx) {
  const $ = ctx.html.load(html);
  const found = [];
  const seen = new Set();
  if (source.id === 'unitree-news' || source.id === 'limx-news') {
    const selector = source.id === 'unitree-news' ? 'a[href*="/news/"]' : 'a[href^="/en/news/"]';
    $(selector).each((_, el) => {
      const a = $(el); const title = plain(ctx, a.text()); const url = ctx.html.absolute(a.attr('href'), pageUrl);
      if (!url || !title || url.replace(/\/$/, '') === pageUrl.replace(/\/$/, '') || seen.has(url)) return;
      const host = new URL(url).hostname;
      if (!host.endsWith(source.id === 'unitree-news' ? 'unitree.com' : 'limxdynamics.com')) return;
      const ancestor = a.closest('li,article,[class*="item"],[class*="card"],[class*="news"]');
      const text = plain(ctx, ancestor.length ? ancestor.text() : a.parent().text());
      const raw = cardDate(ctx, text) || cardDate(ctx, a.attr('aria-label') ?? '');
      if (!raw) {
        // Keep the candidate for retry/diagnosis; hydrate will reject its missing date.
        seen.add(url); found.push(makeCandidate(source, url, title, '', pageUrl)); return;
      }
      seen.add(url); found.push(makeCandidate(source, url, title, raw, pageUrl));
    });
  } else if (source.id === 'galbot-news') {
    $('a[href]').each((_, el) => {
      const a = $(el); const url = ctx.html.absolute(a.attr('href'), pageUrl);
      if (!url || seen.has(url) || !/^https?:/.test(url)) return;
      const host = new URL(url).hostname;
      if (/galbot\.com$/i.test(host) || !/mp\.weixin\.qq\.com|cctvnews\.cctv\.com|news\.cn|xinhuanet\.com|qbitai\.com|jiqizhixin\.com|latepost\.com|theinformation\.com|people\.com\.cn|news\.cctv\.com|chinanews\.com/i.test(host)) return;
      const card = a.hasClass('news-card') ? a : a.closest('.news-featured');
      if (!card.length) return;
      const text = plain(ctx, card.length ? card.text() : a.parent().text());
      const title = plain(ctx, a.text()).replace(/阅读全文\s*$/, '').trim();
      const raw = cardDate(ctx, text);
      if (!title || !raw) { seen.add(url); found.push(makeCandidate(source, url, title || text.slice(0, 160), raw, pageUrl, { pendingReason: !raw ? 'date-missing' : 'title-missing', publisher: publisherFrom(text, url) })); return; }
      seen.add(url); found.push(makeCandidate(source, url, title, raw, pageUrl, { publisher: publisherFrom(text, url), media: true }));
    });
  } else if (source.id === 'agibot-news') {
    $('a[href*="/article/"]').each((_, el) => {
      const a = $(el); const url = ctx.html.absolute(a.attr('href'), pageUrl);
      if (!url || seen.has(url)) return;
      const card = a.closest('li,article,[class*="item"],[class*="list"]');
      const raw = cardDate(ctx, plain(ctx, card.length ? card.text() : a.parent().text()));
      const title = plain(ctx, a.text()).replace(raw, '').replace(/\s+/g, ' ').trim();
      if (!title) return;
      seen.add(url); found.push(makeCandidate(source, url, title, raw, pageUrl, { browserRenderedListing: true }));
    });
  }
  return { found, next: nextPage($, pageUrl, ctx) };
}
function publisherFrom(text, url) {
  const host = new URL(url).hostname;
  if (/mp\.weixin/.test(host)) return text.match(/银河通用机器人|腾讯科技|具身研习社|机器之心|量子位|新智元/)?.[0] ?? '公众号发布者待核';
  if (/cctvnews/.test(host)) return '央视新闻';
  return text.match(/银河通用机器人|腾讯科技|具身研习社|央视新闻|财联社|新华社|机器之心|量子位/)?.[0] ?? host;
}
function makeCandidate(source, url, title, raw, discoveryUrl, extra = {}) {
  const d = raw ? { publishedAt: null, publishedAtRaw: null, datePrecision: 'unknown' } : { publishedAt: null, publishedAtRaw: null, datePrecision: 'unknown' };
  return {
    id: `${source.id}:${url}`, url, title, ...d,
    ...(raw ? { publishedAtRaw: raw } : {}), channelId: 'primary',
    metadata: { discoveryUrl, sourceRole: source.role, ...extra },
  };
}
function nextPage($, current, ctx) {
  const $next = $('a[rel="next"],a[aria-label*="Next" i],a[aria-label*="下一页"],a').filter((_, el) => /^(next|下一页|›|»|>+)$/i.test(plain(ctx, $(el).text()))).first();
  if (!$next.length) return null;
  const url = ctx.html.absolute($next.attr('href'), current);
  return url && url !== current ? url : null;
}
function withDate(candidate, raw, ctx) {
  const d = raw ? normalizedDate(ctx, raw) : { publishedAt: null, publishedAtRaw: null, datePrecision: 'unknown' };
  return { ...candidate, ...d };
}

function decodePayload(json) {
  const table = typeof json === 'string' ? JSON.parse(json) : json;
  const cache = new Map();
  function ref(index, path = new Set()) {
    if (cache.has(index)) return cache.get(index);
    if (path.has(index)) return null;
    path.add(index);
    const source = table[index]; let value;
    if (Array.isArray(source)) {
      value = typeof source[0] === 'string'
        ? { __type: source[0], value: source.length > 1 ? ref(source[1], path) : null }
        : source.map((part) => typeof part === 'number' ? ref(part, path) : part);
    } else if (source && typeof source === 'object') {
      value = Object.fromEntries(Object.entries(source).map(([key, part]) => [key, typeof part === 'number' ? ref(part, path) : part]));
    } else value = source;
    path.delete(index); cache.set(index, value); return value;
  }
  return ref(0);
}

export async function discover(source, ctx) {
  const entryUrl = source.entryUrl || DEFAULTS[source.id];
  const issues = [];
  const candidates = [];
  const visited = [];
  const pageStatuses = [];
  let url = entryUrl;
  let pages = 0;
  let entryFailure = null;
  let accessRestricted = false;
  let browserMode = false;
  if (source.id === 'unitree-news') {
    const apiUrl = 'https://api.unitree.com/website/news/list';
    const apiCandidates = []; const apiPages = [];
    let total = null; let apiRecordsRead = 0; let indexStatus = null;
    const languageCounts = {};
    try { indexStatus = (await ctx.http.get(source.entryUrl || DEFAULTS[source.id], { timeoutMs: 30000 })).status; }
    catch (error) { issues.push({ kind: 'original-index-failed', url: source.entryUrl || DEFAULTS[source.id], error: error.message, status: error.status ?? null }); }
    const maxPages = Math.max(1, ctx.maxPages ?? 3);
    const resumePage = Number(ctx.state?.nextPage);
    const continuationStart = Number.isInteger(resumePage) && resumePage > 1
      ? (maxPages >= 3 ? Math.max(2, resumePage - 1) : resumePage)
      : 2;
    const requestedPages = [1, ...Array.from({ length: Math.max(0, maxPages - 1) }, (_, index) => continuationStart + index)];
    let lastSuccessfulPage = null; let paginationFailed = false; let reachedEnd = false;
    for (const page of requestedPages) {
      const pageUrl = `${apiUrl}?page=${page}&pageSize=20`;
      let pageItemCount = 0;
      try {
        const response = await ctx.http.get(pageUrl, { timeoutMs: 30000 });
        const payload = JSON.parse(response.text);
        const data = payload?.data;
        if (payload?.code !== 100 || !Array.isArray(data?.items)) throw new Error('Unexpected Unitree public news API response');
        total = Number(data.count); apiPages.push(pageUrl); apiRecordsRead += data.items.length;
        pageItemCount = data.items.length;
        lastSuccessfulPage = page;
        for (const item of data.items) {
          const languages = Array.isArray(item.lang) ? item.lang.map(String) : [];
          for (const language of languages.length ? languages : ['unknown']) languageCounts[language] = (languageCounts[language] || 0) + 1;
          const detailRoute = languages.includes('1') ? `/cn/news/${item.id}` : `/news/${item.id}`;
          const detailUrl = `https://www.unitree.com${detailRoute}`;
          const candidate = makeCandidate(source, detailUrl, item.title || item.description, item.postTime, source.entryUrl || DEFAULTS[source.id], { unitreeArticleId: String(item.id), unitreeLanguages: languages, discoveryMethod: 'official-json-api', apiUrl: pageUrl });
          Object.assign(candidate, normalizedDate(ctx, item.postTime));
          apiCandidates.push(candidate);
        }
      } catch (error) {
        issues.push({ kind: 'api-page-failed', url: pageUrl, error: error.message, status: error.status ?? null }); paginationFailed = true; break;
      }
      if (pageItemCount === 0 || (Number.isFinite(total) && page * 20 >= total)) { reachedEnd = true; break; }
    }
    if (apiCandidates.length) return { candidates: apiCandidates, issues, ...(paginationFailed ? {} : { nextState: { nextPage: reachedEnd ? 2 : lastSuccessfulPage + 1 } }), coverage: { entryUrl: source.entryUrl || DEFAULTS[source.id], entryStatus: indexStatus, method: 'official-json-api', apiUrl, apiStatus: 200, pagesFetched: apiPages.length, pageUrls: apiPages, apiRecordsRead, languageCounts, reportedTotal: total, candidateCount: apiCandidates.length, incomplete: paginationFailed || !reachedEnd, overlapSkippedDueToPageBudget: maxPages === 2 && Number.isInteger(resumePage) && resumePage > 2 } };
    issues.push({ kind: 'official-api-unavailable-fallback-to-html', apiUrl });
  }
  if (source.id === 'limx-news') {
    const apiUrl = 'https://www.limxdynamics.com/api/web/blogs/list';
    const maxPages = Math.max(1, ctx.maxPages ?? 3);
    const resumePage = Number(ctx.state?.nextPage);
    const continuationStart = Number.isInteger(resumePage) && resumePage > 1
      ? (maxPages >= 3 ? Math.max(2, resumePage - 1) : resumePage)
      : 2;
    const requestedPages = [1, ...Array.from({ length: Math.max(0, maxPages - 1) }, (_, index) => continuationStart + index)];
    const apiCandidates = []; const pageUrls = []; let total = null; let lastSuccessfulPage = null; let paginationFailed = false; let reachedEnd = false;
    for (const pageNum of requestedPages) {
      const pageUrl = `${apiUrl} (pageNum=${pageNum})`;
      try {
        const response = await ctx.http.post(apiUrl, { language: 'en', pageNum, pageSize: 12, excludeTop: true }, { timeoutMs: 30000 });
        const payload = JSON.parse(response.text);
        if (payload?.code !== 200 || !Array.isArray(payload.rows) || typeof payload.hasNext !== 'boolean') throw new Error('Unexpected LimX official public blog listing response');
        pageUrls.push(pageUrl); total = Number(payload.total); lastSuccessfulPage = pageNum;
        for (const item of payload.rows) {
          const raw = item.publishTime || '';
          const url = `https://www.limxdynamics.com/${item.language || 'en'}/news/${encodeURIComponent(item.blogId)}`;
          const candidate = makeCandidate(source, url, item.title || '', raw, entryUrl, { limxBlogId: String(item.blogId), discoveryMethod: 'official-json-api', apiUrl, apiPage: pageNum });
          Object.assign(candidate, normalizedDate(ctx, raw)); apiCandidates.push(candidate);
        }
        if (!payload.hasNext) { reachedEnd = true; break; }
      } catch (error) {
        issues.push({ kind: 'api-page-failed', url: pageUrl, error: error.message, status: error.status ?? error.response?.status ?? null }); paginationFailed = true; break;
      }
    }
    if (apiCandidates.length) return { candidates: apiCandidates, issues, ...(paginationFailed ? {} : { nextState: { nextPage: reachedEnd ? 2 : lastSuccessfulPage + 1 } }), coverage: { entryUrl, method: 'official-json-api', apiUrl, pagesFetched: pageUrls.length, pageUrls, pageSize: 12, reportedTotal: total, candidateCount: apiCandidates.length, datedCount: apiCandidates.filter(c => c.publishedAt).length, incomplete: paginationFailed || !reachedEnd, overlapSkippedDueToPageBudget: maxPages === 2 && Number.isInteger(resumePage) && resumePage > 2, paginationCompleteness: paginationFailed ? 'failed-page-checkpoint-preserved' : reachedEnd ? 'reported-end-reached' : 'truncated-at-max-pages' } };
  }
  if (source.id === 'galbot-news') {
    try {
      const page = await ctx.http.get(entryUrl, { timeoutMs: 30000 });
      const $ = ctx.html.load(page.text);
      const payloadPath = $('link[rel="preload"][as="fetch"][href*="_payload.json"]').attr('href')
        || page.text.match(/href="([^"]*_payload\.json\?[^"]+)"/)?.[1];
      if (!payloadPath) throw new Error('Public Nuxt listing payload URL is absent');
      const payloadUrl = ctx.html.absolute(payloadPath, page.url || entryUrl);
      const response = await ctx.http.get(payloadUrl, { timeoutMs: 30000 });
      const decoded = decodePayload(response.text);
      const state = decoded?.data?.value?.['news-list'];
      const data = state?.data;
      if (state?.code !== 200 || !Array.isArray(data?.list)) throw new Error('Unexpected public news listing payload');
      const result = data.list.map((item) => {
        const raw = item.publish_time || '';
        const publisher = item.title || '';
        const headline = item.content || item.eng_content || '';
        const url = ctx.html.absolute(item.url, entryUrl);
        const extra = { publisher, publisherLabel: item.source || null, media: publisher !== '银河通用机器人', galbotItemId: item.id, discoveryMethod: 'official-nuxt-public-payload', payloadUrl, summary: item.eng_content || null };
        const candidate = makeCandidate(source, url, headline, raw, entryUrl, extra);
        Object.assign(candidate, normalizedDate(ctx, raw));
        return candidate;
      });
      const pageInfo = data.pager || {};
      const invalid = result.filter((item) => !item.url || !item.title || !item.publishedAt).length;
      return { candidates: result, issues, coverage: { entryUrl, entryStatus: page.status, method: 'official-nuxt-public-payload', payloadUrl, payloadStatus: response.status, pagesFetched: 1, pageUrls: [entryUrl, payloadUrl], pageSize: pageInfo.page_size, reportedTotal: pageInfo.total, candidateCount: result.length, undatedCount: result.filter(item => !item.publishedAt).length, invalidCandidateCount: invalid, listingComplete: result.length >= (pageInfo.total ?? result.length), incomplete: result.length < (pageInfo.total ?? result.length), note: 'The public payload reports page_size=500 and returns the full listed archive; source selection and original-page hydration remain separate.' } };
    } catch (error) { issues.push({ kind: 'payload-fetch-or-parse-failed', entryUrl, error: error.message, status: error.status ?? null }); }
  }
  while (url && pages < (ctx.maxPages ?? 3)) {
    let response;
    if (browserMode && source.id === 'agibot-news') {
      try { response = await ctx.browser.get(url, { timeoutMs: 35000, waitMs: 2500, waitForSelector: 'a[href*="/article/"]' }); }
      catch (error) { entryFailure = { url, error: error.message, status: error.status ?? null }; issues.push({ kind: 'browser-page-failed', ...entryFailure }); break; }
    } else try {
      response = await ctx.http.get(url, { timeoutMs: 30000 });
      if (source.id === 'agibot-news' && /404|doesn't exist/i.test(response.text.slice(0, 3000))) throw Object.assign(new Error('Official path returned custom 404 content'), { response });
    }
    catch (error) {
      entryFailure = { url, error: error.message, status: error.status ?? error.response?.status ?? null };
      accessRestricted = confirmedAccessRestriction(error);
      issues.push({ kind: accessRestricted ? 'page-fetch-blocked' : 'page-fetch-failed', ...entryFailure });
      if (source.id === 'agibot-news') {
        // Do not switch transports after a response explicitly identifying an access restriction.
        if (accessRestricted) break;
        try {
          response = await ctx.browser.get(url, { timeoutMs: 35000, waitMs: 5000, waitForSelector: 'a[href*="/article/"]' });
          issues.push({ kind: 'browser-alternative', entryUrl: url, method: 'public-rendered-page', status: response.status, resolvedUrl: response.url });
          entryFailure = null;
          browserMode = true;
        } catch (browserError) {
          issues.push({ kind: 'browser-alternative-failed', entryUrl: url, error: browserError.message, status: browserError.status ?? null });
          break;
        }
      } else break;
    }
    visited.push(response.url || url); pageStatuses.push(response.status); pages++;
    const parsed = pageCandidates(source, response.text, response.url || url, ctx);
    for (const candidate of parsed.found) {
      const raw = candidate.publishedAtRaw;
      if (raw) Object.assign(candidate, normalizedDate(ctx, raw));
      candidates.push(candidate);
    }
    url = parsed.next;
    if (source.id === 'agibot-news' && pages === 1 && Number.isInteger(Number(ctx.state?.nextPage)) && Number(ctx.state.nextPage) > 1) {
      const maxPages = Math.max(1, ctx.maxPages ?? 3);
      const startPage = maxPages >= 3 ? Math.max(2, Number(ctx.state.nextPage) - 1) : Number(ctx.state.nextPage);
      url = new URL(entryUrl); url.searchParams.set('page', String(startPage)); url = url.href;
    }
  }
  if (url) issues.push({ kind: 'pagination-truncated', nextUrl: url, maxPages: ctx.maxPages ?? 3 });
  const paginationUnknown = source.id === 'limx-news' && pages === 1 && !url;
  if (!candidates.length && entryFailure && source.id === 'agibot-news' && !accessRestricted) {
    if (source.id === 'agibot-news') {
      const alt = 'https://www.agibot.com/News';
      try {
        const r = await ctx.http.get(alt, { timeoutMs: 30000 });
        const parsed = pageCandidates(source, r.text, r.url || alt, ctx);
        for (const c of parsed.found) { if (c.publishedAtRaw) Object.assign(c, normalizedDate(ctx, c.publishedAtRaw)); candidates.push(c); }
        issues.push({ kind: 'entry-alternative', entryUrl, alternativeUrl: alt, status: r.status, resultCount: parsed.found.length });
      } catch (error) {
        issues.push({ kind: 'entry-alternative-failed', entryUrl, alternativeUrl: alt, error: error.message, status: error.status ?? error.response?.status ?? null });
      }
    }
  }
  const agibotNextPage = source.id === 'agibot-news' ? (url ? Number(new URL(url).searchParams.get('page') || 1) : Number(new URL(visited.at(-1) || entryUrl).searchParams.get('page') || 1)) : null;
  return {
    candidates, issues,
    ...(source.id === 'agibot-news' && !entryFailure && !issues.some(issue => issue.kind === 'browser-page-failed') ? { nextState: { nextPage: agibotNextPage } } : {}),
    coverage: { entryUrl, pagesFetched: pages, pageUrls: visited, pageStatuses, candidateCount: candidates.length, datedCount: candidates.filter(c => c.publishedAt).length, undatedCount: candidates.filter(c => !c.publishedAt).length, incomplete: Boolean(url || entryFailure || paginationUnknown), paginationCompleteness: paginationUnknown ? 'unknown-no-public-next-link' : url ? 'truncated-at-max-pages' : 'observed', nextUrl: url, entryFailure, overlapSkippedDueToPageBudget: source.id === 'agibot-news' && (ctx.maxPages ?? 3) === 2 && Number.isInteger(Number(ctx.state?.nextPage)) && Number(ctx.state.nextPage) > 2, paginationNote: paginationUnknown ? 'One visible listing page returned 16 records but has no public next-page link; older archive completeness is unverified.' : source.id === 'agibot-news' && (ctx.maxPages ?? 3) === 2 && Number.isInteger(Number(ctx.state?.nextPage)) && Number(ctx.state.nextPage) > 2 ? 'The two-page budget refreshes page 1 and advances directly to the next unread historical page; no historical overlap is fetched in this run.' : undefined },
  };
}

function usableArticle(content) {
  return content && content.length >= 100 && !/verify you are human|captcha|access denied|登录后查看|请在微信客户端打开/i.test(content.slice(0, 500));
}
function usableUnitreeApiBody(content, title) {
  const text = String(content || '').trim();
  return text.length >= 40 && text !== String(title || '').trim() && !/verify you are human|captcha|access denied|登录后查看|请在微信客户端打开/i.test(text.slice(0, 500));
}
function urlsFromArticle(content, links = []) {
  const textUrls = [...String(content || '').matchAll(/https?:\/\/[^\s<>"'）)]+/g)].map((m) => m[0].replace(/[，。；、]+$/g, ''));
  return [...new Set([...(links || []).map((x) => typeof x === 'string' ? x : x?.url), ...textUrls].filter(Boolean))];
}
async function galbotProjectEvidence(candidate, content, links, ctx) {
  const words = `${candidate.title || ''} ${candidate.metadata?.summary || ''}`;
  const projectNames = [...new Set(words.match(/\b[A-Z]{2,}(?:-[A-Z0-9]+)*\b|\b[A-Z][a-z0-9]+(?:[A-Z][A-Za-z0-9]+)+\b/g) || [])]
    .filter((name) => !/^(?:VLA|AI|API|AstraBrain|GALBOT)$/i.test(name));
  const namesProject = (text, name) => {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`(?:^|[^A-Za-z0-9])${escaped}(?=$|[^A-Za-z0-9])`, 'i').test(String(text ?? ''));
  };
  if (projectNames.length) {
    const feedUrl = 'https://www.youtube.com/feeds/videos.xml?channel_id=UCtWK-1gf-HoocxS-DUirRow';
    const response = await ctx.http.get(feedUrl, { timeoutMs: 30000 });
    const parser = new Parser({ customFields: { item: [['media:group', 'mediaGroup'], ['yt:channelId', 'channelId'], ['yt:videoId', 'videoId']] } });
    const feed = await parser.parseString(response.text);
    const video = feed.items.find((item) => projectNames.some((name) => namesProject(item.title, name)));
    const description = plain(ctx, video?.mediaGroup?.['media:description']?.[0] || video?.contentSnippet || '');
    const title = plain(ctx, video?.title || '');
    const videoId = video?.videoId || video?.id?.replace(/^yt:video:/, '');
    const videoUrl = video?.link || (videoId ? `https://www.youtube.com/watch?v=${videoId}` : '');
    const ownerChannel = video?.channelId || '';
    if (video && videoUrl && description.length >= 80 && (!ownerChannel || ownerChannel === 'UCtWK-1gf-HoocxS-DUirRow')) {
      return { url: videoUrl, kind: 'official_demo', relation: 'original', title, mediaType: 'application/atom+xml', content: description, publishedAtRaw: video.isoDate || video.pubDate || null, feedUrl, feedContent: response.text, author: video.author || null, channelId: ownerChannel || null };
    }
  }

  const sourceUrls = urlsFromArticle(content, links);
  const firstParty = sourceUrls.filter((url) => /(?:^|\.)galbot\.com\//i.test(url) || /(?:^|\.)whrgoc\.com\//i.test(url));
  for (const url of firstParty) {
    try {
      const response = await ctx.http.get(url, { timeoutMs: 30000 });
      if (/captcha|wappoc_appmsgcaptcha|verify/i.test(response.url || '') || /captcha|access denied/i.test(response.text.slice(0, 12000))) continue;
      const article = ctx.html.article(response.text, response.url || url);
      if (!usableArticle(article.content)) continue;
      const projectWords = projectNames.length ? projectNames : [];
      const specificMatch = projectWords.some((name) => namesProject(`${article.title} ${article.content}`, name));
      if (!specificMatch) continue;
      return { url: response.url || url, kind: /whrgoc\.com/i.test(url) ? 'project' : 'official_announcement', relation: 'original', title: article.title || candidate.title, mediaType: response.headers?.['content-type'] || 'text/html', content: article.content, publishedAtRaw: article.publishedAtRaw || null };
    } catch {}
  }

  // This official project entry documents Galbot's synthetic/real-data training pipeline.
  // It is background support only, not an event-specific original source or independent validation.
  if (!/张直政|Zhizheng Zhang/i.test(content) || !/galbot\.com/i.test(candidate.metadata?.discoveryUrl || '')) {
    throw new Error(`pending_evidence: no article-linked first-party or project source for ${candidate.url}`);
  }
  try {
    const response = await ctx.http.get(GALBOT_PROJECT_URL, { timeoutMs: 30000 });
    if (/captcha|verify/i.test(response.url || '') || /captcha|access denied/i.test(response.text.slice(0, 12000))) throw new Error('Official project source is blocked');
    const $ = ctx.html.load(response.text);
    const body = plain(ctx, $('.g-content').first().text());
    const title = plain(ctx, $('h1').first().text() || $('title').text());
    if (body.length < 500 || !/galbot/i.test(body) || !/(synthetic.*real|real.*synthetic|虚实融合|training data)/i.test(body)) throw new Error('Official project content did not qualify as related technical evidence');
    return { url: response.url || GALBOT_PROJECT_URL, kind: 'project', relation: 'supporting', title, mediaType: response.headers?.['content-type'] || 'text/html', content: body };
  } catch (error) {
    candidate.metadata.pendingEvidence = { status: 'pending_evidence', reason: error.message, attemptedUrl: GALBOT_PROJECT_URL };
    throw new Error(`pending_evidence: Galbot original project source unavailable for ${candidate.url}: ${error.message}`);
  }
}

function galbotXinhuaInterview(candidate, content, response, ctx) {
  const pageUrl = response?.url || candidate.url;
  let host = '';
  try { host = new URL(pageUrl).hostname.toLowerCase(); } catch { return null; }
  if (!/(?:^|\.)xinhuanet\.com$/.test(host) && !/(?:^|\.)news\.cn$/.test(host)) return null;

  const $ = ctx.html.load(response?.text || '');
  const publisher = plain(ctx, $('meta[name="source"]').attr('content') || '');
  if (!/^(?:新华网|新华社)$/.test(publisher)) return null;
  const headline = plain(ctx, $('h1').first().text() || $('title').text());
  if (!/银河通用/.test(headline) || !/赵于莉/.test(headline)) return null;

  const articleBody = $('#main-left #detailContent, .main-left #detailContent, #detailContent').first();
  if (!articleBody.length) return null;
  const paragraphs = articleBody.find('p').map((_, el) => plain(ctx, $(el).text())).get().filter(text => text.length > 15);
  const bodyText = paragraphs.join('\n\n');
  const leadParagraph = paragraphs[0] || '';
  if (!bodyText || bodyText.length < 100 || leadParagraph.length > 500) return null;
  const interviewClaim = /北京银河通用机器人有限公司.{0,40}赵于莉.{0,20}接受新华网专访/;
  if (!interviewClaim.test(leadParagraph.replace(/\s+/g, '')) || !interviewClaim.test(String(content || '').replace(/\s+/g, ''))) return null;

  const visibleTimestamp = plain(ctx, $('.header-time').first().text());
  const match = visibleTimestamp.match(/(20\d{2})\s*(\d{1,2})\/(\d{1,2})\s*(\d{1,2}):(\d{2}):(\d{2})/);
  if (!match) return null;
  const [, year, month, day, hour, minute, second] = match;
  const publishedAtRaw = `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')} ${hour.padStart(2, '0')}:${minute}:${second}`;
  const metaPublishedAtRaw = plain(ctx, $('meta[name="publishdate"]').attr('content') || '') || null;
  if (metaPublishedAtRaw && metaPublishedAtRaw !== publishedAtRaw.slice(0, 10)) return null;
  return { publisher, headline, content: bodyText, publishedAtRaw, visibleTimestamp, metaPublishedAtRaw, interviewee: '赵于莉' };
}

export async function hydrate(candidate, source, ctx) {
  if (!candidate.url) throw new Error(`Missing candidate URL: ${candidate.id}`);
  if (candidate.metadata?.pendingReason) throw new Error(`Candidate is pending qualification: ${candidate.metadata.pendingReason}`);
  let response; let parsed; let content; let title; let unresolvedOriginalEntry = null;
  let mediaType = 'text/html';
  if (source.id === 'unitree-news' && candidate.metadata?.unitreeArticleId) {
    const apiUrl = `https://api.unitree.com/website/news/info?id=${encodeURIComponent(candidate.metadata.unitreeArticleId)}`;
    response = await ctx.http.get(apiUrl, { timeoutMs: 30000 });
    const payload = JSON.parse(response.text); const article = payload?.data?.article;
    if (payload?.code !== 100 || !article) throw new Error(`Unitree official article API returned no article: ${apiUrl}`);
    content = plain(ctx, article.content || ''); title = article.title || candidate.title;
    candidate.publishedAtRaw = article.postTime || candidate.publishedAtRaw;
    Object.assign(candidate, normalizedDate(ctx, candidate.publishedAtRaw));
    mediaType = 'application/json';
    parsed = { authors: article.author?.name ? [article.author.name] : [] };
  } else {
    try { response = await ctx.http.get(candidate.url, { timeoutMs: 30000 }); }
    catch (error) {
      if (confirmedAccessRestriction(error)) throw error;
      if (source.id === 'galbot-news' && candidate.metadata?.media && /WAM[- ]?TTT/i.test(`${candidate.title} ${candidate.metadata?.summary || ''}`)) {
        unresolvedOriginalEntry = { status: 'pending_evidence', url: candidate.url, publisher: candidate.metadata.publisher, publishedAtRaw: candidate.publishedAtRaw, error: error.message, httpStatus: error.status ?? error.response?.status ?? null };
      } else if (source.id === 'agibot-news') response = await ctx.browser.get(candidate.url, { timeoutMs: 35000, waitMs: 5000 });
      else throw error;
    }
    if (!unresolvedOriginalEntry) {
      if (/404|doesn't exist/i.test((response.text || '').slice(0, 2500)) && source.id === 'agibot-news') response = await ctx.browser.get(candidate.url, { timeoutMs: 35000, waitMs: 5000 });
      const isChallenge = /captcha|wappoc_appmsgcaptcha|verify/i.test(response.url || '') || /captcha|verify you are human|access denied|sign in to continue/i.test((response.text || '').slice(0, 12000));
      if (isChallenge && source.id === 'galbot-news' && candidate.metadata?.media && /WAM[- ]?TTT/i.test(`${candidate.title} ${candidate.metadata?.summary || ''}`)) {
        unresolvedOriginalEntry = { status: 'pending_evidence', url: candidate.url, publisher: candidate.metadata.publisher, publishedAtRaw: candidate.publishedAtRaw, finalUrl: response.url, reason: 'Original article redirected to an access challenge' };
      } else if (isChallenge) throw new Error(`Original evidence page redirected to a challenge: ${response.url || candidate.url}`);
    }
    if (!unresolvedOriginalEntry) {
      parsed = ctx.html.article(response.text, response.url || candidate.url);
      content = parsed.content; title = parsed.title || candidate.title;
    }
  }
  if (unresolvedOriginalEntry && source.id === 'galbot-news') {
    const video = await galbotProjectEvidence(candidate, '', [], ctx);
    const videoDate = normalizedDate(ctx, video.publishedAtRaw);
    if (!videoDate.publishedAt || videoDate.datePrecision === 'unknown') throw new Error(`pending_evidence: official alternative video has no precise date: ${video.url}`);
    const metadata = {
      ...candidate.metadata, actualPublisher: 'GALBOT official YouTube', sourceRole: 'OFFICIAL_PROJECT_VIDEO',
      alternativeType: 'official-channel-video', unresolvedOriginalEntry,
      sourceListPublishedAt: candidate.publishedAt, sourceListPublishedAtRaw: candidate.publishedAtRaw,
      officialEvidencePublishedAt: videoDate.publishedAt, officialEvidencePublishedAtRaw: video.publishedAtRaw,
      officialEvidenceUrl: video.url, officialChannelId: video.channelId, requestedAt: ctx.now,
    };
    return {
      sourceId: source.id, channelId: candidate.channelId || 'primary', sourceItemId: candidate.id,
      title: video.title, url: video.url, publishedAt: videoDate.publishedAt, publishedAtRaw: video.publishedAtRaw,
      datePrecision: videoDate.datePrecision, content: video.content, contentFormat: 'text', evidenceClass: video.kind,
      evidence: [
        { url: candidate.metadata.discoveryUrl, kind: 'official_announcement', relation: 'discovery', title: candidate.title },
        { url: video.url, kind: 'official_demo', relation: 'original', title: video.title },
      ], authors: video.author ? [video.author] : [], topics: [], metadata,
      raw: { url: video.feedUrl, mediaType: video.mediaType, content: video.feedContent },
    };
  }
  const firsthandInterview = source.id === 'galbot-news' && candidate.metadata?.media
    ? galbotXinhuaInterview(candidate, content, response, ctx)
    : null;
  if (firsthandInterview) {
    content = firsthandInterview.content;
    title = firsthandInterview.headline || title;
    parsed = { ...parsed, title, content, publishedAtRaw: firsthandInterview.publishedAtRaw, datePrecision: 'second' };
  }
  if (!usableArticle(content) && !(source.id === 'unitree-news' && usableUnitreeApiBody(content, title))) {
    if (source.id === 'agibot-news' && response.url?.includes('/article/')) throw new Error(`Article body unavailable: ${candidate.url}`);
    const rendered = await ctx.browser.get(candidate.url, { timeoutMs: 35000, waitMs: 5000 });
    response = rendered;
    const renderedArticle = ctx.html.article(rendered.html || rendered.text, rendered.url || candidate.url);
    parsed = renderedArticle; content = renderedArticle.content; title = renderedArticle.title || title;
  }
  if (!usableArticle(content) && !(source.id === 'unitree-news' && usableUnitreeApiBody(content, title))) throw new Error(`Article body unavailable or challenge page: ${candidate.url}`);
  if (firsthandInterview) {
    candidate.metadata.sourceListPublishedAt = candidate.publishedAt || null;
    candidate.metadata.sourceListPublishedAtRaw = candidate.publishedAtRaw || null;
    candidate.metadata.sourceListDatePrecision = candidate.datePrecision || 'unknown';
    candidate.metadata.articleMetaPublishedAtRaw = firsthandInterview.metaPublishedAtRaw;
    candidate.metadata.articleVisibleTimestampRaw = firsthandInterview.visibleTimestamp;
    Object.assign(candidate, normalizedDate(ctx, firsthandInterview.publishedAtRaw));
  }
  if ((!candidate.publishedAtRaw || !candidate.publishedAt) && parsed?.publishedAtRaw) {
    Object.assign(candidate, normalizedDate(ctx, parsed.publishedAtRaw));
  }
  if (!candidate.publishedAtRaw || !candidate.publishedAt || ['unknown', 'month', 'year'].includes(candidate.datePrecision)) throw new Error(`No qualifying publication date: ${candidate.url}`);
  const media = Boolean(candidate.metadata?.media);
  const publisher = candidate.metadata?.publisher || new URL(candidate.url).hostname;
  if (source.id === 'galbot-news' || source.id === 'agibot-news') title = candidate.title;
  const kind = media ? 'independent_reporting' : 'official_announcement';
  const evidence = [{ url: candidate.url, kind, relation: 'original', title }];
  const metadata = { ...candidate.metadata, actualPublisher: publisher, sourceRole: media ? 'MEDIA_ORIGINAL' : source.role, requestedAt: ctx.now };
  if (media && source.id === 'galbot-news') {
    if (firsthandInterview) {
      metadata.reportingType = 'original_reporting';
      metadata.reportingFormat = 'firsthand_interview';
      metadata.interviewee = firsthandInterview.interviewee;
      metadata.claimVerification = 'company_statement_unverified';
      metadata.claimVerificationNote = 'Technical and deployment claims are attributed to the Galbot executive interviewed; this article does not independently validate them.';
    } else {
      const project = await galbotProjectEvidence(candidate, content, parsed?.links || [], ctx);
      if (project.relation !== 'original') {
        candidate.metadata.originalReportingFetched = { url: candidate.url, publisher, title, contentLength: content.length, reportingType: 'original_reporting' };
        candidate.metadata.pendingEvidence = { status: 'pending_evidence', reason: 'Only related background was found; no exact event-specific original technical source', supportingUrl: project.url, supportingTitle: project.title, supportingContentLength: project.content.length };
        throw new Error(`pending_evidence: no exact event-specific primary source for ${candidate.url}; related project background is supporting only: ${project.url}`);
      }
      evidence.push({ url: project.url, kind: project.kind, relation: project.relation, title: project.title });
      metadata.reportingType = 'original_reporting';
      metadata.projectEvidenceScope = 'Original project description of Galbot synthetic and real data training; not an independent validation and not evidence for every claim in the CCTV report.';
      metadata.projectEvidenceFetched = { url: project.url, mediaType: project.mediaType, contentLength: project.content.length };
      if (project.publishedAtRaw) metadata.projectEvidencePublishedAtRaw = project.publishedAtRaw;
      if (project.author) metadata.projectEvidenceAuthor = project.author;
    }
  }
  return {
    sourceId: source.id, channelId: candidate.channelId || 'primary', sourceItemId: candidate.id,
    title, url: candidate.url, publishedAt: candidate.publishedAt, publishedAtRaw: candidate.publishedAtRaw,
    datePrecision: candidate.datePrecision, content, contentFormat: 'text', evidenceClass: kind,
    evidence, authors: parsed.authors || [], topics: [],
    metadata,
    raw: { url: mediaType === 'application/json' ? `https://api.unitree.com/website/news/info?id=${encodeURIComponent(candidate.metadata.unitreeArticleId)}` : (response.url || candidate.url), mediaType: response.headers?.['content-type'] || mediaType, content: response.text },
  };
}
