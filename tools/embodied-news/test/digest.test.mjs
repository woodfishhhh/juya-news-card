import test from 'node:test';
import assert from 'node:assert/strict';
import { buildDigest } from '../lib/digest.mjs';

const config = { sources: [{ id: 'robot', name: '机器人官方', officialProfiles: [] }] };
const now = new Date('2026-10-11T01:00:00Z');
const item = { sourceId: 'robot', channelId: 'primary', eventId: 'event-one', title: 'Robot release', url: 'https://example.org/robot', publishedAt: '2026-10-10T12:00:00Z', publishedAtRaw: '2026-10-10', datePrecision: 'second', content: 'A documented robotics release with known limitations.', evidenceClass: 'official_announcement', evidence: [] };

test('expanded subscriptions do not silently cap a qualified issue at twenty events', () => {
  const items=Array.from({length:27},(_,i)=>({...item,eventId:`event-${i}`,url:`https://example.org/robot-${i}`}));
  assert.equal(buildDigest({config,now,items}).data.selectedEvents,27);
  assert.equal(buildDigest({config,now,items,limit:4}).data.selectedEvents,4);
});

test('daily digest deduplicates events and excludes retired sources and future precise timestamps', () => {
  const result = buildDigest({ config, now, items: [item, { ...item, url: 'https://example.org/second' }, { ...item, sourceId: 'retired', eventId: 'other' }, { ...item, eventId: 'future', publishedAt: '2026-10-12T00:00:00Z' }] });
  assert.equal(result.data.freshEvents, 1);
  assert.equal(result.data.items[0].relatedSources.length, 2);
  assert.match(result.markdown, /未重新联网采集/);
});

test('historical items appear only as an explicitly labelled seven-day review', () => {
  const result = buildDigest({ config, now, items: [{ ...item, publishedAt: '2026-10-08T00:00:00Z' }, { ...item, eventId: 'old', publishedAt: '2026-09-30T00:00:00Z' }] });
  assert.equal(result.data.freshEvents, 0);
  assert.equal(result.data.selectedEvents, 1);
  assert.equal(result.data.mode, 'recent_review');
  assert.match(result.markdown, /不计入今日新增/);
});

test('day precision, unverified sources and Markdown-like titles remain explicit', () => {
  const result = buildDigest({ config, now, collectedThisRun: true, items: [{ ...item, title: '<script>[fake](url)', datePrecision: 'day', publishedAt: '2026-10-11T00:00:00Z' }], run: { channels: [{ sourceId: 'robot', channelId: 'primary', status: 'blocked', accepted: 0, failed: 1 }] } });
  assert.equal(result.data.freshEvents, 1);
  assert.equal(result.data.sourceHealth[0].status, 'blocked');
  assert.match(result.markdown, /不能当作精确到小时/);
  assert.ok(!result.markdown.includes('<script>'));
  assert.match(result.markdown, /未取得合格条目/);
});
