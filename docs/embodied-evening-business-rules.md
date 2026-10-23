# 具身智能晚报：选题、制作与发布规则

更新：2026-10-23。现行完整契约已整合至 [production-contract.md](../tools/embodied-news/reports/production-contract.md)，每期以该文件和用户最新明确更正为准。

- 北京时间 19:00 开始本机制作；以真实采集截止点前 24 小时为新闻窗口。条数随合格消息，不设 3–5 题上限。
- 第一页概览，随后每页一个主题、4–6 个相关要点；中文固定开场“大家好，我是木鱼，欢迎收看今天的具身智能晚报”，固定结尾“今天的具身智能晚报就到这里了，感谢你的收看，早点休息”。英文自然对应。
- 每题首尾各 2.5 秒卡片，中间连续真实素材；普通图最多 3 秒，视频使用有限、不同的源片段；题间 0.5 秒纸张翻页声。
- 单行语义字幕、可见 popout、背景轻暗和上下导航统一帧时间。MiniMax 整主题上游 1.0，渲染只加速一次至 1.3。
- 150 个关键词中英文检索与原生 RSS/RSSHub 分层；Feed 是发现线索，原文、日期、证据合格才进入新闻池。
- 素材绑定句序号、原文及真实声音时间；审片绑定具体成片和输入哈希。横竖、中英封面单独设计与验收，旧已接受发布包不追溯替换。
- 技术通过、实际审看、用户验收、平台提交、审核和公开发布分别记录；人工听感尚未检查时保留缺口，不用上传授权替代。
- 发布使用具体期次授权，国内中文、YouTube 中英分列表；视频、简介和合集状态分别核对。定时制作不自动获得每日外发授权。

使用 [生产入口](../tools/embodied-news/README.md)，读取 [晚报工作流](../tools/embodied-news/reports/evening-workflow.md)、[Juya 流程](../tools/embodied-news/reports/juya-workflow.md) 和 [发布流程](../tools/embodied-news/reports/publication-workflow.md)。[两线程整合记录](embodied-integration-2026-10-23.md) 说明代码来源和历史交付状态。

`tools/evening-video` 保留早期独立基础渲染器的兼容入口和历史 demo；当前栏目使用 `tools/embodied-news/bin/render-juya-video.py` 的生产适配。旧 18:00、固定 3–5 题、两行字幕和旧开场词不再是当前栏目要求。
