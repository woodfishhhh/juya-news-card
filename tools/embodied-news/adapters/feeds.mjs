import Parser from 'rss-parser';
import {withFeedIntake} from '../lib/feed-intake.mjs';

const parser = new Parser({ timeout: 25000, headers: { 'User-Agent': 'EmbodiedNewsCollector/0.1 (+local research digest)' }, customFields: { item: [['content:encoded', 'contentEncoded'], ['dc:creator', 'creator']] } });

const ROBOTICS = /robot|robotic|embodi|vla|manipulat|humanoid|locomot|teleoperat|grasp|dexter|isaac|lerobot|groot|openpi|physical intelligence|具身|机器人|机械臂|灵巧手|人形|操作|仿真|运动控制|导航/i;
const ROBOTICS_RESEARCH = /robot|robotic|embodi|manipulat|humanoid|locomot|teleoperat|grasp|dexter|具身|机器人|机械臂|灵巧手|人形|操作|运动控制|导航/i;
const BROAD_FEEDS = new Set(['deepmind-feed', 'nvidia-developer-feed']);
export const FOCUSED_BROAD_FEEDS = new Set(['publisher-amazon-science','publisher-mit-news','publisher-nvidia-blog','publisher-nvidia-research','publisher-nsf','publisher-rss-nist']);
const ROBOT_TITLE = /\b(?:robots?|robotics?|robotic|humanoids?|embodied?|vlas?|physical ai|groot|lerobot|openpi)\b|具身|机器人|机械臂|灵巧手|人形/i;
const TECHNICAL_ROBOT_CONTEXT = /\b(?:robot(?:ic)?\s+(?:arm|control|policy|manipulation|navigation|locomotion|learning|training|simulation|system|model|hardware|workload|dataset|task|grasp)|robotics\s+(?:workloads?|simulation|benchmark|hardware|training|data|systems?|models?|control|policies|manipulation|navigation|locomotion|tasks?))\b|机械臂|灵巧手|机器人(?:控制|策略|操作|导航|训练|仿真|数据集|模型)/i;
const QBIT_FINANCIAL_ROUNDUP = /(?:36家|机器人公司|上市机器人|财报).*(?:机器人|公司|商业化)|(?:机器人|公司).*(?:36家|上市|财报|敲钟)/i;
const MONTH_NAMES = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
const GITHUB_API = {
  'lerobot-releases': 'https://api.github.com/repos/huggingface/lerobot/releases?per_page=10',
  'groot-releases': 'https://api.github.com/repos/NVIDIA/Isaac-GR00T/releases?per_page=10',
  'isaaclab-releases': 'https://api.github.com/repos/isaac-sim/IsaacLab/releases?per_page=10',
  'openpi-releases': 'https://api.github.com/repos/Physical-Intelligence/openpi/releases?per_page=10',
};
const OPENPI_COMMIT_API = 'https://api.github.com/repos/Physical-Intelligence/openpi/commits?per_page=10';
async function parseFeed(text) {
  return new Promise((resolve, reject) => parser.parseString(text, (error, feed) => error ? reject(error) : resolve(feed)));
}

function first(...values) { return values.find((v) => typeof v === 'string' && v.trim())?.trim() ?? ''; }
function dateOnlyParts(raw) {
  const s = String(raw ?? '').trim();
  let match = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (match) return { year: Number(match[1]), month: Number(match[2]) - 1, day: Number(match[3]) };
  const noWeekday = s.replace(/^(?:sun(?:day)?|mon(?:day)?|tue(?:sday)?|wed(?:nesday)?|thu(?:rsday)?|fri(?:day)?|sat(?:urday)?)\.?\s*,?\s+/i, '');
  match = noWeekday.match(/^(\d{1,2})\s+([a-z]+),?\s+(\d{4})$/i)
    ?? noWeekday.match(/^([a-z]+)\s+(\d{1,2}),?\s+(\d{4})$/i);
  if (!match) return null;
  const dayFirst = /^\d/.test(match[1]);
  const day = Number(dayFirst ? match[1] : match[2]);
  const monthName = (dayFirst ? match[2] : match[1]).toLowerCase();
  const month = MONTH_NAMES.findIndex((name) => name === monthName || name.slice(0, 3) === monthName);
  if (month < 0) return null;
  return { year: Number(match[3]), month, day };
}
function monthOnly(raw) {
  const match = String(raw ?? '').trim().match(/^([a-z]+)\s+(\d{4})$/i);
  if (!match) return false;
  const name = match[1].toLowerCase();
  return MONTH_NAMES.some((month) => month === name || month.slice(0, 3) === name);
}
function precision(raw) {
  if (!raw) return 'unknown';
  const s = String(raw).trim();
  if (/^\d{4}$/.test(s)) return 'year';
  if (/^\d{4}-\d{2}$/.test(s)) return 'month';
  if (monthOnly(s)) return 'month';
  if (dateOnlyParts(s)) return 'day';
  // Do not let Date.parse interpret an unzoned wall-clock value in the host's
  // local timezone. Feed timestamps should carry their published offset.
  const hasClock = /(?:T|\s)\d{1,2}:\d{2}(?::\d{2}(?:\.\d+)?)?/i.test(s);
  const hasZone = /(?:\b(?:GMT|UTC|UT)\b|[zZ]|[+-]\d{2}:?\d{2})\s*$/i.test(s);
  if (!hasZone) return 'unknown';
  return Number.isFinite(Date.parse(s)) ? 'second' : 'unknown';
}
function toIso(raw) {
  if (!raw || precision(raw) === 'unknown' || precision(raw) === 'year' || precision(raw) === 'month') return null;
  const day = dateOnlyParts(raw);
  if (day) {
    const d = new Date(Date.UTC(day.year, day.month, day.day));
    if (d.getUTCFullYear() !== day.year || d.getUTCMonth() !== day.month || d.getUTCDate() !== day.day) return null;
    return d.toISOString();
  }
  const d = new Date(raw);
  return Number.isNaN(d.valueOf()) ? null : d.toISOString();
}
function clean(html, ctx) {
  const s = ctx.html.text(html ?? '').replace(/\s+/g, ' ').trim();
  return s;
}
export function evaluateRelevance(sourceId, title, content) {
  const safeTitle = String(title ?? '');
  if (FOCUSED_BROAD_FEEDS.has(sourceId)) {
    const eligible=ROBOT_TITLE.test(safeTitle) || /\b(?:prosthetic|haptic|exoskeleton|dexterous|locomotion|robotx|robosub)\b/i.test(safeTitle);
    return {eligible,reason:eligible ? 'Robotics or embodied hardware is the main headline topic' : 'Whole-site feed headline is not a robotics event'};
  }
  if (sourceId === 'hub-zhuoqing') {
    const eligible=/机器人|智能车|电赛|电子设计|机械臂|电机|单片机|嵌入式|传感器|自动控制|运动控制|电路|示波器|模数转换|数模转换|\b(?:robot|robotics|FOC|PID|STM32|FPGA|RoboMaster|RoboCup)\b/i.test(safeTitle);
    return {eligible,reason:eligible ? 'Concrete robotics or hardware topic in engineering author headline' : 'General AI coursework is not robotics news'};
  }
  const summary = String(content ?? '');
  if (sourceId === 'qbitai-feed' && QBIT_FINANCIAL_ROUNDUP.test(safeTitle)) {
    return { eligible: false, reason: 'broad robotics-company financial roundup without a discrete embodied technology or deployment event' };
  }
  // These feeds are attached to repositories whose sole project is robotics/embodied AI;
  // a terse tag title such as "n1.7 release" still belongs to that robotics project.
  if (['lerobot-releases', 'groot-releases', 'isaaclab-releases', 'openpi-releases'].includes(sourceId)) {
    return { eligible: true, reason: 'dedicated robotics project release source' };
  }
  const text = `${safeTitle} ${summary}`;
  const matcher = sourceId === 'arxiv-cs-ro' ? ROBOTICS_RESEARCH : ROBOTICS;
  if (!matcher.test(text)) return { eligible: false, reason: 'no recognized embodied robotics topic in title or source text' };
  // These are whole-site feeds. A passing mention of robotics in an education
  // announcement or generic edge-agent benchmark is not enough by itself.
  // Require robotics in the headline or a technical robot-specific context.
  if (BROAD_FEEDS.has(sourceId) && ROBOT_TITLE.test(safeTitle)) {
    return { eligible: true, reason: 'robotics is in the headline of a whole-site feed item' };
  }
  if (BROAD_FEEDS.has(sourceId) && !TECHNICAL_ROBOT_CONTEXT.test(summary)) {
    return { eligible: false, reason: 'whole-site feed has only incidental robotics mentions, without robot-specific technical context' };
  }
  return { eligible: true, reason: 'recognized embodied robotics topic in source text' };
}

export function evaluateSourceRelevance(source, title, content) {
  if (source.topicScope === 'robotics-project') return {eligible:true,reason:'Dedicated robotics project'};
  if (source.topicScope === 'engineering' && /电机|伺服|减速器|丝杠|编码器|力矩|触觉|力觉|单片机|电路|固件|嵌入式|开源硬件|机械设计|\b(?:motor|servo|encoder|actuator|microcontroller|firmware|PCB|FPGA|STM32|FOC|PID)\b/i.test(`${title ?? ''} ${content ?? ''}`)) return {eligible:true,reason:'Hardware engineering topic from a scoped publisher'};
  return evaluateRelevance(source.id,title,content);
}
function isEligible(source, item) {
  if (source.topicScope === 'robotics-project') return true;
  const articleText = clean(item.contentEncoded ?? item.content ?? '', { html: { text: (x) => x.replace(/<[^>]*>/g, ' ') } });
  const summary = `${item.contentSnippet ?? ''} ${articleText}`;
  const relevance = evaluateSourceRelevance(source, item.title, summary);
  // Keep this known roundup in the durable candidate queue so it remains
  // visible as excluded/pending rather than disappearing during discovery.
  return relevance.eligible || (source.id === 'qbitai-feed' && QBIT_FINANCIAL_ROUNDUP.test(item.title ?? ''));
}
function idFor(source, item) {
  if (source.id === 'arxiv-cs-ro') return (item.link?.match(/abs\/([^?#]+)/)?.[1] ?? item.guid ?? item.link ?? item.title).replace(/v\d+$/, '');
  return item.guid ?? item.id ?? item.link ?? item.title;
}
// Preserve the publisher's original timestamp (including its explicit offset)
// rather than using rss-parser's pre-normalized isoDate as the raw evidence.
function parseDate(item) { return first(item.pubDate, item.published, item.updated, item['dc:date'], item.isoDate); }
function channelFor(item) {
  const links = item.link ? [item.link] : [];
  return { links, authors: [first(item.creator, item.author)].filter(Boolean) };
}
function rssCandidate(source, item) {
  const raw = parseDate(item);
  const link = first(item.link, item.guid);
  let itemTitle = first(item.title, link);
  if (source.id.endsWith('-releases')) {
    itemTitle = itemTitle.replace(/^Release notes from [^:]+:\s*/i, '').replace(/^Release\s+/, '').replace(/\s+·\s+[^·]+$/, '');
    itemTitle = `Release ${itemTitle}`;
  }
  const candidate = {
    id: `${source.id}:${idFor(source, item)}`, url: link, title: itemTitle,
    publishedAt: toIso(raw), publishedAtRaw: raw || null, datePrecision: source.feedDatePrecision === 'day' ? 'day' : precision(raw), channelId: 'primary',
    metadata: { feedId: source.id, feedUrl: source.entryUrl, feedGuid: item.guid ?? null, summary: first(item.contentSnippet, item.contentEncoded, item.content), authors: channelFor(item).authors, feedLinks: linksFor(item), sourceRole: source.role },
  };
  if (source.id === 'qbitai-feed' && QBIT_FINANCIAL_ROUNDUP.test(candidate.title)) {
    candidate.metadata.eligibility = 'excluded_financial_roundup';
    candidate.metadata.exclusionReason = 'Broad market/financial roundup without a discrete embodied technology, project or deployment event.';
  }
  return candidate;
}
function linksFor(item) { return [item.link, ...(item.enclosure?.url ? [item.enclosure.url] : [])].filter(Boolean); }
function ghCandidate(source, item, feedUrl) {
  const raw = item.published_at ?? item.created_at;
  return {
    id: `${source.id}:${item.id ?? item.tag_name}`, url: item.html_url, title: first(item.name, item.tag_name),
    publishedAt: toIso(raw), publishedAtRaw: raw ?? null, datePrecision: precision(raw), channelId: 'primary',
    metadata: { feedId: source.id, feedUrl, fallback: 'github-rest-api', releaseTag: item.tag_name, summary: item.body ?? '', sourceRole: source.role },
  };
}
function githubNextPage(response, page, count, pageSize) {
  const link = response.headers?.link ?? response.headers?.Link ?? '';
  const nextHref = String(link).match(/<([^>]+)>\s*;\s*rel="?next"?/i)?.[1];
  if (nextHref) {
    try {
      const next = Number(new URL(nextHref).searchParams.get('page'));
      if (Number.isSafeInteger(next) && next > page) return next;
    } catch { /* fall through to the bounded page-size signal */ }
  }
  return count >= pageSize ? page + 1 : null;
}
function githubPagePlan(savedPage, savedPhase, budget) {
  if (savedPage <= 1) return Array.from({ length: budget }, (_, index) => ({ page: index + 1, role: index ? 'continuation' : 'cursor' }));
  const steps = [];
  let phase = ['head', 'overlap', 'cursor', 'scan'].includes(savedPhase) ? savedPhase : 'head';
  let scanPage = savedPage + 1;
  while (steps.length < budget) {
    if (phase === 'head') {
      steps.push({ page: 1, role: 'head' });
      phase = 'overlap';
    } else if (phase === 'overlap') {
      const overlapPage = savedPage - 1;
      if (overlapPage === 1 && steps.some((step) => step.page === 1)) { phase = 'cursor'; continue; }
      steps.push({ page: overlapPage, role: 'overlap' });
      phase = 'cursor';
    } else if (phase === 'cursor') {
      steps.push({ page: savedPage, role: 'cursor' });
      phase = 'scan';
    } else {
      steps.push({ page: scanPage++, role: 'continuation' });
    }
  }
  return steps;
}
function roundupEvidenceUrl(value, base) {
  const href = ctxSafeAbsolute(value, base);
  if (!href) return false;
  const url = new URL(href);
  const host = url.hostname.replace(/^www\./, '');
  if (/spectrum\.ieee\.org|robotsguide\.com|youtube\.com|youtu\.be|twitter\.com|x\.com|facebook\.com|linkedin\.com|instagram\.com/i.test(host)) return false;
  if (url.pathname === '/' || /\/(?:publications|news-and-media|about|careers)\/?$/i.test(url.pathname)) return false;
  return /arxiv\.org\/abs\/|github\.com\/[^/]+\/[^/]+|\.github\.io\/[^/]+|\.edu(?:\.|\/)|\.ac\.|\.pdf$/i.test(`${host}${url.pathname}`)
    || url.pathname.split('/').filter(Boolean).length >= 2;
}
function ctxSafeAbsolute(value, base) { try { const url = new URL(value, base); return /^https?:$/.test(url.protocol) ? url.href : null; } catch { return null; } }
function segmentSlug(value) { return String(value || 'segment').normalize('NFKD').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 48) || 'segment'; }
async function expandIeeeRoundup(candidate, source, ctx) {
  const response = await ctx.http.get(candidate.url, { timeoutMs: 30000 });
  const $ = ctx.html.load(response.text);
  const body = $('.article_post--body-and-tags').first();
  if (!body.length) return [];
  const segments = [];
  body.find('p').each((_, el) => {
    const paragraph = $(el);
    paragraph.find('a[href]').each((__, anchor) => {
      const href = ctx.html.absolute($(anchor).attr('href'), response.url ?? candidate.url);
      if (!href || !roundupEvidenceUrl(href, candidate.url)) return;
      const quote = paragraph.prevAll('blockquote.rm-anchors').first();
      const horizontalRule = paragraph.prevAll('.horizontal-rule').first();
      if (!quote.length || (horizontalRule.length && quote.index() < horizontalRule.index())) return;
      const segmentContext = ctx.html.text(quote.html() || paragraph.text());
      if (segmentContext.length < 50) return;
      const segmentTitle = ctx.html.text($(anchor).text()).replace(/^\[|\]$/g, '').trim() || new URL(href).pathname.split('/').filter(Boolean).at(-1);
      const id = `${candidate.id}:segment:${segmentSlug(segmentTitle)}-${segments.length + 1}`;
      segments.push({
        ...candidate,
        id,
        title: `${candidate.title}: ${segmentTitle}`,
        metadata: { ...candidate.metadata, roundupSegment: true, roundupTitle: candidate.title, segmentTitle, segmentContext, segmentUrl: href, originalUrl: href, segmentKind: /arxiv\.org/i.test(href) ? 'preprint' : /github\.com/i.test(href) ? 'repository' : 'project' },
      });
    });
  });
  return segments;
}

export async function discover(source, ctx) {
  return withFeedIntake(source, ctx, discoverSources);
}

async function discoverSources(source, ctx) {
  const issues = [];
  const coverage = { pagesRequested: ctx.maxPages ?? 3, pagesFetched: 0, entryUrl: source.entryUrl, fallbackUrl: null, incomplete: false, filteredOut: 0, roundupSegments: 0 };
  let candidates = [];
  // The root commits this checkpoint atomically with candidates. Keep adapter
  // state JSON-only and free of credentials or signed URLs.
  let nextState = ctx.state && typeof ctx.state === 'object' ? structuredClone(ctx.state) : {};
  let entryError = null;
  try {
    const resumeRssCursor = typeof ctx.state?.rssCursorUrl === 'string' ? ctx.state.rssCursorUrl : null;
    let pageUrl = source.entryUrl;
    let firstPage = true;
    let page = 0;
    let sourceItemCount = 0;
    const seen = new Set();
    while (pageUrl && page < coverage.pagesRequested) {
      const response = await ctx.http.get(pageUrl, { timeoutMs: 30000 });
      const feed = await parseFeed(response.text);
      page++;
      coverage.pagesFetched++;
      if (page === 1) { coverage.entryStatus = response.status; coverage.feedTitle = feed.title ?? null; }
      const items = feed.items ?? [];
      sourceItemCount += items.length;
      for (const item of items) {
        if (!isEligible(source, item)) { coverage.filteredOut++; continue; }
        const candidate = rssCandidate(source, item);
        if (!candidate.url || !candidate.publishedAt || ['unknown', 'month', 'year'].includes(candidate.datePrecision))
          issues.push({ url: candidate.url || pageUrl, kind: 'qualification', status: 'pending', error: 'Feed item missing URL or precise publication date', title: candidate.title, candidateId: candidate.id });
        if (source.id === 'ieee-robotics-feed' && /^Video Friday:/i.test(candidate.title)) {
          try {
            coverage.articleBodyFetches = (coverage.articleBodyFetches ?? 0) + 1;
            const segments = await expandIeeeRoundup(candidate, source, ctx);
            if (segments.length) {
              coverage.roundupArticlesExpanded = (coverage.roundupArticlesExpanded ?? 0) + 1;
              coverage.roundupSegments += segments.length;
              for (const segment of segments) if (!seen.has(segment.id)) { candidates.push(segment); seen.add(segment.id); }
              continue;
            }
          } catch (error) {
            coverage.roundupArticleFailures = (coverage.roundupArticleFailures ?? 0) + 1;
            issues.push({ url: candidate.url, kind: 'roundup-expansion', status: 'pending', error: String(error.message ?? error), title: candidate.title });
          }
        }
        if (!seen.has(candidate.id)) { candidates.push(candidate); seen.add(candidate.id); }
      }
      const $ = ctx.html.load(response.text);
      const next = $('[rel]').filter((_, el) => String($(el).attr('rel') ?? '').toLowerCase() === 'next').first().attr('href');
      const discoveredNext = next ? ctx.html.absolute(next, response.url ?? pageUrl) : null;
      pageUrl = firstPage && resumeRssCursor ? resumeRssCursor : discoveredNext;
      firstPage = false;
      if (pageUrl) {
        try {
          const nextUrl = new URL(pageUrl);
          const baseUrl = new URL(source.entryUrl);
          const unsafeCursor = [...nextUrl.searchParams.keys()].some((key) => /token|secret|signature|sig|key|auth/i.test(key));
          if (nextUrl.origin === baseUrl.origin && !unsafeCursor) nextState.rssCursorUrl = pageUrl;
          else nextState.rssCursorUrl = null;
        } catch { nextState.rssCursorUrl = null; }
      } else nextState.rssCursorUrl = null;
      if (pageUrl && page === coverage.pagesRequested) coverage.incomplete = true;
    }
    coverage.itemCount = sourceItemCount;
    coverage.emptyFeed = coverage.itemCount === 0;
  } catch (error) {
    entryError = error;
    coverage.entryError = String(error.message ?? error);
    issues.push({ url: source.entryUrl, kind: 'entry', error: coverage.entryError });
  }

  // GitHub's unauthenticated public Releases API is the retryable official listing fallback
  // for documented slow/empty Atom endpoints. It remains separately visible in coverage.
  if ((!candidates.length || entryError) && GITHUB_API[source.id]) {
    try {
      let total = 0;
      const fallbackBudget = Math.max(0, coverage.pagesRequested - coverage.pagesFetched);
      const savedPage = Number.isSafeInteger(nextState.githubReleasePage) && nextState.githubReleasePage > 1 ? nextState.githubReleasePage : 1;
      const savedPhase = nextState.githubReleasePhase;
      const pages = githubPagePlan(savedPage, savedPhase, fallbackBudget);
      let releasePagesUsed = 0;
      for (let index = 0; index < pages.length; index++) {
        const { page, role } = pages[index];
        const apiUrl = GITHUB_API[source.id].replace('per_page=10', 'per_page=100') + `&page=${page}`;
        coverage.fallbackUrl ??= apiUrl;
        const response = await ctx.http.get(apiUrl, { headers: { Accept: 'application/vnd.github+json' }, timeoutMs: 30000 });
        const releases = JSON.parse(response.text);
        releasePagesUsed++;
        if (page === 1) coverage.fallbackStatus = response.status;
        total += Array.isArray(releases) ? releases.length : 0;
        for (const release of (Array.isArray(releases) ? releases : [])) {
          const synthetic = ghCandidate(source, release, apiUrl);
          if (!['lerobot-releases', 'groot-releases', 'isaaclab-releases', 'openpi-releases'].includes(source.id) && !ROBOTICS.test(`${synthetic.title} ${synthetic.metadata.summary}`)) { coverage.filteredOut++; continue; }
          if (!synthetic.publishedAt) issues.push({ url: synthetic.url, kind: 'qualification', status: 'pending', candidateId: synthetic.id, title: synthetic.title, error: 'GitHub release has no precise publication date' });
          candidates.push(synthetic);
        }
        const nextPage = githubNextPage(response, page, Array.isArray(releases) ? releases.length : 0, 100);
        if (nextPage) {
          if (role === 'cursor' || role === 'continuation') {
            nextState.githubReleasePage = nextPage;
            nextState.githubReleasePhase = index + 1 < pages.length ? 'scan' : 'head';
          } else {
            nextState.githubReleasePage = savedPage;
            nextState.githubReleasePhase = role === 'head' ? 'overlap' : 'cursor';
          }
        } else {
          nextState.githubReleasePage = null;
          nextState.githubReleasePhase = null;
          break;
        }
      }
      coverage.fallbackItemCount = total;
      coverage.fallbackPagesFetched = releasePagesUsed;
      coverage.releaseResumePolicy = fallbackBudget === 1 && savedPage > 1
        ? 'RSS head attempted each run; REST head, overlap, then saved cursor rotate across bounded calls'
        : 'REST head and overlapped saved cursor precede continuation when page budget allows';
      if ((nextState.githubReleasePage ?? 1) > 1) coverage.incomplete = true;
      let commitPagesUsed = 0;
      const commitBudget = Math.max(0, fallbackBudget - releasePagesUsed);
      if (source.id === 'openpi-releases' && !candidates.length && commitBudget > 0) {
        coverage.commitAlternativeUrl = OPENPI_COMMIT_API;
        const savedCommitPage = Number.isSafeInteger(nextState.githubCommitPage) && nextState.githubCommitPage > 1 ? nextState.githubCommitPage : 1;
        const savedCommitPhase = nextState.githubCommitPhase;
        const commitPages = githubPagePlan(savedCommitPage, savedCommitPhase, commitBudget);
        let commitTotal = 0;
        for (let index = 0; index < commitPages.length; index++) {
          const { page, role } = commitPages[index];
          const url = new URL(OPENPI_COMMIT_API);
          url.searchParams.set('per_page', '100');
          url.searchParams.set('page', String(page));
          const response = await ctx.http.get(url.href, { headers: { Accept: 'application/vnd.github+json' }, timeoutMs: 30000 });
          const commits = JSON.parse(response.text);
          commitPagesUsed++;
          if (page === 1) coverage.commitAlternativeStatus = response.status;
          commitTotal += Array.isArray(commits) ? commits.length : 0;
          for (const commit of (Array.isArray(commits) ? commits : [])) {
          const raw = commit.commit?.committer?.date ?? commit.commit?.author?.date ?? null;
          const title = first(commit.commit?.message?.split(/\r?\n/, 1)[0], commit.sha);
          if (/^(docs?(\([^)]*\))?:|chore(\([^)]*\))?:|test(\([^)]*\))?:|ci(\([^)]*\))?:|dependabot|bump |remove .*dependency)/i.test(title)) {
            coverage.commitAlternativeFilteredOut = (coverage.commitAlternativeFilteredOut ?? 0) + 1;
            continue;
          }
          candidates.push({
            id: `${source.id}:commit:${commit.sha}`, url: commit.html_url, title,
            publishedAt: toIso(raw), publishedAtRaw: raw, datePrecision: precision(raw), channelId: 'primary',
            metadata: { feedId: source.id, feedUrl: source.entryUrl, fallback: 'github-commits-api', kind: 'project_code_update', dateSemantics: 'commit_date', commitSha: commit.sha, summary: commit.commit?.message ?? '', releaseMonitoringContinues: true, sourceRole: source.role },
          });
          }
          const nextPage = githubNextPage(response, page, Array.isArray(commits) ? commits.length : 0, 100);
          if (nextPage) {
            if (role === 'cursor' || role === 'continuation') {
              nextState.githubCommitPage = nextPage;
              nextState.githubCommitPhase = index + 1 < commitPages.length ? 'scan' : 'head';
            } else {
              nextState.githubCommitPage = savedCommitPage;
              nextState.githubCommitPhase = role === 'head' ? 'overlap' : 'cursor';
            }
          } else {
            nextState.githubCommitPage = null;
            nextState.githubCommitPhase = null;
            break;
          }
        }
        coverage.commitAlternativeCount = commitTotal;
        coverage.commitAlternativePagesFetched = commitPagesUsed;
        coverage.commitResumePolicy = commitBudget === 1 && savedCommitPage > 1
          ? 'RSS and releases head are refreshed each run; REST head, overlap, then saved cursor rotate across bounded calls'
          : 'REST head and overlapped saved cursor precede continuation when page budget allows';
        if ((nextState.githubCommitPage ?? 1) > 1) coverage.incomplete = true;
      }
    } catch (error) {
      coverage.fallbackError = String(error.message ?? error);
      issues.push({ url: coverage.fallbackUrl, kind: 'fallback', error: coverage.fallbackError });
    }
  }
  if (source.id === 'arxiv-cs-ro') {
    const previous = nextState.arxiv ?? {};
    const active = previous.window;
    const overlapMs = 2 * 24 * 60 * 60 * 1000;
    const windowTo = active?.to ?? ctx.now;
    const fromDate = active?.from
      ?? (previous.lastCompleteAt
        ? new Date(Math.max(0, Date.parse(previous.lastCompleteAt) - overlapMs)).toISOString()
        : new Date(Math.max(0, Date.parse(windowTo) - 7 * 24 * 60 * 60 * 1000)).toISOString());
    let start = Number.isSafeInteger(active?.start) && active.start >= 0 ? active.start : 0;
    const maxPages = Math.max(0, Number(ctx.maxPages ?? 3) - coverage.pagesFetched);
    let apiPagesFetched = 0;
    let apiFailed = false;
    let apiComplete = false;
    const apiSeen = new Set(candidates.map((candidate) => candidate.id));
    const apiUrl = (offset) => {
      const query = 'cat:cs.RO';
      const url = new URL('https://export.arxiv.org/api/query');
      url.searchParams.set('search_query', query);
      url.searchParams.set('sortBy', 'lastUpdatedDate');
      url.searchParams.set('sortOrder', 'descending');
      url.searchParams.set('start', String(offset));
      url.searchParams.set('max_results', '100');
      return url.href;
    };
    coverage.arxivWindow = { from: fromDate, to: windowTo, start };
    coverage.arxivApiPagesRequested = maxPages;
    coverage.arxivResumePolicy = maxPages === 0
      ? 'no Export API page budget; state unchanged'
      : maxPages === 1 && start > 0
        ? 'RSS head refreshed each run; Export API reads saved cursor with 50-result overlap'
        : 'RSS and Export API heads refreshed before overlapping saved-page continuation';
    coverage.arxivApiStarts = [];
    try {
      // RSS is refreshed above on every run. With one Export API slot, spend
      // it on the saved cursor and overlap 50 results so the bounded scan moves
      // forward; when there is room, reread the API head as well.
      const offsets = start > 0
        ? (maxPages === 1
          ? [Math.max(0, start - 50)]
          : [0, ...Array.from({ length: Math.max(0, maxPages - 1) }, (_, index) => Math.max(0, start - 50) + index * 100)])
        : Array.from({ length: maxPages }, (_, index) => start + index * 100);
      for (const offset of offsets.slice(0, maxPages)) {
        const cursorOffset = start;
        coverage.arxivApiStarts.push(offset);
        const requestUrl = apiUrl(offset);
        const response = await ctx.http.get(requestUrl, { timeoutMs: 30000, cacheMs: 86400000 });
        const $ = ctx.html.load(response.text, { xmlMode: true });
        const entries = $('entry').toArray();
        if (!$('feed').length || (!entries.length && /<(?:error|html)|Bad Gateway|Rate exceeded/i.test(response.text))) throw new Error('arXiv Export API returned an error page');
        if (entries.length === 1 && !$(entries[0]).find('id').first().text().trim() && /error|bad request|invalid query/i.test($(entries[0]).text())) throw new Error('arXiv Export API returned an Atom error entry');
        let belowWindow = false;
        for (const entry of entries) {
          const row = $(entry);
          const link = row.find('id').first().text().trim();
          const paperId = link.match(/abs\/([^?#]+)/)?.[1]?.replace(/v\d+$/, '');
          const title = ctx.html.text(row.find('title').first().text()).replace(/\s+/g, ' ').trim();
          const summary = ctx.html.text(row.find('summary').first().text()).replace(/\s+/g, ' ').trim();
          const published = row.find('published').first().text().trim();
          const updated = row.find('updated').first().text().trim();
          const updatedAt = toIso(updated);
          const authors = row.find('author > name').map((_, el) => ctx.html.text($(el).text()).trim()).get().filter(Boolean);
          if (!updatedAt || updatedAt > windowTo) continue;
          if (updatedAt < fromDate) { belowWindow = true; continue; }
          if (!paperId || !isEligible(source, { title, contentSnippet: summary })) continue;
          const id = `${source.id}:${paperId}`;
          if (apiSeen.has(id)) continue;
          apiSeen.add(id);
          const candidate = {
            id, url: `https://arxiv.org/abs/${paperId}`, title,
            publishedAt: toIso(published), publishedAtRaw: published || null,
            datePrecision: precision(published), channelId: 'primary',
            metadata: {
              feedId: source.id, feedUrl: source.entryUrl, feedGuid: link,
              summary, authors, sourceRole: source.role, fallback: 'arxiv-export-api-window',
              arxivPublishedAt: toIso(published), arxivPublishedAtRaw: published || null,
              arxivUpdatedAt: toIso(updated), arxivUpdatedAtRaw: updated || null,
            },
          };
          candidates.push(candidate);
          if (!candidate.publishedAt) issues.push({ url: candidate.url, kind: 'qualification', status: 'pending', error: 'arXiv API entry missing precise published date', title, candidateId: id });
        }
        apiPagesFetched++;
        coverage.arxivApiStatus ??= response.status;
        coverage.arxivApiItemCount = (coverage.arxivApiItemCount ?? 0) + entries.length;
        if (offset === cursorOffset || (cursorOffset > 0 && offset === Math.max(0, cursorOffset - 50))) start = offset + entries.length;
        if (belowWindow) { apiComplete = true; break; }
        if (entries.length < 100) {
          apiComplete = true;
          break;
        }
      }
    } catch (error) {
      apiFailed = true;
      coverage.arxivApiError = String(error.message ?? error);
      issues.push({ url: 'https://export.arxiv.org/api/query', kind: 'arxiv-window', error: coverage.arxivApiError });
    }
    coverage.arxivApiPagesFetched = apiPagesFetched;
    coverage.arxivWindowIncomplete = !apiComplete;
    if (apiFailed) {
      // A failed page is retryable at the same offset. Earlier successful pages
      // remain durable because candidates and this cursor share the root txn.
      nextState.arxiv = { ...previous, window: { from: fromDate, to: windowTo, start } };
    } else if (apiComplete) {
      nextState.arxiv = { lastCompleteAt: windowTo, window: null };
    } else {
      nextState.arxiv = { ...previous, window: { from: fromDate, to: windowTo, start } };
    }
  }
  return { candidates, issues, coverage, nextState };
}

function evidenceClassFor(id) {
  if (id === 'arxiv-cs-ro') return 'preprint';
  if (id.includes('release')) return 'repository';
  if (id === 'ieee-robotics-feed' || id === 'qbitai-feed') return 'independent_reporting';
  return 'official_announcement';
}
function mediaOriginalLink(links, articleUrl, articleTitle, body) {
  const baseHost = new URL(articleUrl).hostname.replace(/^www\./, '');
  const usable = (links ?? []).map((link) => typeof link === 'string' ? link : link?.url).filter(Boolean);
  const stop = new Set(['robot', 'robots', 'robotic', 'robotics', 'people', 'building', 'assistive', 'independently', 'help', 'life', 'little', 'video', 'friday', 'with', 'from', 'more', 'better']);
  const significant = (String(articleTitle).toLowerCase().match(/[a-z\u3400-\u9fff]{4,}/g) ?? []).filter((word) => !stop.has(word));
  const refs = String(body ?? '').match(/(?:参考链接|references)[:：]?([\s\S]{0,1200})/i)?.[1] ?? '';
  const cited = refs.match(/https?:\/\/[^\s\]）)>,，。；;]+/g)?.map((url) => url.replace(/[.,，。；;]+$/g, '')) ?? [];
  const citation = cited.find((href) => {
    try { const u = new URL(href); return !/youtube\.com|youtu\.be|x\.com|twitter\.com/i.test(u.hostname); } catch { return false; }
  });
  if (citation) return citation;
  return usable.find((href) => {
    try {
      const url = new URL(href, articleUrl);
      if (!/^https?:$/.test(url.protocol) || url.hostname.replace(/^www\./, '') === baseHost) return false;
      if (/youtube\.com|youtu\.be|x\.com|twitter\.com|facebook\.com|linkedin\.com|instagram\.com/i.test(url.hostname)) return false;
      if (url.pathname === '/' || url.pathname === '') return false;
      const link = (url.hostname + url.pathname + (links.find((x) => (typeof x === 'string' ? x : x?.url) === href)?.title ?? '')).toLowerCase();
      const matchedTopic = significant.some((word) => word.length >= 4 && link.includes(word));
      const primaryEvidencePath = /arxiv\.org\/abs\/|github\.com\/[^/]+\/[^/]+|huggingface\.co\/[^/]+\/[^/]+|\.github\.io\/[^/]+/i.test(`${url.hostname}${url.pathname}`);
      return matchedTopic || primaryEvidencePath;
    } catch { return false; }
  }) ?? null;
}

export async function hydrate(candidate, source, ctx) {
  if (!candidate.url) throw new Error(`Missing candidate URL: ${candidate.id}`);
  if (candidate.metadata?.eligibility === 'excluded_financial_roundup') throw new Error(`Candidate excluded from daily event pool: ${candidate.metadata.exclusionReason}`);
  if (!candidate.publishedAt || candidate.datePrecision === 'unknown' || candidate.datePrecision === 'month' || candidate.datePrecision === 'year') {
    throw new Error(`Missing precise publication date: ${candidate.id}`);
  }
  let response;
  let mediaType = 'text/html';
  let content = '';
  let articleLinks = [];
  let title = candidate.title;
  let dateRaw = candidate.publishedAtRaw;
  let dateIso = candidate.publishedAt;
  let datePrecision = candidate.datePrecision;
  let originalPublishedAtRaw = null;
  let originalPublishedAt = null;
  let originalDatePrecision = 'unknown';
  let originalRaw = '';
  let rawUrl = candidate.url;

  if (candidate.metadata.fallback === 'github-commits-api') {
    const repo = candidate.url.match(/github\.com\/([^/]+\/[^/]+)/)?.[1];
    if (!repo || !candidate.metadata.commitSha) throw new Error(`Cannot resolve OpenPI commit API URL: ${candidate.url}`);
    const apiUrl = `https://api.github.com/repos/${repo}/commits/${candidate.metadata.commitSha}`;
    response = await ctx.http.get(apiUrl, { headers: { Accept: 'application/vnd.github+json' }, timeoutMs: 30000 });
    const commit = JSON.parse(response.text);
    const files = (commit.files ?? []).slice(0, 12).map((f) => `\n\n--- ${f.filename} (${f.status}) ---\n${f.patch ?? '[patch omitted by GitHub API]'}`).join('');
    content = `${commit.commit?.message ?? candidate.metadata.summary}${files}`.trim();
    title = first(commit.commit?.message?.split(/\r?\n/, 1)[0], title);
    dateRaw = commit.commit?.committer?.date ?? commit.commit?.author?.date ?? dateRaw;
    dateIso = toIso(dateRaw);
    datePrecision = precision(dateRaw);
    mediaType = 'application/vnd.github+json';
    originalRaw = response.text;
    rawUrl = response.url ?? apiUrl;
    if (!content || content.length < 40) throw new Error(`GitHub commit message/patch unavailable: ${candidate.url}`);
  } else if (candidate.metadata.fallback === 'github-rest-api') {
    const apiUrl = `https://api.github.com/repos/${candidate.url.match(/github\.com\/([^/]+\/[^/]+)/)?.[1]}/releases/tags/${encodeURIComponent(candidate.metadata.releaseTag)}`;
    if (apiUrl.includes('undefined')) throw new Error(`Cannot resolve GitHub release API URL: ${candidate.url}`);
    response = await ctx.http.get(apiUrl, { headers: { Accept: 'application/vnd.github+json' }, timeoutMs: 30000 });
    const release = JSON.parse(response.text);
    content = first(release.body, release.name, release.tag_name);
    title = first(release.name, release.tag_name, title);
    dateRaw = release.published_at ?? release.created_at ?? dateRaw;
    dateIso = toIso(dateRaw);
    datePrecision = precision(dateRaw);
    mediaType = 'application/vnd.github+json';
    originalRaw = response.text;
    rawUrl = response.url ?? apiUrl;
    if (!content || content.length < 40) throw new Error(`GitHub release body unavailable or too short: ${candidate.url}`);
  } else if (source.id === 'arxiv-cs-ro') {
    const paperId = candidate.url.match(/(?:abs|pdf)\/([^?#]+)/)?.[1];
    if (!paperId) throw new Error(`Cannot extract arXiv id from ${candidate.url}`);
    const apiUrl = `https://export.arxiv.org/api/query?id_list=${encodeURIComponent(paperId)}`;
    response = await ctx.http.get(apiUrl, { timeoutMs: 30000 });
    const axml = ctx.html.load(response.text, { xmlMode: true });
    const paperTitle = ctx.html.text(axml('entry > title').first().text());
    const abstract = ctx.html.text(axml('entry > summary').first().text());
    const paperAuthors = axml('entry > author > name').map((_, el) => ctx.html.text(axml(el).text())).get().filter(Boolean);
    if (!paperTitle || !abstract || abstract.length < 80) throw new Error(`arXiv API abstract unavailable: ${apiUrl}`);
    title = paperTitle;
    content = abstract;
    mediaType = 'application/atom+xml';
    const published = axml('entry > published').first().text().trim();
    const updated = axml('entry > updated').first().text().trim();
    originalPublishedAtRaw = published || null;
    originalPublishedAt = toIso(published);
    originalDatePrecision = precision(published);
    dateRaw = published || dateRaw;
    dateIso = toIso(published) || dateIso;
    datePrecision = precision(published) || datePrecision;
    if (candidate.metadata.fallback === 'arxiv-export-api-window') {
      candidate.metadata.exportApiDiscoveredAt = candidate.publishedAt;
      candidate.metadata.discoveryDateSemantics = 'v1_published';
    } else {
      candidate.metadata.feedAnnouncedAt = candidate.publishedAt;
    }
    candidate.metadata.latestVersionUpdatedAt = toIso(updated);
    candidate.metadata.arxivUpdatedAtRaw = updated || null;
    if (paperAuthors.length) candidate.metadata.paperAuthors = paperAuthors;
    originalRaw = response.text;
    rawUrl = response.url ?? apiUrl;
    candidate.metadata.originalUrl = `https://arxiv.org/abs/${paperId}`;
  } else if (source.id === 'ieee-robotics-feed' && candidate.metadata.roundupSegment) {
    const mediaResponse = await ctx.http.get(candidate.url, { timeoutMs: 30000 });
    const mediaDom = ctx.html.load(mediaResponse.text);
    const mediaBody = mediaDom('.article_post--body-and-tags').first();
    if (!mediaBody.length) throw new Error(`IEEE roundup body unavailable: ${candidate.url}`);
    const matchingAnchor = mediaBody.find('a[href]').toArray().some((anchor) => ctx.html.absolute(mediaDom(anchor).attr('href'), mediaResponse.url ?? candidate.url) === candidate.metadata.segmentUrl);
    if (!matchingAnchor) throw new Error(`Segment source link no longer appears in IEEE roundup: ${candidate.metadata.segmentUrl}`);
    let originalResponse;
    if (/arxiv\.org\/(?:abs|pdf)\//i.test(candidate.metadata.segmentUrl)) {
      const paperId = candidate.metadata.segmentUrl.match(/(?:abs|pdf)\/([^?#]+)/)?.[1];
      const apiUrl = `https://export.arxiv.org/api/query?id_list=${encodeURIComponent(paperId)}`;
      originalResponse = await ctx.http.get(apiUrl, { timeoutMs: 30000 });
      const axml = ctx.html.load(originalResponse.text, { xmlMode: true });
      title = ctx.html.text(axml('entry > title').first().text()) || candidate.title;
      content = ctx.html.text(axml('entry > summary').first().text());
      originalPublishedAtRaw = axml('entry > published').first().text().trim() || null;
      originalDatePrecision = precision(originalPublishedAtRaw);
      originalPublishedAt = toIso(originalPublishedAtRaw);
      mediaType = 'application/atom+xml';
    } else {
      originalResponse = await ctx.http.get(candidate.metadata.segmentUrl, { timeoutMs: 30000 });
      let originalArticle = ctx.html.article(originalResponse.text, originalResponse.url ?? candidate.metadata.segmentUrl);
      content = originalArticle.content;
      title = originalArticle.title || candidate.title;
      originalPublishedAtRaw = originalArticle.publishedAtRaw || null;
      originalDatePrecision = originalArticle.datePrecision || 'unknown';
      originalPublishedAt = ['second', 'day'].includes(originalDatePrecision) ? originalArticle.publishedAt : null;
      if (!content || content.length < 80) {
        const $ = ctx.html.load(originalResponse.text);
        const body = $('main article, article, main, .post-content, .entry-content').first();
        content = body.length ? ctx.html.text(body.html()) : '';
      }
      mediaType = originalResponse.headers?.['content-type'] || 'text/html';
    }
    if (!content || content.length < 80) throw new Error(`IEEE segment original evidence body unavailable: ${candidate.metadata.segmentUrl}`);
    response = originalResponse;
    originalRaw = originalResponse.text;
    rawUrl = originalResponse.url ?? candidate.metadata.segmentUrl;
  } else {
    response = await ctx.http.get(candidate.url, { timeoutMs: 30000 });
    if (source.id.endsWith('-releases')) {
      const $ = ctx.html.load(response.text);
      const releaseBody = $('.markdown-body').first();
      content = releaseBody.length ? ctx.html.text(releaseBody.html()) : '';
    } else {
      if (source.id === 'ieee-robotics-feed' && /robotsguide\.com/i.test(candidate.url)) {
        const $ = ctx.html.load(response.text);
        const story = $('article.ruled-lg').first();
        content = story.length ? ctx.html.text(story.html()) : '';
        title = ctx.html.text(story.find('h1').first().text()) || title;
        const published = story.find('time[datetime]').first().attr('datetime') || '';
        const articleDate = ctx.html.date(published);
        originalPublishedAtRaw = articleDate.publishedAtRaw || null;
        originalDatePrecision = articleDate.datePrecision;
        originalPublishedAt = ['second', 'day'].includes(articleDate.datePrecision) ? articleDate.publishedAt : null;
      } else {
        const article = ctx.html.article(response.text, response.url ?? candidate.url);
        content = article.content;
        articleLinks = article.links ?? [];
        originalPublishedAtRaw = article.publishedAtRaw || null;
        originalDatePrecision = article.datePrecision || 'unknown';
        originalPublishedAt = ['second', 'day'].includes(article.datePrecision) ? article.publishedAt : null;
        title = article.title || title;
      }
    }
    originalRaw = response.text;
    rawUrl = response.url ?? candidate.url;
    // Keep feed timestamp as the discovery publication timestamp; article dates can denote updates.
    if (source.id.endsWith('-releases')) {
      candidate.metadata.feedUpdatedAt = candidate.publishedAt;
      candidate.metadata.feedUpdatedAtRaw = candidate.publishedAtRaw;
      const releaseMatch = candidate.url.match(/github\.com\/([^/]+\/[^/]+)\/releases\/tag\/([^?#]+)/);
      let apiRelease = null;
      let releaseApiUrl = null;
      let releaseApiResponse = null;
      if (releaseMatch) {
        releaseApiUrl = `https://api.github.com/repos/${releaseMatch[1]}/releases/tags/${encodeURIComponent(decodeURIComponent(releaseMatch[2]))}`;
        try {
          releaseApiResponse = await ctx.http.get(releaseApiUrl, { headers: { Accept: 'application/vnd.github+json' }, timeoutMs: 30000 });
          apiRelease = JSON.parse(releaseApiResponse.text);
          candidate.metadata.releaseApiStatus = releaseApiResponse.status;
        } catch (error) {
          candidate.metadata.releaseApiError = String(error.message ?? error);
        }
      }
      // Some GitHub release pages are client-rendered or omit the release notes
      // from their HTML. The public Releases API exposes the same maintainer
      // notes without requiring browser login or bypassing an access control.
      if ((!content || content.length < 80) && typeof apiRelease?.body === 'string' && apiRelease.body.trim().length >= 80) {
        content = apiRelease.body.trim();
        title = first(apiRelease.name, apiRelease.tag_name, title);
        if (releaseApiResponse) {
          originalRaw = releaseApiResponse.text;
          rawUrl = releaseApiResponse.url ?? releaseApiUrl;
          mediaType = 'application/vnd.github+json';
        }
        candidate.metadata.releaseBodyEvidenceUrl = releaseApiResponse?.url ?? releaseApiUrl;
        candidate.metadata.releaseBodySource = 'github-releases-api';
      }
      const releasePageDate = ctx.html.load(response.text)('relative-time[datetime],time[datetime]').first().attr('datetime') || null;
      const publishedRaw = apiRelease?.published_at || releasePageDate;
      if (!publishedRaw || !toIso(publishedRaw)) throw new Error(`GitHub release original published date unavailable: ${candidate.url}`);
      dateRaw = publishedRaw;
      dateIso = toIso(publishedRaw);
      datePrecision = precision(publishedRaw);
      originalPublishedAtRaw = publishedRaw;
      originalPublishedAt = dateIso;
      originalDatePrecision = datePrecision;
      candidate.metadata.releaseDateEvidenceUrl = releaseApiUrl ?? candidate.url;
      candidate.metadata.releaseCreatedAt = apiRelease?.created_at ?? null;
      candidate.metadata.releaseUpdatedAt = apiRelease?.updated_at ?? null;
      candidate.metadata.releaseApiPublishedAt = apiRelease?.published_at ?? null;
    }
    if (!content || content.length < 80) {
      const rendered = await ctx.browser.get(candidate.url, { timeoutMs: 30000 });
      response = rendered;
      originalRaw = rendered.text;
      rawUrl = rendered.url ?? candidate.url;
      const renderedArticle = ctx.html.article(rendered.html ?? rendered.text, rendered.url ?? candidate.url);
      content = renderedArticle.content;
      articleLinks = renderedArticle.links ?? articleLinks;
      title = renderedArticle.title || title;
    }
  }
  if (!content || content.length < 80 || /enable javascript|verify you are human|sign in to continue|access denied/i.test(content.slice(0, 500))) {
    throw new Error(`Article body unavailable, too short or blocked: ${candidate.url}`);
  }
  if (!dateIso || !dateRaw || ['unknown', 'month', 'year'].includes(datePrecision)) throw new Error(`No qualifying publication date: ${candidate.url}`);
  let originalUrl = candidate.metadata.originalUrl ?? candidate.url;
  let originalTitle = title;
  let originalContent = content;
  let originalMediaType = mediaType;
  let originalKind = evidenceClassFor(source.id);
  if (source.id === 'ieee-robotics-feed') {
    if (candidate.metadata.roundupSegment) {
      originalUrl = candidate.metadata.segmentUrl;
      originalTitle = title;
      originalContent = content;
      originalKind = candidate.metadata.segmentKind;
    } else {
      originalUrl = mediaOriginalLink(articleLinks, candidate.url, title, content);
      if (!originalUrl) throw new Error(`No linked paper, project or technical evidence found for media report: ${candidate.url}`);
      const originalResponse = await ctx.http.get(originalUrl, { timeoutMs: 30000 });
      const originalArticle = ctx.html.article(originalResponse.text, originalResponse.url ?? originalUrl);
      originalContent = originalArticle.content;
      originalTitle = originalArticle.title || title;
      if (!originalContent || originalContent.length < 80) throw new Error(`Linked original evidence body unavailable: ${originalUrl}`);
      originalRaw = originalResponse.text;
      rawUrl = originalResponse.url ?? originalUrl;
      originalMediaType = originalResponse.headers?.['content-type'] || 'text/html';
      originalKind = /arxiv\.org/i.test(originalUrl) ? 'preprint' : /github\.com|github\.io/i.test(originalUrl) ? 'repository' : 'project';
    }
  } else if (source.id === 'qbitai-feed') {
    originalUrl = mediaOriginalLink(articleLinks, candidate.url, title, content);
    if (!originalUrl && source.id === 'qbitai-feed' && /本文由\s*Striding AI\s*提供.{0,50}授权转载/.test(content)) {
      candidate.metadata.contentOrigin = 'company_statement_republished';
      candidate.metadata.sourceAttribution = 'Striding AI';
      throw new Error(`Company-provided announcement has no retrieved official original page: ${candidate.url}`);
    }
    if (!originalUrl) throw new Error(`No linked original source found in media report: ${candidate.url}`);
    const originalResponse = await ctx.http.get(originalUrl, { timeoutMs: 30000 });
    const originalArticle = ctx.html.article(originalResponse.text, originalResponse.url ?? originalUrl);
    originalContent = originalArticle.content;
    originalTitle = originalArticle.title || title;
    originalPublishedAtRaw = originalArticle.publishedAtRaw || null;
    originalDatePrecision = originalArticle.datePrecision || 'unknown';
    originalPublishedAt = ['second', 'day'].includes(originalArticle.datePrecision) ? originalArticle.publishedAt : null;
    originalRaw = originalResponse.text;
    rawUrl = originalResponse.url ?? originalUrl;
    if (!originalContent || originalContent.length < 80) throw new Error(`Linked original source body unavailable: ${originalUrl}`);
    originalMediaType = 'text/html';
    originalKind = candidate.metadata.contentOrigin ? 'official_announcement' : /arxiv\.org/i.test(originalUrl) ? 'preprint' : /github\.com/i.test(originalUrl) ? 'repository' : 'project';
  }
  const evidence = [{ url: originalUrl, kind: originalKind, relation: 'original', title: originalTitle }];
  if (source.id === 'qbitai-feed') evidence.unshift({ url: candidate.url, kind: 'independent_reporting', relation: 'discovery', title });
  return {
    sourceId: source.id, channelId: candidate.channelId ?? 'primary', sourceItemId: candidate.id,
    title, url: candidate.url, publishedAt: dateIso, publishedAtRaw: dateRaw, datePrecision,
    content: originalContent, contentFormat: 'text', evidenceClass: originalKind, evidence,
    authors: candidate.metadata.paperAuthors ?? candidate.metadata.authors ?? [], topics: [],
    metadata: { ...candidate.metadata, originalPageUrl: originalUrl, sourcePublishedAt: dateIso, sourcePublishedAtRaw: dateRaw, originalPublishedAt, originalPublishedAtRaw, originalDatePrecision },
    raw: { url: rawUrl, mediaType: originalMediaType, content: originalRaw },
  };
}
