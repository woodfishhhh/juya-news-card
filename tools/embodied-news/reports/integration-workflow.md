# RSSHub 与 JuyaCard 接入说明

2026-10-23 用户确认：沿用 JuyaCard，扩大 RSS/RSSHub 信源，素材绑定口播位置，审片绑定具体版本，独立设计封面。已有已接受视频和发布包不追溯替换。

## 来源采集

`config/sources.json` 引用 `rsshubConfig` 后，采集器自动合并 `config/rsshub.json` 中 `enabled=true` 的订阅。`baseUrl` 指向本机 RSSHub；`route` 保存官方路由，原生 RSS 入口使用 `entryUrl`。仓库 release 使用维护者原始 API 验证正文和发布日期；社区与媒体仅有线索时保留待核验，不伪装成官方事实。不配置 Cookie、私人访问令牌，不启用需要其他浏览器运行时的路由。原文页面交互仍交给 EGO。原文正文必须实际取回；原生 Feed 与原文及已登记网站同域时，发布者原生 Feed 的精确时间可作为一手日期证据，记录 `dateEvidenceBasis=publisher-native-feed`；RSSHub 生成时间不能走此路径。

```powershell
node bin/probe-rsshub.mjs --kind rsshub --activate true --out reports/source-research/<本次目录>
node bin/collect.mjs --data data/live --sources <来源ID> --pages 1 --limit 3
node bin/replay-feed-intake.mjs data/live/runs/<运行ID>/feed-intake/<来源摘要>/intake-<摘要>.json
```

探测工具仅验证真实 Feed 能否解析、有多少条及相关线索，不证明原文核验和入库。无日期、仅日精度、窗口前历史、窗口后条目分别标记，保持在候选队列供后续核验；不因窗口标签丢弃恢复任务。`--since ISO --until ISO` 可传给 collect 固定发现窗口，默认 `[启动时刻前24小时, 启动时刻)`。每个来源采集包保存 HTTP/API 响应、SHA-256、候选及去重关系、错误和游标，重放不联网。

晚报入口会先执行 `start-rsshub.ps1` 检查/启动本机服务；启动失败保留缺口，继续其他来源。本机 RSSHub 使用 `deploy/rsshub.compose.yaml`，只监听 127.0.0.1:1200；停止使用同一个 compose 项目的 `down`，不会删除原消息池。Docker Desktop 和本机代理须运行；源失败按失败处理，不能静默声称接入完成。

## 关键词与国内外扩展（2026-10-23）

`sources.json` 还引用 `publisherFeedConfig`、`domesticFeedConfig` 和 `keywordFeedConfigs`。现有 150 个用户关键词按七组各有中英文检索入口，分别保存在 `rss-keywords.json` 和 `rss-keywords-international.json`；名称中的 international 表示补充语种配置，其中也包含英文原词的中文检索。翻译保存在 `keyword-translations.en.json`，数字型关键词仍是搜索提示，不能当成事实。

关键词入口先读 Bing News RSS，无相关结果或请求/解析失败时回退 Google News RSS。结果只进入待核验队列，保留原始搜索链接、发布者、关键词与快照；搜索日期不作为原始发布日期。`discovery_ready` / `discovery_empty` 表示 Feed 发现成功，不表示新闻合格。正式日报只读取通过原文正文、日期和来源规则的消息。所有搜索项均禁止直接 hydrate 为新闻。

新增发布者在 `rss-publishers.json`，国内政策与媒体 RSSHub 路由在 `rss-domestic.json`；失败入口保留但不启用。综合站点需要明确机器人主题，指定工程硬件站点可覆盖电机、编码器、固件等；已排除来源继续过滤。搜索线索进入后续 EGO 原文核验流程，不需要把邮箱开户作为公开 RSS 的前置条件。

```powershell
node bin/build-keyword-feeds.mjs
node bin/build-keyword-feeds.mjs config/rss-keywords-international.json --complement
node bin/probe-keyword-feeds.mjs --config config/rss-keywords.json --out reports/source-research/<本次目录>/keyword-probe
node bin/import-keyword-intakes.mjs --config config/rss-keywords.json --probe reports/source-research/<本次目录>/keyword-probe --data data/live
node bin/export-rss-catalog.mjs --out reports/source-research/rss-keywords-2026-10-23
```

导入器先校验响应哈希并重放，再将已抓取线索写入队列，不联网、不增加合格新闻。`export-rss-catalog` 的目录应包含本次 `keyword-probe` 和 `complement-probe` 证据。订阅 CSV、150 词对应表和两份 OPML 见 `reports/source-research/rss-keywords-2026-10-23/`。OPML 内本机 RSSHub 地址需要该设备可访问本机 1200 端口；搜索项的备用 URL 保存在 JSON/CSV 中。

## 素材与口播

在 `content.json` 每主题的 `mediaSequences.zh/en` 里关联完整句原文：

```json
{
  "path": "assets/robot-demo.mp4",
  "kind": "video",
  "source_in": 12,
  "source_out": 20,
  "seconds": 8,
  "binding": {
    "sentence": 1,
    "text": "此处必须逐字对应该语言 sentences 的第二句。",
    "offsetSeconds": 0
  }
}
```

同一 binding 的素材连续排列，共同覆盖到下一 binding；句子位置取真实 `narration_captions.start / 1.3`。`offsetSeconds` 是最终播放秒，须在该句真实发声范围内。第一组从开头卡片结束开始，最后组结束于末尾卡片；过晚的第一组、乱序、改稿未更新、跨窗或素材不足都报错。绑定只证明位置与文本一致，实际画面是否支持说法仍须审片。

`python bin/prepare-juya-media.py <期次目录>` 只验证，`--write` 写入新 manifest；`--locale zh/en` 可只改一版。该命令不调用 MiniMax。旧未绑定的历史 manifest 仍可读取；新音频准备要求绑定并标记 sentence-v1。所有旧素材时长和有限区间检查保留。

## 封面

期次目录增加 `cover.json`，字段要求如下（本机历史示例仍在独立日报的 `reports/integration/2026-10-23/juya-sample/cover.json`，不随仓库分发）。包括本期 `themeId`、实际图片、来源 URL、权利说明、日期、中英文 headline/subtitle。`python bin/build-juya-cover.py <期次目录>` 输出 1920×1080 横图和 1080×1440 竖图，按比例重新排版，不裁掉机器人主体。标题应经过事实审查，禁止用未经确认的性能和数字制造悬念。

输出的 `cover.zh/en.provenance.json` 记录设计输入、来源图片、内容版本和所有 PNG 哈希。修改封面后重新生成并审图。封面变化不要求重新合成旁白或渲染成片；发布检查会要求封面与视频属于同一个 content.json 版本。

## 审片与发布版本

新成片的 `.manifest.json` 包含 productionBinding，覆盖输入文件、渲染代码、字体及参数。渲染期间输入变化会失败。`verify-juya-video.py` 的技术结果绑定 productionIdentity；技术通过不等于已实听、已审图或用户接受。

```powershell
python bin/review-juya.py <成片.mp4> --stage visual --decision approved --reviewer "实际审片人" --notes "实际连续审看范围及发现" --evidence <期次目录/verification/审片证据.txt>
python bin/review-juya.py <成片.mp4> --stage acceptance --decision approved --reviewer "用户" --notes "用户明确接受的版本与范围" --evidence <期次目录/verification/用户确认.txt>
python bin/review-juya.py <cover.zh.provenance.json> --stage visual --decision approved --reviewer "实际审图人" --notes "逐张检查中文横竖封面" --evidence <期次目录/verification/封面审图.txt>
python bin/check-juya-publication.py <成片.mp4> <cover.zh.provenance.json>
```

仅在实际执行对应检查或收到明确用户接受后记录 approved，不可运行示例命令制造通过。也可用 rejected 记录失败。旧记录保留历史；输入、成片、封面或审片证据文件改变都会使对应记录失效。历史成片没有绑定时不会补造当年的审片结果，也不擅自重渲染；本次功能验收与旧期次用户验收分开。

`check-juya-publication.py` 检查技术结果、实际审片、用户接受及封面审图版本；成功也不扩大期次发布授权。七平台仍按 publication-workflow.md 执行并保存回执。
