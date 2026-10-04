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
