# Daily Picks v4（Google Apps Script）

每天自动从 YouTube、Podcast、Substack 挑 5 条内容，用 Gemini 写 highlights，发一封 HTML 邮件。

## 一、GAS 是怎么运作的

Google Apps Script（GAS）是 Google 提供的**云端 JavaScript 运行环境**。代码放在 Google 的服务器上，不需要自己的电脑开着。

```
          每天 8 点
  触发器 ──────────▶ sendDailyYouTubePicks()
 (Triggers)                │
                           ├─ SpreadsheetApp 读你的 Google Sheet（频道 / 播客 / Substack / 屏蔽词）
                           ├─ UrlFetchApp    抓 RSS、调用 YouTube API、调用 Gemini API
                           ├─ PropertiesService 读写"已推荐记录"、API Key
                           └─ GmailApp       把邮件发给你
```

几个关键概念：

| 概念 | 在哪里 | 作用 |
|---|---|---|
| **项目 (Project)** | script.google.com | 一个项目可以有多个 `.gs` 文件，**所有文件共享同一个全局作用域**，所以 `Main.gs` 可以直接调用 `Picks.gs` 里的函数。不需要 import。 |
| **触发器 (Triggers)** | 左侧栏 ⏰ 图标 | 决定"什么时候自动运行哪个函数"。时间触发器只能精确到小时段，例如 8:00–9:00 之间的某个时刻。**触发器绑定的是函数名**，改函数名会让触发器失效，所以 v4 保留了 `sendDailyYouTubePicks` 这个名字。 |
| **脚本属性 (Script Properties)** | 左侧栏 ⚙️ 项目设置 → 脚本属性 | 一个小型键值存储。用来放 API Key（不写进代码），也存"已推荐 ID"和"最近 Discovery 话题"。单个值上限约 9KB。 |
| **执行记录 (Executions)** | 左侧栏 ☰ 执行 | 每次运行的 `Logger.log` 日志都在这里。出问题先看这里。 |
| **授权** | 第一次运行时弹窗 | 脚本要访问 Sheet、发邮件、访问外部网址，第一次运行需要你点"允许"。代码用到的服务变了，会再弹一次。 |

主要限制（个人 Gmail 账号）：

- 单次运行最长 **6 分钟**。v4 用 `fetchAll` 并行抓播客和 Substack 的 RSS，运行超过 2.5 分钟就不再"看视频"，避免超时。
- Gmail 发信每天有上限（个人账号约 100 封），这里每天只发 1 封。
- `UrlFetchApp` 每天 20,000 次请求，这里每天约 30–60 次。
- YouTube API 每天 10,000 配额。`search` 每次 100，其他每次 1，这里每天约 300–700。

## 二、v4 的流程

```
Part 1A  YouTube 频道 API ─┐
Part 1B  Podcast RSS      ├─▶ 规则过滤 ─▶ 启发式排序 ─▶ Gemini 按你的口味挑 1 条 + 写推荐理由
Part 1C  Substack RSS     ┤
Part 2   Breakout 搜索    ┤   （播放量 ÷ 订阅数：小频道的爆款）
Part 3   Discovery 搜索   ┘   （Gemini 先想一个具体的"兔子洞"话题，再去搜）
                                   │
                                   ▼
               Gemini 写 highlights（YouTube 直接"看"视频前 45 分钟，失败就读简介）
                                   │
                                   ▼
                     发邮件 ─▶ 发送成功后才保存"已推荐记录"
```

## 三、文件说明

| 文件 | 内容 | 需要改吗 |
|---|---|---|
| `Config.gs` | 邮箱、Sheet ID、各种阈值、**你的口味描述 `USER_PROFILE`**、兴趣种子 `INTERESTS` | ✅ 主要改这里 |
| `Main.gs` | 主流程 `sendDailyYouTubePicks`，以及测试用的 `testRun` | |
| `Picks.gs` | 五个栏目的选片逻辑 | |
| `Gemini.gs` | Gemini 调用（含重试）、选片、Discovery 话题、highlights | |
| `Sources.gs` | 读 Sheet、抓取和解析 RSS | |
| `YouTube.gs` | YouTube Data API 封装 | |
| `Email.gs` | 邮件 HTML（table 布局，兼容 Gmail） | |
| `Utils.gs` | 工具函数、已推荐记录 | |
| `Setup.gs` | `installDailyTrigger`、`diagnose`、`resetSeen` 等手动工具 | |

## 四、部署步骤（从 v3 升级）

1. 打开 script.google.com 里原来的项目。
2. **删掉旧代码**（或者先复制一份项目备份：概述 → 创建副本）。
3. 按上表建 8 个 `.gs` 文件（左侧 Files 旁边的 ＋ → 脚本），把对应内容贴进去。文件名不影响运行，只是方便管理。
4. 确认 ⚙️ 项目设置里：
   - 时区是 `(GMT+08:00) Singapore`
   - 脚本属性里有 `GEMINI_API_KEY` 和 `YOUTUBE_API_KEY`
5. 在编辑器顶部的函数下拉框选 `diagnose` → 运行。第一次会要求授权。看日志，确认全部 OK。
6. 选 `testRun` → 运行。你会收到一封 `[TEST]` 邮件，这次不会记录"已推荐"。
7. 选 `installDailyTrigger` → 运行一次。这会删掉旧的触发器，再建一个每天 8 点的新触发器。
   - 如果想改成每周发一次，在 ⏰ 触发器页面手动修改即可。
8. （可选）运行 `cleanupV3Properties`，删掉旧版不再使用的 `DISCOVERY_TOPIC_POOL`。

Google Sheet 的格式和 v3 完全一样，不需要改。Substack 那一列填主页地址就可以，脚本会自动补 `/feed`。

## 五、常见调整

- **推荐不合口味** → 改 `Config.gs` 里的 `USER_PROFILE`。这是最有效的调整。
- **想看中文 highlights** → `OUTPUT_LANGUAGE: 'Simplified Chinese'`。
- **日志里经常出现 Gemini 429 / quota** → `VIDEO_UNDERSTANDING.enabled: false`，或者把 `maxMinutes` 调小。
- **某个栏目经常是空的** → 看执行日志里"通过筛选 N 条"，再放宽 `RULES` 里对应的阈值。
- **想让旧内容重新被推荐** → 运行 `resetSeen`。
