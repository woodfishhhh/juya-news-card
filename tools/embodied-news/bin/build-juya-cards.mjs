import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve, join, dirname, basename, extname, sep } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';

const args = {};
for (let i = 2; i < process.argv.length; i += 2) {
  if (!['--content-file', '--output', '--juya-root', '--serve', '--port'].includes(process.argv[i]) || process.argv[i + 1] === undefined) {
    throw new Error('Arguments use --content-file, --output, --juya-root, --serve or --port followed by a value');
  }
  args[process.argv[i].slice(2)] = process.argv[i + 1];
}
if (!args['content-file'] || !args.output) throw new Error('--content-file and --output are required');
const contentPath = resolve(args['content-file']);
const output = resolve(args.output);
const juyaRoot = resolve(args['juya-root'] || process.env.JUYA_ROOT || fileURLToPath(new URL('../../..', import.meta.url)));
const pack = JSON.parse(await readFile(contentPath, 'utf8'));
const pages = pack.pages || [pack];
const templateId = pack.template || 'claudeStyle';
const sourceLabel = pack.language === 'en' ? 'Source: ' : '来源：';
const { generateTemplateHtml } = await import(pathToFileURL(join(juyaRoot, 'src/templates/ssr-runtime.ts')).href);
const { TEMPLATES } = await import(pathToFileURL(join(juyaRoot, 'src/templates/index.ts')).href);
if (!TEMPLATES[templateId]?.ssrReady) throw new Error('Juya template is not SSR-ready: ' + templateId);

const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const highlight = value => {
  // Work on text nodes only, preserving any existing authored markup.
  return String(value).split(/(<[^>]*>)/g).map(part => part.startsWith('<') ? part : part
    .replace(/\b(?:ProxyArray|RobotStudio|MuJoCo-Warp|Fashion Inductor|AI Robot Trainer|OmniCore|Newton|PyTorch|CUDA|MPC|Agility Arc|Komodo|Cantilever|CRIA|CFree|IMPACT|Umi)\b/g, '<code>$&</code>')
    .replace(/\b\d[\d,.]*(?:%|×|:1)?/g, '<strong>$&</strong>')).join('');
};
const font = await readFile(join(juyaRoot, 'public/assets/htmlFont.ttf'));
await mkdir(output, { recursive: true });
const manifest = {
  generatedAt: new Date().toISOString(), engine: 'juya-news-card native React SSR',
  templateId, juyaRoot, viewport: { width: 1920, height: 1080, deviceScaleFactor: 1 },
  screenshotTransport: 'ego-browser', contentPath,
  contentSha256: createHash('sha256').update(await readFile(contentPath)).digest('hex'),
  pages: []
};
for (const [index, page] of pages.entries()) {
  if (pack.productionFormat === 'single-theme-video' && page.kind !== 'overview') {
    if (page.kind !== 'topic' || !page.topicId || page.cards.length < 4 || page.cards.length > 6 ||
        page.cards.some(card => card.topicId !== page.topicId)) {
      throw new Error('Video topic pages require 4–6 points about the same topicId');
    }
  }
  if (!page.mainTitle || !Array.isArray(page.cards) || page.cards.length < 1 || page.cards.length > 8) throw new Error('Each page requires mainTitle and 1..8 cards');
  const data = { mainTitle: page.mainTitle, cards: page.cards.map(card => {
    if (!card.title || !card.desc || !card.sourceUrl || !card.dateLabel) throw new Error('Every card needs title, desc, sourceUrl and dateLabel');
    const source = new URL(card.sourceUrl);
    if (source.protocol !== 'https:') throw new Error('Card source must use HTTPS');
    return {
      title: card.title, icon: card.icon || 'article',
      desc: `<span class="juya-date">${escape(card.dateLabel)}</span>${pack.productionFormat === 'single-theme-video' ? highlight(card.desc) : card.desc}<span class="juya-limit">${escape(card.boundary)}</span><a class="juya-source" href="${escape(source.href)}">${escape(sourceLabel)}${escape(card.sourceName || source.hostname)} ↗</a>`
    };
  }) };
  const number = String(index + 1).padStart(2, '0');
  let html = generateTemplateHtml(data, templateId, { bottomReservedPx: 100 });
  const extraStyle = `<style>
@font-face{font-family:JuyaNewsFont;src:url(data:font/ttf;base64,${font.toString('base64')}) format('truetype');font-display:swap}
body,.main-container{font-family:JuyaNewsFont,"Microsoft YaHei",system-ui,sans-serif!important}
.juya-issue{position:absolute;left:96px;right:96px;top:37px;display:flex;justify-content:space-between;font-size:21px;letter-spacing:1.4px;color:#8a7568;z-index:20}
.juya-foot{position:absolute;left:96px;right:96px;bottom:29px;display:flex;justify-content:space-between;align-items:center;border-top:1px solid #ded7cc;padding-top:16px;font-size:20px;color:#776b61;z-index:20}
.juya-date{display:block;margin-bottom:10px;font-size:22px;line-height:1.4;font-weight:600;color:#83736a}
.juya-limit{display:block;margin-top:10px;font-size:22px;line-height:1.4;color:#71675f}
.juya-source{display:block;margin-top:7px;font-size:21px;line-height:1.4;color:#9c543e;text-decoration:none}
.card-title{font-size:44px!important;line-height:1.2!important}
.js-desc{font-size:32px!important;line-height:1.5!important}
</style>`;
  html = html.replace('</head>', extraStyle + '</head>');
  if (pack.productionFormat === 'single-theme-video') {
    html = html.replace('</head>', '<style>.juya-issue{top:76px!important}.juya-foot{display:none!important}.content-wrapper{position:absolute!important;left:0!important;right:0!important;top:112px!important;transform:none!important;gap:24px!important}.title-zone{height:96px!important}.card-title{font-size:42px!important}.js-desc{font-size:34px!important}</style></head>');
    if (pack.layoutRevision === 'compact-r2') {
      html = html.replace('</head>', `<style>
.content-wrapper{top:108px!important;height:auto!important;padding-left:80px!important;padding-right:80px!important;gap:22px!important}
.title-zone{height:104px!important}.main-title{font-size:76px!important;line-height:1.15!important;white-space:normal!important;text-wrap:balance}
.card-zone>div{display:grid!important;grid-template-columns:repeat(${page.cards.length <= 4 ? 4 : 6},minmax(0,1fr))!important;gap:22px!important}
.card-item{grid-column:span 2;width:auto!important;min-width:0!important;min-height:292px!important;padding:8px!important;margin:0!important}
${page.cards.length === 5 ? '.card-item:nth-child(4){grid-column:2/span 2}.card-item:nth-child(5){grid-column:4/span 2}' : ''}
.card-title{font-size:${pack.language === 'en' ? 32 : 42}px!important;white-space:nowrap!important;overflow:visible!important;text-overflow:clip!important}
.title-box .material-symbols-rounded{font-size:${pack.language === 'en' ? 44 : 52}px!important}
.js-desc{font-size:${pack.language === 'en' ? 32 : 34}px!important;line-height:${pack.language === 'en' ? 1.25 : 1.42}!important}.juya-date,.juya-source,.juya-limit{display:none!important}
.title-box{padding:18px 20px 7px!important}.card-item>div:last-child{padding:0 20px 20px!important}.juya-issue{top:70px!important;font-size:20px!important}
</style></head>`);
    }
  }
  html = html.replace('</body>', `<div class="juya-issue"><span>${escape(page.sourceLine || pack.issueTitle || '机器人与具身智能')}</span><span>${escape(page.dateLabel || pack.period || '')} · ${number}/${String(pages.length).padStart(2, '0')}</span></div><footer class="juya-foot"><span>${escape(pack.footer || '日期、来源与核验边界见各卡片')}</span><span>JUYA · 机器人与具身智能</span></footer></body>`);
  const htmlFile = `card-${number}.html`;
  await writeFile(join(output, htmlFile), html, 'utf8');
  manifest.pages.push({ number: index + 1, title: data.mainTitle, html: htmlFile, png: `card-${number}.png`, cards: page.cards.map(c => ({ itemId: c.itemId, title: c.title, sourceUrl: c.sourceUrl, dateLabel: c.dateLabel })) });
}
await writeFile(join(output, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', 'utf8');
const gallery = `<!doctype html><meta charset="utf-8"><title>${escape(pack.issueTitle)}</title><style>body{margin:40px auto;max-width:1300px;background:#fbf9f6;color:#4a403a;font-family:system-ui}h1{margin:24px 0}img{width:100%;border:1px solid #ddd;border-radius:12px}a{color:#9c543e}section{margin:36px 0}p{line-height:1.8}</style><h1>${escape(pack.issueTitle)}</h1><p>${escape(pack.period)} · ${escape(pack.footer)}</p>${manifest.pages.map(p => `<section><h2>${p.number}. ${escape(p.title)}</h2><a href="${p.png}"><img src="${p.png}" alt="${escape(p.title)}"></a><p><a href="${p.html}">查看 HTML</a> · <a href="${p.png}">下载 PNG</a></p></section>`).join('')}`;
await writeFile(join(output, 'index.html'), gallery, 'utf8');
console.log(JSON.stringify({ output, templateId, pages: manifest.pages.length, cardCount: pages.reduce((n, p) => n + p.cards.length, 0) }));

if (args.serve === 'true') {
  const port = Number(args.port || 18763);
  if (!Number.isSafeInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid local preview port');
  const types = { '.html': 'text/html; charset=utf-8', '.json': 'application/json; charset=utf-8', '.png': 'image/png' };
  const server = createServer(async (request, response) => {
    try {
      const pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
      const target = resolve(output, '.' + (pathname === '/' ? '/index.html' : pathname));
      if (!target.startsWith(output + sep) || !types[extname(target)] || basename(target).startsWith('.')) { response.writeHead(404).end(); return; }
      const bytes = await readFile(target);
      response.writeHead(200, { 'content-type': types[extname(target)], 'cache-control': 'no-store' }).end(bytes);
    } catch { response.writeHead(404).end(); }
  });
  server.listen(port, '127.0.0.1', () => console.log(`Juya local preview: http://127.0.0.1:${port}`));
}
