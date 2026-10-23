const timezone = 'Asia/Shanghai';
const day = value => new Intl.DateTimeFormat('sv-SE', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(value));
const text = value => String(value || '').replace(/\s+/g, ' ').trim().replace(/[\\`*_\[\]<>|]/g, '\\$&');
const link = value => new URL(value).href.replace(/[<>]/g, c => encodeURIComponent(c));

export function buildDigest({ items, config, run = null, now = new Date(), hours = 24, limit = Infinity, collectedThisRun = false }) {
  const end = new Date(now).getTime();
  const start = end - hours * 3600000;
  const active = new Map(config.sources.map(source => [source.id, source]));
  const scoped = items.filter(item => {
    const source = active.get(item.sourceId);
    if (!source) return false;
    return item.channelId === 'primary' || /^profile-\d+$/.test(item.channelId || '') && Number(item.channelId.slice(8)) <= (source.officialProfiles || []).length;
  }).sort((a, b) => Date.parse(b.publishedAt) - Date.parse(a.publishedAt));
  const within = (item, from) => item.datePrecision === 'day'
    ? item.publishedAt.slice(0, 10) >= day(from) && item.publishedAt.slice(0, 10) <= day(end)
    : Date.parse(item.publishedAt) >= from && Date.parse(item.publishedAt) <= end;
  function events(rows) {
    const seen = new Map();
    for (const item of rows) {
      const key = item.eventId || item.url;
      if (!seen.has(key)) seen.set(key, { ...item, relatedSources: [] });
      seen.get(key).relatedSources.push({ name: active.get(item.sourceId).name, url: item.url });
    }
    return [...seen.values()];
  }
  const fresh = events(scoped.filter(item => within(item, start)));
  const recent = fresh.length ? [] : events(scoped.filter(item => within(item, end - 7 * 86400000)));
  const selected = (fresh.length ? fresh : recent).slice(0, limit);
  const health = config.sources.flatMap(source => ['primary', ...(source.officialProfiles || []).map((_, i) => `profile-${i + 1}`)].map(channelId => {
    const row = run?.channels?.find(channel => channel.sourceId === source.id && channel.channelId === channelId);
    return { sourceId: source.id, name: source.name, channelId, status: row?.status || 'not_checked', accepted: row?.accepted || 0, failed: row?.failed || 0, issues: row?.issues || [] };
  }));
  const data = { generatedAt: new Date(end).toISOString(), timezone, date: day(end), window: { from: new Date(start).toISOString(), to: new Date(end).toISOString(), hours }, collectedThisRun, latestCollectionAt: run?.finishedAt || null, freshEvents: fresh.length, selectedEvents: selected.length, mode: fresh.length ? 'daily' : recent.length ? 'recent_review' : 'no_recent_items', sourceHealth: health, items: selected };
  const lines = [`# 具身智能日报 · ${data.date}`, '', `生成时间：${new Date(end).toLocaleString('zh-CN', { timeZone: timezone, hour12: false })}（北京时间）`, '', `本期按原始发布日期查看过去 ${hours} 小时，找到 ${fresh.length} 个事件。日精度来源按对应自然日纳入，不能当作精确到小时的时间。`, ''];
  if (!collectedThisRun) lines.push('本次仅整理已有消息库，未重新联网采集。', '');
  if (data.mode === 'recent_review') lines.push('## 近七天回顾', '', '本期时间窗口内暂无合格消息。以下为近七天资料，明确作为回顾，不计入今日新增。', '');
  else if (data.mode === 'no_recent_items') lines.push('本期及近七天暂无已入库的合格消息。请结合下方来源状态判断，不能据此断言行业没有新进展。', '');
  else lines.push('## 本期消息', '');
  for (const [index, item] of selected.entries()) {
    const source = active.get(item.sourceId);
    const excerpt = item.content.replace(/\s+/g, ' ').trim();
    lines.push(`### ${index + 1}. ${text(item.title)}`, '', `来源：${text(source.name)} · 原始日期：${text(item.publishedAtRaw || item.publishedAt)} · 证据类别：${text(item.evidenceClass)}`, '', `原文摘录：${text(excerpt.slice(0, 320))}${excerpt.length > 320 ? '…' : ''}`, '', `[阅读原文](<${link(item.url)}>)`);
    const original = (item.evidence || []).filter(e => e.relation === 'original' && e.url !== item.url);
    if (original.length) lines.push('', '原始证据：' + original.map((e, i) => `[${i + 1}](<${link(e.url)}>)`).join('、'));
    if (item.relatedSources.length > 1) lines.push('', '同一事件的其他来源：' + item.relatedSources.slice(1).map(s => `[${text(s.name)}](<${link(s.url)}>)`).join('、'));
    lines.push('');
  }
  const labels = { sample_verified: '已采到合格条目', degraded: '部分成功', blocked: '未取得合格条目', not_checked: '本轮未检查' };
  lines.push('## 来源状态', '', '| 来源 / 入口 | 本轮结果 | 合格条目 | 失败条目 |', '| --- | --- | ---: | ---: |');
  for (const row of health) lines.push(`| ${text(row.name)} / ${row.channelId} | ${labels[row.status] || text(row.status)} | ${row.accepted} | ${row.failed} |`);
  lines.push('', '原文摘录保留来源语言。本程序未调用付费模型，不将企业声明或演示自动认定为独立验证。完整原文、失败原因和时间记录保存在本地消息库与本次运行日志中。', '');
  return { data, markdown: lines.join('\n') };
}
