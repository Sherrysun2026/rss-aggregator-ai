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
