import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';

// Public DOM records captured by the supported cloud browser. No cookies,
// tokens, account identifiers or browser-profile copying is permitted here.
export async function loadXObservation(file, profileUrl, { now = Date.now(), maxAgeMs = 600000 } = {}) {
  const raw = await readFile(file, 'utf8');
  const data = JSON.parse(raw);
  if (data.schemaVersion !== 1 || data.method !== 'supported-cloud-browser-public-dom') throw new Error('Unsupported browser observation format');
  if (data.profileUrl !== profileUrl || data.originalText !== true) throw new Error('Browser observation profile/original-text mismatch');
  const zonedSecond = /^([0-9]{4})-([0-9]{2})-([0-9]{2})T([0-9]{2}):([0-9]{2}):([0-9]{2})(?:\.[0-9]+)?(?:Z|[+-][0-9]{2}:[0-9]{2})$/;
  const validTimestamp = value => {
    const match = zonedSecond.exec(String(value || ''));
    if (!match || !Number.isFinite(Date.parse(value))) return false;
    const [year,month,day,hour,minute,second] = match.slice(1).map(Number);
    const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
    const days = [31,leap ? 29 : 28,31,30,31,30,31,31,30,31,30,31];
    return month>=1 && month<=12 && day>=1 && day<=days[month-1] && hour<24 && minute<60 && second<60;
  };
  if (!validTimestamp(data.capturedAt)) throw new Error('Capture time requires a valid zoned second-precision timestamp');
  const captured = Date.parse(data.capturedAt);
  if (!Number.isFinite(captured) || captured > now + 60000 || now - captured > maxAgeMs) throw new Error('Fresh cloud browser observation required; cached records cannot prove live collection');
  if (!Array.isArray(data.posts) || !data.posts.length) throw new Error('Browser observation contains no posts');
  const profile = new URL(profileUrl);
  const expected = profile.pathname.replace(/\/$/, '').toLowerCase();
  for (const post of data.posts) {
    const allowed = new Set(['url','author','text','publishedAt','dateLabel','originalText','expanded','detailVerifiedAt']);
    if (Object.keys(post).some(key=>!allowed.has(key))) throw new Error('Browser observation contains non-public-schema fields');
    if (!validTimestamp(post.publishedAt) || !validTimestamp(post.detailVerifiedAt)) throw new Error('Post dates require zoned second-precision timestamps');
    const url = new URL(post.url);
    const match = url.pathname.match(/^\/([^/]+)\/status\/(\d+)$/);
    if (url.username || url.password || url.search || url.hash || url.origin !== 'https://x.com' || !match || ('/' + match[1]).toLowerCase() !== expected || post.author?.toLowerCase() !== expected) throw new Error('Browser observation is not a post by the configured official account');
    if (post.originalText !== true || post.expanded !== true || !post.text?.trim() || !Number.isFinite(Date.parse(post.publishedAt))) throw new Error('Browser post requires expanded original text and precise publication date');
    if (Date.parse(post.publishedAt) > Date.parse(post.detailVerifiedAt)) throw new Error('Publication time cannot be after the observed post detail');
    if (!Number.isFinite(Date.parse(post.detailVerifiedAt)) || Date.parse(post.detailVerifiedAt) > captured || captured - Date.parse(post.detailVerifiedAt) > maxAgeMs) throw new Error('Fresh post-detail verification is required');
  }
  return { ...data, raw, digest: createHash('sha256').update(raw).digest('hex') };
}
