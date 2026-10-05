// ============================================
// Daily Picks v4 — 配置
// 所有"可以调的东西"都集中在这个文件里，其他文件一般不用动。
// API Key 不写在代码里，放在：项目设置 → 脚本属性（Script Properties）
//   GEMINI_API_KEY / YOUTUBE_API_KEY
// ============================================

const CONFIG = {
  EMAIL_TO: 'sherrysun@albizmarketing.com',
  SHEET_ID: '1EQ4fH7OlqW4Qt-QP-iCgorKENOs5m3lbaGddFabBrjI',
  TIMEZONE: 'Asia/Singapore',
  SEND_HOUR: 8,                       // installDailyTrigger() 用的发送时间（新加坡时间）

  // 主模型：免费额度较宽、实测稳定。想知道你的 Key 还能用哪些模型，运行 listGeminiModels()。
  GEMINI_MODEL: 'gemini-3.5-flash-lite',
  // 备用模型：主模型繁忙或额度用完时自动改用（各自独立额度）；不想用就改成 null
  GEMINI_FALLBACK_MODEL: 'gemini-2.5-flash',
  // 只对 2.5 系列生效：0 = 关闭 thinking，省 token 也避免输出被吃掉
  GEMINI_THINKING_BUDGET: 0,
  // 免费版每分钟只允许几次请求：同一模型两次调用之间至少间隔多久（毫秒）。付费后都可以改成 0。
  GEMINI_MIN_INTERVAL_MS: {
    'gemini-3.5-flash-lite': 5000,
    'gemini-2.5-flash': 12500,        // 实测免费版约每分钟 5 次
    default: 12500
  },
  BILINGUAL: true,                    // true = 摘要/推荐理由/标题都给中英双语；false = 只有英文

  // 让 Gemini 直接"看" YouTube 视频来写 highlights（比只读简介准确得多）
  // 如果日志里经常出现 429 / quota 错误，把 enabled 改成 false。
  VIDEO_UNDERSTANDING: {
    enabled: true,
    maxMinutes: 30,                   // 只看前 30 分钟，控制 token 和等待时间
    fps: 0.1,                         // 每 10 秒取一帧画面（音频是完整的），大幅省 token
    skipAfterMs: 2.5 * 60 * 1000      // 脚本已运行超过 2.5 分钟就改用文字模式，避免 GAS 6 分钟超时
  },

  SEEN_LIMIT: 400,                    // 记住最近推荐过的 400 条，不重复推荐
  RECENT_TOPICS_LIMIT: 30,            // Discovery 记住最近 30 个话题，避免重复
  RERANK_POOL: 15,                    // 每个栏目最多把 15 个候选交给 Gemini 挑

  RULES: {
    favoriteVideo: { maxAgeDays: 365, perChannel: 3, minMinutes: 20, minLikeRate: 0.015 },
    podcast:       { maxAgeDays: 180, perShow: 3, minMinutes: 20 },
    substack:      { maxAgeDays: 30, perPublication: 3, minChars: 400 },
    trending:      { maxAgeDays: 30, queries: 3, rounds: 2, minMinutes: 20, minViews: 10000, minLikeRate: 0.015 },
    discovery:     { maxAgeYears: 5, rounds: 2, minMinutes: 12, minViews: 5000, minLikeRate: 0.015, wantCandidates: 6 }
  }
};

CONFIG.SHEET_URL = 'https://docs.google.com/spreadsheets/d/' + CONFIG.SHEET_ID + '/edit';

// ============================================
// 你的口味描述 —— 这是推荐质量最关键的一段，请按自己的真实想法修改。
// Gemini 每次挑内容、写 highlights、想 Discovery 话题都会读这段。
// 写得越具体（喜欢什么样的、讨厌什么样的），推荐越准。
// ============================================

const USER_PROFILE = [
  'I work in marketing and have broad intellectual curiosity.',
  'I love: long-form conversations with genuine experts and practitioners (researchers, doctors, investors, founders, monks, historians); '
    + 'evidence-based takes on health, longevity, brain health and women\'s health; mental models and decision-making; '
    + 'investing and how wealth really works; AI and where marketing is heading; Buddhism, meditation and consciousness; '
    + 'anthropology, human origins and art history; personal knowledge management.',
  'What makes something great for me: a non-obvious idea, a specific framework or study, a surprising connection between fields, '
    + 'or a first-hand story I could not get anywhere else.',
  'I dislike: motivational fluff and hustle culture, listicles ("10 habits of..."), clickbait titles, reaction videos, '
    + 'clip compilations, shallow beginner overviews, crypto / get-rich-quick hype, and anything that is really selling a course.'
].join('\n');

// 兴趣种子：Part 2 Breakout 从这里随机挑搜索词；Part 3 Discovery 以此为"已知领域"往外延伸。
const INTERESTS = [
  'mental models decision making',
  'leadership lessons long interview',
  'investing philosophy interview',
  'AI impact on marketing',
  'longevity science women',
  'brain health neuroscience',
  'psychology emotional healing',
  'nutrition science evidence',
  'personal knowledge management second brain',
  'meditation neuroscience',
  'buddhist philosophy teaching',
  'consciousness research',
  'human evolution anthropology',
  'art history documentary',
  'biohacking evidence based',
  'deep work productivity'
];
