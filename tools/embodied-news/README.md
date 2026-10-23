# 具身智能日报 · Juya 生产模块

从本机日报的两条工作线整合：真实来源采集/去重、双语关键词 RSS、Juya 原生卡片、整主题配音时间轴、连续媒体、句级素材绑定、独立封面与具体版本审片。代码可独立运行，不依赖 Dot。继续复用本仓库 React SSR 模板与固定的 Juya 基础渲染器，不迁移其他渲染引擎。

## 明天从这里开始

在 **juya-news-card 仓库根目录**：

```powershell
npm ci
npm run news:install
pwsh -NoProfile -File ./run-embodied-news.ps1
```

根入口会检查本机 RSSHub 并执行基础采集、去重和文字报告，真实网页交互交给 EGO。**这条命令不会自动完成选题、配音、素材、视频和发布**；每期先读 [制作契约](reports/production-contract.md)，按 [晚报工作流](reports/evening-workflow.md) 接续编辑和制作。

已有消息池无需搬迁：

```powershell
pwsh -File ./run-embodied-news.ps1 `
  -DataDirectory 'D:\Coding\具身智能日报\data\live' `
  -ReportDirectory 'D:\Coding\具身智能日报\reports\daily'
```

也可在仓库根目录创建 Git 忽略的 `config/embodied-news.local.json`，之后直接运行入口：

```json
{
  "dataDirectory": "D:/Coding/具身智能日报/data/live",
  "reportDirectory": "D:/Coding/具身智能日报/reports/daily"
}
```

参数优先于环境变量 `EMBODIED_DATA_DIR` / `EMBODIED_REPORT_DIR`，环境变量优先于本机 JSON。都未配置时使用本模块的 `data/live`、`reports/daily`。所有运行数据保持 Git 忽略。本机现有 19:00 调度继续保留，本模块不创建第二个日程。

## 依赖与检查

- 采集器：Node.js >=22.13（使用内置 SQLite）；根 Web 应用仍遵循自己的版本要求。
- 视频：Python >=3.10、`pip install -r tools/embodied-news/requirements.txt`、FFmpeg/FFprobe。Windows PowerShell 入口复用本机 Codex Python 和 WinGet FFmpeg。
- 卡片：根目录 Node 依赖和 `public/assets/htmlFont.ttf`；调用现有 Juya SSR，HTML/PNG 通过 EGO 检查与导出。
- RSSHub：Docker Desktop 或配置的可访问实例；`deploy/rsshub.compose.yaml` 固定镜像摘要。当前 Windows compose 代理默认 `host.docker.internal:7897`，其他机器按实际环境设置 `EMBODIED_RSSHUB_PROXY`。
- MiniMax 与 BGM：使用已授权的本机配置和媒体，仓库不包含密钥、音乐、配音缓存或真实素材。

```powershell
# 仓库根目录
npm test
npm run check
npm run news:test
pwsh -File ./run-embodied-news.ps1 -Action Verify
# 以下在 tools/embodied-news 目录
python bin/test-production.py
```

`Verify` 仅验证已保存消息，没有样本不代表采集成功。Python 测试入口会实际加载历史命名中的 `*.test.py`，防止 unittest discovery 静默跑零项。

## 来源与关键词

`config/sources.json` 合并以下配置的启用项：

| 配置 | 用途 |
| --- | --- |
| rsshub.json | 首轮 RSSHub 路由和原生订阅 |
| rss-publishers.json | 国内外发布者原生 RSS/Atom |
| rss-domestic.json | 工信部、政府、统计及媒体 RSSHub 路由 |
| rss-keywords.json / rss-keywords-international.json | 150 个原词各自的中英文发现入口 |

整合时共启用 112 条发布者/平台订阅，另有 300 条搜索配置（299 个不同搜索 URL）。入口数不代表独立出版者或新闻数。配置里的验证时间是历史探测记录，当前可用性必须看本次运行。搜索条目为 `discoveryOnly`，只进待核验队列；原始正文、日期和来源证据通过后才成为新闻。已排除来源继续保留，不能从搜索重新绕回。

每次 RSS 采集保存响应哈希、真实时间窗、候选及游标，可离线重放。直接运行 `node bin/export-rss-catalog.mjs --out <导出目录>` 可生成 OPML/CSV；没有本次原始探测包时，观察数量标为未知，不伪造历史统计。细节和维护命令见 [集成说明](reports/integration-workflow.md)。

## 每期制作

制作包可以继续放在原本机日报目录，所有命令接受显式路径。manifest、music-order、素材和音频应与 MP4 留在同一个完整制作包，验证器按该包查找输入。按顺序完成：

1. 核验原文和时间，写 `content.json` 与中英文自然稿；每主题 4–6 要点。复制 [验收清单](reports/templates/issue-acceptance.md)。
2. 卡片包设置 `productionFormat=single-theme-video`、`layoutRevision=compact-r2`，运行 `build-juya-cards.ps1 -ContentFile <卡片包JSON> -OutputDirectory <HTML目录> -Serve`，用 EGO 以 1920×1080 导出 PNG。
3. 媒体以 `mediaSequences.zh/en[].binding` 关联完整句原文与句序号。按项目 MiniMax skill 先小样、整主题合成，保留提供方词级时间戳。`prepare-juya-audio.ps1 -ContentFile <content.json> -MusicRoot <已授权音乐目录>` 生成双语 manifest，渲染只加速一次至 1.3。
4. `python bin/prepare-juya-media.py <制作包> --write`；随后执行 `verify-juya-inputs.py`、`preflight-juya-media.py`，补足素材缺口再渲染。
5. `render-juya-video.ps1 -Manifest <manifest.zh.json> -OutputDirectory <制作包>`；英文同理。`verify-juya-video.py <成片>` 检查最终视频和真实人声波形，再做连续画面审看与实际听感检查。
6. `cover.json` 单独定义真实主题、图片来源和中英文标题，`build-juya-cover.py <制作包>` 输出横竖封面。封面与视频分别审查，检查项绑定准确版本。
7. `review-juya.py` 记录真正发生的审片/用户验收，`check-juya-publication.py` 检查对应视频及封面版本。只有具体期次已授权时执行七平台发布，分别保留视频、文案和合集状态。

详细参数与 JSON 结构见 [Juya 流程](reports/juya-workflow.md)、[口播/封面/版本说明](reports/integration-workflow.md)。上游固定副本位于 `vendor/juya-news-card`，与可修改的生产适配分离；历史已接受成片不因为此次代码合并而重渲染。

## 两线程结论与历史交付

[整合记录](../../docs/embodied-integration-2026-10-23.md) 总结 10 月 23 日制作/发布线及本次能力扩展。原文快照、消息池、账号、配音、素材、成片、历史发布回执仍在原本机目录；这些没有被复制到 Git。专属邮箱的全局 skill 和加密凭证也保持本机独立，不属于公开 Juya 仓库。
