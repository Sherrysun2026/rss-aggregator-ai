// ============================================
// Gemini：统一调用 + 选片 + Discovery 话题 + Highlights
// ============================================

/**
 * 调用 Gemini，返回文本；失败返回 null。
 * 遇到 429（限流）或 5xx 会自动等待重试，最多 3 次。
 * options: temperature, maxTokens, json, mediaResolution
 */
function callGemini(parts, options) {
  options = options || {};
  const generationConfig = {
    temperature: options.temperature != null ? options.temperature : 0.4,
    maxOutputTokens: options.maxTokens || 2048
  };
  if (CONFIG.GEMINI_THINKING_BUDGET != null) {
    generationConfig.thinkingConfig = { thinkingBudget: CONFIG.GEMINI_THINKING_BUDGET };
  }
  if (options.json) generationConfig.responseMimeType = 'application/json';
  if (options.mediaResolution) generationConfig.mediaResolution = options.mediaResolution;

  const url = 'https://generativelanguage.googleapis.com/v1beta/models/' + CONFIG.GEMINI_MODEL + ':generateContent';
  const request = {
    method: 'post',
    contentType: 'application/json',
    headers: { 'x-goog-api-key': getSecret('GEMINI_API_KEY') }, // key 放 header，不出现在 URL 里
    payload: JSON.stringify({ contents: [{ role: 'user', parts: parts }], generationConfig: generationConfig }),
    muteHttpExceptions: true
  };

  for (let attempt = 1; attempt <= 3; attempt++) {
    let res;
    try {
      res = UrlFetchApp.fetch(url, request);
    } catch (e) {
      log('Gemini 请求异常（第 ' + attempt + ' 次）：' + e.message);
      if (attempt === 3) return null;
      Utilities.sleep(3000);
      continue;
    }

    const code = res.getResponseCode();
    if (code === 200) {
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
      return text || null;
    }

    log('Gemini HTTP ' + code + '（第 ' + attempt + ' 次）：' + res.getContentText().slice(0, 300));
    const retryable = code === 429 || code >= 500;
    if (!retryable || attempt === 3) return null;
    Utilities.sleep(5000 * Math.pow(2, attempt - 1)); // 5s, 10s
  }
  return null;
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
function pickBestWithGemini(candidates, slotDescription, ctx) {
  if (!candidates.length) return null;
  const pool = candidates.slice(0, CONFIG.RERANK_POOL);
  if (pool.length === 1) return pool[0];

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
    'If every candidate is weak, still pick the least bad one.',
    '',
    'Return JSON only: {"index": <number>, "why": "<one sentence, max 25 words, written to me as \'you\', in '
      + CONFIG.OUTPUT_LANGUAGE + ', on why this is worth my time>"}'
  ].join('\n');

  const result = callGeminiJson(prompt, { temperature: 0.3, maxTokens: 512 });
  const index = result ? Number(result.index) : NaN;

  if (result && Number.isInteger(index) && pool[index]) {
    const picked = pool[index];
    picked.why = oneLine(result.why || '', 220);
    log('Gemini 选中 #' + index + '：' + picked.title);
    return picked;
  }

  log('Gemini 选片失败，退回启发式排序');
  return pool[Math.floor(Math.random() * Math.min(pool.length, 3))];
}

// ============================================
// Discovery：每天生成一个"兔子洞"话题
// ============================================

function planDiscovery(ctx) {
  const recent = getRecentTopics();

  const prompt = [
    'About me:',
    USER_PROFILE,
    '',
    'My usual interests: ' + INTERESTS.join('; '),
    '',
    'Topics I have already been shown recently (do NOT repeat or closely paraphrase): ' + (recent.join('; ') || 'none'),
    'Never suggest anything related to: ' + (ctx.blocked.join(', ') || 'n/a'),
    '',
    'Propose ONE "rabbit hole" for today\'s Discovery pick. It should sit just outside my usual interests: '
      + 'ideally an unexpected intersection of two of them, or a concrete, surprising question a curious person '
      + 'would want to go deep on. Make it specific (a phenomenon, person, place, study, or question), never a broad category.',
    '',
    'The level of specificity I want:',
    '- Why some Japanese companies have survived for 1,000 years',
    '- What the Dunbar number means for how teams should be designed',
    '- What brain scans of long-term meditators actually show',
    '- How Renaissance painters suddenly mastered perspective',
    'Too generic (never do this): personal growth, AI trends, healthy habits, mindfulness for beginners.',
    '',
    'Return JSON only:',
    '{"theme": "3-6 word label", "hook": "one sentence: the curious question this explores", '
      + '"queries": ["three YouTube search queries, 3-7 words each, ordered from most specific to slightly broader, '
      + 'phrased the way a real person would type them"]}'
  ].join('\n');

  for (let attempt = 1; attempt <= 2; attempt++) {
    const plan = callGeminiJson(prompt, { temperature: 1.0, maxTokens: 512 });
    if (plan && plan.theme && Array.isArray(plan.queries) && plan.queries.length) {
      const allText = [plan.theme, plan.hook].concat(plan.queries).join(' ');
      if (!matchesBlocked(allText, ctx.blocked)) {
        return {
          theme: oneLine(plan.theme, 80),
          hook: oneLine(plan.hook || '', 200),
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

function writeHighlights(item, ctx) {
  const vu = CONFIG.VIDEO_UNDERSTANDING;
  const canWatch = item.type === 'youtube'
    && vu.enabled
    && item.minutes > 0
    && Date.now() - ctx.startedAt < vu.skipAfterMs;

  if (canWatch) {
    const watchedMinutes = Math.min(item.minutes, vu.maxMinutes);
    const parts = [
      {
        fileData: { fileUri: item.url },
        videoMetadata: { startOffset: '0s', endOffset: Math.round(watchedMinutes * 60) + 's', fps: vu.fps }
      },
      { text: buildHighlightsPrompt(item, watchedMinutes) }
    ];
    const text = callGemini(parts, { temperature: 0.3, mediaResolution: 'MEDIA_RESOLUTION_LOW' });
    if (text) {
      log('Highlights（看视频）：' + item.title.slice(0, 50));
      return cleanModelText(text);
    }
    log('视频理解失败，改用文字资料：' + item.title.slice(0, 50));
  }

  const text = callGeminiText(buildHighlightsPrompt(item, 0), { temperature: 0.3 });
  if (text) log('Highlights（文字）：' + item.title.slice(0, 50));
  return text ? cleanModelText(text) : '';
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
    'Instructions:',
    '- Write in ' + CONFIG.OUTPUT_LANGUAGE + ', 130-180 words of flowing prose. Open with the single most interesting idea, no preamble.',
    '- Be concrete: name the specific arguments, frameworks, studies, numbers, people or examples that actually appear.',
    '- Never invent details. If the source is thin (e.g. a description that is mostly links and sponsors), '
      + 'write only 50-90 words describing what it is about, without guessing specifics.',
    '- Ignore sponsor reads, ads, discount codes and social links.',
    '- End with one sentence on who will get the most out of it, or what to pay attention to.',
    '- Third person. No bullet points, no markdown, no emoji, no headings.',
    'Return only the briefing text.'
  ].join('\n');
}
