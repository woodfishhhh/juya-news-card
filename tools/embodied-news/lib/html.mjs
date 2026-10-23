import { load } from 'cheerio';
export { load };
export function text(value) {
  const $ = load(String(value || ''));
  $('script,style,noscript,nav,footer,header').remove();
  return $.root().text().replace(/[\t\r ]+/g, ' ').replace(/\n\s*\n+/g, '\n\n').trim();
}
export function absolute(value, base) {
  try { const u = new URL(value, base); return /^https?:$/.test(u.protocol) ? u.href : null; } catch { return null; }
}
export function date(value) {
  const raw = String(value || '').trim();
  if (!raw) return { publishedAt: null, publishedAtRaw: raw, datePrecision: 'unknown' };
  let precision = 'second';
  let normal = raw.replace(/年|\//g, '-').replace(/月/g, '-').replace(/日/g, '').trim();
  if (/^\d{4}$/.test(normal)) { precision = 'year'; normal += '-01-01'; }
  else if (/^\d{4}-\d{1,2}$/.test(normal)) { precision = 'month'; normal += '-01'; }
  else if (/^\d{4}-\d{1,2}-\d{1,2}$/.test(normal) || (!/[T:]\d/.test(normal) && !/\d{1,2}:\d{2}/.test(normal))) precision = 'day';
  const ms = Date.parse(normal);
  return { publishedAt: Number.isFinite(ms) ? new Date(ms).toISOString() : null, publishedAtRaw: raw, datePrecision: Number.isFinite(ms) ? precision : 'unknown' };
}
export function article(html, url) {
  const $ = load(html);
  const json = [];
  $('script[type="application/ld+json"]').each((_, el) => {
    try { const o = JSON.parse($(el).text()); json.push(...(Array.isArray(o) ? o : [o]), ...(o['@graph'] || [])); } catch {}
  });
  const news = json.find(o => /Article|BlogPosting|NewsArticle|ScholarlyArticle|VideoObject/.test(String(o['@type']))) || {};
  const title = text(news.headline || $('meta[property="og:title"]').attr('content') || $('h1').first().text() || $('title').text());
  const rawDate = news.datePublished || $('meta[property="article:published_time"]').attr('content') || $('meta[name="date"],meta[name="pubdate"],meta[itemprop="datePublished"]').first().attr('content') || $('time[datetime]').first().attr('datetime') || '';
  $('script,style,noscript,nav,header,footer,.menu,.sidebar,.related,.share,.cookie-banner').remove();
  let body = $('[itemprop="articleBody"],.entry-content,.article-content,.post-content,article,main').first();
  if (!body.length) body = $('body');
  const content = text(news.articleBody || body.html());
  const links = [];
  body.find('a[href]').each((_, el) => { const href = absolute($(el).attr('href'), url); if (href) links.push({ url: href, title: text($(el).text()) }); });
  const author = news.author || $('meta[name="author"]').attr('content');
  return { title, content, ...date(rawDate), links, authors: (Array.isArray(author) ? author : author ? [author] : []).map(a => typeof a === 'string' ? a : a.name).filter(Boolean) };
}
