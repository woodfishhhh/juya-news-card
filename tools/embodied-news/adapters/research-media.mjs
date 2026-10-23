const ROBOTICS = /robot|robotic|embodi|manipulat|locomot|vla|physical intelligence|具身|机器人|机械臂|灵巧手|移动操作/i;
const MEDIA_ROBOTICS = /robot|robotic|humanoid|embodi|manipulat|locomot|vla|physical intelligence|具身|机器人|机械臂|灵巧手|移动操作|autonomous.{0,35}fleet|fleet.{0,35}autonomous|sensor|actuator|physical ai|construction equipment|robot-use|robot use/i;
const PLAIN_AI = /\b(chatgpt|llm|language model|generative ai|text-to-image|copilot)\b/i;
const BLOCKED = /enable javascript|verify you are human|access denied|captcha|sign in to continue/i;
const ROBOT_REPORT_BRAND = /\bthe robot report\b/gi;

const clean = (value = '') => String(value).replace(/<[^>]*>/g, ' ').replace(/&nbsp;|&#160;/gi, ' ').replace(/&amp;/gi, '&').replace(/&#39;|&apos;/gi, "'").replace(/&quot;/gi, '"').replace(/\s+/g, ' ').trim();
const first = (...values) => values.find(value => value != null && String(value).trim()) ?? '';
const roboticsTopicText = (...values) => values.filter(Boolean).map(value => String(value).replace(ROBOT_REPORT_BRAND, ' ')).join(' ');
const isRoboticsTopic = (...values) => MEDIA_ROBOTICS.test(roboticsTopicText(...values));
const hashId = (url) => url.replace(/^https?:\/\//, '').replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-|-$/g, '').toLowerCase();
const isoDate = (value) => {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.valueOf()) ? null : d.toISOString();
};
const precisionOf = (raw) => raw && /\dT\d{2}:\d{2}/.test(raw) ? 'second' : raw && /\d{4}-\d{2}-\d{2}/.test(raw) ? 'day' : 'unknown';
const keyTopics = (text) => {
  const hits = [];
  for (const [re, topic] of [[/VLA|vision.language.action/i, 'VLA'], [/manipulat|grasp|dexter|操作|抓取/i, 'robot-manipulation'], [/locomot|gait|行走|运动控制/i, 'locomotion'], [/simulat|仿真/i, 'simulation'], [/robot|机器人/i, 'robotics'], [/具身/i, 'embodied-intelligence']]) if (re.test(text)) hits.push(topic);
  return [...new Set(hits)];
};
const dateFields = ($) => {
  const raw = first($('meta[name="citation_publication_date"]').attr('content'), $('meta[property="article:published_time"]').attr('content'), $('meta[name="date"]').attr('content'), $('time[datetime]').first().attr('datetime'), $('time').first().text());
  const iso = isoDate(raw);
  return { raw: raw || null, iso, precision: precisionOf(raw) };
};
const nativeDate = (ctx, value) => {
  if (typeof value === 'number' || /^\d{13}$/.test(String(value ?? ''))) {
    const d = new Date(Number(value));
    return Number.isNaN(d.valueOf()) ? ctx.html.date(null) : { publishedAt: d.toISOString(), publishedAtRaw: String(value), datePrecision: 'second' };
  }
  return ctx.html.date(value);
};
function proceedingsAbstract($) {
  let value = '';
  $('b').each((_, el) => {
    if (/^abstract\s*:/i.test(clean($(el).text()))) value = clean($(el).parent().next('p').text());
  });
  return value;
}
function jiqDate(value) {
  const raw = String(value ?? '').trim();
  const match = raw.match(/^(\d{4})[/-](\d{1,2})[/-](\d{1,2})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?$/);
  if (!match) return { publishedAt: null, publishedAtRaw: raw || null, datePrecision: 'unknown' };
  const date = `${match[1]}-${match[2].padStart(2, '0')}-${match[3].padStart(2, '0')}`;
  const time = match[4] ? `T${match[4].padStart(2, '0')}:${match[5]}:${match[6] ?? '00'}+08:00` : 'T00:00:00+08:00';
  const parsed = new Date(`${date}${time}`);
  return Number.isNaN(parsed.valueOf()) ? { publishedAt: null, publishedAtRaw: raw, datePrecision: 'unknown' } : { publishedAt: parsed.toISOString(), publishedAtRaw: raw, datePrecision: match[4] ? 'second' : 'day' };
}

function candidate({ id, url, title, publishedAt, publishedAtRaw, datePrecision, metadata = {}, authors = [] }) {
  return { id, url, title, publishedAt: publishedAt ?? null, publishedAtRaw: publishedAtRaw ?? null, datePrecision: datePrecision ?? 'unknown', channelId: 'primary', metadata, authors };
}

async function fetchHtml(ctx, url, options = {}) {
  let response = await ctx.http.get(url, { timeoutMs: 30000, ...options });
  let html = response.text;
  if (!html || html.length < 1000 || BLOCKED.test(html.slice(0, 1000))) {
    const rendered = await ctx.browser.get(url, { timeoutMs: 30000 });
    response = rendered;
    html = rendered.html ?? rendered.text;
  }
  if (!html || BLOCKED.test(html.slice(0, 1200))) throw new Error(`Unavailable or blocked body: ${url}`);
  return { response, html };
}
async function fetchJson(ctx, url, options = {}) {
  const headers = { Accept: 'application/json', 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36', 'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8', Referer: 'https://www.jiqizhixin.com/articles', 'X-Requested-With': 'XMLHttpRequest', ...options.headers };
  let httpError = null;
  let allowBrowserFallback = true;
  try {
    const response = await ctx.http.get(url, { timeoutMs: 30000, ...options, headers });
    try { return { response, data: JSON.parse(response.text), transport: 'http' }; } catch {}
    const requested = new URL(url);
    const finalUrl = new URL(response.url ?? url);
    if (requested.origin !== finalUrl.origin || requested.pathname !== finalUrl.pathname) {
      httpError = `Public endpoint redirected to a non-JSON page: ${finalUrl.href}`;
      allowBrowserFallback = false;
    }
  } catch (error) { httpError = String(error.message ?? error); }
  if (allowBrowserFallback) {
    try {
      const response = await ctx.browser.get(url, { timeoutMs: 30000, waitMs: 0 });
      const raw = response.html ?? response.text;
      try { return { response, data: JSON.parse(raw), transport: 'browser' }; } catch {}
      const $ = ctx.html.load(raw);
      const pre = $('pre').first().text();
      try { return { response, data: JSON.parse(pre), transport: 'browser' }; } catch {}
    } catch (error) { httpError ??= String(error.message ?? error); }
  }
  throw new Error(`Public endpoint did not return JSON over HTTP or browser${httpError ? ` (HTTP attempt: ${httpError})` : ''}: ${url}`);
}

function linksFrom($, selector, base) {
  return $(selector).toArray().map((el) => {
    const a = $(el).is('a') ? $(el) : $(el).find('a').first();
    const href = a.attr('href');
    if (!href || href.startsWith('#') || href.startsWith('javascript:')) return null;
    try { return { title: clean(a.text()), url: new URL(href, base).href }; } catch { return null; }
  }).filter(x => x?.title && x.url.startsWith('http'));
}

async function discoverCorl(source, ctx) {
  const issues = [];
  const candidates = [];
  const coverage = { entryUrl: source.entryUrl, pages: [], paginationComplete: false, filteredOut: 0, notes: 'CoRL announcement says accepted papers/reviews become public after decisions; use OpenReview public API. One bounded page, maxPages is honored.' };
  const openReview = 'https://api2.openreview.net/notes?content.venueid=robot-learning.org/CoRL/2026/Conference&limit=1000&offset=0';
  const pages = [source.entryUrl, 'https://2026.corl.org/contributions/instruction-for-authors', openReview].slice(0, Math.max(1, ctx.maxPages ?? 3));
  const openReviewAttempted = pages.includes(openReview);
  let notes = [];
  let homeHtml = '';
  for (const url of pages) {
    try {
      const { response: res, data } = url === openReview ? await fetchJson(ctx, openReview) : { response: await ctx.http.get(url, { headers: { Accept: 'application/json,text/html,*/*' }, timeoutMs: 30000 }), data: null };
      coverage.pages.push({ url, status: res.status, bytes: res.text?.length ?? res.html?.length ?? 0, browser: Boolean(res.html), snapshotPath: res.snapshotPath ?? null });
      if (url === source.entryUrl) homeHtml = res.text ?? res.html ?? '';
      if (url === openReview) notes = data.notes ?? [];
    } catch (e) { issues.push({ url, kind: 'listing', error: String(e.message ?? e) }); coverage.pages.push({ url, error: String(e.message ?? e) }); }
  }
  if (homeHtml) {
    const $home = ctx.html.load(homeHtml);
    const rawNow = String(ctx.now ?? new Date().toISOString()).slice(0, 10);
    const announcements = [];
    $home('li').each((_, el) => {
      const line = clean($home(el).text());
      const match = line.match(/^(\d{1,2})\/(\d{1,2})\s*[-–]\s*(.+)$/);
      const anchor = $home(el).find('a[href]').first();
      if (!match || !anchor.length) return;
      const mm = Number(match[1]); const dd = Number(match[2]);
      const day = `${mm.toString().padStart(2, '0')}/${dd.toString().padStart(2, '0')}`;
      const publishedAt = `2026-${day.slice(0, 2)}-${day.slice(3)}T00:00:00.000Z`;
      const isFuture = publishedAt.slice(0, 10) > rawNow;
      const url = new URL(anchor.attr('href'), source.entryUrl).href;
      announcements.push(candidate({ id: `corl-2026-announcement-${hashId(url)}`, url, title: clean(match[3]), publishedAt, publishedAtRaw: `${match[1]}/${match[2]} (dated announcement on official CoRL 2026 homepage)`, datePrecision: 'day', metadata: { itemKind: 'official_announcement', dateSemantics: 'official_dated_announcement', dateSource: source.entryUrl, dateEvidenceText: line, dateEvidenceSnapshotPath: coverage.pages.find(page => page.url === source.entryUrl)?.snapshotPath ?? null, conferenceDates: '2026-11-09/2026-11-12', conferenceDatesSource: source.entryUrl, futureDated: isFuture, qualificationIssue: isFuture ? 'Official date is in the future; retain pending until publication date is reached' : null } }));
    });
    candidates.push(...announcements);
    coverage.announcementCount = announcements.length;
    coverage.announcementDatePolicy = 'The official 2026 homepage provides dated announcement rows; the row month/day inherits the explicit 2026 conference context. Future rows remain pending. Conference dates are separate metadata.';
    coverage.homeAnnouncementsComplete = true;
  }
  coverage.openReviewNotes = notes.length;
  for (const note of notes) {
    const c = note.content ?? {};
    const title = clean(c.title?.value ?? c.title);
    const abstract = clean(c.abstract?.value ?? c.abstract);
    if (!title || !abstract || !ROBOTICS.test(`${title} ${abstract}`) || PLAIN_AI.test(title) && !ROBOTICS.test(abstract)) { coverage.filteredOut++; continue; }
    // CoRL's official author instructions state decisions are announced on 2026-09-04.
    // Keep this public-release date separate from the conference event dates.
    const id = note.id ?? note.number;
    const url = `https://openreview.net/forum?id=${encodeURIComponent(id)}`;
    const authors = (c.authors?.value ?? c.authors ?? []).map(clean).filter(Boolean);
    const pdate = nativeDate(ctx, note.pdate);
    const releaseDate = pdate.publishedAt ? pdate.publishedAt.slice(0, 10) : null;
    const publishedAtRaw = pdate.publishedAt ? pdate.publishedAtRaw : null;
    coverage.paginationComplete = notes.length < 1000;
    const cand = candidate({ id: `corl-2026-${id}`, url, title, publishedAt: pdate.publishedAt, publishedAtRaw, datePrecision: pdate.datePrecision, authors, metadata: { abstract, venue: 'CoRL 2026', conferenceDates: '2026-11-09/2026-11-12', conferenceDatesSource: 'https://2026.corl.org/', openReviewId: id, acceptanceReleaseDate: '2026-09-04', acceptanceReleaseDateSource: 'https://2026.corl.org/contributions/instruction-for-authors', dateSemantics: pdate.publishedAt ? 'openreview_published_at' : 'publication_date_pending' } });
    coverage.paginationComplete = notes.length < 1000;
    candidates.push(cand);
  }
  coverage.discovered = candidates.length;
  const openReviewIssue = issues.find(issue => issue.url === openReview);
  coverage.announcementPaginationComplete = Boolean(homeHtml);
  coverage.acceptedPaperDiscovery = { status: !openReviewAttempted ? 'SKIPPED_PAGE_BUDGET' : openReviewIssue ? 'BLOCKED' : notes.length >= 1000 ? 'INCOMPLETE_LIMIT' : 'LIST_RETURNED', noteCount: openReviewAttempted && !openReviewIssue ? notes.length : null, error: openReviewIssue?.error ?? null };
  coverage.paginationComplete = openReviewAttempted && !openReviewIssue && notes.length < 1000;
  if (openReviewIssue) coverage.paginationIncompleteReason = `Official dated homepage announcements were read, but accepted papers remain incomplete because the OpenReview listing returned ${openReviewIssue.error}.`;
  else if (notes.length >= 1000) coverage.paginationIncompleteReason = 'OpenReview returned the 1000-item cap; offset pagination beyond the first page is not implemented in this bounded adapter.';
  else if (!openReviewAttempted) coverage.paginationIncompleteReason = `maxPages=${ctx.maxPages ?? 3} reached before the OpenReview accepted-paper listing was requested.`;
  return { candidates, issues, coverage };
}

async function discoverProceedings(source, ctx) {
  const issues = [];
  const coverage = { entryUrl: source.entryUrl, pages: [], volumes: [], paginationComplete: false, filteredOut: 0, notes: 'This is Robotics: Science and Systems (RSS), a proceedings archive, not a syndicated RSS feed. Newest available volume plus one preceding volume are bounded by maxPages.' };
  const base = 'https://www.roboticsproceedings.org/';
  const { response, html } = await fetchHtml(ctx, base);
  const $ = ctx.html.load(html);
  const indexLinks = linksFrom($, 'a', response.url ?? base);
  const volumes = indexLinks.filter(x => /\/rss\d+\/(?:index\.html)?$/i.test(x.url) || /\/rss\d+\/$/i.test(x.url));
  const indexText = clean($.text());
  const volumePages = [...new Set(volumes.map(x => x.url))].slice(0, Math.max(1, Math.min(ctx.maxPages ?? 3, 3)));
  coverage.pages.push({ url: response.url ?? base, status: response.status, bytes: html.length });
  const candidates = [];
  for (const volumeUrl of volumePages) {
    try {
      const { response: vres, html: vhtml } = await fetchHtml(ctx, volumeUrl);
      const $v = ctx.html.load(vhtml);
      const papers = linksFrom($v, 'a', vres.url ?? volumeUrl).filter(x => /\/p\d+\.(?:html|pdf)$/i.test(x.url));
      coverage.pages.push({ url: volumeUrl, status: vres.status, bytes: vhtml.length, papers: papers.length });
      coverage.volumes.push({ url: volumeUrl, paperLinks: papers.length });
      const volumeTitle = clean($v('title').text());
      for (const paper of papers) {
        const paperUrl = paper.url.replace(/\.pdf$/i, '.html');
        const roman = volumeTitle.match(/Systems\s+([IVX]+)/i)?.[1];
        const heading = roman ? `Robotics: Science and Systems ${roman}` : '';
        const position = heading ? indexText.indexOf(heading) : -1;
        const volumeSection = position >= 0 ? indexText.slice(position, position + 260) : '';
        const conf = volumeSection.match(/(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2}\s*(?:-|–)\s*(?:(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+)?\d{1,2},?\s*\d{4}/i)?.[0] ?? null;
        candidates.push(candidate({ id: `rss-proceedings-${hashId(paperUrl)}`, url: paperUrl, title: paper.title, publishedAt: null, publishedAtRaw: null, datePrecision: 'unknown', metadata: { venue: 'Robotics: Science and Systems', volumeTitle, conferenceDates: conf, conferenceDatesSource: base, proceedingEntryUrl: volumeUrl, qualificationIssue: 'Publication date and abstract are checked from the official paper page during hydrate' } }));
      }
    } catch (e) { issues.push({ url: volumeUrl, kind: 'volume', error: String(e.message ?? e) }); }
  }
  coverage.paginationComplete = volumePages.length === volumes.length && volumePages.length < (ctx.maxPages ?? 3);
  if (volumePages.length >= (ctx.maxPages ?? 3) && volumes.length > volumePages.length) coverage.paginationIncompleteReason = `maxPages=${ctx.maxPages} reached; ${volumes.length - volumePages.length} older volumes omitted`;
  coverage.discoveredPaperCount = candidates.length;
  coverage.datesDeferredToHydrate = true;
  return { candidates, issues, coverage };
}

const ROBOT_REPORT_FEEDS = [
  'https://www.therobotreport.com/feed/',
  'https://www.therobotreport.com/category/robotics/feed/',
  'https://www.therobotreport.com/robots.txt',
];
async function discoverRobotReport(source, ctx) {
  const issues = [];
  const coverage = { entryUrl: source.entryUrl, priorConfiguredCheckStatus: source.check?.httpStatus ?? null, paginationComplete: false, pages: [], originalEntryFailure: null, fallbackAttempts: [], filteredOut: 0, notes: 'The official WordPress feed and public REST API are tried first; Robot Report article links are kept only with explicit release date and original page access.' };
  const candidates = [];
  let parser;
  try { const Parser = (await import('rss-parser')).default; parser = new Parser(); } catch { parser = null; }
  for (const url of ROBOT_REPORT_FEEDS.slice(0, ctx.maxPages ?? 3)) {
    try {
      const res = await ctx.http.get(url, { headers: { Accept: 'application/rss+xml,application/atom+xml,application/json,text/plain,*/*' }, timeoutMs: 25000 });
      coverage.pages.push({ url, status: res.status, bytes: res.text?.length ?? 0 });
      if (url === source.entryUrl) coverage.originalEntryStatus = res.status;
      if (!parser || !/<(?:rss|feed|rdf:RDF)/i.test(res.text)) continue;
      const feed = await parser.parseString(res.text);
      for (const item of feed.items ?? []) {
        const title = clean(item.title);
        if (!isRoboticsTopic(title, item.contentSnippet ?? '')) { coverage.filteredOut++; continue; }
        const raw = item.isoDate ?? item.pubDate ?? null;
        const date = isoDate(raw);
        const publisherFeedBodyHtml = String(item['content:encoded'] ?? item.content ?? item.contentSnippet ?? '');
        const publisherFeedBodyText = clean(ctx.html.text(publisherFeedBodyHtml));
        const $feedBody = ctx.html.load(publisherFeedBodyHtml);
        const publisherFeedLinks = $feedBody('a[href]').toArray().map(a => ({ title: clean($feedBody(a).text()), url: new URL($feedBody(a).attr('href'), item.link).href })).filter(link => link.url.startsWith('http'));
        candidates.push(candidate({ id: `robot-report-${hashId(item.guid ?? item.link)}`, url: item.link, title, publishedAt: date, publishedAtRaw: raw, datePrecision: date ? precisionOf(raw) : 'unknown', metadata: { summary: clean(item.contentSnippet ?? ''), publisherFeedBodyHtml, publisherFeedBodyText, publisherFeedLinks, feedUrl: url, alternateOriginalFeed: url !== source.entryUrl, qualificationIssue: date ? null : 'No explicit publication date in source item' } }));
      }
      if (candidates.length) break;
    } catch (e) {
      coverage.fallbackAttempts.push({ url, error: String(e.message ?? e) });
      if (url === source.entryUrl) coverage.originalEntryFailure = { status: 403, error: String(e.message ?? e) };
      issues.push({ url, kind: url === source.entryUrl ? 'original-entry' : 'fallback', error: String(e.message ?? e) });
    }
  }
  // Public WordPress JSON endpoint is tested explicitly even if feeds are denied; no credentials.
  try {
    const api = 'https://www.therobotreport.com/wp-json/wp/v2/posts?per_page=20&_fields=date,link,title,excerpt,content';
    const res = await ctx.http.get(api, { headers: { Accept: 'application/json' }, timeoutMs: 25000 });
    coverage.pages.push({ url: api, status: res.status, bytes: res.text?.length ?? 0 });
    const posts = JSON.parse(res.text);
    coverage.apiItemCount = posts.length;
    for (const post of posts) {
      const title = clean(post.title?.rendered);
      const summary = clean(post.excerpt?.rendered);
      if (!ROBOTICS.test(`${title} ${summary}`) || PLAIN_AI.test(title) && !ROBOTICS.test(summary)) { coverage.filteredOut++; continue; }
      const raw = post.date_gmt ? `${post.date_gmt}Z` : post.date;
      const date = isoDate(raw);
      if (!candidates.some(c => c.url === post.link)) candidates.push(candidate({ id: `robot-report-${hashId(post.link)}`, url: post.link, title, publishedAt: date, publishedAtRaw: raw, datePrecision: date ? precisionOf(raw) : 'unknown', metadata: { summary, feedUrl: api, originalApiRecord: true, qualificationIssue: date ? null : 'No explicit publication date in source item' } }));
    }
  } catch (e) { coverage.apiFailure = String(e.message ?? e); issues.push({ url: 'https://www.therobotreport.com/wp-json/wp/v2/posts', kind: 'fallback', error: coverage.apiFailure }); }
  coverage.paginationComplete = false;
  coverage.paginationIncompleteReason = candidates.length ? 'Feed/API cap is bounded; older pages are not enumerated.' : 'No accessible feed or API; no items discovered.';
  return { candidates, issues, coverage };
}

async function discoverJiqizhixin(source, ctx) {
  const issues = [];
  const coverage = { entryUrl: source.entryUrl, pages: [], apiAttempts: [], filteredOut: 0, paginationComplete: false, notes: 'Rendered official article index is tried; only public page/API payloads are used. Generic AI stories are filtered unless the full content is explicitly robotics/embodiment related.' };
  const candidates = [];
  let index;
  try {
    const result = await fetchHtml(ctx, source.entryUrl, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; EmbodiedNews/0.1)' } });
    index = result;
    coverage.pages.push({ url: result.response.url ?? source.entryUrl, status: result.response.status, bytes: result.html.length, rendered: Boolean(result.response.html) });
  } catch (e) { issues.push({ url: source.entryUrl, kind: 'index', error: String(e.message ?? e) }); coverage.indexError = String(e.message ?? e); }
  const apiBase = 'https://www.jiqizhixin.com/api/v1/search/base?keywords=';
  if (index) {
    const $ = ctx.html.load(index.html);
    for (const a of linksFrom($, 'a', index.response.url ?? source.entryUrl)) {
      if (!/jiqizhixin\.com\/(?:articles|news)\//i.test(a.url)) continue;
      if (!ROBOTICS.test(a.title)) { coverage.filteredOut++; continue; }
      candidates.push(candidate({ id: `jiqizhixin-${hashId(a.url)}`, url: a.url, title: a.title, metadata: { discoveredBy: 'official-index' } }));
    }
  }
  const apiTerms = ['具身智能', '机器人', 'VLA'];
  for (const apiTerm of apiTerms.slice(0, ctx.maxPages ?? 3)) {
    const apiUrl = `${apiBase}${encodeURIComponent(apiTerm)}`;
    try {
      const { response: res, data, transport } = await fetchJson(ctx, apiUrl);
      coverage.apiAttempts.push({ url: apiUrl, status: res.status, bytes: res.text?.length ?? res.html?.length ?? 0, via: transport });
      const rows = data.articles?.nodes ?? (Array.isArray(data) ? data : data.articles ?? data.data ?? data.items ?? data.results ?? []);
      for (const row of rows) {
        const title = clean(row.title ?? row.name);
        const url = first(row.path, row.url, row.link, row.canonical_url, row.slug && `https://www.jiqizhixin.com/articles/${row.slug}`);
        const summary = clean(row.content ?? row.body ?? row.description ?? row.abstract ?? row.summary);
        if (!url || !ROBOTICS.test(`${title} ${summary}`) || PLAIN_AI.test(title) && !ROBOTICS.test(summary)) { coverage.filteredOut++; continue; }
        const raw = row.published_at ?? row.publishedAt ?? row.publish_time ?? row.created_at ?? row.date;
        const parsed = jiqDate(raw);
        candidates.push(candidate({ id: `jiqizhixin-${hashId(url)}`, url: new URL(url, source.entryUrl).href, title, publishedAt: parsed.publishedAt, publishedAtRaw: raw || null, datePrecision: parsed.datePrecision, metadata: { summary, apiUrl, apiArticleId: row.id, sourceApiDate: raw || null, qualificationIssue: parsed.publishedAt && !['unknown', 'month', 'year'].includes(parsed.datePrecision) ? null : 'Public article index has no qualifying explicit publication date' } }));
      }
    } catch (e) { coverage.apiAttempts.push({ url: apiUrl, error: String(e.message ?? e) }); }
  }
  const unique = [...new Map(candidates.map(x => [x.url, x])).values()];
  coverage.discovered = unique.length;
  coverage.paginationComplete = false;
  coverage.paginationIncompleteReason = 'The public search API was queried once for each of three robotics-focused terms; additional result pages and the complete article archive are not traversed in this bounded adapter.';
  return { candidates: unique, issues, coverage };
}

export async function discover(source, ctx) {
  if (source.id === 'corl-2026') return discoverCorl(source, ctx);
  if (source.id === 'rss-proceedings') return discoverProceedings(source, ctx);
  if (source.id === 'robot-report-feed') return discoverRobotReport(source, ctx);
  if (source.id === 'jiqizhixin-library') return discoverJiqizhixin(source, ctx);
  throw new Error(`Unsupported research-media source: ${source.id}`);
}

function originalEvidence(sourceId, candidate, bodyTitle) {
  if (sourceId === 'corl-2026' && candidate.metadata.itemKind === 'official_announcement') return [
    { url: candidate.url, kind: 'official_announcement', relation: 'original', title: bodyTitle },
    { url: candidate.metadata.dateSource, kind: 'official_announcement', relation: 'supporting', title: 'Official CoRL 2026 dated announcement list' },
  ];
  if (sourceId === 'corl-2026') return [
    { url: candidate.url, kind: 'paper', relation: 'original', title: bodyTitle },
    { url: 'https://2026.corl.org/contributions/instruction-for-authors', kind: 'official_announcement', relation: 'supporting', title: 'CoRL 2026 decision release date and proceedings policy' },
  ];
  if (sourceId === 'rss-proceedings') return [{ url: candidate.url, kind: 'paper', relation: 'original', title: bodyTitle }];
  const kindFor = (url) => /arxiv\.org/i.test(url) ? 'preprint' : /openreview\.net|roboticsproceedings\.org/i.test(url) ? 'paper' : /github\.com/i.test(url) ? 'repository' : /huggingface\.co/i.test(url) ? 'model_card' : /readthedocs\.io/i.test(url) ? 'project' : 'official_announcement';
  return [
    ...((candidate.metadata.originalEvidenceSnapshots ?? []).map(item => ({ url: item.url, kind: item.kind ?? kindFor(item.url), relation: item.relation ?? 'original', title: item.title }))),
    { url: candidate.url, kind: 'independent_reporting', relation: 'discovery', title: bodyTitle },
  ];
}

const EVIDENCE_LABEL_STOP = new Set(['a','an','and','as','at','by','for','from','in','is','it','of','on','or','the','to','with','according','said','company','source','website','official','here','click','read','more','learn','about','price','tag','register','now','buy','download','prospectus','warehouse','automated','storage','asrs','manufacturing','factory','industry','industrial','robotics','robot','humanoid','sensor','system','platform','technology','report','reports','news','services','solutions','product','products','design']);
const BLOCKED_LINK_HOST = /(?:linkedin\.com|facebook\.com|instagram\.com|twitter\.com|x\.com|youtube\.com|youtu\.be|cvent\.me|robobusiness\.com|eventbrite\.)/i;
const TRACKING_PARAM = /^(?:utm_.+|_gl|gclid|fbclid|mc_.+)$/i;
const ROBOTICS_SOURCE_PAGE = /robot|robotic|humanoid|embodi|vla|autonomous.{0,35}fleet|fleet.{0,35}autonomous|sensor|actuator|physical ai|construction equipment|robot-use|robot use/i;
const NON_ROBOTICS_APPLICATION_PAGE = /\b(?:vfx|entertainment|film|video games|gaming|animation)\b/i;
function cleanLinkUrl(raw, base) {
  try {
    const url = new URL(raw, base);
    if (!/^https?:$/.test(url.protocol)) return null;
    for (const key of [...url.searchParams.keys()]) if (TRACKING_PARAM.test(key)) url.searchParams.delete(key);
    url.hash = '';
    return url.href;
  } catch { return null; }
}
function usefulEvidenceLink(link, mediaHost) {
  const url = cleanLinkUrl(link.url, link.base);
  if (!url) return null;
  const parsed = new URL(url);
  if (parsed.hostname === mediaHost || parsed.hostname.endsWith(`.${mediaHost}`) || BLOCKED_LINK_HOST.test(parsed.hostname)) return null;
  const segments = parsed.pathname.split('/').filter(Boolean);
  if (/\/(?:category|tag|author|search|wp-content|login|cart|checkout)(?:\/|$)/i.test(parsed.pathname)) return null;
  const text = clean(link.title);
  const tokens = (text.toLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}-]{2,}/gu) ?? []).filter(token => !EVIDENCE_LABEL_STOP.has(token));
  if (!text || !tokens.length || text.length < 3) return null;
  return { title: text, url, tokens, isRoot: !segments.length };
}
function evidenceKind(url) {
  if (/arxiv\.org/i.test(url)) return 'preprint';
  if (/openreview\.net|roboticsproceedings\.org/i.test(url)) return 'paper';
  if (/github\.com/i.test(url)) return 'repository';
  if (/huggingface\.co/i.test(url)) return 'model_card';
  if (/readthedocs\.io/i.test(url)) return 'project';
  return /\/(?:news|press|announcements?|blog)\//i.test(new URL(url).pathname) ? 'official_announcement' : 'project';
}
async function retrieveBrandedOriginal(ctx, link, mediaHost) {
  const candidateLink = usefulEvidenceLink(link, mediaHost);
  if (!candidateLink) return null;
  const inspect = async (url, sourceAnchorText, followedAnchorText = null) => {
    try {
      const page = await fetchHtml(ctx, url);
      const article = ctx.html.article(page.html, page.response.url ?? url);
      const title = clean(first(article.title, ctx.html.load(page.html)('title').text()));
      const text = clean(first(article.content, ctx.html.text(page.html)));
      if (text.length < 80) return null;
      const pageIdentity = `${title} ${new URL(url).pathname}`;
      if (/\b(?:terms|conditions|privacy|cookie|biography|books?|author profile|careers?|contact us)\b/i.test(pageIdentity) || /\/books?\//i.test(new URL(url).pathname)) return null;
      const searchable = `${title} ${text}`.toLowerCase();
      const matched = candidateLink.tokens.filter(token => searchable.includes(token));
      if (!matched.length) return null;
      const titleMatched = candidateLink.tokens.filter(token => title.toLowerCase().includes(token));
      const bodyMatched = candidateLink.tokens.filter(token => text.toLowerCase().includes(token));
      const titleMatchThreshold = candidateLink.tokens.length > 1 ? 2 : 1;
      const bodyMatchThreshold = candidateLink.tokens.length > 1 ? candidateLink.tokens.length - 1 : 1;
      if (titleMatched.length < titleMatchThreshold || bodyMatched.length < bodyMatchThreshold) return null;
      const pageHost = new URL(url).hostname.toLowerCase();
      const hostTokens = pageHost.split('.').flatMap(part => part.split(/[-_]/)).filter(part => part.length >= 4);
      const hostBrandMatch = candidateLink.tokens.some(token => hostTokens.some(hostToken => hostToken.includes(token) || token.includes(hostToken)));
      if (!hostBrandMatch && !matched.some(token => title.toLowerCase().includes(token))) return null;
      const identity = `${title} ${new URL(url).pathname}`;
      const relation = ROBOTICS_SOURCE_PAGE.test(`${title} ${text}`) && !NON_ROBOTICS_APPLICATION_PAGE.test(identity) ? 'original' : 'supporting';
      return { url, title, content: text, kind: evidenceKind(url), relation, sourceAnchorText, followedAnchorText };
    } catch { return null; }
  };
  const directPath = !candidateLink.isRoot;
  if (directPath) return await inspect(candidateLink.url, candidateLink.title);
  // A named company link to its root can discover the company's specific product page, but the homepage itself is never accepted as original evidence.
  try {
    const root = await fetchHtml(ctx, candidateLink.url);
    const $ = ctx.html.load(root.html);
    const host = new URL(candidateLink.url).hostname;
    const internal = $('a[href]').toArray().map(el => ({ title: clean($(el).text()), url: cleanLinkUrl($(el).attr('href'), candidateLink.url) })).filter(item => {
      if (!item.url || new URL(item.url).hostname !== host) return false;
      const path = new URL(item.url).pathname;
      if (!path.split('/').filter(Boolean).length || /\/(?:category|tag|author|search|careers?|contact|login|cart|checkout|privacy|terms)(?:\/|$)/i.test(path)) return false;
      return /product|system|technology|dev|model|platform|solution|sensor|robot|mobius/i.test(`${item.title} ${path}`);
    }).slice(0, 4);
    for (const item of internal) {
      const validated = await inspect(item.url, candidateLink.title, item.title);
      if (validated) return validated;
    }
  } catch {}
  return null;
}

export async function hydrate(candidate, source, ctx) {
  if (!candidate?.url || !candidate.title) throw new Error('Candidate is missing its URL or title');
  if (!['corl-2026', 'rss-proceedings'].includes(source.id) && (!candidate.publishedAt || ['unknown', 'month', 'year'].includes(candidate.datePrecision))) throw new Error(`No explicit qualifying publication date: ${candidate.url}`);
  if (source.id === 'robot-report-feed' && !isRoboticsTopic(candidate.title, candidate.metadata?.summary, candidate.metadata?.publisherFeedBodyText)) throw new Error(`Media candidate is not robotics-related beyond its publisher brand: ${candidate.url}`);
  let response;
  let html;
  let articlePageError = null;
  try { ({ response, html } = await fetchHtml(ctx, candidate.url)); }
  catch (error) {
    articlePageError = String(error.message ?? error);
    if (source.id !== 'robot-report-feed' || !candidate.metadata?.publisherFeedBodyHtml) throw error;
    html = candidate.metadata.publisherFeedBodyHtml;
    response = { text: html, url: candidate.metadata.feedUrl, status: 200, headers: { 'content-type': 'application/rss+xml' } };
    candidate.metadata.contentSource = 'publisher_official_feed_item';
    candidate.metadata.articlePageFetchFailure = articlePageError;
  }
  const $ = ctx.html.load(html);
  let title = clean(first($('meta[name="citation_title"]').attr('content'), $('meta[property="og:title"]').attr('content'), $('h1').first().text(), candidate.title));
  let content = '';
  let mediaType = 'text/html';
  let authors = candidate.authors ?? [];
  if (source.id === 'corl-2026' && candidate.metadata.itemKind === 'official_announcement') {
    const article = ctx.html.article(html, response.url ?? candidate.url);
    title = clean(first(article.title, candidate.title));
    const googleSitesContent = $('.tyJCtd').toArray().map(el => clean(ctx.html.text($(el).html()))).filter(text => text && !/^(?:skip to|search this site|navigation)$/i.test(text)).join('\n\n');
    content = clean(first(googleSitesContent, $('main').text(), article.content, $('article').text()));
    candidate.metadata.dateSemantics = 'official_dated_announcement';
    if (candidate.metadata.futureDated) throw new Error(`Future dated CoRL notice remains pending: ${candidate.url}`);
  } else if (source.id === 'corl-2026') {
    const abstract = clean(first($('meta[name="citation_abstract"]').attr('content'), $('meta[name="description"]').attr('content'), candidate.metadata.abstract));
    const forum = candidate.metadata.openReviewId;
    const detailUrl = `https://api2.openreview.net/notes?id=${encodeURIComponent(forum)}`;
    const { data: detail } = await fetchJson(ctx, detailUrl);
    const note = detail.notes?.[0];
    const c = note?.content ?? {};
    title = clean(first(c.title?.value, title));
    content = clean(first(c.abstract?.value, abstract));
    authors = (c.authors?.value ?? authors).map(clean).filter(Boolean);
    mediaType = 'application/json';
    if (!note) throw new Error(`OpenReview paper body unavailable: ${candidate.url}`);
    const published = nativeDate(ctx, note.pdate);
    if (!published.publishedAt || ['unknown', 'month', 'year'].includes(published.datePrecision)) throw new Error(`OpenReview does not expose a per-paper publication date; acceptance notice date remains separate: ${candidate.url}`);
    candidate.publishedAt = published.publishedAt;
    candidate.publishedAtRaw = published.publishedAtRaw;
    candidate.datePrecision = published.datePrecision;
    candidate.metadata.dateSemantics = 'openreview_published_at';
  } else if (source.id === 'rss-proceedings') {
    const proceedingsPaperAbstract = proceedingsAbstract($);
    content = clean(first($('meta[name="citation_abstract"]').attr('content'), $('meta[name="description"]').attr('content'), proceedingsPaperAbstract));
    authors = $('meta[name="citation_author"]').map((_,el)=>clean($(el).attr('content'))).get().filter(Boolean);
    title = clean(first($('meta[name="citation_title"]').attr('content'), title));
    const publication = ctx.html.date($('meta[name="citation_publication_date"]').attr('content'));
    if (!publication.publishedAt || ['unknown', 'month', 'year'].includes(publication.datePrecision)) throw new Error(`Proceedings paper has no explicit publication date; conference dates stay metadata only: ${candidate.url}`);
    candidate.publishedAt = publication.publishedAt;
    candidate.publishedAtRaw = publication.publishedAtRaw;
    candidate.datePrecision = publication.datePrecision;
    candidate.metadata.dateSemantics = 'citation_publication_date';
  } else {
    if (source.id === 'robot-report-feed') {
      const article = ctx.html.article(html, response.url ?? candidate.url);
      title = clean(first(article.title, title));
      content = clean(first(article.content, $('article').text(), $('main').text()));
      authors = article.authors?.length ? article.authors : authors;
      if ((!content || content.length < 120 || BLOCKED.test(content.slice(0, 400))) && candidate.metadata.publisherFeedBodyText?.length >= 120) {
        content = candidate.metadata.publisherFeedBodyText;
        candidate.metadata.contentSource = 'publisher_official_feed_item';
      }
      if (articlePageError) candidate.metadata.articlePageFetchFailure = articlePageError;
      const linked = [...(article.links ?? []), ...(candidate.metadata.publisherFeedLinks ?? [])];
      const mediaHost = new URL(candidate.url).hostname.replace(/^www\./i, '');
      const unique = [...new Map(linked.map(link => {
        const url = cleanLinkUrl(link.url, candidate.url);
        return url ? [url, { title: link.title, url }] : null;
      }).filter(Boolean)).values()];
      const checked = unique.map(link => ({ link, candidate: usefulEvidenceLink(link, mediaHost) })).filter(item => item.candidate).sort((a,b) => {
        const titleTokens = (candidate.title.toLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}-]{2,}/gu) ?? []).filter(token => !EVIDENCE_LABEL_STOP.has(token));
        const score = item => titleTokens.filter(token => item.candidate.title.toLowerCase().includes(token) || new URL(item.candidate.url).hostname.toLowerCase().includes(token)).length;
        return score(b) - score(a);
      });
      const verified = [];
      for (const item of checked.slice(0, 10)) {
        const evidence = await retrieveBrandedOriginal(ctx, item.link, mediaHost);
        if (evidence) verified.push(evidence);
      }
      if (!verified.some(item => item.relation === 'original')) throw new Error(`Media candidate is pending original robotics/company evidence: ${candidate.url}`);
      candidate.metadata.originalEvidence = verified.map(item => item.url);
      candidate.metadata.originalEvidenceSnapshots = verified;
    } else {
    if (source.id === 'jiqizhixin-library' && candidate.metadata?.apiArticleId) {
      const detailUrl = `https://www.jiqizhixin.com/api/article_library/articles/${encodeURIComponent(candidate.metadata.apiArticleId)}.json`;
      const { response: detailResponse, data: detail } = await fetchJson(ctx, detailUrl);
      title = clean(first(detail.title, title));
      const articleHtml = String(detail.content ?? '');
      const $content = ctx.html.load(articleHtml);
      content = clean($content.root().text());
      authors = [clean(detail.author?.name ?? detail.author)].filter(Boolean);
      const articleDate = jiqDate(detail.published_at ?? candidate.metadata.sourceApiDate);
      if (!articleDate.publishedAt || ['unknown', 'month', 'year'].includes(articleDate.datePrecision)) throw new Error(`Official article detail has no exact publication date: ${candidate.url}`);
      candidate.publishedAt = articleDate.publishedAt;
      candidate.publishedAtRaw = detail.published_at ?? candidate.metadata.sourceApiDate;
      candidate.datePrecision = articleDate.datePrecision;
      mediaType = 'application/json';
      const officialLinks = $content('a[href]').toArray().map(el => $content(el).attr('href')).filter(Boolean).map(url => new URL(url, candidate.url).href);
      const inlineUrls = [...articleHtml.matchAll(/(?:github\.com\/[A-Za-z0-9._/-]+|[A-Za-z0-9-]+\.readthedocs\.io(?:\/[A-Za-z0-9._/-]+)?)/gi)].map(match => `https://${match[0].replace(/[.,;:!?]+$/, '')}`);
      const approved = [...new Set([...officialLinks, ...inlineUrls])].filter(url => /(?:arxiv\.org|openreview\.net|roboticsproceedings\.org|github\.com|huggingface\.co|unitree\.com|figure\.ai|limxdynamics\.com|galbot\.com|agibot\.com|deepmind\.google|nvidia\.com|pi\.website|readthedocs\.io)/i.test(url)).slice(0, 4);
      candidate.metadata.originalEvidence = approved;
      candidate.metadata.detailApiUrl = detailUrl;
    }
    const article = ctx.html.article(html, response.url ?? candidate.url);
    title = clean(first(source.id === 'jiqizhixin-library' ? '' : article.title, title));
    content = clean(first(source.id === 'jiqizhixin-library' ? '' : article.content, content, $('article').text(), $('main').text()));
    authors = source.id === 'jiqizhixin-library' ? authors : article.authors?.length ? article.authors : authors;
    // Re-confirm original-evidence URLs are publicly retrievable and contain actual content.
    const links = article.links ?? [];
    const acceptedDomains = /(?:arxiv\.org|openreview\.net|roboticsproceedings\.org|github\.com|huggingface\.co|deepmind\.google|nvidia\.com|unitree\.com|figure\.ai|limxdynamics\.com|galbot\.com|agibot\.com|bostondynamics\.com|pi\.website)/i;
    const mediaEvidence = [...new Set([...(candidate.metadata.originalEvidence ?? []), ...links.map(l => l.url).filter(url => acceptedDomains.test(url) && url !== candidate.url)])].slice(0, 4);
    if ((source.id === 'robot-report-feed' || source.id === 'jiqizhixin-library') && !mediaEvidence.length) throw new Error(`Media candidate is pending original evidence: ${candidate.url}`);
    const verifiedEvidence = [];
    const evidenceSnapshots = [];
    for (const evidenceUrl of mediaEvidence) {
      try {
        const ev = await fetchHtml(ctx, evidenceUrl);
        const evidenceText = clean(ctx.html.article(ev.html, evidenceUrl).content || ctx.html.text(ev.html));
        if (evidenceText.length >= 80) {
          verifiedEvidence.push(evidenceUrl);
          evidenceSnapshots.push({ url: evidenceUrl, title: clean(ctx.html.article(ev.html, evidenceUrl).title), content: evidenceText });
        }
      } catch (error) { (candidate.metadata.failedOriginalEvidence ??= []).push({ url: evidenceUrl, error: String(error.message ?? error) }); }
    }
    if ((source.id === 'robot-report-feed' || source.id === 'jiqizhixin-library') && !verifiedEvidence.length) throw new Error(`Media candidate remains pending: no original evidence page with retrieved body (${candidate.url})`);
    candidate.metadata.originalEvidence = verifiedEvidence;
    candidate.metadata.originalEvidenceSnapshots = evidenceSnapshots;
    }
  }
  if (!content || content.length < 80 || BLOCKED.test(content.slice(0, 400))) throw new Error(`Actual page body/abstract unavailable: ${candidate.url}`);
  if ((source.id === 'robot-report-feed' || source.id === 'jiqizhixin-library') && content.length < 120) throw new Error(`Media article body too short: ${candidate.url}`);
  return {
    sourceId: source.id, channelId: candidate.channelId ?? 'primary', sourceItemId: candidate.id,
    title, url: candidate.url, publishedAt: candidate.publishedAt, publishedAtRaw: candidate.publishedAtRaw,
    datePrecision: candidate.datePrecision, content, contentFormat: 'text',
    evidenceClass: source.id === 'corl-2026' && candidate.metadata.itemKind === 'official_announcement' ? 'official_announcement' : source.id === 'corl-2026' || source.id === 'rss-proceedings' ? 'paper' : 'independent_reporting',
    evidence: originalEvidence(source.id, candidate, title), authors, topics: keyTopics(`${title} ${content}`),
    metadata: { ...candidate.metadata, conferenceDates: candidate.metadata.conferenceDates ?? null },
    raw: { url: response.url ?? candidate.url, mediaType: candidate.metadata.contentSource === 'publisher_official_feed_item' ? 'application/rss+xml' : mediaType, content: response.text },
  };
}
