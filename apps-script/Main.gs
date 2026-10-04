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
      item.highlights = safely('Highlights', function () { return writeHighlights(item, ctx); }) || '';
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
