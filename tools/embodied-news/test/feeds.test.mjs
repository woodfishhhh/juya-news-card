import test from 'node:test';
import assert from 'node:assert/strict';
import { load } from 'cheerio';
import { discover, evaluateRelevance, hydrate } from '../adapters/feeds.mjs';

const XML = (items) => `<?xml version="1.0"?><rss version="2.0"><channel><title>test</title>${items}</channel></rss>`;
const item = (title, link, description, date = 'Tue, 29 Sep 2026 10:00:00 GMT') => `<item><title>${title}</title><link>${link}</link><guid>${link}</guid><description><![CDATA[${description}]]></description><pubDate>${date}</pubDate></item>`;
const arxivEntry = ({ id, title = 'Robot manipulation VLA research', published = '2022-04-12T09:30:00Z', updated = '2026-09-29T10:00:00Z', summary = 'A detailed robot manipulation study describing the policy, experiments, hardware and evaluation results. '.repeat(2) }) => `<entry><id>https://arxiv.org/abs/${id}</id><updated>${updated}</updated><published>${published}</published><title>${title}</title><summary>${summary}</summary><author><name>Researcher One</name></author></entry>`;
const arxivFeed = (entries) => `<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom">${entries.join('')}</feed>`;
function context({ text, article = {} } = {}) {
  return {
    now: '2026-09-30T12:00:00.000Z',
    http: { async get(url) { if (typeof text === 'function') return text(url); return { text, url, status: 200, headers: {} }; } },
    browser: { async get(url) { return { text: '<html/>', html: '<html/>', url, status: 200, headers: {} }; } },
    html: {
      load,
      absolute(value, base) { try { return new URL(value, base).href; } catch { return null; } },
      text(value) { return String(value ?? '').replace(/<[^>]*>/g, ' '); },
      article(value, url) { return { title: article.title ?? 'Parsed title', content: article.content ?? 'This is a retrieved article body with sufficient detail about the robot manipulation research and experimental setup.', publishedAt: null, publishedAtRaw: null, datePrecision: 'unknown', links: [], authors: [], url }; },
    },
  };
}
const source = (id, entryUrl = 'https://example.test/feed.xml', role = 'LAB_ORIGINAL_ANNOUNCEMENT') => ({ id, entryUrl, role });

test('strictly drops general AI from broad all-site feed and retains embodied robotics', async () => {
  const body = XML(
    item('New language model benchmark', 'https://example.test/ai', 'A new benchmark for language model reasoning.') +
    item('Robot manipulation with VLA', 'https://example.test/robot', 'A vision-language-action model controls a robot arm.')
  );
  const result = await discover(source('deepmind-feed'), context({ text: body }));
  assert.equal(result.coverage.itemCount, 2);
  assert.equal(result.coverage.filteredOut, 1);
  assert.equal(result.candidates.length, 1);
  assert.match(result.candidates[0].title, /Robot manipulation/);
});

test('RSS publication timestamps honor explicit offsets and reject host-local wall-clock dates', async () => {
  const previousTz = process.env.TZ;
  const raw = 'Tue, 29 Sep 2026 10:00:00 +0800';
  const body = XML(item('Robot manipulation update', 'https://example.test/robot', 'A detailed robot manipulation update.', raw));
  try {
    process.env.TZ = 'Pacific/Honolulu';
    const hawaii = await discover(source('deepmind-feed'), context({ text: body }));
    process.env.TZ = 'Asia/Shanghai';
    const shanghai = await discover(source('deepmind-feed'), context({ text: body }));
    assert.equal(hawaii.candidates[0].publishedAt, '2026-09-29T02:00:00.000Z');
    assert.equal(shanghai.candidates[0].publishedAt, hawaii.candidates[0].publishedAt);
    assert.equal(hawaii.candidates[0].publishedAtRaw, raw);

    const unzoned = XML(item('Robot manipulation update', 'https://example.test/robot', 'A detailed robot manipulation update.', 'Tue, 29 Sep 2026 10:00:00'));
    const pending = await discover(source('deepmind-feed'), context({ text: unzoned }));
    assert.equal(pending.candidates[0].publishedAt, null);
    assert.equal(pending.candidates[0].datePrecision, 'unknown');
    assert.match(pending.issues[0].error, /publication date/);

    const dateOnly = XML(item('Robot manipulation update', 'https://example.test/robot', 'A detailed robot manipulation update.', 'September 29, 2026'));
    const dayResult = await discover(source('deepmind-feed'), context({ text: dateOnly }));
    assert.equal(dayResult.candidates[0].publishedAt, '2026-09-29T00:00:00.000Z');
    assert.equal(dayResult.candidates[0].datePrecision, 'day');
    const monthOnly = XML(item('Robot manipulation update', 'https://example.test/robot', 'A detailed robot manipulation update.', 'September 2026'));
    const monthResult = await discover(source('deepmind-feed'), context({ text: monthOnly }));
    assert.equal(monthResult.candidates[0].publishedAt, null);
    assert.equal(monthResult.candidates[0].datePrecision, 'month');
  } finally {
    if (previousTz === undefined) delete process.env.TZ;
    else process.env.TZ = previousTz;
  }
});

test('whole-site feeds reject incidental robotics mentions but retain technical robot work', async () => {
  const educatorTitle = 'Empowering India’s next generation of innovators with ATL Saathi';
  const educatorBody = 'ATL Saathi is a Gemini-powered planning and training assistant for educators. The existing labs offer 3D printing, IoT, and robotics; this article covers teacher onboarding, curriculum modules, and AI-generated learning materials.';
  const edgeAgentTitle = 'TensorRT Edge-LLM Completes the MLPerf Edge Agentic Benchmark';
  const edgeAgentBody = 'The introduction lists vehicles and robots among possible edge-device markets. The benchmark itself replays software-engineering agent conversations and function-calling prompts on a Jetson system; the measured workload is a recorded software task, not a physical task.';
  const rosTitle = 'Accelerating a ROS 2 Node with an AI Agent and NVIDIA Isaac ROS';
  const rosBody = 'GPU acceleration can speed up compute-intensive robotics workloads, but a robot message graph may still serialize or copy sensor data through CPU memory.';

  const educator = evaluateRelevance('deepmind-feed', educatorTitle, educatorBody);
  assert.equal(educator.eligible, false);
  assert.match(educator.reason, /incidental robotics mentions/i);
  const genericEdge = evaluateRelevance('nvidia-developer-feed', edgeAgentTitle, edgeAgentBody);
  assert.equal(genericEdge.eligible, false);
  assert.match(genericEdge.reason, /incidental robotics mentions/i);
  assert.equal(evaluateRelevance('nvidia-developer-feed', rosTitle, rosBody).eligible, true);
  assert.equal(evaluateRelevance('deepmind-feed', 'Gemini Robotics 2 brings whole body intelligence to robots', 'Official announcement of the robotics model and capabilities.').eligible, true);

  const educatorFeed = XML(item(educatorTitle, 'https://deepmind.google/blog/atl-saathi/', educatorBody));
  const filtered = await discover(source('deepmind-feed'), context({ text: educatorFeed }));
  assert.equal(filtered.candidates.length, 0);
  assert.equal(filtered.coverage.filteredOut, 1);
  const nvidiaFeed = XML(item(edgeAgentTitle, 'https://developer.nvidia.com/blog/edge-agentic/', edgeAgentBody) + item(rosTitle, 'https://developer.nvidia.com/blog/isaac-ros/', rosBody));
  const retained = await discover(source('nvidia-developer-feed'), context({ text: nvidiaFeed }));
  assert.equal(retained.candidates.length, 1);
  assert.equal(retained.candidates[0].title, rosTitle);
});

test('RSS pagination re-reads the head and resumes its saved same-origin cursor', async () => {
  const page1 = `<?xml version="1.0"?><rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom"><channel><title>test</title><atom:link rel="next" href="https://example.test/page2.xml"/>${item('Robot manipulation update', 'https://example.test/one', 'A detailed robot manipulation update.')}</channel></rss>`;
  const page2 = XML(item('Embodied VLA paper', 'https://example.test/two', 'A robot vision-language-action manipulation study.'));
  const ctx = context({ text: (url) => ({ text: url.endsWith('page2.xml') ? page2 : page1, url, status: 200, headers: {} }) });
  ctx.maxPages = 1;
  const src = source('deepmind-feed');
  const first = await discover(src, ctx);
  assert.equal(first.nextState.rssCursorUrl, 'https://example.test/page2.xml');
  ctx.state = first.nextState;
  ctx.maxPages = 2;
  const resumed = await discover(src, ctx);
  assert.deepEqual(resumed.candidates.map((candidate) => candidate.id), [first.candidates[0].id, 'deepmind-feed:https://example.test/two']);
  assert.equal(resumed.nextState.rssCursorUrl, null);
});

test('records malformed feed failure and uses GitHub official API fallback for failed release Atom', async () => {
  const ctx = context({ text: () => { throw new Error('fixture network failure'); } });
  ctx.http.get = async (url) => {
    if (url.includes('releases.atom')) throw new Error('fixture timeout');
    return { text: JSON.stringify([{ id: 4, name: 'Robot policy release', tag_name: 'v1', html_url: 'https://github.com/huggingface/lerobot/releases/tag/v1', published_at: '2026-09-29T10:00:00Z', body: 'Robot policy and manipulation training improvements.' }]), url, status: 200, headers: {} };
  };
  const result = await discover(source('lerobot-releases', 'https://github.com/huggingface/lerobot/releases.atom'), ctx);
  assert.equal(result.coverage.entryError, 'fixture timeout');
  assert.match(result.coverage.fallbackUrl, /api.github.com/);
  assert.equal(result.candidates.length, 1);
  assert.equal(result.candidates[0].metadata.fallback, 'github-rest-api');
});

test('GitHub release API follows Link pagination, rereads the head, and overlaps its saved page', async () => {
  const ctx = context();
  ctx.maxPages = 3;
  const pages = [];
  ctx.http.get = async (url) => {
    if (url.endsWith('.atom')) throw new Error('fixture Atom unavailable');
    const page = Number(new URL(url).searchParams.get('page'));
    pages.push(page);
    const releases = Array.from({ length: 100 }, (_, index) => ({
      id: `${page}-${index}`, name: `Robot policy release ${page}-${index}`, tag_name: `v${page}-${index}`,
      html_url: `https://github.com/huggingface/lerobot/releases/tag/v${page}-${index}`,
      published_at: '2026-09-29T10:00:00Z', body: 'Robot policy, manipulation and training release improvements.',
    }));
    return { text: JSON.stringify(releases), url, status: 200, headers: { link: `<https://api.github.com/repos/huggingface/lerobot/releases?per_page=100&page=${page + 1}>; rel="next"` } };
  };
  const src = source('lerobot-releases', 'https://github.com/huggingface/lerobot/releases.atom');
  const first = await discover(src, ctx);
  assert.deepEqual(pages, [1, 2, 3]);
  assert.equal(first.nextState.githubReleasePage, 4);
  ctx.state = first.nextState;
  pages.length = 0;
  const resumed = await discover(src, ctx);
  assert.deepEqual(pages, [1, 3, 4]);
  assert.equal(resumed.nextState.githubReleasePage, 5);
  assert.equal(resumed.coverage.incomplete, true);
});

test('GitHub release one-page fallback budget rotates head, overlap, then advances the saved page', async () => {
  const ctx = context();
  ctx.maxPages = 1;
  const pages = [];
  ctx.http.get = async (url) => {
    if (url.endsWith('.atom')) throw new Error('fixture Atom unavailable');
    const page = Number(new URL(url).searchParams.get('page'));
    pages.push(page);
    const releases = Array.from({ length: 100 }, (_, index) => ({ id: `${page}-${index}`, name: `Robot policy ${page}-${index}`, tag_name: `v${page}-${index}`, html_url: `https://github.com/huggingface/lerobot/releases/tag/v${page}-${index}`, published_at: '2026-09-29T10:00:00Z', body: 'Robot policy and manipulation release.' }));
    return { text: JSON.stringify(releases), url, status: 200, headers: { link: `<https://api.github.com/repos/huggingface/lerobot/releases?per_page=100&page=${page + 1}>; rel="next"` } };
  };
  const src = source('lerobot-releases', 'https://github.com/huggingface/lerobot/releases.atom');
  let result = await discover(src, ctx);
  assert.deepEqual(pages, [1]);
  assert.equal(result.nextState.githubReleasePage, 2);
  assert.equal(result.nextState.githubReleasePhase, 'head');
  for (const [expectedPage, expectedPhase] of [[1, 'overlap'], [1, 'cursor'], [2, 'head']]) {
    ctx.state = result.nextState;
    pages.length = 0;
    result = await discover(src, ctx);
    assert.deepEqual(pages, [expectedPage]);
    assert.equal(result.nextState.githubReleasePage, expectedPage === 2 ? 3 : 2);
    assert.equal(result.nextState.githubReleasePhase, expectedPhase);
  }
});

test('GitHub release failed overlap page is retried before its historical cursor advances', async () => {
  const ctx = context();
  ctx.maxPages = 2;
  const pages = [];
  let failOverlap = false;
  ctx.http.get = async (url) => {
    if (url.endsWith('.atom')) throw new Error('fixture Atom unavailable');
    const page = Number(new URL(url).searchParams.get('page'));
    pages.push(page);
    if (page === 2 && failOverlap) { failOverlap = false; throw new Error('fixture overlap failure'); }
    const releases = Array.from({ length: 100 }, (_, index) => ({ id: `${page}-${index}`, name: `Robot policy ${page}-${index}`, tag_name: `v${page}-${index}`, html_url: `https://github.com/huggingface/lerobot/releases/tag/v${page}-${index}`, published_at: '2026-09-29T10:00:00Z', body: 'Robot policy and manipulation release.' }));
    return { text: JSON.stringify(releases), url, status: 200, headers: { link: `<https://api.github.com/repos/huggingface/lerobot/releases?per_page=100&page=${page + 1}>; rel="next"` } };
  };
  const src = source('lerobot-releases', 'https://github.com/huggingface/lerobot/releases.atom');
  const first = await discover(src, ctx);
  assert.equal(first.nextState.githubReleasePage, 3);
  ctx.state = first.nextState;
  failOverlap = true;
  pages.length = 0;
  const interrupted = await discover(src, ctx);
  assert.deepEqual(pages, [1, 2]);
  assert.equal(interrupted.nextState.githubReleasePage, 3);
  assert.equal(interrupted.nextState.githubReleasePhase, 'overlap');
  ctx.state = interrupted.nextState;
  pages.length = 0;
  const resumed = await discover(src, ctx);
  assert.deepEqual(pages, [2, 3]);
  assert.equal(resumed.nextState.githubReleasePage, 4);
});

test('OpenPI commit pagination preserves its cursor and rereads the page head', async () => {
  const ctx = context();
  ctx.maxPages = 5;
  const pages = [];
  ctx.http.get = async (url) => {
    if (url.endsWith('.atom')) return { text: XML(''), url, status: 200, headers: {} };
    if (url.includes('/releases?')) return { text: '[]', url, status: 200, headers: {} };
    if (url.includes('/commits?')) {
      const page = Number(new URL(url).searchParams.get('page'));
      pages.push(page);
      const commits = Array.from({ length: 100 }, (_, index) => ({
        sha: `${page}${String(index).padStart(39, '0')}`,
        html_url: `https://github.com/Physical-Intelligence/openpi/commit/${page}${String(index).padStart(39, '0')}`,
        commit: { message: 'feat: robot policy evaluation update', committer: { date: '2026-09-29T09:00:00Z' } },
      }));
      return { text: JSON.stringify(commits), url, status: 200, headers: { link: `<https://api.github.com/repos/Physical-Intelligence/openpi/commits?per_page=100&page=${page + 1}>; rel="next"` } };
    }
    throw new Error(`Unexpected URL: ${url}`);
  };
  const src = source('openpi-releases', 'https://github.com/Physical-Intelligence/openpi/releases.atom');
  const first = await discover(src, ctx);
  assert.deepEqual(pages, [1, 2, 3]);
  assert.equal(first.nextState.githubCommitPage, 4);
  ctx.state = first.nextState;
  pages.length = 0;
  const resumed = await discover(src, ctx);
  assert.deepEqual(pages, [1, 3, 4]);
  assert.equal(resumed.nextState.githubCommitPage, 5);
  assert.equal(resumed.coverage.incomplete, true);
});

test('OpenPI commit one-page budget progresses after the RSS and empty-release pages', async () => {
  const ctx = context();
  ctx.maxPages = 3; // RSS + empty releases leave one commits page per run.
  const pages = [];
  ctx.http.get = async (url) => {
    if (url.endsWith('.atom')) return { text: XML(''), url, status: 200, headers: {} };
    if (url.includes('/releases?')) return { text: '[]', url, status: 200, headers: {} };
    if (url.includes('/commits?')) {
      const page = Number(new URL(url).searchParams.get('page'));
      pages.push(page);
      const commits = Array.from({ length: 100 }, (_, index) => ({ sha: `${page}${String(index).padStart(39, '0')}`, html_url: `https://github.com/Physical-Intelligence/openpi/commit/${page}${String(index).padStart(39, '0')}`, commit: { message: 'feat: robot policy update', committer: { date: '2026-09-29T09:00:00Z' } } }));
      return { text: JSON.stringify(commits), url, status: 200, headers: { link: `<https://api.github.com/repos/Physical-Intelligence/openpi/commits?per_page=100&page=${page + 1}>; rel="next"` } };
    }
    throw new Error(`Unexpected URL: ${url}`);
  };
  const src = source('openpi-releases', 'https://github.com/Physical-Intelligence/openpi/releases.atom');
  let result = await discover(src, ctx);
  assert.deepEqual(pages, [1]);
  assert.equal(result.nextState.githubCommitPage, 2);
  for (const [expectedPage, expectedPhase] of [[1, 'overlap'], [1, 'cursor'], [2, 'head']]) {
    ctx.state = result.nextState;
    pages.length = 0;
    result = await discover(src, ctx);
    assert.deepEqual(pages, [expectedPage]);
    assert.equal(result.nextState.githubCommitPage, expectedPage === 2 ? 3 : 2);
    assert.equal(result.nextState.githubCommitPhase, expectedPhase);
  }
});

test('hydrate rejects undated candidates without manufacturing a date', async () => {
  const candidate = { id: 'x', url: 'https://example.test/post', title: 'robot', publishedAt: null, publishedAtRaw: null, datePrecision: 'unknown', metadata: {} };
  await assert.rejects(hydrate(candidate, source('deepmind-feed'), context()), /Missing precise publication date/);
});

test('hydrate requires retrieved body even when feed title exists', async () => {
  const candidate = { id: 'x', url: 'https://example.test/post', title: 'robot', publishedAt: '2026-09-29T10:00:00Z', publishedAtRaw: 'Tue, 29 Sep 2026 10:00:00 GMT', datePrecision: 'second', metadata: {} };
  const ctx = context();
  ctx.html.article = () => ({ title: 'robot', content: 'tiny', publishedAtRaw: null, datePrecision: 'unknown', links: [], authors: [] });
  await assert.rejects(hydrate(candidate, source('deepmind-feed'), ctx), /Article body unavailable/);
});

test('Qbit financial roundups stay persisted as excluded candidates', async () => {
  const title = '36家敲钟的机器人公司：赚钱能力差距巨大，商业化也不玩花架子了';
  const body = XML(item(title, 'https://www.qbitai.com/2026/09/499280.html', '36家上市机器人公司的财报、营收与商业化盘点。'));
  const result = await discover(source('qbitai-feed'), context({ text: body }));
  assert.equal(result.candidates.length, 1);
  assert.equal(result.candidates[0].metadata.eligibility, 'excluded_financial_roundup');
  assert.match(result.candidates[0].metadata.exclusionReason, /financial roundup/i);
  assert.equal(evaluateRelevance('qbitai-feed', title, '36家上市机器人公司的财报、营收与商业化盘点。').eligible, false);
});

test('arXiv uses exact v1 submitted time and keeps feed announcement and latest version separate', async () => {
  const body = XML(item('Original feed title', 'https://arxiv.org/abs/2609.12345', 'Robotic manipulation research.'));
  const ctx = context({ text: body });
  ctx.http.get = async (url) => url.includes('export.arxiv.org')
    ? ({ text: `<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom"><entry><title>Paper title from arXiv</title><published>2026-09-28T07:14:08Z</published><updated>2026-09-29T12:10:00Z</updated><summary>${'A sufficiently detailed abstract on manipulation. '.repeat(5)}</summary><author><name>Researcher A</name></author></entry></feed>`, url, status: 200, headers: {} })
    : ({ text: body, url, status: 200, headers: {} });
  const candidate = (await discover(source('arxiv-cs-ro'), ctx)).candidates[0];
  const result = await hydrate(candidate, source('arxiv-cs-ro'), ctx);
  assert.equal(result.publishedAt, '2026-09-28T07:14:08.000Z');
  assert.equal(result.metadata.feedAnnouncedAt, candidate.publishedAt);
  assert.equal(result.metadata.sourcePublishedAt, result.publishedAt);
  assert.equal(result.metadata.latestVersionUpdatedAt, '2026-09-29T12:10:00.000Z');
  assert.equal(result.title, 'Paper title from arXiv');
  assert.equal(result.authors[0], 'Researcher A');
  assert.match(result.raw.url, /export\.arxiv\.org\/api/);
});

test('arXiv bounded update window finds older papers and hydrates original fields from Export API', async () => {
  const paper = arxivEntry({ id: '2204.01234', published: '2022-04-12T09:30:00Z' });
  const body = XML('');
  const ctx = context({ text: body });
  ctx.maxPages = 3;
  const requests = [];
  ctx.http.get = async (url, options = {}) => {
    requests.push({ url, options });
    if (url.includes('/api/query?')) return { text: arxivFeed([paper]), url, status: 200, headers: {} };
    if (url.includes('arxiv.org/api/query?id_list=')) return { text: arxivFeed([paper]), url, status: 200, headers: {} };
    return { text: body, url, status: 200, headers: {} };
  };
  const src = source('arxiv-cs-ro', 'https://rss.arxiv.org/rss/cs.RO', 'RESEARCH_PREPRINT');
  const found = await discover(src, ctx);
  assert.equal(found.candidates.length, 1);
  assert.equal(found.candidates[0].publishedAt, '2022-04-12T09:30:00.000Z');
  assert.equal(found.candidates[0].metadata.arxivUpdatedAt, '2026-09-29T10:00:00.000Z');
  assert.equal(found.candidates[0].metadata.fallback, 'arxiv-export-api-window');
  const query = new URL(requests.find(({ url }) => url.includes('/api/query?')).url);
  assert.equal(query.searchParams.get('search_query'), 'cat:cs.RO');
  assert.equal(query.searchParams.get('sortBy'), 'lastUpdatedDate');
  assert.equal(query.searchParams.get('max_results'), '100');
  assert.equal(requests.find(({ url }) => url.includes('/api/query?')).options.cacheMs, 86400000);
  const hydrated = await hydrate(found.candidates[0], src, ctx);
  assert.equal(hydrated.publishedAt, '2022-04-12T09:30:00.000Z');
  assert.equal(hydrated.metadata.latestVersionUpdatedAt, '2026-09-29T10:00:00.000Z');
  assert.equal(hydrated.authors[0], 'Researcher One');
  assert.match(hydrated.content, /detailed robot manipulation study/);
  assert.match(hydrated.raw.url, /export\.arxiv\.org\/api\/query\?id_list=/);
});

test('arXiv interrupted page keeps frozen window and resumes after re-reading a changed head', async () => {
  const original = Array.from({ length: 100 }, (_, index) => arxivEntry({ id: `2609.${String(index + 1).padStart(5, '0')}` }));
  const body = XML('');
  const ctx = context({ text: body });
  ctx.maxPages = 3;
  let failCursorPage = true;
  let insertedSeen = false;
  const requestedStarts = [];
  ctx.http.get = async (url) => {
    if (url.includes('/api/query?')) {
      const query = new URL(url);
      const start = Number(query.searchParams.get('start'));
      requestedStarts.push(start);
      if (start === 100 && failCursorPage) { failCursorPage = false; throw new Error('interrupted cursor page'); }
      if (start === 0 && requestedStarts.filter((value) => value === 0).length > 1) {
        insertedSeen = true;
        return { text: arxivFeed([arxivEntry({ id: '2610.00001', title: 'New head robot manipulation paper' }), ...original.slice(0, 99)]), url, status: 200, headers: {} };
      }
      return { text: arxivFeed(start === 0 ? original : [arxivEntry({ id: '2501.99999', title: 'Older robot manipulation paper' })]), url, status: 200, headers: {} };
    }
    return { text: body, url, status: 200, headers: {} };
  };
  const src = source('arxiv-cs-ro', 'https://rss.arxiv.org/rss/cs.RO', 'RESEARCH_PREPRINT');
  const firstRun = await discover(src, ctx);
  assert.equal(firstRun.coverage.arxivApiPagesFetched, 1);
  assert.equal(firstRun.nextState.arxiv.window.start, 100);
  assert.equal(firstRun.nextState.arxiv.window.to, ctx.now);
  assert.equal(firstRun.nextState.arxiv.lastCompleteAt, undefined);
  assert.equal(firstRun.candidates.length, 100);

  ctx.state = firstRun.nextState;
  const resumed = await discover(src, ctx);
  assert.deepEqual(requestedStarts.slice(-2), [0, 50]);
  assert.equal(insertedSeen, true);
  assert.ok(resumed.candidates.some((candidate) => candidate.id === 'arxiv-cs-ro:2610.00001'));
  assert.equal(resumed.nextState.arxiv.window, null);
  assert.equal(resumed.nextState.arxiv.lastCompleteAt, ctx.now);
});

test('arXiv one-API-page budget resumes overlapping history instead of rereading only the head', async () => {
  const body = XML('');
  const ctx = context({ text: body });
  ctx.maxPages = 2; // RSS consumes one, leaving one Export API request.
  const starts = [];
  ctx.http.get = async (url) => {
    if (url.includes('/api/query?')) {
      const start = Number(new URL(url).searchParams.get('start'));
      starts.push(start);
      const entries = Array.from({ length: 100 }, (_, index) => arxivEntry({ id: `2610.${String(start + index).padStart(5, '0')}` }));
      return { text: arxivFeed(entries), url, status: 200, headers: {} };
    }
    return { text: body, url, status: 200, headers: {} };
  };
  const src = source('arxiv-cs-ro', 'https://rss.arxiv.org/rss/cs.RO', 'RESEARCH_PREPRINT');
  let result = await discover(src, ctx);
  assert.deepEqual(result.coverage.arxivApiStarts, [0]);
  assert.equal(result.nextState.arxiv.window.start, 100);

  ctx.state = result.nextState;
  result = await discover(src, ctx);
  assert.deepEqual(result.coverage.arxivApiStarts, [50]);
  assert.equal(result.nextState.arxiv.window.start, 150);
  assert.match(result.coverage.arxivResumePolicy, /RSS head refreshed each run/);
  ctx.state = result.nextState;
  result = await discover(src, ctx);
  assert.deepEqual(result.coverage.arxivApiStarts, [100]);
  assert.equal(result.nextState.arxiv.window.start, 200);
  let failOnce = true;
  const previousGet = ctx.http.get;
  ctx.http.get = async (url, options) => {
    if (url.includes('/api/query?') && Number(new URL(url).searchParams.get('start')) === 150 && failOnce) {
      failOnce = false;
      starts.push(150);
      throw new Error('cursor page interrupted');
    }
    return previousGet(url, options);
  };
  ctx.state = result.nextState;
  const interrupted = await discover(src, ctx);
  assert.equal(interrupted.nextState.arxiv.window.start, 200);
  ctx.state = interrupted.nextState;
  result = await discover(src, ctx);
  assert.equal(result.nextState.arxiv.window.start, 250);
  assert.deepEqual(starts, [0, 50, 100, 150, 150]);
});

test('empty OpenPI releases are labeled separately from official commit updates', async () => {
  const commitDate = '2026-09-29T09:00:00Z';
  const sha = 'abcdef123456';
  const ctx = context();
  ctx.http.get = async (url) => {
    if (url.endsWith('.atom')) return { text: XML(''), url, status: 200, headers: {} };
    if (url.includes('/releases?')) return { text: '[]', url, status: 200, headers: {} };
    if (url.endsWith(`/commits/${sha}`)) return { text: JSON.stringify({ commit: { message: 'Add an important robot policy evaluation and training update', committer: { date: commitDate } }, files: [{ filename: 'src/eval.py', status: 'modified', patch: '+robot policy evaluation' }] }), url, status: 200, headers: {} };
    if (url.includes('/commits?')) return { text: JSON.stringify([{ sha, html_url: `https://github.com/Physical-Intelligence/openpi/commit/${sha}`, commit: { message: 'Add an important robot policy evaluation and training update', committer: { date: commitDate } } }]), url, status: 200, headers: {} };
    throw new Error(`Unexpected URL: ${url}`);
  };
  const src = source('openpi-releases', 'https://github.com/Physical-Intelligence/openpi/releases.atom', 'MAINTAINER_RELEASE');
  const found = await discover(src, ctx);
  assert.equal(found.coverage.emptyFeed, true);
  assert.equal(found.coverage.fallbackItemCount, 0);
  assert.equal(found.coverage.commitAlternativeStatus, 200);
  assert.equal(found.candidates[0].metadata.kind, 'project_code_update');
  assert.equal(found.candidates[0].metadata.dateSemantics, 'commit_date');
  const hydrated = await hydrate(found.candidates[0], src, ctx);
  assert.equal(hydrated.publishedAt, '2026-09-29T09:00:00.000Z');
  assert.match(hydrated.content, /robot policy evaluation/);
  assert.equal(hydrated.metadata.kind, 'project_code_update');
});

test('IEEE Video Friday splits a mapped project segment and hydrates its original page', async () => {
  const entry = XML(item('Video Friday: Robot Research', 'https://spectrum.ieee.org/video-friday-robot-research', 'Robot research projects and robot demonstrations.'));
  const segmentPage = '<article class="article_post--body-and-tags"><blockquote class="rm-anchors">ULOHA uses two underwater robot arms to collect demonstrations and perform bimanual manipulation in water. This project includes an autonomous manipulation evaluation and results.</blockquote><p>[ <a href="https://mertcookimg.github.io/uloha/">ULOHA</a> ]</p></article>';
  const ctx = context({ text: entry });
  const parseArticle = ctx.html.article;
  ctx.html.article = (html, url) => url.includes('mertcookimg.github.io/uloha')
    ? { title: 'ULOHA: Underwater Bimanual Robot Learning', content: 'This project describes two underwater robot arms, demonstration data collection, autonomous manipulation experiments, hardware and evaluation results. It includes detailed task and system conditions.', publishedAt: null, publishedAtRaw: null, datePrecision: 'unknown', links: [], authors: [] }
    : parseArticle(html, url);
  ctx.http.get = async (url) => {
    if (url.includes('/feeds/topic/')) return { text: entry, url, status: 200, headers: { 'content-type': 'application/rss+xml' } };
    if (url.includes('video-friday-robot-research')) return { text: segmentPage, url, status: 200, headers: { 'content-type': 'text/html' } };
    if (url.includes('mertcookimg.github.io/uloha')) return { text: '<html><head><title>ULOHA: Underwater Bimanual Robot Learning</title></head><body><main><article><h1>ULOHA: Underwater Bimanual Robot Learning</h1><p>This project describes two underwater robot arms, demonstration data collection, autonomous manipulation experiments, hardware and evaluation results. It includes detailed task and system conditions.</p></article></main></body></html>', url, status: 200, headers: { 'content-type': 'text/html' } };
    throw new Error(`Unexpected URL: ${url}`);
  };
  const src = source('ieee-robotics-feed', 'https://spectrum.ieee.org/feeds/topic/robotics.rss');
  const found = await discover(src, ctx);
  assert.equal(found.coverage.itemCount, 1);
  assert.equal(found.coverage.roundupSegments, 1);
  assert.equal(found.candidates[0].metadata.segmentUrl, 'https://mertcookimg.github.io/uloha/');
  assert.match(found.candidates[0].metadata.segmentContext, /underwater robot arms/i);
  const result = await hydrate(found.candidates[0], src, ctx);
  assert.equal(result.raw.url, 'https://mertcookimg.github.io/uloha/');
  assert.match(result.content, /evaluation results/);
  assert.equal(result.evidence[0].relation, 'original');
  assert.equal(result.evidence[0].url, 'https://mertcookimg.github.io/uloha/');
  assert.equal(result.evidence[0].kind, 'project');
});

test('GitHub release hydrate uses original published_at and preserves Atom updated time', async () => {
  const feedUpdated = '2026-09-02T10:05:00Z';
  const releasePublished = '2026-09-02T10:00:00Z';
  const ctx = context();
  ctx.http.get = async (url) => {
    if (url.endsWith('/releases/tag/v0.6.1')) return { text: `<article class="release-entry"><relative-time datetime="${releasePublished}">${releasePublished}</relative-time><div class="markdown-body">${'Actual release notes body with robot dataset and policy updates. '.repeat(4)}</div></article>`, url, status: 200, headers: { 'content-type': 'text/html' } };
    if (url.includes('/releases/tags/v0.6.1')) return { text: JSON.stringify({ tag_name: 'v0.6.1', published_at: releasePublished, created_at: '2026-09-02T09:58:00Z', updated_at: feedUpdated }), url, status: 200, headers: {} };
    throw new Error(`Unexpected URL: ${url}`);
  };
  const candidate = { id: 'lerobot-releases:v0.6.1', url: 'https://github.com/huggingface/lerobot/releases/tag/v0.6.1', title: 'Release v0.6.1', publishedAt: feedUpdated, publishedAtRaw: feedUpdated, datePrecision: 'second', metadata: { feedId: 'lerobot-releases', feedUrl: 'https://github.com/huggingface/lerobot/releases.atom' } };
  const result = await hydrate(candidate, source('lerobot-releases'), ctx);
  assert.equal(result.publishedAt, '2026-09-02T10:00:00.000Z');
  assert.equal(result.metadata.feedUpdatedAt, feedUpdated);
  assert.equal(result.metadata.releaseUpdatedAt, feedUpdated);
  assert.equal(result.metadata.sourcePublishedAt, result.publishedAt);
  assert.match(result.content, /Actual release notes body/);
});

test('GitHub release hydrate uses official API notes when the release page omits its body', async () => {
  const publishedAt = '2026-09-02T10:00:00Z';
  const releaseBody = 'Maintainer release notes for the robot policy and manipulation stack. '.repeat(3);
  const ctx = context();
  let browserCalls = 0;
  ctx.browser.get = async () => { browserCalls++; throw new Error('browser fallback should not be needed'); };
  ctx.http.get = async (url) => {
    if (url.endsWith('/releases/tag/v0.7.0')) return { text: '<html><body><div class="markdown-body"></div></body></html>', url, status: 200, headers: { 'content-type': 'text/html' } };
    if (url.endsWith('/releases/tags/v0.7.0')) return { text: JSON.stringify({ name: 'v0.7.0', tag_name: 'v0.7.0', body: releaseBody, published_at: publishedAt, updated_at: publishedAt }), url, status: 200, headers: { 'content-type': 'application/vnd.github+json' } };
    throw new Error(`Unexpected URL: ${url}`);
  };
  const candidate = { id: 'lerobot-releases:v0.7.0', url: 'https://github.com/huggingface/lerobot/releases/tag/v0.7.0', title: 'Release v0.7.0', publishedAt, publishedAtRaw: publishedAt, datePrecision: 'second', metadata: { feedId: 'lerobot-releases', feedUrl: 'https://github.com/huggingface/lerobot/releases.atom' } };
  const result = await hydrate(candidate, source('lerobot-releases'), ctx);
  assert.equal(result.publishedAt, '2026-09-02T10:00:00.000Z');
  assert.equal(result.metadata.releaseBodySource, 'github-releases-api');
  assert.equal(result.metadata.releaseBodyEvidenceUrl, 'https://api.github.com/repos/huggingface/lerobot/releases/tags/v0.7.0');
  assert.equal(result.raw.url, result.metadata.releaseBodyEvidenceUrl);
  assert.equal(result.raw.mediaType, 'application/vnd.github+json');
  assert.match(result.content, /Maintainer release notes/);
  assert.equal(browserCalls, 0);
});
