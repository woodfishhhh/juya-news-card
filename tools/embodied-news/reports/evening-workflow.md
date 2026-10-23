# 日报晚报工作流

每期先读 [用户确认要求](production-contract.md)，将 [验收清单](templates/issue-acceptance.md) 复制到本期制作包并逐项填写。涉及已授权发布时继续执行 [七平台发布流程](publication-workflow.md)。本期状态、用户验收、平台审核分别记录。

2026-10-21 起生效，每天北京时间（Asia/Shanghai）19:00 **开始**。当天生成需要采集与核查时间。用户本次另需一份 10 月 15–21 日周报；周报为一次性交付，不增加每周调度。

## 采集

1. 阅读根目录 AGENTS.md、config/sources.json 和本文件。基础配置合并 config/rsshub.json 的已启用订阅；2026-10-23 已授权扩展机器人/工程信源，仍保留明确排除来源。研究库用于找入口；验证真实 Feed 后启用，未取得原文证据的条目保持待核验。
2. 运行 `pwsh -NoProfile -File ./run-evening.ps1`。WSL 使用 `/mnt/c/Program Files/PowerShell/7/pwsh.exe -NoProfile -File 'D:\Coding\juya-news-card\tools\embodied-news\run-evening.ps1'`。此入口允许 HTTP/RSS/API 采集；需要页面渲染或账号浏览时记录缺口，交由 EGO，禁止在本轮自动启动旧 Playwright 浏览器。
3. 先运行 `ego-browser skill`，整个本轮复用一个 TaskSpace。通过 EGO 核查网站入口、失败来源和补充线索；需登录、权限或验证码时保留缺口，由用户完成。来源可包括公司、客户、政府、论文、维护者及赛事主办方。检索目录中的新来源不能自动加入采集配置。
4. 读取 reports/daily/last-run.json、当天程序生成的 MD/JSON 和 data/live/latest-run.json，核对采集起止时间、collectionPerformed、退出状态与逐源缺口。程序数据与 EGO 补查证据分别记录。EGO 仅保存公开文章正文、原始日期、链接、观察时间；不保存成员聊天、凭据、Cookie、浏览器 profile。

## 编辑与交付

- 以本轮开始时刻为截止点，查看此前 24 小时的原始发布。仅有日期的来源明确写“日精度”；新采到的旧公告不算今日新闻。持续事件只收录本日实质增量。
- 关注机器人、机器人 AI、控制/操作、硬件零部件、数据/仿真、真实部署和工程竞赛。普通 AI 产品与热点不凑数。
- 每个事件写清：发生了什么、原始日期/事件日期、具体技术或应用信息、为何值得看、直接来源链接。厂商性能、作者实验与未来计划在句中自然归属；完整核验边界单独保存，不让“本期未复现”等制作备注占据新闻要点。
- 重点条数由实际合格消息决定，不设固定上限；合并重复，不强求每类齐全。研究预印本和未合并 PR 明确标记状态。历史背景另列，不计入本期新增。
- 保存 `reports/daily/YYYY-MM-DD-evening.md` 和同名 JSON，更新 `latest-evening.md`、`latest-evening.json`。保留程序原始日报及历史；补查证据放在 `reports/daily/evidence/YYYY-MM-DD/`，不要把研究库条目冒充主消息池验收记录。
- 文字成稿后，按 [Juya 栏目流程](juya-workflow.md) 把有实质信息的主题编入视频，不以 3–5 条为上限。制作概览、每页一个主题的 4–6 点紧凑卡片、真实素材 popup 和中英文视频。制作包保存在 `reports/videos/evening-YYYY-MM-DD/`，保留文稿、整段配音缓存及实际字幕时间轴、卡片、素材证据、音乐顺序、两个 manifest、MP4 与核验记录。不得用摘要墙、静态 PNG 或 Markdown 代替整期视频交付。
- JSON 至少记录 generatedAt、timezone、window、collectionRunId、items（原始日期、摘要、链接、证据类别与边界）、sourceGaps、evidenceFiles。
- 核对窗口、日期、去重、每条直接引用和证据文件。无足够已核实新闻则如实交付带缺口的晚报；不能把旧文件、HTTP 200、搜索摘要或日程启用当成内容完成。
- 固定中文开场“大家好，我是木鱼，欢迎收看今天的具身智能晚报”；最后播报“今天的具身智能晚报就到这里了，感谢你的收看，早点休息”。英文自然对应翻译。字幕按完整意思分组出现，不逢逗号、顿号就切、至多一行，字号和底板紧凑；素材进入有 popout 缩放动效、背景轻轻变暗。普通图片每张最多 3 秒，复杂图按讲解需要例外并记录；通过 EGO 补足相关图和视频。视频根据完整动作连续播放更久，不受普通图片 3 秒上限限制；剪不同片段、不循环或重复同段，按文稿时长补足原文配图、同主体图片与视频，中间不返回卡片补时。检查最终编码画面的字幕、动效、背景、片段时间轴和人声实际起止。
- 最终给出简洁中文重点、本地晚报、单主题卡片预览和中英文成片链接。配音沿用 MiniMax Podcast_girl，上游 1.0、最终 1.3 倍速；双层导航、每题开头 2.5 秒卡片、中间连续媒体、最后 2.5 秒卡片；题间 0.5 秒配翻页声，开场仍按真实声音结束，不额外等待，BGM 第一首固定 boring life。无需再次添加日程。每日定时任务默认本地制作；已有指定期次发布授权时按发布流程完成，不重复询问。不私信或外发无关消息。若制作失败，明确剩余环节，不能宣称整期完成；无用户行动项时明确说现在不用操作。按 EGO 指南 finish。

本机自动化需要电脑与 Codex 应用运行。[OpenAI 调度说明](https://developers.openai.com/training/walkthroughs/scheduled-tasks)

配音前必读本项目 [.codex/skills/minimax-tts-directing/SKILL.md](../.codex/skills/minimax-tts-directing/SKILL.md)：用官方读音字典校多音字，以完整主题保留朗读上下文，先做真实小样，再使用提供方词级时间戳做字幕。MiniMax 参数、原文字跨度映射、首尾静音裁切和验收细节以技能和 Juya 流程为准。

最新媒体节奏与 r5 验收按 Juya 流程：连续覆盖完整中间窗口，片段衔接不露出纯卡片。普通图仍最多 3 秒，复杂图需理由；视频不设 3 秒上限、不重复源区间。
