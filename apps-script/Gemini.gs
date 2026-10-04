// ============================================
// Gemini：统一调用 + 选片 + Discovery 话题 + Highlights
// ============================================

/**
 * 调用 Gemini，返回文本；失败返回 null。
 * - 5xx（模型繁忙）：等几秒重试
 * - 429（额度用完）：不重试（重试也不会恢复），直接换备用模型（备用模型有自己独立的额度）
 * - 主模型失败过一次后，本次运行剩下的调用直接用备用模型，"看视频"也自动停用
 * options: temperature, maxTokens, json, mediaResolution,
 *          retries（每个模型最多试几次，默认 2）, fallback（是否允许换备用模型，默认 true）
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

    if (model === CONFIG.GEMINI_MODEL && (lastCode === 429 || lastCode >= 500 || lastCode === -1)) {
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
    const text = callGemini(parts, { temperature: 0.3, mediaResolution: 'MEDIA_RESOLUTION_LOW', retries: 1, fallback: false, json: json, maxTokens: 3072 });
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
