// ============================================
// 数据来源：Google Sheet 配置表 + RSS 抓取解析
// ============================================

const NS = {
  atom: XmlService.getNamespace('http://www.w3.org/2005/Atom'),
  yt: XmlService.getNamespace('http://www.youtube.com/xml/schemas/2015'),
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

/** Channels 表：A=Handle  B=Name  C=Channel ID  D=Active */
function getChannels() {
  return readSheetRows('Channels')
    .filter(function (r) { return r[1] && r[2] && isActive(r[3]); })
    .map(function (r) {
      const id = String(r[2]).trim();
      return { name: String(r[1]).trim(), id: id, rssUrl: 'https://www.youtube.com/feeds/videos.xml?channel_id=' + id };
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

// ---------- YouTube 频道 RSS ----------

/** 每个频道取最近 perChannel 条没推荐过的视频 ID（旧版只截前 50 条，导致只有前几个频道有机会） */
function getFavoriteChannelVideoIds(ctx) {
  const rules = CONFIG.RULES.favoriteVideo;
  const cutoff = daysAgo(rules.maxAgeDays);
  const channels = getChannels();
  const ids = [];

  fetchFeeds(channels).forEach(function (feed) {
    const fresh = feed.root.getChildren('entry', NS.atom)
      .map(function (entry) {
        return { id: childText(entry, 'videoId', NS.yt), published: parseDate(childText(entry, 'published', NS.atom)) };
      })
      .filter(function (v) { return v.id && v.published && v.published >= cutoff && !ctx.seen.has(v.id); })
      .slice(0, rules.perChannel);
    fresh.forEach(function (v) { ids.push(v.id); });
  });

  log('YouTube 频道：' + channels.length + ' 个，候选视频 ' + ids.length + ' 条');
  return ids;
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
