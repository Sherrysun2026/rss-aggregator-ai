// ============================================
// Daily Picks v4 — 单文件版（整段贴进 GAS 的 Code.gs 即可）
// ============================================


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


// ============================================
// 通用工具函数
// ============================================

function log(message) {
  Logger.log(message);
}

function getSecret(name) {
  const value = PropertiesService.getScriptProperties().getProperty(name);
  if (!value) throw new Error('Script Property "' + name + '" 未设置（项目设置 → 脚本属性）');
  return value;
}

function daysAgo(days) {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000);
}

/** Fisher-Yates 洗牌，返回新数组（原来的 sort(random) 是有偏的） */
function shuffle(array) {
  const a = array.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const tmp = a[i]; a[i] = a[j]; a[j] = tmp;
  }
  return a;
}

function unique(array) {
  return Array.from(new Set(array));
}

function chunk(array, size) {
  const out = [];
  for (let i = 0; i < array.length; i += size) out.push(array.slice(i, i + size));
  return out;
}

// ---------- 时长 ----------

/** YouTube ISO 8601 时长（PT1H2M3S）→ 分钟 */
function parseIsoDuration(iso) {
  const m = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(iso || '');
  if (!m) return 0;
  return (Number(m[1]) || 0) * 1440 + (Number(m[2]) || 0) * 60 + (Number(m[3]) || 0) + (Number(m[4]) || 0) / 60;
}

/** 播客 itunes:duration（HH:MM:SS / MM:SS / 秒数）→ 分钟，无法解析返回 0 */
function parseClockDuration(text) {
  const t = String(text || '').trim();
  if (!t) return 0;
  if (t.indexOf(':') !== -1) {
    const p = t.split(':').map(Number);
    if (p.some(isNaN)) return 0;
    if (p.length === 3) return p[0] * 60 + p[1] + p[2] / 60;
    if (p.length === 2) return p[0] + p[1] / 60;
    return 0;
  }
  const seconds = Number(t);
  return isNaN(seconds) ? 0 : seconds / 60;
}

function formatDuration(minutes) {
  if (!minutes) return '';
  if (minutes < 60) return Math.round(minutes) + ' min';
  const h = Math.floor(minutes / 60);
  const m = Math.round(minutes % 60);
  return h + 'h' + (m > 0 ? ' ' + m + 'm' : '');
}

function formatCount(n) {
  if (n == null) return '';
  if (n >= 1e6) return (n / 1e6).toFixed(n >= 1e7 ? 0 : 1) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(n >= 1e4 ? 0 : 1) + 'K';
  return String(n);
}

// ---------- 文本 ----------

function decodeEntities(s) {
  return String(s || '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, function (_, n) { return safeFromCodePoint(Number(n)); })
    .replace(/&#x([0-9a-f]+);/gi, function (_, n) { return safeFromCodePoint(parseInt(n, 16)); })
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

function safeFromCodePoint(n) {
  try { return String.fromCodePoint(n); } catch (e) { return ''; }
}

function stripHtml(html) {
  const text = String(html || '')
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>|<\/p>|<\/li>|<\/h\d>/gi, ' ')
    .replace(/<[^>]+>/g, ' ');
  return decodeEntities(text).replace(/\s+/g, ' ').trim();
}

function truncate(s, max) {
  s = String(s || '');
  return s.length > max ? s.slice(0, max - 1).trim() + '…' : s;
}

function oneLine(s, max) {
  return truncate(String(s || '').replace(/\s+/g, ' ').trim(), max);
}

function removeEmoji(s) {
  return String(s || '').replace(/[\p{Extended_Pictographic}️‍]/gu, '').replace(/\s+/g, ' ').trim();
}

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** 标题里有没有明显的非拉丁文字（中日韩、阿拉伯、西里尔、印地等）。旧版正则因为 \W 匹配一切非英文字符而失效。 */
function isLikelyEnglish(text) {
  return !/[Ѐ-ӿ֐-ۿऀ-෿฀-๿぀-ヿ㐀-鿿가-힯]/.test(text || '');
}

function matchesBlocked(text, blocked) {
  const lower = String(text || '').toLowerCase();
  return (blocked || []).some(function (b) { return b && lower.indexOf(b) !== -1; });
}

// ---------- 已推荐记录（存在 Script Properties，不需要额外的表） ----------

const SEEN_PROPERTY = 'SEEN_VIDEO_IDS';      // 沿用旧版的 key，旧的已看记录继续有效
const PROPERTY_MAX_CHARS = 8500;             // 单个 Script Property 上限约 9KB

/** YouTube ID 原样保存；播客/Substack 的 guid 往往是很长的 URL，压成 12 位哈希省空间 */
function seenKey(id) {
  id = String(id || '');
  if (/^[\w-]{1,16}$/.test(id)) return id;
  const digest = Utilities.computeDigest(Utilities.DigestAlgorithm.MD5, id, Utilities.Charset.UTF_8);
  return 'h:' + Utilities.base64EncodeWebSafe(digest).slice(0, 12);
}

function loadSeen() {
  const props = PropertiesService.getScriptProperties();
  let list = [];
  try { list = JSON.parse(props.getProperty(SEEN_PROPERTY) || '[]'); } catch (e) { list = []; }
  const set = new Set(list);

  return {
    has: function (id) { return set.has(seenKey(id)) || set.has(String(id)); },
    add: function (id) {
      const key = seenKey(id);
      if (!set.has(key)) { set.add(key); list.push(key); }
    },
    size: function () { return set.size; },
    save: function () {
      let trimmed = list.slice(-CONFIG.SEEN_LIMIT);
      while (trimmed.length && JSON.stringify(trimmed).length > PROPERTY_MAX_CHARS) trimmed = trimmed.slice(1);
      props.setProperty(SEEN_PROPERTY, JSON.stringify(trimmed));
    }
  };
}

// ---------- Discovery 最近话题 ----------

const RECENT_TOPICS_PROPERTY = 'RECENT_DISCOVERY_TOPICS';

function getRecentTopics() {
  try {
    return JSON.parse(PropertiesService.getScriptProperties().getProperty(RECENT_TOPICS_PROPERTY) || '[]');
  } catch (e) {
    return [];
  }
}

function addRecentTopic(topic) {
  if (!topic) return;
  const topics = getRecentTopics().concat([topic]).slice(-CONFIG.RECENT_TOPICS_LIMIT);
  PropertiesService.getScriptProperties().setProperty(RECENT_TOPICS_PROPERTY, JSON.stringify(topics));
}


// ============================================
// 数据来源：Google Sheet 配置表 + RSS 抓取解析
// ============================================

const NS = {
  atom: XmlService.getNamespace('http://www.w3.org/2005/Atom'),
  itunes: XmlService.getNamespace('http://www.itunes.com/dtds/podcast-1.0.dtd'),
  content: XmlService.getNamespace('http://purl.org/rss/1.0/modules/content/')
};

const FEED_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (compatible; DailyPicks/4.0; RSS reader)',
  'Accept': 'application/rss+xml, application/atom+xml, application/xml, text/xml, */*'
};

// ---------- Sheet ----------

let spreadsheetCache = null;

function getSpreadsheet() {
  if (!spreadsheetCache) spreadsheetCache = SpreadsheetApp.openById(CONFIG.SHEET_ID);
  return spreadsheetCache;
}

function readSheetRows(sheetName) {
  const sheet = getSpreadsheet().getSheetByName(sheetName);
  if (!sheet) {
    log('⚠️ 找不到工作表 "' + sheetName + '"');
    return [];
  }
  return sheet.getDataRange().getValues().slice(1); // 第一行是表头
}

function isActive(value) {
  return String(value).trim().toUpperCase() === 'YES';
}

/** Channels 表：A=Handle  B=Name  C=Channel ID  D=Active（Channel ID 和 Handle 至少填一个） */
function getChannels() {
  return readSheetRows('Channels')
    .filter(function (r) { return r[1] && (r[0] || r[2]) && isActive(r[3]); })
    .map(function (r) {
      return { name: String(r[1]).trim(), handle: String(r[0] || '').trim(), id: String(r[2] || '').trim() };
    });
}

/** Podcasts 表：A=Name  B=RSS URL  C=Active */
function getPodcasts() {
  return readSheetRows('Podcasts')
    .filter(function (r) { return r[0] && r[1] && isActive(r[2]); })
    .map(function (r) { return { name: String(r[0]).trim(), rssUrl: String(r[1]).trim() }; });
}

/** Substack 表：A=Name  B=URL（填主页即可，会自动补 /feed）  C=Active */
function getSubstacks() {
  return readSheetRows('Substack')
    .filter(function (r) { return r[0] && r[1] && isActive(r[2]); })
    .map(function (r) { return { name: String(r[0]).trim(), rssUrl: toSubstackFeedUrl(r[1]) }; });
}

function toSubstackFeedUrl(url) {
  const base = String(url).trim().replace(/\/+$/, '');
  return /\/feed$/i.test(base) ? base : base + '/feed';
}

/** Blocked Topics 表：A=Topic（不区分大小写，标题/话题里包含就过滤） */
function getBlockedTopics() {
  return readSheetRows('Blocked Topics')
    .map(function (r) { return String(r[0]).trim().toLowerCase(); })
    .filter(Boolean);
}

// ---------- RSS ----------

/** 并行抓取多个 feed，返回 [{ source, root }]，失败的自动跳过 */
function fetchFeeds(sources) {
  if (!sources.length) return [];

  const requests = sources.map(function (s) {
    return { url: s.rssUrl, muteHttpExceptions: true, followRedirects: true, headers: FEED_HEADERS };
  });

  let responses;
  try {
    responses = UrlFetchApp.fetchAll(requests);
  } catch (e) {
    // fetchAll 只要有一个地址 DNS 失败就整体报错，这时退回逐个抓
    log('fetchAll 失败，改为逐个抓取：' + e.message);
    responses = requests.map(function (req) {
      try {
        return UrlFetchApp.fetch(req.url, { muteHttpExceptions: true, followRedirects: true, headers: FEED_HEADERS });
      } catch (err) {
        return null;
      }
    });
  }

  return sources.map(function (source, i) {
    const res = responses[i];
    if (!res || res.getResponseCode() !== 200) {
      log('  ✗ ' + source.name + ': ' + (res ? 'HTTP ' + res.getResponseCode() : 'network error'));
      return null;
    }
    try {
      return { source: source, root: XmlService.parse(res.getContentText()).getRootElement() };
    } catch (e) {
      log('  ✗ ' + source.name + ': XML 解析失败（' + e.message + '）');
      return null;
    }
  }).filter(Boolean);
}

function childText(element, name, namespace) {
  const child = namespace ? element.getChild(name, namespace) : element.getChild(name);
  return child ? child.getText().trim() : '';
}

function attrValue(element, name) {
  const attr = element ? element.getAttribute(name) : null;
  return attr ? attr.getValue() : '';
}

function parseDate(text) {
  const d = new Date(text);
  return isNaN(d.getTime()) ? null : d;
}

// ---------- YouTube 频道（用 YouTube API，不用 RSS）----------
// YouTube 的 RSS（feeds/videos.xml）从 Google 服务器访问经常返回 404，
// 所以改用 Data API 读取每个频道的"上传"播放列表。配额：每个频道约 1–2 units。

/** 每个频道取最近 perChannel 条没推荐过的视频 ID */
function getFavoriteChannelVideoIds(ctx) {
  const rules = CONFIG.RULES.favoriteVideo;
  const cutoff = daysAgo(rules.maxAgeDays);
  const channels = resolveUploadPlaylists(getChannels());
  const ids = [];

  channels.forEach(function (channel) {
    const fresh = ytApi('playlistItems', { part: 'contentDetails', playlistId: channel.uploads, maxResults: 15 })
      .map(function (it) {
        const cd = it.contentDetails || {};
        return { id: cd.videoId, published: parseDate(cd.videoPublishedAt) };
      })
      .filter(function (v) { return v.id && v.published && v.published >= cutoff && !ctx.seen.has(v.id); })
      .slice(0, rules.perChannel);
    fresh.forEach(function (v) { ids.push(v.id); });
  });

  log('YouTube 频道：' + channels.length + ' 个可用，候选视频 ' + ids.length + ' 条');
  return ids;
}

/**
 * 给每个频道找到"上传"播放列表 ID。
 * 先用 Sheet 里的 Channel ID 批量查；查不到的再用 Handle（@xxx）查，并在日志里提示正确的 ID。
 */
function resolveUploadPlaylists(channels) {
  const uploadsById = {};
  const validIds = channels.map(function (c) { return c.id; }).filter(function (id) { return /^UC[\w-]{22}$/.test(id); });

  chunk(unique(validIds), 50).forEach(function (group) {
    ytApi('channels', { part: 'contentDetails', id: group.join(','), maxResults: 50 }).forEach(function (c) {
      uploadsById[c.id] = c.contentDetails.relatedPlaylists.uploads;
    });
  });

  return channels.map(function (c) {
    let uploads = uploadsById[c.id];
    if (!uploads && c.handle) {
      const found = ytApi('channels', { part: 'contentDetails', forHandle: c.handle.replace(/^@/, '') })[0];
      if (found) {
        uploads = found.contentDetails.relatedPlaylists.uploads;
        log('  ℹ️ ' + c.name + '：Channel ID "' + c.id + '" 无效，已用 Handle 找到。正确的 ID 是 ' + found.id + '（建议更新到 Sheet 的 C 列）');
      }
    }
    if (!uploads) {
      log('  ✗ ' + c.name + '：找不到这个频道，请检查 Sheet 里的 Channel ID（UC 开头 24 位）或 Handle（@xxx）');
      return null;
    }
    return Object.assign({}, c, { uploads: uploads });
  }).filter(Boolean);
}

// ---------- Podcast ----------

function getPodcastCandidates(ctx) {
  const rules = CONFIG.RULES.podcast;
  const cutoff = daysAgo(rules.maxAgeDays);
  const podcasts = getPodcasts();
  const candidates = [];

  fetchFeeds(podcasts).forEach(function (feed) {
    const channel = feed.root.getChild('channel');
    if (!channel) return;

    channel.getChildren('item').slice(0, 30)
      .map(function (item) { return parsePodcastItem(item, feed.source); })
      .filter(function (ep) {
        return ep
          && ep.pubDate >= cutoff
          && !ctx.seen.has(ep.id)
          && !matchesBlocked(ep.title, ctx.blocked)
          && (ep.minutes === 0 || ep.minutes >= rules.minMinutes); // 0 = feed 没写时长，不因此排除
      })
      .slice(0, rules.perShow) // 每个节目最多几集，避免高频更新的节目霸占候选
      .forEach(function (ep) { candidates.push(ep); });
  });

  log('Podcast：' + podcasts.length + ' 个节目，候选单集 ' + candidates.length + ' 条');
  return candidates;
}

function parsePodcastItem(item, source) {
  const title = removeEmoji(childText(item, 'title'));
  const pubDate = parseDate(childText(item, 'pubDate'));
  if (!title || !pubDate) return null;

  const episodeType = childText(item, 'episodeType', NS.itunes).toLowerCase();
  if (episodeType === 'trailer') return null;

  const enclosure = item.getChild('enclosure');
  const link = childText(item, 'link') || attrValue(enclosure, 'url');
  const notes = childText(item, 'encoded', NS.content) || childText(item, 'description') || childText(item, 'summary', NS.itunes);
  const minutes = parseClockDuration(childText(item, 'duration', NS.itunes));

  return {
    type: 'podcast',
    id: childText(item, 'guid') || link || source.name + '_' + title,
    title: title,
    channel: source.name,
    description: truncate(stripHtml(notes), 2500),
    pubDate: pubDate,
    publishedAt: Utilities.formatDate(pubDate, CONFIG.TIMEZONE, 'yyyy-MM-dd'),
    minutes: minutes,
    duration: formatDuration(minutes),
    url: link
  };
}

// ---------- Substack ----------

function getSubstackCandidates(ctx) {
  const rules = CONFIG.RULES.substack;
  const cutoff = daysAgo(rules.maxAgeDays);
  const substacks = getSubstacks();
  const candidates = [];

  fetchFeeds(substacks).forEach(function (feed) {
    const channel = feed.root.getChild('channel');
    if (!channel) return;

    channel.getChildren('item')
      .map(function (item) { return parseSubstackItem(item, feed.source); })
      .filter(function (post) {
        return post
          && post.pubDate >= cutoff
          && post.charCount >= rules.minChars // 付费文章在 RSS 里通常只有一小段预览
          && !ctx.seen.has(post.id)
          && !matchesBlocked(post.title, ctx.blocked);
      })
      .slice(0, rules.perPublication)
      .forEach(function (post) { candidates.push(post); });
  });

  log('Substack：' + substacks.length + ' 个，候选文章 ' + candidates.length + ' 篇');
  return candidates;
}

function parseSubstackItem(item, source) {
  // Substack 也会发播客/视频，这里只要文章
  const enclosureType = attrValue(item.getChild('enclosure'), 'type');
  if (/audio|video/.test(enclosureType)) return null;

  const title = removeEmoji(childText(item, 'title'));
  const pubDate = parseDate(childText(item, 'pubDate'));
  if (!title || !pubDate) return null;

  const fullText = stripHtml(childText(item, 'encoded', NS.content) || childText(item, 'description'));
  const words = fullText ? fullText.split(' ').length : 0;
  const link = childText(item, 'link');

  return {
    type: 'substack',
    id: childText(item, 'guid') || link || source.name + '_' + title,
    title: title,
    channel: source.name,
    description: truncate(fullText, 4000),
    charCount: fullText.length,
    pubDate: pubDate,
    publishedAt: Utilities.formatDate(pubDate, CONFIG.TIMEZONE, 'yyyy-MM-dd'),
    minutes: 0,
    duration: words >= 200 ? Math.max(1, Math.round(words / 230)) + ' min read' : '',
    url: link
  };
}


// ============================================
// YouTube Data API 封装
// 配额参考（每天 10,000 units）：search = 100 / 次，videos、channels = 1 / 次
// 本脚本每天大约用 300–1,300 units
// ============================================

function ytApi(endpoint, params) {
  const query = Object.keys(params)
    .map(function (k) { return k + '=' + encodeURIComponent(params[k]); })
    .join('&');
  const url = 'https://www.googleapis.com/youtube/v3/' + endpoint + '?' + query
    + '&key=' + encodeURIComponent(getSecret('YOUTUBE_API_KEY'));

  try {
    const res = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
    const body = JSON.parse(res.getContentText());
    if (res.getResponseCode() !== 200) {
      log('YouTube API ' + endpoint + ' 错误 ' + res.getResponseCode() + ': ' + (body.error ? body.error.message : ''));
      return [];
    }
    return body.items || [];
  } catch (e) {
    log('YouTube API ' + endpoint + ' 异常：' + e.message);
    return [];
  }
}

/** 搜索，只返回视频 ID（part=id 更省流量，配额同样是 100） */
function ytSearchIds(q, options) {
  const params = Object.assign({
    part: 'id',
    q: q,
    type: 'video',
    maxResults: 25,
    relevanceLanguage: 'en',
    regionCode: 'US'
  }, options || {});
  return ytApi('search', params)
    .map(function (item) { return item.id && item.id.videoId; })
    .filter(Boolean);
}

/** 批量取视频详情，自动按 50 个一组切分 */
function ytVideoDetails(ids) {
  const out = [];
  chunk(unique(ids), 50).forEach(function (group) {
    ytApi('videos', { part: 'snippet,statistics,contentDetails', id: group.join(','), maxResults: 50 })
      .forEach(function (v) { out.push(v); });
  });
  return out;
}

/** channelId → 订阅数（订阅数被隐藏的频道为 null） */
function ytChannelSubscribers(channelIds) {
  const map = {};
  chunk(unique(channelIds), 50).forEach(function (group) {
    ytApi('channels', { part: 'statistics', id: group.join(','), maxResults: 50 }).forEach(function (c) {
      const s = c.statistics || {};
      map[c.id] = s.hiddenSubscriberCount ? null : Number(s.subscriberCount || 0);
    });
  });
  return map;
}

/** API 返回的视频 → 统一的内容对象 */
function toVideoItem(v) {
  const s = v.snippet || {};
  const st = v.statistics || {};
  const views = Number(st.viewCount || 0);
  const likes = st.likeCount != null ? Number(st.likeCount) : null; // 隐藏了点赞数就是 null
  const minutes = parseIsoDuration((v.contentDetails || {}).duration);

  return {
    type: 'youtube',
    id: v.id,
    title: s.title || '',
    channel: s.channelTitle || '',
    channelId: s.channelId || '',
    description: truncate(s.description || '', 3000),
    publishedAt: (s.publishedAt || '').slice(0, 10),
    lang: s.defaultAudioLanguage || s.defaultLanguage || '',
    isLive: !!s.liveBroadcastContent && s.liveBroadcastContent !== 'none',
    views: views,
    likes: likes,
    likeRate: likes != null && views > 0 ? likes / views : null,
    minutes: minutes,
    duration: formatDuration(minutes),
    url: 'https://www.youtube.com/watch?v=' + v.id,
    thumbnail: bestThumbnail(s.thumbnails)
  };
}

function bestThumbnail(thumbs) {
  thumbs = thumbs || {};
  const best = thumbs.maxres || thumbs.standard || thumbs.high || thumbs.medium || thumbs.default;
  return best ? best.url : '';
}

function isEnglishVideo(item) {
  if (item.lang) return /^en/i.test(item.lang);
  return isLikelyEnglish(item.title);
}

function passesVideoRules(item, rules, ctx) {
  return !ctx.seen.has(item.id)
    && !item.isLive
    && isEnglishVideo(item)
    && !matchesBlocked(item.title, ctx.blocked)
    && item.minutes >= (rules.minMinutes || 0)
    && item.views >= (rules.minViews || 0)
    && (item.likeRate == null || item.likeRate >= (rules.minLikeRate || 0));
}

function byLikeRateDesc(a, b) {
  return (b.likeRate || 0) - (a.likeRate || 0);
}


// ============================================
// Gemini：统一调用 + 选片 + Discovery 话题 + Highlights
// ============================================

/**
 * 调用 Gemini，返回文本；失败返回 null。
 * - 5xx（模型繁忙）：等几秒重试
 * - 429（额度用完）：不重试（重试也不会恢复），直接换备用模型（备用模型有自己独立的额度）
 * - 主模型失败过一次后，本次运行剩下的调用直接用备用模型，"看视频"也自动停用
 * options: temperature, maxTokens, json, mediaResolution,
 *          retries（每个模型最多试几次，默认 2）, fallback（是否允许换备用模型，默认 true）,
 *          markBusy（主模型繁忙时是否让本次运行后续都改用备用模型，默认 true）
 */

let geminiPrimaryBusy = false;
const geminiLastCallAt = {};

/** 同一个模型两次调用之间至少间隔 GEMINI_MIN_INTERVAL_MS 里设定的时间，避免撞到"每分钟次数"限制 */
function waitForGeminiSlot(model) {
  const intervals = CONFIG.GEMINI_MIN_INTERVAL_MS || {};
  const interval = typeof intervals === 'number' ? intervals
    : (intervals[model] != null ? intervals[model] : (intervals.default || 0));
  const wait = (geminiLastCallAt[model] || 0) + interval - Date.now();
  if (wait > 0) Utilities.sleep(wait);
  geminiLastCallAt[model] = Date.now();
}

function callGemini(parts, options) {
  options = options || {};
  const canFallback = options.fallback !== false && !!CONFIG.GEMINI_FALLBACK_MODEL;
  const models = canFallback && geminiPrimaryBusy ? [CONFIG.GEMINI_FALLBACK_MODEL]
    : canFallback ? [CONFIG.GEMINI_MODEL, CONFIG.GEMINI_FALLBACK_MODEL]
    : [CONFIG.GEMINI_MODEL];
  const retries = options.retries || 2;

  for (let m = 0; m < models.length; m++) {
    const model = models[m];
    const url = 'https://generativelanguage.googleapis.com/v1beta/models/' + model + ':generateContent';
    const request = {
      method: 'post',
      contentType: 'application/json',
      headers: { 'x-goog-api-key': getSecret('GEMINI_API_KEY') }, // key 放 header，不出现在 URL 里
      payload: JSON.stringify({ contents: [{ role: 'user', parts: parts }], generationConfig: buildGenerationConfig(model, options) }),
      muteHttpExceptions: true
    };
    let lastCode = 0;

    for (let attempt = 1; attempt <= retries; attempt++) {
      let res;
      try {
        waitForGeminiSlot(model);
        res = UrlFetchApp.fetch(url, request);
      } catch (e) {
        log('Gemini ' + model + ' 请求异常（第 ' + attempt + ' 次）：' + e.message);
        lastCode = -1;
        if (attempt < retries) Utilities.sleep(3000);
        continue;
      }

      lastCode = res.getResponseCode();
      if (lastCode === 200) {
        const body = JSON.parse(res.getContentText());
        const candidate = body.candidates && body.candidates[0];
        const resultParts = candidate && candidate.content && candidate.content.parts;
        if (!resultParts) {
          log('Gemini 没有返回内容，finishReason=' + (candidate ? candidate.finishReason : 'n/a'));
          return null;
        }
        const text = resultParts
          .filter(function (p) { return !p.thought; })
          .map(function (p) { return p.text || ''; })
          .join('')
          .trim();
        if (text && model !== CONFIG.GEMINI_MODEL) log('（已改用备用模型 ' + model + '）');
        return text || null;
      }

      log('Gemini ' + model + ' HTTP ' + lastCode + '（第 ' + attempt + ' 次）：' + describeGeminiError(res.getContentText()));
      if (lastCode < 500) break;                               // 429 / 400 / 404：重试没用
      if (attempt < retries) Utilities.sleep(5000 * attempt);  // 5s, 10s
    }

    // 额度用完（429）对所有请求都成立；繁忙（5xx）只在普通请求上才算数——
    // 看视频是很重的请求，它超时不代表普通文字请求也会失败（markBusy: false）
    const overloaded = lastCode >= 500 || lastCode === -1;
    if (model === CONFIG.GEMINI_MODEL && (lastCode === 429 || (overloaded && options.markBusy !== false))) {
      geminiPrimaryBusy = true;
    } else if (lastCode !== 429 && lastCode < 500) {
      return null; // 400 / 404 之类：请求本身有问题，换模型也没用
    }
  }
  return null;
}

/** 2.5 系列可以用 thinkingBudget: 0 关掉思考；其他（3.x 等）不传这个参数，并给足输出 token，避免思考吃掉输出 */
function buildGenerationConfig(model, options) {
  const is25 = /^gemini-2\.5-flash/.test(model);
  const config = {
    temperature: options.temperature != null ? options.temperature : 0.4,
    maxOutputTokens: is25 ? (options.maxTokens || 2048) : Math.max(options.maxTokens || 0, 4096)
  };
  if (is25 && CONFIG.GEMINI_THINKING_BUDGET != null) config.thinkingConfig = { thinkingBudget: CONFIG.GEMINI_THINKING_BUDGET };
  if (options.json) config.responseMimeType = 'application/json';
  if (options.mediaResolution) config.mediaResolution = options.mediaResolution;
  return config;
}

/** 把 Gemini 的错误整理成一行；额度错误会附上具体是哪个额度（每分钟 / 每天 / token） */
function describeGeminiError(raw) {
  try {
    const err = JSON.parse(raw).error;
    const quotaIds = [];
    (err.details || []).forEach(function (d) {
      (d.violations || []).forEach(function (v) { if (v.quotaId) quotaIds.push(v.quotaId); });
    });
    return String(err.message || '').split('. ')[0].slice(0, 160) + (quotaIds.length ? ' [额度: ' + unique(quotaIds).join(', ') + ']' : '');
  } catch (e) {
    return String(raw).slice(0, 200);
  }
}

function callGeminiText(prompt, options) {
  return callGemini([{ text: prompt }], options);
}

/** 要求 Gemini 返回 JSON 并解析；解析失败返回 null */
function callGeminiJson(prompt, options) {
  const text = callGeminiText(prompt, Object.assign({ json: true }, options || {}));
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch (e) {
    const match = text.match(/[\[{][\s\S]*[\]}]/);
    if (match) {
      try { return JSON.parse(match[0]); } catch (err) { /* fall through */ }
    }
    log('Gemini JSON 解析失败：' + text.slice(0, 200));
    return null;
  }
}

function cleanModelText(text) {
  return String(text || '')
    .replace(/\*\*|__|^#+\s*/gm, '')
    .replace(/^(highlights?|summary|briefing)\s*:\s*/i, '')
    .trim();
}

// ============================================
// 选片：让 Gemini 按你的口味从候选里挑一条
// ============================================

/**
 * candidates 应该已经按启发式规则（点赞率/爆款度）排好序，
 * Gemini 失败时会退回到前 3 名里随机选一条。
 * 返回被选中的 item，并附上 item.why（推荐理由）。
 */
function pickBestWithGemini(candidates, slotDescription, ctx, options) {
  const allowSkip = !!(options && options.allowSkip); // true = 候选都不好时 Gemini 可以拒绝（返回 -1）
  if (!candidates.length) return null;
  const pool = candidates.slice(0, CONFIG.RERANK_POOL);
  if (pool.length === 1 && !allowSkip) return pool[0];

  const list = pool.map(function (c, i) {
    const meta = [
      c.channel,
      c.duration,
      c.publishedAt,
      c.breakout ? c.breakout.toFixed(1) + 'x views/subscribers' : ''
    ].filter(Boolean).join(' · ');
    return i + '. ' + c.title + '  [' + meta + ']\n   ' + oneLine(c.description, 300);
  }).join('\n');

  const prompt = [
    'You are my personal content curator.',
    '',
    'About me:',
    USER_PROFILE,
    ctx.blocked.length ? '\nNever pick anything about: ' + ctx.blocked.join(', ') : '',
    '',
    'Slot to fill: ' + slotDescription,
    '',
    'Candidates:',
    list,
    '',
    'Choose the ONE candidate I would get the most out of.',
    'Prefer: insight density, credible speakers (researchers, practitioners, people with first-hand experience), '
      + 'specific ideas over generic advice, and novelty compared with mainstream content.',
    'Penalize: clickbait titles, listicles, motivational fluff, clips or compilations, reaction content, '
      + 'and anything that is mainly selling a product or course.',
    allowSkip
      ? 'If none of them is genuinely worth my time (all clickbait, money-making hype, motivational fluff or shallow), '
        + 'return {"index": -1} instead of settling for the least bad one.'
      : 'If every candidate is weak, still pick the least bad one.',
    '',
    'Return JSON only: {"index": <number>, "why": "<one English sentence, max 25 words, written to me as \'you\', on why this is worth my time>"'
      + (CONFIG.BILINGUAL ? ', "why_zh": "<the same reason as one natural Simplified Chinese sentence, max 50 characters>"' : '') + '}'
  ].join('\n');

  const result = callGeminiJson(prompt, { temperature: 0.3, maxTokens: 512 });
  const index = result ? Number(result.index) : NaN;

  if (allowSkip && index === -1) {
    log('Gemini 认为这批候选都不值得推荐');
    return null;
  }

  if (result && Number.isInteger(index) && pool[index]) {
    const picked = pool[index];
    picked.why = oneLine(result.why || '', 220);
    picked.whyZh = oneLine(result.why_zh || '', 120);
    log('Gemini 选中 #' + index + '：' + picked.title);
    return picked;
  }

  log('Gemini 选片失败，退回启发式排序');
  return pool[Math.floor(Math.random() * Math.min(pool.length, 3))];
}

// ============================================
// Discovery：每天生成一个"兔子洞"话题
// ============================================

function planDiscovery(ctx, rejectedThemes) {
  const recent = getRecentTopics().concat(rejectedThemes || []);

  const prompt = [
    'About me:',
    USER_PROFILE,
    '',
    'My usual interests: ' + INTERESTS.join('; '),
    '',
    'Topics I have already been shown recently (do NOT repeat or closely paraphrase): ' + (recent.join('; ') || 'none'),
    'Never suggest anything related to: ' + (ctx.blocked.join(', ') || 'n/a'),
    '',
    'Task: pick ONE "rabbit hole" for today\'s Discovery video.',
    'Step 1 (silently): brainstorm 8 candidates. Each must be a concrete phenomenon, person, place, study, invention, '
      + 'historical episode, or surprising question, sitting just outside my usual interests '
      + '(ideally an unexpected link between two of them, or a field next door I have never looked at).',
    'Step 2: discard anything a typical self-improvement or pop-science YouTube viewer has already seen many times. '
      + 'Overexposed (never pick): Stoicism, dopamine detox, atomic habits, flow state, Dunning-Kruger, Maslow, '
      + 'the marshmallow test, 10,000-hour rule, cold plunges, intermittent fasting basics, "ancient wisdom meets neuroscience".',
    'Step 3: return the most surprising remaining candidate that still has enough good long-form YouTube content.',
    '',
    'The level of specificity I want:',
    '- Why some Japanese companies have survived for 1,000 years',
    '- How the Medici bank invented modern finance and then collapsed',
    '- What octopus intelligence suggests about consciousness',
    '- Why Tibetan sky burial exists',
    '- How Victorian advertising invented the modern brand',
    'Too generic (never do this): personal growth, AI trends, healthy habits, mindfulness for beginners, philosophy and psychology.',
    '',
    'Return JSON only:',
    '{"theme": "a specific 3-6 word label", "hook": "the curious question this explores, max 20 words", '
      + (CONFIG.BILINGUAL ? '"theme_zh": "theme in natural Simplified Chinese", "hook_zh": "hook in natural Simplified Chinese", ' : '')
      + '"queries": ["three YouTube search queries, 2-6 words each, ordered from specific to slightly broader, '
      + 'phrased the way a real person would type them"]}'
  ].join('\n');

  for (let attempt = 1; attempt <= 2; attempt++) {
    const plan = callGeminiJson(prompt, { temperature: 1.0, maxTokens: 512 });
    if (plan && plan.theme && Array.isArray(plan.queries) && plan.queries.length) {
      const allText = [plan.theme, plan.hook].concat(plan.queries).join(' ');
      if (!matchesBlocked(allText, ctx.blocked)) {
        return {
          theme: oneLine(plan.theme, 80),
          hook: oneLine(plan.hook || '', 160),
          themeZh: oneLine(plan.theme_zh || '', 40),
          hookZh: oneLine(plan.hook_zh || '', 80),
          queries: plan.queries.slice(0, 3).map(function (q) { return oneLine(q, 80); })
        };
      }
      log('Discovery 话题命中屏蔽词，重试：' + plan.theme);
    }
  }

  // Gemini 不可用时的兜底：随机两个兴趣交叉
  const picks = shuffle(INTERESTS);
  log('Discovery 使用兜底话题');
  return { theme: picks[0], hook: '', queries: [picks[0], picks[1]] };
}

// ============================================
// Highlights
// ============================================

/** 返回 { highlights, highlightsZh, titleZh }；双语模式下中文部分由同一次调用生成，不额外花额度 */
function writeHighlights(item, ctx) {
  const vu = CONFIG.VIDEO_UNDERSTANDING;
  const canWatch = item.type === 'youtube'
    && vu.enabled
    && item.minutes > 0
    && !geminiPrimaryBusy            // 主模型已经繁忙/没额度，就别再花额度看视频
    && Date.now() - ctx.startedAt < vu.skipAfterMs;
  const json = CONFIG.BILINGUAL;

  if (canWatch) {
    const watchedMinutes = Math.min(item.minutes, vu.maxMinutes);
    const parts = [
      {
        fileData: { fileUri: item.url },
        videoMetadata: { startOffset: '0s', endOffset: Math.round(watchedMinutes * 60) + 's', fps: vu.fps }
      },
      { text: buildHighlightsPrompt(item, watchedMinutes) }
    ];
    // 看视频很慢，失败就直接改用文字，不重试
    const text = callGemini(parts, { temperature: 0.3, mediaResolution: 'MEDIA_RESOLUTION_LOW', retries: 1, fallback: false, markBusy: false, json: json, maxTokens: 3072 });
    if (text) {
      log('Highlights（看视频）：' + item.title.slice(0, 50));
      return parseHighlights(text);
    }
    log('视频理解失败，改用文字资料：' + item.title.slice(0, 50));
  }

  const text = callGeminiText(buildHighlightsPrompt(item, 0), { temperature: 0.3, json: json, maxTokens: 3072 });
  if (text) log('Highlights（文字）：' + item.title.slice(0, 50));
  return text ? parseHighlights(text) : null;
}

function parseHighlights(text) {
  if (!CONFIG.BILINGUAL) return { highlights: cleanModelText(text) };
  let data = null;
  try {
    data = JSON.parse(text);
  } catch (e) {
    const match = text.match(/\{[\s\S]*\}/);
    try { data = match ? JSON.parse(match[0]) : null; } catch (err) { data = null; }
  }
  if (!data || !data.en) return { highlights: cleanModelText(text) }; // 没按 JSON 返回，就当作纯英文摘要
  return {
    highlights: cleanModelText(data.en),
    highlightsZh: cleanModelText(data.zh || ''),
    titleZh: oneLine(data.title_zh || '', 120)
  };
}

function buildHighlightsPrompt(item, watchedMinutes) {
  const kind = { youtube: 'YouTube video', podcast: 'podcast episode', substack: 'newsletter article' }[item.type];
  const materialLabel = { youtube: 'Video description', podcast: 'Show notes', substack: 'Article text (may be truncated)' }[item.type];

  const sourceNote = watchedMinutes
    ? 'You have the video itself (you watched the first ' + Math.round(watchedMinutes) + ' minutes'
      + (item.minutes > watchedMinutes ? ' of ' + item.duration : '') + '). '
      + 'The description below is extra context (chapters, guests, links).'
    : 'You do NOT have the full ' + kind + '. The text below is your only source.';

  return [
    'Write a short briefing about this ' + kind + ' for the reader described below.',
    '',
    'Reader:',
    USER_PROFILE,
    '',
    'Title: ' + item.title,
    'From: ' + item.channel,
    'Published: ' + (item.publishedAt || 'unknown'),
    item.duration ? 'Length: ' + item.duration : '',
    '',
    sourceNote,
    '',
    materialLabel + ':',
    item.description || '(none)',
    '',
    'Instructions for the English briefing:',
    '- 130-180 words of flowing prose. Open with the single most interesting idea, no preamble.',
    '- Be concrete: name the specific arguments, frameworks, studies, numbers, people or examples that actually appear.',
    '- Never invent details. If the source is thin (e.g. a description that is mostly links and sponsors), '
      + 'write only 50-90 words describing what it is about, without guessing specifics.',
    '- Ignore sponsor reads, ads, discount codes and social links.',
    '- End with one sentence on who will get the most out of it, or what to pay attention to.',
    '- Third person. No bullet points, no markdown, no emoji, no headings.',
    CONFIG.BILINGUAL ? [
      '',
      'Also write a Simplified Chinese version for a reader whose English is limited:',
      '- Rewrite the same content in natural, fluent Chinese (not a word-for-word translation), about 200-300 characters.',
      '- The first time a specialized term, acronym, drug, scientific concept, or lesser-known person appears, '
        + 'keep the original term and add a short plain-language explanation in Chinese parentheses, '
        + 'e.g. "DMT（二甲基色胺，一种强效致幻物质）", "entoptic phenomena（内视现象：眼睛自身结构产生、看到的光点或图案）".',
      '- Also translate the title into natural Chinese.',
      '',
      'Return JSON only: {"en": "<English briefing>", "zh": "<中文摘要>", "title_zh": "<中文标题>"}'
    ].join('\n') : 'Return only the briefing text.'
  ].join('\n');
}


// ============================================
// 五个栏目的选片逻辑
// 共同模式：抓候选 → 规则过滤 → 启发式排序 → Gemini 按口味挑一条
// ctx = { seen, blocked, startedAt }，选中的内容会立刻加入 ctx.seen，避免栏目之间重复
// ============================================

function choose(candidates, slotDescription, ctx, options) {
  const picked = pickBestWithGemini(candidates, slotDescription, ctx, options);
  if (picked) ctx.seen.add(picked.id);
  return picked;
}

// ---------- Part 1A：你订阅的 YouTube 频道 ----------

function pickFavoriteVideo(ctx) {
  const rules = CONFIG.RULES.favoriteVideo;
  const ids = shuffle(getFavoriteChannelVideoIds(ctx)).slice(0, 100);

  const candidates = ytVideoDetails(ids)
    .map(toVideoItem)
    .filter(function (v) { return passesVideoRules(v, rules, ctx); })
    .sort(byLikeRateDesc);
  log('YouTube 频道：通过筛选 ' + candidates.length + ' 条');

  // 先打乱再交给 Gemini，避免每天都是点赞率最高的那几个频道
  return choose(shuffle(candidates.slice(0, CONFIG.RERANK_POOL * 2)),
    'A long-form video from YouTube channels I already follow. Pick the one most worth my time today.', ctx);
}

// ---------- Part 1B：Podcast ----------

function pickPodcast(ctx) {
  const candidates = shuffle(getPodcastCandidates(ctx));
  return choose(candidates,
    'A podcast episode from shows I already follow. Pick the episode with the most substantive conversation.', ctx);
}

// ---------- Part 1C：Substack ----------

function pickSubstack(ctx) {
  const candidates = shuffle(getSubstackCandidates(ctx));
  return choose(candidates,
    'A newsletter article from writers I follow. Pick the most original, thought-provoking piece (not news roundups or housekeeping posts).', ctx);
}

// ---------- Part 2：Breakout（小频道爆款）----------
// 不再按绝对播放量排序（那样永远是大众内容），而是看"播放量 / 订阅数"：
// 小频道的视频播放远超自身订阅数，通常说明内容本身真的好。

function pickTrending(ctx) {
  const rules = CONFIG.RULES.trending;
  const publishedAfter = daysAgo(rules.maxAgeDays).toISOString();
  const queryPool = shuffle(INTERESTS);

  // 一轮 3 个搜索词；Gemini 觉得这批都是标题党/鸡汤，就换一批搜索词再来一轮（每轮约 300 YouTube 配额）
  for (let round = 0; round < rules.rounds; round++) {
    const queries = queryPool.slice(round * rules.queries, (round + 1) * rules.queries);
    if (!queries.length) break;
    log('Breakout 第 ' + (round + 1) + ' 轮搜索词：' + queries.join(' | '));

    const picked = choose(findBreakoutCandidates(queries, publishedAfter, rules, ctx),
      'A breakout video from the last ' + rules.maxAgeDays + ' days: videos massively outperforming their channel size '
        + '(views vs subscribers, shown first). Pick the one with real substance, not just hype.', ctx, { allowSkip: true });
    if (picked) return picked;
  }
  return null;
}

function findBreakoutCandidates(queries, publishedAfter, rules, ctx) {
  let ids = [];
  queries.forEach(function (q) {
    ids = ids.concat(ytSearchIds(q, { order: 'relevance', publishedAfter: publishedAfter, videoDuration: 'long' }));
  });
  ids = unique(ids).filter(function (id) { return !ctx.seen.has(id); });

  const videos = ytVideoDetails(ids)
    .map(toVideoItem)
    .filter(function (v) { return passesVideoRules(v, rules, ctx); });
  log('Breakout：通过筛选 ' + videos.length + ' 条');
  if (!videos.length) return [];

  const subscribers = ytChannelSubscribers(videos.map(function (v) { return v.channelId; }));
  videos.forEach(function (v) {
    const subs = subscribers[v.channelId];
    v.subscribers = subs != null ? subs : null;
    v.breakout = subs != null ? v.views / Math.max(subs, 1000) : null;
  });

  // 有订阅数的按爆款倍数排序，隐藏订阅数的排在后面
  return videos.sort(function (a, b) {
    if (a.breakout == null) return 1;
    if (b.breakout == null) return -1;
    return b.breakout - a.breakout;
  });
}

// ---------- Part 3：Discovery（兔子洞）----------

function pickDiscovery(ctx) {
  const rules = CONFIG.RULES.discovery;
  const rejected = [];

  // 第一轮如果候选都不够好（比如搜到的只是旅游 vlog），换一个话题再来一轮；最后一轮一定选出一条
  for (let round = 1; round <= rules.rounds; round++) {
    const plan = planDiscovery(ctx, rejected);
    log('Discovery 第 ' + round + ' 轮话题：' + plan.theme + ' — ' + plan.hook);
    log('Discovery 搜索词：' + plan.queries.join(' | '));

    const candidates = findDiscoveryCandidates(plan, rules, ctx);
    const isLastRound = round === rules.rounds;
    const picked = choose(candidates,
      'Discovery rabbit hole "' + plan.theme + '"' + (plan.hook ? ': ' + plan.hook : '')
        + '. The pick must be directly about this theme (not a loosely related tangent, travel vlog or sensational clip). '
        + 'Pick the video that opens it up best for a curious newcomer who wants depth, not a shallow overview.',
      ctx, { allowSkip: !isLastRound });

    if (picked) {
      picked.discovery = plan;
      return picked;
    }
    rejected.push(plan.theme);
  }
  return null;
}

function findDiscoveryCandidates(plan, rules, ctx) {
  const publishedAfter = daysAgo(rules.maxAgeYears * 365).toISOString();
  let candidates = [];

  // 从最具体的搜索词开始，候选够了就停（每次搜索 100 配额）
  for (let i = 0; i < plan.queries.length && candidates.length < rules.wantCandidates; i++) {
    const known = candidates.map(function (c) { return c.id; });
    const ids = ytSearchIds(plan.queries[i], { order: 'relevance', publishedAfter: publishedAfter })
      .filter(function (id) { return !ctx.seen.has(id) && known.indexOf(id) === -1; });
    const found = ytVideoDetails(ids)
      .map(toVideoItem)
      .filter(function (v) { return passesVideoRules(v, rules, ctx); });
    log('  "' + plan.queries[i] + '" → ' + found.length + ' 条');
    candidates = candidates.concat(found);
  }
  return candidates.sort(byLikeRateDesc);
}


// ============================================
// 邮件 HTML
// 用 table 布局 + 内联样式：Gmail 不支持 flex / position:absolute，旧版在 Gmail 里会变形。
// 所有标题、简介都经过 escapeHtml，避免 & < 之类的字符把排版弄坏。
// ============================================

const THEMES = {
  favorite:  { label: 'YouTube',   accent: '#7c3aed', soft: '#ede9fe', cta: 'Watch' },
  podcast:   { label: 'Podcast',   accent: '#c026d3', soft: '#fae8ff', cta: 'Listen' },
  substack:  { label: 'Substack',  accent: '#ea580c', soft: '#ffedd5', cta: 'Read' },
  trending:  { label: 'Breakout',  accent: '#0284c7', soft: '#e0f2fe', cta: 'Watch' },
  discovery: { label: 'Discovery', accent: '#059669', soft: '#d1fae5', cta: 'Watch' }
};

const FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";

function buildEmailHtml(picks, dateLabel) {
  const discoveryPlan = picks.discovery && picks.discovery.discovery;

  const body = [
    headerHtml(dateLabel),
    sectionHtml('Part 01 — Curated Picks', 'From the channels, shows and writers you follow', '#7c3aed', [
      renderItem(picks.favorite, 'favorite'),
      renderItem(picks.podcast, 'podcast'),
      renderItem(picks.substack, 'substack')
    ]),
    sectionHtml('Part 02 — Breakout', 'Recent videos punching far above their channel size', '#0284c7', [
      renderItem(picks.trending, 'trending')
    ]),
    sectionHtml('Part 03 — Discovery',
      discoveryPlan ? discoveryPlan.theme + (discoveryPlan.hook ? ' — ' + discoveryPlan.hook : '')
        + (discoveryPlan.themeZh ? '\n' + discoveryPlan.themeZh + (discoveryPlan.hookZh ? '：' + discoveryPlan.hookZh : '') : '')
        : 'A rabbit hole just outside your usual interests',
      '#059669', [renderItem(picks.discovery, 'discovery')]),
    footerHtml()
  ].join('');

  return '<!DOCTYPE html><html><head><meta charset="UTF-8">'
    + '<meta name="viewport" content="width=device-width,initial-scale=1"></head>'
    + '<body style="margin:0;padding:0;background:#f4f3fb;">'
    + '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f4f3fb;">'
    + '<tr><td align="center" style="padding:24px 12px;">'
    + '<table role="presentation" width="640" cellpadding="0" cellspacing="0" border="0" '
    + 'style="width:100%;max-width:640px;font-family:' + FONT + ';color:#1f2937;">'
    + body
    + '</table></td></tr></table></body></html>';
}

function headerHtml(dateLabel) {
  return '<tr><td style="background:#1e1b4b;background-image:linear-gradient(135deg,#0f0c29,#302b63,#24243e);'
    + 'border-radius:16px;padding:32px 28px;text-align:center;">'
    + '<p style="margin:0 0 8px;color:#a78bfa;font-size:11px;letter-spacing:4px;text-transform:uppercase;font-weight:600;">Daily Curation</p>'
    + '<h1 style="margin:0 0 8px;color:#ffffff;font-size:28px;font-weight:800;">Daily Picks</h1>'
    + '<p style="margin:0;color:#c4b5fd;font-size:14px;">' + escapeHtml(dateLabel) + '</p>'
    + '</td></tr>'
    + spacer(24);
}

function sectionHtml(label, subtitle, color, itemsHtml) {
  const divider = '<tr><td style="padding:0 24px;"><div style="height:1px;background:#ede9fe;line-height:1px;font-size:1px;">&nbsp;</div></td></tr>';
  return '<tr><td style="padding:0 4px 10px;">'
    + '<p style="margin:0;font-size:12px;font-weight:800;color:' + color + ';letter-spacing:2px;text-transform:uppercase;'
    + 'border-left:4px solid ' + color + ';padding-left:10px;">' + escapeHtml(label) + '</p>'
    + '<p style="margin:4px 0 0;padding-left:14px;font-size:13px;line-height:1.6;color:#6b7280;">' + escapeHtml(subtitle).replace(/\n/g, '<br>') + '</p>'
    + '</td></tr>'
    + '<tr><td style="background:#ffffff;border-radius:16px;border-top:4px solid ' + color + ';">'
    + '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">'
    + itemsHtml.join(divider)
    + '</table></td></tr>'
    + spacer(28);
}

function renderItem(item, themeKey) {
  const t = THEMES[themeKey];
  if (!item) {
    return '<tr><td style="padding:20px 24px;font-size:13px;color:#9ca3af;font-style:italic;">'
      + 'No ' + t.label + ' pick today — nothing passed the filters.</td></tr>';
  }

  const tags = [
    pill(t.label, t.soft, t.accent, true),
    pill(item.channel),
    item.duration ? pill(item.duration) : '',
    item.breakout ? pill(item.breakout.toFixed(1) + '× subscribers', '#fef3c7', '#b45309', true) : ''
  ].join('');

  const thumbnail = item.thumbnail
    ? '<a href="' + escapeHtml(item.url) + '" style="text-decoration:none;">'
      + '<img src="' + escapeHtml(item.thumbnail) + '" width="592" alt="" '
      + 'style="display:block;width:100%;max-width:592px;height:auto;border:0;border-radius:10px;margin:0 0 14px;"></a>'
    : '';

  const why = item.why
    ? '<p style="margin:0 0 12px;font-size:13px;line-height:1.6;color:' + t.accent + ';">'
      + '<strong>Why this pick:</strong> ' + escapeHtml(item.why)
      + (item.whyZh ? '<br><strong>推荐理由：</strong>' + escapeHtml(item.whyZh) : '') + '</p>'
    : '';

  let highlights = String(item.highlights || '').split(/\n\s*\n/).filter(Boolean).map(function (p) {
    return '<p style="margin:0 0 12px;font-size:14px;line-height:1.8;color:#374151;">' + escapeHtml(p.trim()) + '</p>';
  }).join('');
  if (highlights && item.highlightsZh) {
    highlights += '<p style="margin:16px 0 6px;font-size:11px;font-weight:700;letter-spacing:2px;color:' + t.accent + ';">中文摘要</p>'
      + String(item.highlightsZh).split(/\n\s*\n/).filter(Boolean).map(function (p) {
        return '<p style="margin:0 0 12px;font-size:14px;line-height:1.9;color:#374151;">' + escapeHtml(p.trim()) + '</p>';
      }).join('');
  }
  if (!highlights && item.description) {
    // Gemini 写不出 highlights（比如额度用完）时，退而显示原始简介的开头
    highlights = '<p style="margin:0 0 12px;font-size:13px;line-height:1.7;color:#6b7280;">'
      + escapeHtml(oneLine(item.description, 320)) + '</p>';
  }

  const button = '<a href="' + escapeHtml(item.url) + '" style="display:inline-block;background:' + t.accent + ';'
    + 'color:#ffffff;font-size:14px;font-weight:700;padding:11px 26px;border-radius:10px;text-decoration:none;">'
    + t.cta + ' →</a>';

  return '<tr><td style="padding:22px 24px;">'
    + '<div style="margin:0 0 12px;">' + tags + '</div>'
    + thumbnail
    + '<h3 style="margin:0 0 6px;font-size:18px;line-height:1.35;font-weight:800;">'
    + '<a href="' + escapeHtml(item.url) + '" style="color:#111827;text-decoration:none;">' + escapeHtml(item.title) + '</a></h3>'
    + (item.titleZh ? '<p style="margin:0 0 6px;font-size:14px;color:#4b5563;">' + escapeHtml(item.titleZh) + '</p>' : '')
    + '<p style="margin:0 0 14px;font-size:12px;color:#9ca3af;">' + escapeHtml(metaLine(item)) + '</p>'
    + why
    + (highlights ? '<div style="border-left:3px solid ' + t.accent + ';padding-left:14px;margin:0 0 16px;">' + highlights + '</div>' : '')
    + button
    + '</td></tr>';
}

function metaLine(item) {
  const parts = [];
  if (item.type === 'youtube') {
    parts.push(formatCount(item.views) + ' views');
    if (item.likeRate != null) parts.push((item.likeRate * 100).toFixed(1) + '% like rate');
    if (item.subscribers) parts.push(formatCount(item.subscribers) + ' subscribers');
  }
  if (item.publishedAt) parts.push('Published ' + item.publishedAt);
  return parts.join('  ·  ');
}

function pill(text, bg, color, bold) {
  return '<span style="display:inline-block;margin:0 6px 6px 0;padding:4px 11px;border-radius:20px;font-size:11px;'
    + 'background:' + (bg || '#f3f4f6') + ';color:' + (color || '#4b5563') + ';' + (bold ? 'font-weight:700;' : '') + '">'
    + escapeHtml(text) + '</span>';
}

function spacer(height) {
  return '<tr><td style="height:' + height + 'px;line-height:' + height + 'px;font-size:1px;">&nbsp;</td></tr>';
}

function footerHtml() {
  return '<tr><td style="background:#ffffff;border:1px solid #e5e7eb;border-radius:12px;padding:18px;text-align:center;">'
    + '<p style="margin:0 0 6px;font-size:12px;color:#9ca3af;">Daily Picks — curated with Gemini · Singapore time</p>'
    + '<a href="' + escapeHtml(CONFIG.SHEET_URL) + '" style="font-size:12px;color:#7c3aed;font-weight:600;text-decoration:none;">'
    + 'Manage channels, podcasts &amp; blocked topics</a>'
    + '</td></tr>';
}

/** 纯文本版本（不支持 HTML 的邮件客户端会显示这个） */
function buildPlainText(picks, dateLabel) {
  const lines = ['Daily Picks — ' + dateLabel, ''];
  [['YouTube', picks.favorite], ['Podcast', picks.podcast], ['Substack', picks.substack],
    ['Breakout', picks.trending], ['Discovery', picks.discovery]].forEach(function (pair) {
    if (!pair[1]) return;
    lines.push('[' + pair[0] + '] ' + pair[1].title + (pair[1].titleZh ? '（' + pair[1].titleZh + '）' : ''), pair[1].url, '');
  });
  return lines.join('\n');
}


// ============================================
// 主流程
// 定时触发器调用的是 sendDailyYouTubePicks（保留旧名字，已有的触发器不用改）
// ============================================

function sendDailyYouTubePicks() {
  runDailyPicks({ dryRun: false });
}

/** 测试用：真实跑一遍并发一封 [TEST] 邮件，但不记录"已推荐"，明天照样能推这些内容 */
function testRun() {
  runDailyPicks({ dryRun: true });
}

function runDailyPicks(options) {
  const dryRun = !!(options && options.dryRun);
  const dateLabel = Utilities.formatDate(new Date(), CONFIG.TIMEZONE, 'dd MMM yyyy');
  log('=== Daily Picks v4 开始' + (dryRun ? '（测试模式）' : '') + ' ===');

  try {
    const ctx = { seen: loadSeen(), blocked: getBlockedTopics(), startedAt: Date.now() };
    log('已推荐记录 ' + ctx.seen.size() + ' 条，屏蔽词 ' + ctx.blocked.length + ' 个');

    // 1. 选片（各栏目互相独立，一个失败不影响其他）
    const picks = {
      favorite:  safely('Part 1 YouTube', function () { return pickFavoriteVideo(ctx); }),
      podcast:   safely('Part 1 Podcast', function () { return pickPodcast(ctx); }),
      substack:  safely('Part 1 Substack', function () { return pickSubstack(ctx); }),
      trending:  safely('Part 2 Breakout', function () { return pickTrending(ctx); }),
      discovery: safely('Part 3 Discovery', function () { return pickDiscovery(ctx); })
    };

    const items = Object.keys(picks).map(function (k) { return picks[k]; }).filter(Boolean);
    Object.keys(picks).forEach(function (k) { log(k + ': ' + (picks[k] ? picks[k].title : '—')); });

    if (!items.length) {
      sendErrorEmail('No content found', '五个栏目都没有选出内容，请查看执行日志（Executions）。');
      return;
    }

    // 2. 写 highlights
    items.forEach(function (item) {
      Object.assign(item, safely('Highlights', function () { return writeHighlights(item, ctx); }) || {});
    });

    // 3. 发邮件
    const discoveryTheme = picks.discovery && picks.discovery.discovery ? picks.discovery.discovery.theme : '';
    const subject = (dryRun ? '[TEST] ' : '') + 'Daily Picks · ' + dateLabel + (discoveryTheme ? ' · ' + discoveryTheme : '');
    // 用 GmailApp（和 v3 一样），不需要重新授权
    GmailApp.sendEmail(CONFIG.EMAIL_TO, subject, buildPlainText(picks, dateLabel), {
      htmlBody: buildEmailHtml(picks, dateLabel),
      name: 'Daily Picks'
    });
    log('邮件已发送：' + subject);

    // 4. 邮件发出去之后才保存记录（旧版是先记录再发，发失败内容就丢了）
    if (!dryRun) {
      ctx.seen.save();
      if (discoveryTheme) addRecentTopic(discoveryTheme);
    }

    log('=== 完成，用时 ' + Math.round((Date.now() - ctx.startedAt) / 1000) + ' 秒 ===');
  } catch (e) {
    log('致命错误：' + e.stack);
    sendErrorEmail('Run failed', e.message + '\n\n' + e.stack);
  }
}

function safely(label, fn) {
  try {
    return fn();
  } catch (e) {
    log('⚠️ ' + label + ' 出错：' + e.message);
    return null;
  }
}

function sendErrorEmail(title, details) {
  GmailApp.sendEmail(CONFIG.EMAIL_TO, 'Daily Picks - ERROR: ' + title, details);
}


// ============================================
// 一次性设置 & 诊断工具（手动在编辑器里运行，不会被定时调用）
// ============================================

/** 创建每天定时发送的触发器（会先删掉旧的同名触发器，避免一天发两封） */
function installDailyTrigger() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'sendDailyYouTubePicks') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('sendDailyYouTubePicks')
    .timeBased()
    .everyDays(1)
    .atHour(CONFIG.SEND_HOUR)
    .inTimezone(CONFIG.TIMEZONE)
    .create();
  log('已创建触发器：每天 ' + CONFIG.SEND_HOUR + ':00–' + (CONFIG.SEND_HOUR + 1) + ':00（' + CONFIG.TIMEZONE + '）');
}

/** 列出当前所有触发器 */
function listTriggers() {
  const triggers = ScriptApp.getProjectTriggers();
  if (!triggers.length) log('没有任何触发器 —— 脚本不会自动运行，请运行 installDailyTrigger');
  triggers.forEach(function (t) {
    log(t.getHandlerFunction() + ' | ' + t.getEventType() + ' | id=' + t.getUniqueId());
  });
}

/** 检查配置、API Key、Sheet、各个 RSS 是否正常（约花 10–20 个 YouTube 配额） */
function diagnose() {
  log('=== Diagnose ===');

  ['GEMINI_API_KEY', 'YOUTUBE_API_KEY'].forEach(function (name) {
    const v = PropertiesService.getScriptProperties().getProperty(name);
    log(name + ': ' + (v ? 'OK (' + v.length + ' chars)' : '❌ MISSING'));
  });

  const channels = getChannels();
  const podcasts = getPodcasts();
  const substacks = getSubstacks();
  log('Channels: ' + channels.length + ' | Podcasts: ' + podcasts.length + ' | Substacks: ' + substacks.length
    + ' | Blocked: ' + getBlockedTopics().length);
  log('已推荐记录: ' + loadSeen().size() + ' | 最近 Discovery 话题: ' + getRecentTopics().join('; '));

  log('--- YouTube 频道检查（失败的会列出来）---');
  log('YouTube 频道正常 ' + resolveUploadPlaylists(channels).length + ' / ' + channels.length);

  log('--- Podcast / Substack RSS 检查（失败的会列出来）---');
  const feeds = podcasts.concat(substacks);
  log('RSS 正常 ' + fetchFeeds(feeds).length + ' / ' + feeds.length);

  log('--- YouTube API ---');
  log(ytVideoDetails(['dQw4w9WgXcQ']).length ? 'YouTube API OK' : '❌ YouTube API 失败（看上面的错误）');

  log('--- Gemini ---');
  const reply = callGeminiText('Reply with exactly: OK', { maxTokens: 20 });
  log(reply ? 'Gemini OK: ' + reply : '❌ Gemini 失败（看上面的错误）');

  listTriggers();
  log('=== Diagnose 完成 ===');
}

/** 列出你的 Gemini API Key 目前能用的模型（Google 换型号时用来查新名字） */
function listGeminiModels() {
  const res = UrlFetchApp.fetch('https://generativelanguage.googleapis.com/v1beta/models?pageSize=200', {
    headers: { 'x-goog-api-key': getSecret('GEMINI_API_KEY') },
    muteHttpExceptions: true
  });
  if (res.getResponseCode() !== 200) {
    log('查询失败 HTTP ' + res.getResponseCode() + '：' + describeGeminiError(res.getContentText()));
    return;
  }
  (JSON.parse(res.getContentText()).models || [])
    .filter(function (m) { return (m.supportedGenerationMethods || []).indexOf('generateContent') !== -1; })
    .forEach(function (m) { log(m.name.replace('models/', '') + '  —  ' + (m.displayName || '')); });
  log('当前设置：主模型 ' + CONFIG.GEMINI_MODEL + '，备用模型 ' + CONFIG.GEMINI_FALLBACK_MODEL);
}

/** 清空"已推荐"记录（想让旧内容重新有机会被推荐时用） */
function resetSeen() {
  PropertiesService.getScriptProperties().deleteProperty(SEEN_PROPERTY);
  log('已清空推荐记录');
}

/** 删除 v3 遗留的话题池属性（v4 不再使用，可选运行一次） */
function cleanupV3Properties() {
  PropertiesService.getScriptProperties().deleteProperty('DISCOVERY_TOPIC_POOL');
  log('已删除 DISCOVERY_TOPIC_POOL');
}
