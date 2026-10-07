/* パーサの結果が「想定どおりか」を見る。
 *
 * 元アプリの HTML は Rails の画面なので、UI が変わると列見出しや器の形が
 * いきなり変わる。パーサは正規表現なので、壊れた HTML でも例外を投げずに
 * 空配列を返すことがある。その「静かに壊れる」のを拾うのがここ。
 *
 * 想定は clone/site/auth で検証できた形（列見出し・見出し文言）。
 * 想定外なら理由を返して呼び出し側が Discord へ送る。
 */

/** 画面ごとの想定。実 HTML で確認できたものだけ。 */
export const PAGE_EXPECTATIONS = {
  '/dashboard': {
    kind: 'dashboard',
    heading: 'ダッシュボード'
  },
  '/reports': {
    kind: 'table',
    columns: ['タイトル', '期間', 'ステータス', '期限', '作成日'],
    itemsKey: 'reports'
  },
  '/orders': {
    kind: 'table',
    columns: ['商品', '単価', '数量', '合計', 'ステータス', '作成日'],
    itemsKey: 'orders'
  },
  '/equipments': {
    kind: 'list',
    heading: '利用可能な機材',
    itemsKey: 'equipments'
  },
  '/loans': {
    kind: 'loans',
    heading: '機材貸出',
    sectionTitles: ['申請中', '貸出中']
  },
  '/notifications': {
    kind: 'list',
    heading: '通知',
    itemsKey: 'notifications'
  },
  '/reports/:id': {
    kind: 'report-detail'
  },
  // 学生の注文詳細 `/orders/:id`。side_panel の断片か全ページ。
  '/orders/:id': {
    kind: 'order-detail'
  },
  // `/ta/orders/:id/details` は Turbo Frame の断片が正常形。
  // `<main>` / `<body>` を持たないので器の判定は frame で行う。
  '/ta/orders/:id': {
    kind: 'ta-order-detail'
  },
  '/ta': {
    kind: 'dashboard',
    heading: 'TAダッシュボード'
  },
  '/ta/orders': {
    kind: 'table',
    columns: ['商品', 'チーム', '単価', '数量', '合計', 'ステータス', '作成日時', '操作'],
    itemsKey: 'orders'
  },
  '/ta/reports': {
    kind: 'table',
    columns: ['チーム', 'タイトル', '期間', 'ステータス', '期限'],
    itemsKey: 'reports'
  },
  '/ta/teams': {
    kind: 'list',
    heading: 'チーム管理',
    itemsKey: 'teams'
  },
  '/ta/users': {
    kind: 'list',
    heading: 'ユーザー一覧 (TA)',
    itemsKey: 'users'
  }
};

/** `/reports/114` や `/reports/<uuid>/edit` を `/reports/:id` の想定に寄せる。
 *  TA のクエリ付き path（`?per_page=` / `?submission_id=`）も正規化する。 */
export function expectationPath(path) {
  const bare = String(path || '').split('?')[0];
  if (PAGE_EXPECTATIONS[bare]) return bare;
  if (PAGE_EXPECTATIONS[path]) return path;
  if (/^\/reports\/(?:\d+|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:\/edit)?$/i.test(bare)) {
    return '/reports/:id';
  }
  if (/^\/orders\/(?:\d+|[0-9a-f-]{36})(?:\/details)?$/i.test(bare)) {
    return '/orders/:id';
  }
  if (/^\/ta\/orders\/(?:\d+|[0-9a-f-]{36})\/details$/i.test(bare)) {
    return '/ta/orders/:id';
  }
  return bare;
}

/**
 * HTML とパース結果を見て、想定外なら { ok: false, reasons } を返す。
 * パース自体が例外を投げた場合は呼び出し側で catch して扱う。
 */
export function inspectParse(path, html, parsed) {
  const reasons = [];
  const expect = PAGE_EXPECTATIONS[expectationPath(path)];

  if (typeof html !== 'string' || !html.trim()) {
    reasons.push('HTML が空');
    return { ok: false, reasons };
  }

  if (html.length < 200) {
    reasons.push(`HTML が短すぎる（${html.length} 文字）`);
  }

  // Turbo Frame の断片（注文詳細など）は器が無くて正常。
  // frame 自体が無いものだけを「器が無い」とする。
  if (!/<main\b/i.test(html) && !/<body\b/i.test(html) && !/<turbo-frame\b/i.test(html)) {
    reasons.push('<main> も <body> も無い');
  }

  // ログイン画面は meister.html() が先に弾く想定。ここまで来たら想定外。
  if (/name="user\[password\]"/.test(html) || /action="\/users\/sign_in"/.test(html)) {
    reasons.push('ログイン画面の HTML が返ってきた');
  }

  if (!expect) {
    return reasons.length ? { ok: false, reasons } : { ok: true, reasons: [] };
  }

  if (!parsed || typeof parsed !== 'object') {
    reasons.push('パース結果がオブジェクトではない');
    return { ok: false, reasons };
  }

  switch (expect.kind) {
    case 'dashboard':
      inspectDashboard(expect, parsed, reasons);
      break;
    case 'table':
      inspectTable(expect, parsed, reasons);
      break;
    case 'list':
      inspectList(expect, parsed, reasons);
      break;
    case 'loans':
      inspectLoans(expect, parsed, reasons);
      break;
    case 'report-detail':
      inspectReportDetail(html, parsed, reasons);
      break;
    case 'ta-order-detail':
      inspectTaOrderDetail(html, parsed, reasons);
      break;
    case 'order-detail':
      inspectOrderDetail(html, parsed, reasons);
      break;
    default:
      reasons.push(`未知の kind: ${expect.kind}`);
  }

  return { ok: reasons.length === 0, reasons };
}

function inspectDashboard(expect, parsed, reasons) {
  if (parsed.heading !== expect.heading) {
    reasons.push(`見出しが「${expect.heading}」ではない（得た値: ${JSON.stringify(parsed.heading)}）`);
  }
}

function inspectTable(expect, parsed, reasons) {
  const labels = Array.isArray(parsed.columns)
    ? parsed.columns.map((c) => c?.label).filter(Boolean)
    : [];

  if (!labels.length) {
    reasons.push('列見出しが取れない');
  } else if (labels.join('\0') !== expect.columns.join('\0')) {
    reasons.push(
      `列見出しが想定と違う（想定: ${expect.columns.join(' / ')}、得た値: ${labels.join(' / ')}）`
    );
  }

  const items = parsed[expect.itemsKey];
  if (!Array.isArray(items)) {
    reasons.push(`${expect.itemsKey} が配列ではない`);
    return;
  }

  for (const [i, row] of items.entries()) {
    if (!row || typeof row !== 'object') {
      reasons.push(`${expect.itemsKey}[${i}] がオブジェクトではない`);
      continue;
    }
    if (Array.isArray(row.cells) && labels.length && row.cells.length !== labels.length) {
      reasons.push(
        `${expect.itemsKey}[${i}] のセル数が列数と違う`
        + `（列 ${labels.length}・セル ${row.cells.length}）`
      );
    }
  }
}

function inspectList(expect, parsed, reasons) {
  if (parsed.heading !== expect.heading) {
    reasons.push(`見出しが「${expect.heading}」ではない（得た値: ${JSON.stringify(parsed.heading)}）`);
  }
  if (!Array.isArray(parsed[expect.itemsKey])) {
    reasons.push(`${expect.itemsKey} が配列ではない`);
  }
}

function inspectReportDetail(html, parsed, reasons) {
  if (!Array.isArray(parsed.fields)) {
    reasons.push('fields が配列ではない');
    return;
  }
  const named = [...String(html || '').matchAll(/\bdata-field-name="([^"]+)"/g)]
    .map((m) => m[1]);
  const got = new Set(parsed.fields.map((f) => f?.name).filter(Boolean));
  for (const name of named) {
    if (!got.has(name)) {
      reasons.push(`data-field-name="${name}" の項目がパース結果に無い`);
    }
  }
}

/** TA 注文詳細。`/ta/orders/:id/details` は side_panel の断片が正常形。 */
function inspectTaOrderDetail(html, parsed, reasons) {
  if (!/<turbo-frame\b[^>]*\bside_panel\b/i.test(String(html || ''))) {
    reasons.push('注文詳細の turbo-frame（side_panel）が無い');
  }
  if (!parsed || typeof parsed !== 'object') {
    reasons.push('パース結果がオブジェクトではない');
    return;
  }
  if (!String(parsed.product || '').trim()) {
    reasons.push('商品名が取れない');
  }
}

/** 学生の注文詳細。商品名は必須、履歴は配列であること。 */
function inspectOrderDetail(html, parsed, reasons) {
  if (!parsed || typeof parsed !== 'object') {
    reasons.push('パース結果がオブジェクトではない');
    return;
  }
  if (!String(parsed.product || '').trim()) {
    reasons.push('商品名が取れない');
  }
  if (!Array.isArray(parsed.history)) {
    reasons.push('history が配列ではない');
  }
}

function inspectLoans(expect, parsed, reasons) {
  if (parsed.heading !== expect.heading) {
    reasons.push(`見出しが「${expect.heading}」ではない（得た値: ${JSON.stringify(parsed.heading)}）`);
  }
  if (!Array.isArray(parsed.sections)) {
    reasons.push('sections が配列ではない');
    return;
  }
  const titles = parsed.sections.map((s) => s?.title).filter(Boolean);
  for (const want of expect.sectionTitles) {
    if (!titles.includes(want)) {
      reasons.push(`貸出の節「${want}」が無い（得た値: ${titles.join(' / ') || 'なし'}）`);
    }
  }
}

/** Discord に載せる HTML の抜粋。秘密や Cookie は出さない。 */
export function htmlSnippet(html, limit = 900) {
  if (typeof html !== 'string') return '';
  const cleaned = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/authenticity_token"\s+value="[^"]+"/gi, 'authenticity_token" value="[redacted]"')
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned.length <= limit ? cleaned : `${cleaned.slice(0, limit)}…`;
}

/** パース異常の Discord 本文。 */
export function buildParseAlertPayload({ path, origin, reasons, html, error }) {
  const lines = [
    path ? `path: \`${path}\`` : null,
    origin ? `origin: ${origin}` : null,
    error ? `exception: ${String(error).slice(0, 500)}` : null,
    reasons?.length ? `reasons:\n${reasons.map((r) => `• ${r}`).join('\n')}` : null
  ].filter(Boolean);

  const snippet = htmlSnippet(html);
  return {
    username: 'Meister Fork Parser',
    embeds: [{
      title: 'HTML パースで予期せぬデータ',
      description: [
        lines.join('\n'),
        snippet ? `\nHTML 抜粋:\n\`\`\`\n${snippet.slice(0, 800)}\n\`\`\`` : null
      ].filter(Boolean).join('\n'),
      color: 0xc4552d,
      timestamp: new Date().toISOString(),
      footer: { text: 'DISCORD_WEBHOOK · mms-fork' }
    }]
  };
}
