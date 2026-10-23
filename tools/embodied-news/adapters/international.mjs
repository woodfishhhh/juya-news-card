const ROBOTICS = /robot|robotic|embodi|vla|manipulat|humanoid|locomot|teleoperat|grasp|dexter|atlas|spot|stretch|具身|机器人|机械臂|人形/i;
const ROOTS = {
  'figure-news': 'https://www.figure.ai',
  'boston-dynamics-blog': 'https://bostondynamics.com',
  'physical-intelligence-blog': 'https://www.pi.website',
};

function compact(value) { return String(value ?? '').replace(/\s+/g, ' ').trim(); }
function dateInfo(raw) {
  if (!raw) return { publishedAt: null, publishedAtRaw: null, datePrecision: 'unknown' };
  const s = String(raw).trim();
  const isoDay = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  const slashDay = s.match(/^(\d{4})\/(\d{1,2})\/(\d{1,2})$/);
  const monthDay = s.match(/^(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,2}),\s+(\d{4})$/i);
  let dayParts = isoDay ? [Number(isoDay[1]), Number(isoDay[2]), Number(isoDay[3])] : slashDay ? [Number(slashDay[1]), Number(slashDay[2]), Number(slashDay[3])] : null;
  if (monthDay) {
    const months = ['january','february','march','april','may','june','july','august','september','october','november','december'];
    dayParts = [Number(monthDay[3]), months.indexOf(monthDay[1].toLowerCase()) + 1, Number(monthDay[2])];
  }
  if (dayParts) {
    const [year, month, day] = dayParts; const value = new Date(Date.UTC(year, month - 1, day));
    if (value.getUTCFullYear() === year && value.getUTCMonth() === month - 1 && value.getUTCDate() === day) return { publishedAt: value.toISOString(), publishedAtRaw: s, datePrecision: 'day' };
    return { publishedAt: null, publishedAtRaw: s, datePrecision: 'unknown' };
  }
  const precision = /^\d{4}$/.test(s) ? 'year' : /^\d{4}-\d{1,2}$/.test(s) ? 'month' : 'unknown';
  if (precision !== 'unknown') return { publishedAt: null, publishedAtRaw: s, datePrecision: precision };
  const hasExplicitZone = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(s);
  const hasTime = /\d{1,2}:\d{2}/.test(s);
  if (!hasExplicitZone || !hasTime || !Number.isFinite(Date.parse(s))) return { publishedAt: null, publishedAtRaw: s, datePrecision: 'unknown' };
  return { publishedAt: new Date(s).toISOString(), publishedAtRaw: s, datePrecision: 'second' };
}
function idFromUrl(url) { return url.replace(/[?#].*$/, '').replace(/\/$/, '').split('/').at(-1); }
function candidate(source, url, title, rawDate, metadata = {}) {
  return { id: idFromUrl(url), url, title: compact(title), ...dateInfo(rawDate), channelId: 'primary', metadata };
}
function checkSource(source) {
  if (!ROOTS[source.id]) throw new Error(`Unsupported international source: ${source.id}`);
}
function confirmedAccessRestriction(error) {
  const status = error.status ?? error.response?.status;
  if (![403, 429].includes(status)) return false;
  const body = String(error.response?.text ?? '').slice(0, 20000);
  return /(?:南墙|waf|禁止访问|请求存在威胁|已被拦截|access denied|forbidden|security checkpoint|verify you are human|captcha|too many requests|rate limit|频繁|请求过快)/i.test(body);
}
function parsed(html, ctx) {
  if (typeof ctx.html.load === 'function') return ctx.html.load(html);
  // Helpers are always used in production. This fallback keeps offline adapters easy to fixture.
  return null;
}
function assertPage(html, url) {
  if (/vercel security checkpoint|verify you are human|captcha|access denied|sign in to continue/i.test(String(html).slice(0, 20000))) {
    throw new Error(`Official page is challenge/blocked; refusing to bypass it: ${url}`);
  }
}
function getDateFromArticle(html, $) {
  const ld = $('script[type="application/ld+json"]').toArray();
  for (const node of ld) {
    try {
      const data = JSON.parse($(node).text());
      const stack = Array.isArray(data) ? [...data] : [data];
      while (stack.length) {
        const item = stack.pop();
        if (!item || typeof item !== 'object') continue;
        if (item.datePublished) return item.datePublished;
        if (item['@graph']) stack.push(...item['@graph']);
      }
    } catch { /* other JSON-LD blocks can be unrelated */ }
  }
  return $('time[datetime]').first().attr('datetime') ?? $('meta[property="article:published_time"]').attr('content') ?? null;
}
function articleContent(response, ctx, url) {
  const html = response.html ?? response.text;
  assertPage(html, url);
  const article = ctx.html.article(html, response.url ?? url);
  let content = compact(article.content);
  const $ = parsed(html, ctx);
  if (content.length < 80 && $) {
    const root = $('main').first().length ? $('main').first() : $('body');
    root.find('header,nav,footer,script,style,svg,form').remove();
    content = compact(root.text());
  }
  const title = compact(article.title || ($ && $('h1').first().text()));
  const rawDate = article.publishedAtRaw || ($ && getDateFromArticle(html, $));
  const authors = article.authors ?? [];
  if (content.length < 80 || /enable javascript|verify you are human|access denied/i.test(content.slice(0, 500))) throw new Error(`Official article body unavailable or blocked: ${url}`);
  const date = dateInfo(rawDate);
  if (!date.publishedAt || ['unknown', 'month', 'year'].includes(date.datePrecision)) throw new Error(`Official article has no qualifying publication date: ${url}`);
  return { content, title, ...date, authors };
}

export async function discover(source, ctx) {
  checkSource(source);
  const issues = [];
  const candidates = [];
  const coverage = { entryUrl: source.entryUrl, pagesRequested: [], paginationComplete: true };
  const maxPages = Math.max(1, ctx.maxPages ?? 3);

  if (source.id === 'physical-intelligence-blog') {
    // The official site currently serves a Vercel checkpoint to this unauthenticated collector.
    // Try only its official public page and normal browser rendering; never solve or evade challenges.
    try {
      coverage.pagesRequested.push(source.entryUrl);
      let response;
      try { response = await ctx.http.get(source.entryUrl); }
      catch (httpError) {
        issues.push({ url: source.entryUrl, stage: 'http', error: httpError.message });
        if (confirmedAccessRestriction(httpError)) throw httpError;
        response = await ctx.browser.get(source.entryUrl);
        coverage.browserFallback = true;
      }
      assertPage(response.html ?? response.text, response.url ?? source.entryUrl);
      const $ = parsed(response.html ?? response.text, ctx);
      if (!$) throw new Error('HTML parser unavailable');
      $('a[href*="/blog/"]').each((_, node) => {
        const a = $(node); const url = ctx.html.absolute(a.attr('href'), response.url ?? source.entryUrl);
        const title = compact(a.text());
        const dateText = compact(a.closest('article,li').text()).match(/\b(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2},\s+20\d{2}\b/)?.[0];
        // This is the company's own research blog; include every dated post, including π0 names
        // that do not contain an English robotics keyword.
        if (url && url !== source.entryUrl && title) candidates.push(candidate(source, url, title, dateText, { listingUrl: source.entryUrl }));
      });
      return { candidates, issues, coverage: { ...coverage, paginationNote: 'All linked blog entries on the rendered index were collected; no separate page links were exposed.', discovered: candidates.length } };
    } catch (error) {
      issues.push({ url: source.entryUrl, stage: 'discovery', error: error.message });
      return { candidates, issues, coverage: { ...coverage, blocked: true, entryError: error.message, discovered: 0 } };
    }
  }

  if (source.id === 'boston-dynamics-blog') {
    // /feed/ is valid RSS but has no items; use the site's public WordPress REST post collection.
    const feedUrl = new URL('/feed/', ROOTS[source.id]).href;
    try {
      const feed = await ctx.http.get(feedUrl);
      const $feed = parsed(feed.text, ctx);
      const rssItems = $feed ? $feed('item').length : 0;
      coverage.originalFeed = { url: feedUrl, status: feed.status, itemCount: rssItems };
      if (rssItems !== 0) issues.push({ url: feedUrl, stage: 'feed', error: 'RSS has items; adapter REST fallback used only as an additional listing.' });
      else issues.push({ url: feedUrl, stage: 'feed', error: 'Official RSS returned valid XML with zero items; using public WordPress REST endpoint.' });
    } catch (error) {
      coverage.originalFeed = { url: feedUrl, error: error.message };
      issues.push({ url: feedUrl, stage: 'feed', error: error.message });
    }
    const perPage = 20;
    const savedPage = Number.isSafeInteger(ctx.state?.nextPage) && ctx.state.nextPage > 1 ? ctx.state.nextPage : 2;
    const start = maxPages >= 3 ? Math.max(2, savedPage - 1) : savedPage;
    const pages = [1, ...Array.from({length: Math.max(0, maxPages - 1)}, (_, i) => start + i)];
    let nextPage = savedPage;
    let listingFailed = false;
    coverage.overlapSkippedDueToPageBudget = savedPage > 2 && maxPages < 3;
    for (const page of pages) {
      const api = new URL('/wp-json/wp/v2/blog', ROOTS[source.id]);
      api.search = new URLSearchParams({ per_page: String(perPage), page: String(page), _fields: 'date,date_gmt,link,title,excerpt,content' }).toString();
      coverage.pagesRequested.push(api.href);
      try {
        const response = await ctx.http.get(api.href);
        const rows = JSON.parse(response.text);
        if (!Array.isArray(rows)) throw new Error('WordPress REST response was not an array');
        for (const row of rows) {
          const title = compact(row.title?.rendered);
          const body = compact(row.excerpt?.rendered ?? row.content?.rendered);
          if (!ROBOTICS.test(`${title} ${body}`)) continue;
          // WordPress returns `date_gmt` without a zone suffix even though its contract is UTC.
          // Normalize that value explicitly; do not interpret the site's local `date` as machine-local time.
          const utcRaw = row.date_gmt ? `${row.date_gmt.replace(/Z$/, '')}Z` : null;
          candidates.push(candidate(source, row.link, title, utcRaw, { listingUrl: source.entryUrl, discoveryApi: api.href, excerpt: body.slice(0, 240), sourceDateLocal: row.date ?? null, sourceDateGmt: row.date_gmt ?? null }));
        }
        const totalPages = Number(response.headers?.['x-wp-totalpages']);
        if (Number.isSafeInteger(totalPages) && totalPages > 0) coverage.reportedTotalPages = totalPages;
        if (page >= savedPage || savedPage === 2 && page === 1) nextPage = page + 1;
        if (rows.length < perPage || totalPages > 0 && page >= totalPages) { coverage.pagesExhausted = true; nextPage = 2; break; }
      } catch (error) {
        issues.push({ url: api.href, stage: 'listing', error: error.message });
        coverage.paginationComplete = false;
        listingFailed = true;
        if (page === 1 && candidates.length === 0) throw error;
        break;
      }
    }
    if (!coverage.pagesExhausted && coverage.pagesRequested.length >= maxPages) coverage.paginationComplete = false;
    // Failed pages are retried from the last committed cursor. Re-reading
    // successful pages is harmless because the pool deduplicates their URLs.
    return { candidates, issues, coverage: { ...coverage, discovered: candidates.length }, ...(listingFailed ? {} : {nextState:{nextPage}}) };
  }

  // Figure's news page is a statically rendered, date-bearing official index. Its page query is ignored;
  // detect that duplicate behavior and report incomplete pagination rather than inventing page URLs.
  const seen = new Set();
  for (let page = 1; page <= maxPages; page += 1) {
    const pageUrl = page === 1 ? source.entryUrl : `${source.entryUrl}${source.entryUrl.includes('?') ? '&' : '?'}page=${page}`;
    coverage.pagesRequested.push(pageUrl);
    const response = await ctx.http.get(pageUrl);
    const html = response.html ?? response.text;
    assertPage(html, response.url ?? pageUrl);
    const $ = parsed(html, ctx);
    if (!$) throw new Error('HTML parser unavailable');
    const before = candidates.length;
    $('a[href^="/news/"]').each((_, node) => {
      const a = $(node); const url = ctx.html.absolute(a.attr('href'), response.url ?? ROOTS[source.id]);
      if (!url || seen.has(url)) return;
      seen.add(url);
      const titleNode = a.clone(); titleNode.find('time').remove();
      const title = compact(titleNode.text());
      const rawDate = a.find('time[datetime]').first().attr('datetime') ?? a.closest('article,li').find('time[datetime]').first().attr('datetime');
      if (title) candidates.push(candidate(source, url, title, rawDate, { listingUrl: source.entryUrl }));
    });
    if (page > 1 && candidates.length === before) { coverage.paginationComplete = false; coverage.paginationNote = 'page query returned no additional official index entries'; break; }
  }
  // Figure's page query currently repeats the same HTML. Its public XML sitemap is the
  // authoritative URL inventory and exposes two additional current official news pages.
  const sitemapUrl = `${ROOTS[source.id]}/sitemap.xml`;
  try {
    coverage.pagesRequested.push(sitemapUrl);
    const response = await ctx.http.get(sitemapUrl);
    const $ = parsed(response.text, ctx);
    const newsUrls = $ ? $('loc').map((_, node) => compact($(node).text())).get().filter((url) => url.startsWith(`${ROOTS[source.id]}/news/`)) : [];
    let added = 0;
    for (const url of newsUrls) {
      if (seen.has(url)) continue;
      seen.add(url);
      candidates.push(candidate(source, url, idFromUrl(url).replace(/-/g, ' '), null, { listingUrl: sitemapUrl, titlePendingHydration: true }));
      added += 1;
    }
    coverage.sitemap = { url: sitemapUrl, status: response.status, officialNewsUrls: newsUrls.length, additionalCandidates: added };
    coverage.indexPaginationComplete = coverage.paginationComplete;
    coverage.paginationComplete = true;
  } catch (error) {
    coverage.sitemap = { url: sitemapUrl, error: error.message };
    coverage.indexPaginationComplete = coverage.paginationComplete;
    coverage.paginationComplete = false;
    issues.push({ url: sitemapUrl, stage: 'pagination-alternative', error: error.message });
  }
  return { candidates, issues, coverage: { ...coverage, discovered: candidates.length } };
}

export async function hydrate(item, source, ctx) {
  checkSource(source);
  let response;
  let hydrateFallback = null;
  try { response = await ctx.http.get(item.url, { timeoutMs: 30000 }); }
  catch (httpError) {
    if (confirmedAccessRestriction(httpError)) throw httpError;
    // Browser rendering is a normal public-page fallback; challenge pages still fail in articleContent.
    response = await ctx.browser.get(item.url, { timeoutMs: 30000 });
    hydrateFallback = { method: 'browser', httpError: httpError.message };
  }
  const article = articleContent(response, ctx, item.url);
  const originalEvidence = { url: response.url ?? item.url, kind: 'official_announcement', relation: 'original', title: article.title || item.title };
  return {
    sourceId: source.id, channelId: item.channelId ?? 'primary', sourceItemId: item.id,
    title: article.title || item.title, url: item.url,
    publishedAt: article.publishedAt, publishedAtRaw: article.publishedAtRaw, datePrecision: article.datePrecision,
    content: article.content, contentFormat: 'text', evidenceClass: 'official_announcement', evidence: [originalEvidence],
    authors: article.authors, topics: [],
    metadata: { ...item.metadata, ...(hydrateFallback ? { hydrateFallback } : {}), companyStatement: true, independentValidation: 'not established by official announcement' },
    raw: { url: response.url ?? item.url, mediaType: response.headers?.['content-type'] ?? 'text/html', content: response.text },
  };
}
