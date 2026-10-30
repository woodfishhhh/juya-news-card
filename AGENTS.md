# juya-news-card

Next.js + React + TypeScript 的新闻卡片生成与渲染工具。模块、命令和配置见 `README.md`；按固定流程操作本项目时读 `.agents/skills/juya-news-card-operator/SKILL.md`。`tools/embodied-news/` 有自己的 `AGENTS.md`。

- 常用命令：`npm run dev`、`npm run build`、`npm test`、`npm run test-render`。

## 收尾清理与规则固化

- 任务结束前删掉本次产生的临时文件：调试脚本、日志、根目录截图（如 `card-install-smoke.png`）、`.tmp/`、`.playwright-*`、一次性 worktree。要留的渲染样张放进 `docs/` 并说明用途。
- 把这次确认的做法、踩过的坑和用户明确的偏好写回本文件、`README.md` 或对应 skill 的相关条目，改写已有条目，过时的删掉，不追加流水账。
