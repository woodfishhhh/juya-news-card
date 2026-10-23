# Embodied news production module

本目录是 Juya 仓库内的采集与晚报制作模块。每期先读 `reports/production-contract.md`，再按相应工作流执行。代码、可公开信源配置和验收模板可入 Git；消息池、原文快照、账号凭证、Cookie、真实媒体、配音缓存和已发布制作包留在本机。

- 浏览器操作使用 EGO；HTTP/RSS/API 请求可以直接执行，自动采集不得自行启动其他浏览器运行时。
- 沿用 Juya 原生 React SSR 卡片与固定 vendor 渲染器，通过 `bin/juya_production.py` 加载生产适配；vendor 快照保持字节不变。
- 新期素材绑定完整口播句与真实时间轴；独立封面、技术检查、实际审片和用户验收分别记录具体版本。不要重做已接受历史成片。
- 验证：`npm test`；`python bin/test-production.py`。Python 需 numpy、Pillow 和可用的 FFmpeg/FFprobe。配音操作先读 `.codex/skills/minimax-tts-directing/SKILL.md`；测试不读取个人密钥、不调用付费服务。
- 既有本机数据用 `-DataDirectory` / `-ReportDirectory` 指定；不要复制、覆盖或清空旧数据来“迁移”。根目录入口 `run-embodied-news.ps1` 可读取 Git 忽略的 `config/embodied-news.local.json`。
- 日程继续使用已有安排，不重复创建；默认本地制作，发布沿用具体期次授权，不扩大为后续每日投稿。
