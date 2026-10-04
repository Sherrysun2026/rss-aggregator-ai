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
  const plan = planDiscovery(ctx);
  log('Discovery 话题：' + plan.theme + ' — ' + plan.hook);
  log('Discovery 搜索词：' + plan.queries.join(' | '));

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

  candidates.sort(byLikeRateDesc);
  const picked = choose(candidates,
    'Discovery rabbit hole "' + plan.theme + '"' + (plan.hook ? ': ' + plan.hook : '')
      + '. The pick must be directly about this theme (not a loosely related or sensational tangent). '
      + 'Pick the video that opens it up best for a curious newcomer who wants depth, not a shallow overview.', ctx);

  if (picked) picked.discovery = plan;
  return picked;
}
