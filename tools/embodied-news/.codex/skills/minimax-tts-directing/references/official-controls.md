# MiniMax 官方控制参数

核对日期：2026-10-21。通过 EGO 阅读的主文档：

- [同步语音合成 HTTP](https://platform.minimax.cn/docs/api-reference/speech-t2a-http)
- [语音使用指南与归一化](https://platform.minimax.cn/docs/guides/speech-t2a-websocket#文本归一化)

## 已核对的请求

```json
{
  "model": "speech-2.8-turbo",
  "text": "处理数据后，机器人重新执行任务。",
  "stream": false,
  "output_format": "hex",
  "voice_setting": {"voice_id":"Podcast_girl", "speed":1.0, "vol":1, "pitch":0},
  "audio_setting": {"sample_rate":32000, "bitrate":128000, "format":"mp3", "channel":1},
  "language_boost": "Chinese",
  "text_normalization_mode": "quality",
  "pronunciation_dict": {"tone":["处理/(chu3)(li3)","重新/(chong2)(xin1)","执行/(zhi2)(xing2)"]},
  "subtitle_enable": true,
  "subtitle_type": "word"
}
```

- `text` 少于 10,000 字符；段落可用换行。大段落应保留完整上下文，再按语义拆到请求限制以内。
- 读音字典是对象，`tone` 是 `原文/替换读法` 字符串数组。可用普通文本、括号拼音、IPA 或文档支持的日语假名；不能用旧 CLI 的 `{text,tone}` 对象数组替代。
- 文中可放括号拼音或官方 `<#x#>` 停顿。停顿 0.01–99.99 秒，至多两位小数；两侧必须有可朗读文字，不能连续使用。为便于字幕保持原文，通常优先字典而不是直接改展示文本。
- speed 0.5–2，pitch 为 -12–12 的整数，vol 大于 0 且不超过 10。日报固定上游 speed=1.0、pitch=0，后期仅一次 1.3。
- emotion 可选 happy、sad、angry、fearful、disgusted、surprised、calm 等。官网对 fluent、whisper 的文字与枚举有交叉说明；按更具体的限制，两者仅对 speech-2.6-hd/turbo 使用。2.8 不设置这两个值。通常不传 emotion，让模型按文稿自然朗读。
- `text_normalization_mode`: basic 或 quality。quality 适用于非流式 2.8/2.6 hd/turbo；流式或其他模型会回退 basic。该顶层字段优先于已弃用的 `voice_setting.text_normalization`。归一化结果仍需核听数字、单位和缩写。
- `subtitle_enable=true` 与 `subtitle_type=word` 请求词级时间。非流式通常从 `data.subtitle_file` 下载；流式从 `data.subtitle` 获取。先观察真实返回结构和时间单位，不预设字段。音频 URL 可能只有效 24 小时；下载成音频文件后验证。实际小样观察到：字典词展开成多个音素行，共用同一原文字范围；须合并这些时间。英文多段的字符计数会省略段间空格，部分 word_begin 还与段内文本偏移一位；按每段原文和有序 word 字符串严格匹配映射，不能盲信偏移，也不能用字数比例估时。
- `(laughs)`、`(breath)` 等表现标签需要特定模型支持，新闻旁白默认不添加。
- 检查 `base_resp.status_code=0`、audio 有效以及解码；HTTP 200 不能单独判断成功。

## 2026-10-21 本机接入差异

本机 `mmx-cli@1.0.16` 的 `--pronunciation` 实现组装成对象数组，与当前官方对象结构不同；命令也没有暴露词级 subtitle_type 和全部归一化参数。不能只因 CLI 有开关便断言已正确送达。

本技能的桥接脚本从同一安装目录导入 `MiniMaxSDK`，复用现有认证；向 `sdk.speech.synthesize()` 传完整 JSON，绕过 CLI 参数拼装。SDK 旧 TypeScript 类型同样不能覆盖当前官方协议。没有修改 SDK、认证配置或浏览器资料。

调用实际服务的小样回执和原始时间戳是验证协议生效的证据；仅静态查阅实现不能证明服务支持。新闻项目记录在本轮制作包的 `audio/tts-calibration.*` 与 `verification/`。
