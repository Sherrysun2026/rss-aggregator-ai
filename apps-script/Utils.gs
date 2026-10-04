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
