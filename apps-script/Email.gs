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
      discoveryPlan ? discoveryPlan.theme + (discoveryPlan.hook ? ' — ' + discoveryPlan.hook : '') : 'A rabbit hole just outside your usual interests',
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
    + '<p style="margin:4px 0 0;padding-left:14px;font-size:13px;color:#6b7280;">' + escapeHtml(subtitle) + '</p>'
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
      + '<strong>Why this pick:</strong> ' + escapeHtml(item.why) + '</p>'
    : '';

  const highlights = String(item.highlights || '').split(/\n\s*\n/).filter(Boolean).map(function (p) {
    return '<p style="margin:0 0 12px;font-size:14px;line-height:1.8;color:#374151;">' + escapeHtml(p.trim()) + '</p>';
  }).join('');

  const button = '<a href="' + escapeHtml(item.url) + '" style="display:inline-block;background:' + t.accent + ';'
    + 'color:#ffffff;font-size:14px;font-weight:700;padding:11px 26px;border-radius:10px;text-decoration:none;">'
    + t.cta + ' →</a>';

  return '<tr><td style="padding:22px 24px;">'
    + '<div style="margin:0 0 12px;">' + tags + '</div>'
    + thumbnail
    + '<h3 style="margin:0 0 6px;font-size:18px;line-height:1.35;font-weight:800;">'
    + '<a href="' + escapeHtml(item.url) + '" style="color:#111827;text-decoration:none;">' + escapeHtml(item.title) + '</a></h3>'
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
    lines.push('[' + pair[0] + '] ' + pair[1].title, pair[1].url, '');
  });
  return lines.join('\n');
}
