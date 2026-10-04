// ============================================
// Gemini：统一调用 + 选片 + Discovery 话题 + Highlights
// ============================================

/**
 * 调用 Gemini，返回文本；失败返回 null。
 * 遇到 429（限流）或 5xx（模型繁忙）会等待重试；主模型一直繁忙时，换备用模型再试。
 * options: temperature, maxTokens, json, mediaResolution,
 *          retries（每个模型最多试几次，默认 2）, fallback（是否允许换备用模型，默认 true）
 */
// 主模型本次运行中已经连续繁忙过一次，就不再先试它，直接用备用模型（省下每次十几秒的重试等待）
let geminiPrimaryBusy = false;

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

  const request = {
    method: 'post',
    contentType: 'application/json',
    headers: { 'x-goog-api-key': getSecret('GEMINI_API_KEY') }, // key 放 header，不出现在 URL 里
    payload: JSON.stringify({ contents: [{ role: 'user', parts: parts }], generationConfig: generationConfig }),
    muteHttpExceptions: true
  };

  const canFallback = options.fallback !== false && !!CONFIG.GEMINI_FALLBACK_MODEL;
  const models = canFallback && geminiPrimaryBusy ? [CONFIG.GEMINI_FALLBACK_MODEL]
    : canFallback ? [CONFIG.GEMINI_MODEL, CONFIG.GEMINI_FALLBACK_MODEL]
    : [CONFIG.GEMINI_MODEL];
  const retries = options.retries || 2;

  for (let m = 0; m < models.length; m++) {
    const url = 'https://generativelanguage.googleapis.com/v1beta/models/' + models[m] + ':generateContent';

    for (let attempt = 1; attempt <= retries; attempt++) {
      let res;
      try {
        res = UrlFetchApp.fetch(url, request);
      } catch (e) {
        log('Gemini ' + models[m] + ' 请求异常（第 ' + attempt + ' 次）：' + e.message);
        if (attempt < retries) Utilities.sleep(3000);
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
        if (text && m > 0) log('（已改用备用模型 ' + models[m] + '）');
        return text || null;
      }

      let message = res.getContentText();
      try { message = JSON.parse(message).error.message; } catch (e) { /* 保留原文 */ }
      log('Gemini ' + models[m] + ' HTTP ' + code + '（第 ' + attempt + ' 次）：' + String(message).slice(0, 200));

      const retryable = code === 429 || code >= 500;
      if (!retryable) return null;                                         // 400 之类的错误重试也没用
      if (attempt < retries) Utilities.sleep(5000 * attempt); // 5s, 10s
    }
    if (models[m] === CONFIG.GEMINI_MODEL && canFallback) geminiPrimaryBusy = true;
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
    // 看视频很慢，失败就直接改用文字，不重试
    const text = callGemini(parts, { temperature: 0.3, mediaResolution: 'MEDIA_RESOLUTION_LOW', retries: 1, fallback: false });
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
