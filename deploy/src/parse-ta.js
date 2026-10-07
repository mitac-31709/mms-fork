/* TA 画面（`/ta/**`）の HTML → JSON。
 *
 * 学生画面のパーサ（parse.js / parse-pages.js）と同じ方針。
 * ネットワークに触らない純関数だけを置く。
 */

import {
  parseColumns, parseEmptyState, parseIdToken, text, toIso
} from './parse.js';
import { cleanOrderStatus, toNumber } from './parse-pages.js';

function main(html) {
  const m = String(html || '').match(/<main\b[^>]*>([\s\S]*)<\/main>/i);
  return m ? m[1] : String(html || '');
}

/** ビューモード。TAモード表示か、ナビが /ta/orders を指していれば ta。 */
export function parseViewMode(html) {
  const body = String(html || '');
  const badge = (body.match(/>\s*(TAモード|学生モード)\s*</) || [])[1] || null;
  const canSwitch = /action="\/view_mode\/switch"/.test(body);
  const hasTaNav = /href="\/ta\/orders"/.test(body);
  const hasStudentNav = /href="\/orders"/.test(body) && !hasTaNav;
  let mode = null;
  if (badge === 'TAモード' || (hasTaNav && !hasStudentNav)) mode = 'ta';
  else if (badge === '学生モード' || hasStudentNav) mode = 'student';
  else if (hasTaNav) mode = 'ta';
  else mode = 'student';
  return {
    mode,
    badge: badge || (mode === 'ta' ? 'TAモード' : null),
    canSwitch,
    canTa: canSwitch || hasTaNav || mode === 'ta'
  };
}

/** 利用者情報 + ビューモード。 */
export function parseUserWithMode(html) {
  const target = (name) => {
    const re = new RegExp(
      `<(\\w+)\\b[^>]*data-mobile-menu-target="${name}"[^>]*>([\\s\\S]*?)</\\1>`
    );
    const m = String(html || '').match(re);
    return m ? text(m[2]) || null : null;
  };
  const view = parseViewMode(html);
  return {
    name: target('userName'),
    badge: target('userBadge') || view.badge,
    mode: view.mode,
    canSwitch: view.canSwitch,
    canTa: view.canTa
  };
}

/** TA 注文テーブルの列ラベルを正規化する（チェックボックス列などを落とす）。 */
const TA_ORDER_COL_ALIASES = [
  ['商品', '商品'],
  ['チーム', 'チーム'],
  ['単価', '単価'],
  ['数量', '数量'],
  ['合計', '合計'],
  ['ステータス', 'ステータス'],
  ['作成日時', '作成日時'],
  ['作成日', '作成日'],
  ['操作', '操作']
];

function normalizeTaOrderColumns(rawColumns) {
  const out = [];
  for (const col of rawColumns || []) {
    const label = String(col?.label || '');
    const hit = TA_ORDER_COL_ALIASES.find(([key]) => label.includes(key));
    if (hit) out.push({ label: hit[1], column: col.column });
  }
  // チェックボックスで列が壊れていても、想定列を返す
  if (!out.find((c) => c.label === '商品')) {
    return [
      { label: '商品' }, { label: 'チーム' }, { label: '単価' }, { label: '数量' },
      { label: '合計' }, { label: 'ステータス' }, { label: '作成日時' }, { label: '操作' }
    ];
  }
  return out;
}

function parseFilterOptions(html, name) {
  const re = new RegExp(
    `<select\\b[^>]*name="${name}"[^>]*>([\\s\\S]*?)</select>`,
    'i'
  );
  const m = String(html || '').match(re);
  if (!m) return [];
  const opts = [];
  const optRe = /<option\b([^>]*)>([\s\S]*?)<\/option>/gi;
  let o;
  while ((o = optRe.exec(m[1]))) {
    const value = ((o[1].match(/\bvalue="([^"]*)"/) || [])[1] ?? '').trim();
    const label = text(o[2]);
    if (!label) continue;
    opts.push({ value, label });
  }
  return opts;
}

/** セル内のアバター数字・頭文字を除いた主テキスト。 */
function cellPrimaryText(cellHtml) {
  const html = String(cellHtml || '');
  // 商品名など、青リンク風の span を優先
  const title = html.match(
    /<(?:span|a|div)\b[^>]*class="[^"]*(?:text-blue|font-medium|font-semibold)[^"]*"[^>]*>([\s\S]*?)<\/(?:span|a|div)>/i
  );
  if (title) {
    const t = text(title[1]);
    if (t) return t;
  }
  const spans = [];
  const spanRe = /<span\b[^>]*>([\s\S]*?)<\/span>/gi;
  let m;
  while ((m = spanRe.exec(html))) {
    const t = text(m[1]);
    if (t) spans.push(t);
  }
  if (spans.length) {
    // 末尾側が本体（先頭はアバター数字など）
    return spans[spans.length - 1];
  }
  return text(html);
}

/** 「2個」「2 個」も数値にする。 */
function toQuantity(value) {
  return toNumber(String(value || '').replace(/個/g, ''));
}

/** `/ta/orders`。行 id は UUID。列はチェックボックス付き。 */
export function parseTaOrders(html) {
  const body = main(html);
  const columns = normalizeTaOrderColumns(parseColumns(body));
  const labels = columns.map((c) => c.label);

  const tbody = body.match(/<tbody\b[^>]*>([\s\S]*?)<\/tbody>/);
  const orders = [];
  if (tbody) {
    const trRe = /<tr\b([^>]*)>([\s\S]*?)<\/tr>/g;
    let tr;
    while ((tr = trRe.exec(tbody[1]))) {
      const idMatch = tr[1].match(/\bid="order_([^"]+)"/);
      const id = idMatch ? parseIdToken(idMatch[1]) : null;
      if (id == null) continue;

      const cellHtmls = [];
      const tdRe = /<td\b[^>]*>([\s\S]*?)<\/td>/g;
      let td;
      while ((td = tdRe.exec(tr[2]))) cellHtmls.push(td[1]);

      // 先頭がチェックボックスならスキップしてデータ列に合わせる
      let offset = 0;
      if (cellHtmls[0] && /type="checkbox"|data-order-id=/.test(cellHtmls[0])) {
        offset = 1;
      }
      const dataCells = cellHtmls.slice(offset);
      const byLabel = {};
      const byLabelHtml = {};
      labels.forEach((label, i) => {
        byLabelHtml[label] = dataCells[i] || '';
        byLabel[label] = text(dataCells[i] || '');
      });

      const product = cellPrimaryText(byLabelHtml['商品'] || dataCells[0] || '')
        || byLabel['商品'] || '';
      const team = cellPrimaryText(byLabelHtml['チーム'] || '')
        || byLabel['チーム'] || '';
      const unitPrice = byLabel['単価'] ?? '';
      const quantity = byLabel['数量'] ?? '';
      const total = byLabel['合計'] ?? '';
      const createdAt = byLabel['作成日時'] ?? byLabel['作成日'] ?? '';
      const status = cleanOrderStatus(byLabel['ステータス'] ?? '');

      orders.push({
        id,
        product,
        team,
        unitPrice,
        quantity,
        total,
        status,
        createdAt,
        createdAtISO: toIso(createdAt),
        unitPriceValue: toNumber(unitPrice),
        quantityValue: toQuantity(quantity),
        totalValue: toNumber(total)
      });
    }
  }

  return {
    heading: headingText(body) || '注文管理',
    columns,
    empty: parseEmptyState(body),
    filters: {
      status: parseFilterOptions(body, 'status'),
      team: parseFilterOptions(body, 'team_id'),
      quantity: parseFilterOptions(body, 'quantity')
    },
    orders
  };
}

const ORDER_STATUSES = ['保留中', '注文済み', '受取可能', '受取済み', 'キャンセル済み'];

/** `/ta/orders/:id/details`（Turbo Frame）。 */
export function parseTaOrderDetail(html) {
  const body = String(html || '');
  const title = body.match(/<h2\b[^>]*class="[^"]*text-2xl[^"]*"[^>]*>([\s\S]*?)<\/h2>/i);

  let status = '';
  for (const s of ORDER_STATUSES) {
    // ステータス pill 内の語だけ（商品名の隣接を拾わない）
    if (new RegExp(`(?:animate-pulse|rounded-full)[\\s\\S]{0,80}>\\s*${s}\\s*<`).test(body)
      || new RegExp(`>\\s*${s}\\s*<\\/span>`).test(body)) {
      status = s;
      break;
    }
  }
  if (!status) {
    for (const s of ORDER_STATUSES) {
      if (body.includes(s)) { status = s; break; }
    }
  }

  const team = (
    body.match(/rounded-lg whitespace-nowrap">\s*<span[^>]*>([\s\S]*?)<\/span>/)
  );
  const total = (body.match(/text-3xl[^>]*>\s*([^<]+)\s*</) || [])[1] || null;

  const fields = {};
  const labelRe = /<label\b[^>]*>([\s\S]*?)<\/label>[\s\S]{0,80}?<p\b[^>]*>([\s\S]*?)<\/p>/gi;
  let lm;
  while ((lm = labelRe.exec(body))) {
    const label = text(lm[1]);
    const value = text(lm[2]);
    if (label && value) fields[label] = value;
  }
  for (const label of ['単価', '数量', 'ショップ名', '型番', '商品URL', 'メモ']) {
    if (fields[label]) continue;
    const re = new RegExp(
      `<label\\b[^>]*>\\s*${label}\\s*<\\/label>[\\s\\S]{0,120}?<p\\b[^>]*>([\\s\\S]*?)<\\/p>`,
      'i'
    );
    const m = body.match(re);
    if (m) fields[label] = text(m[1]);
  }

  const budget = (body.match(/チーム累計予算使用額[\s\S]{0,200}?text-xl[^>]*>\s*([^<]+)/)
    || [])[1] || null;

  const id = parseIdToken(
    (body.match(/\/ta\/orders\/([^/"'?]+)/) || [])[1]
  );

  return {
    id,
    product: title ? text(title[1]) : '',
    status,
    team: team ? text(team[1]) : null,
    total: total ? text(total) : null,
    totalValue: toNumber(total),
    teamBudget: budget ? text(budget) : null,
    fields,
    editHref: id ? `/ta/orders/${id}/edit` : null
  };
}

function headingText(body) {
  const m = body.match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/i);
  return m ? text(m[1]) || null : null;
}

/** 提出締め切り（submission）カード。 */
export function parseTaReportSubmissions(html) {
  const body = main(html);
  const subs = [];
  const re = /href="\/ta\/reports\?submission_id=([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = re.exec(body))) {
    const id = parseIdToken(m[1]);
    if (id == null) continue;
    const inner = m[2];
    const when = text((inner.match(/font-medium[^>]*>([\s\S]*?)</) || [])[1] || '');
    const progress = text((inner.match(/>(\d+\/\d+\s*完了)</) || [])[1] || '');
    const overdue = /期限切れ/.test(inner);
    const selected = /ring-2|border-emerald/.test(m[0] + inner);
    const label = [when, progress].filter(Boolean).join(' · ')
      || text(inner).slice(0, 40);
    if (!label) continue;
    if (subs.some((s) => s.id === id)) continue;
    subs.push({ id, label, when: when || null, progress: progress || null, overdue, selected });
  }
  return subs;
}

/** `/ta/reports`。列は チーム / タイトル / 期間 / ステータス / 期限。 */
export function parseTaReports(html) {
  const body = main(html);
  const columns = (parseColumns(body) || [])
    .map((c) => {
      const label = String(c.label || '');
      for (const want of ['チーム', 'タイトル', '期間', 'ステータス', '期限', '作成日']) {
        if (label.includes(want)) return { label: want, column: c.column };
      }
      return null;
    })
    .filter(Boolean);

  const labels = columns.length
    ? columns.map((c) => c.label)
    : ['チーム', 'タイトル', '期間', 'ステータス', '期限'];

  const tbody = body.match(/<tbody\b[^>]*>([\s\S]*?)<\/tbody>/);
  const reports = [];
  if (tbody) {
    const trRe = /<tr\b([^>]*)>([\s\S]*?)<\/tr>/g;
    let tr;
    while ((tr = trRe.exec(tbody[1]))) {
      const idMatch = tr[1].match(/\bid="report_([^"]+)"/);
      const id = idMatch ? parseIdToken(idMatch[1]) : null;
      if (id == null) continue;
      const cells = [];
      const tdRe = /<td\b[^>]*>([\s\S]*?)<\/td>/g;
      let td;
      while ((td = tdRe.exec(tr[2]))) cells.push(text(td[1]));
      const byLabel = {};
      labels.forEach((label, i) => { byLabel[label] = cells[i] ?? ''; });

      const status = cleanOrderStatus(byLabel['ステータス'] ?? '')
        .replace(/^[✓○]\s*/, '');
      const due = byLabel['期限'] ?? '';
      reports.push({
        id,
        team: byLabel['チーム'] ?? '',
        title: byLabel['タイトル'] ?? cells[1] ?? '',
        period: byLabel['期間'] ?? '',
        status,
        due,
        dueISO: toIso(due)
      });
    }
  }

  return {
    heading: headingText(body) || '週報一覧',
    columns: labels.map((label) => ({ label })),
    empty: parseEmptyState(body),
    filters: {
      team: parseFilterOptions(body, 'team_id')
    },
    submissions: parseTaReportSubmissions(html),
    reports
  };
}

/** `/ta/teams`。id は操作列の `/ta/teams/:id` リンクから取る。 */
export function parseTaTeams(html) {
  const body = main(html);
  const tbody = body.match(/<tbody\b[^>]*>([\s\S]*?)<\/tbody>/);
  const teams = [];
  if (tbody) {
    const trRe = /<tr\b[^>]*>([\s\S]*?)<\/tr>/g;
    let tr;
    while ((tr = trRe.exec(tbody[1]))) {
      const row = tr[1];
      const cells = [];
      const tdRe = /<td\b[^>]*>([\s\S]*?)<\/td>/g;
      let td;
      while ((td = tdRe.exec(row))) cells.push(td[1]);
      if (cells.length < 2) continue;
      const link = row.match(/href="\/ta\/teams\/([^/"'?]+)"/);
      const id = link ? parseIdToken(link[1]) : null;
      const name = text(cells[0]);
      if (!name) continue;
      teams.push({
        id,
        name,
        members: text(cells[1] || ''),
        spend: text(cells[2] || ''),
        pendingInvites: text(cells[3] || ''),
        spendValue: toNumber(cells[2] || '')
      });
    }
  }
  return {
    heading: headingText(body) || 'チーム管理',
    empty: parseEmptyState(body),
    teams
  };
}

/** `/ta/users`。アバター頭文字は名前に混ぜない。 */
export function parseTaUsers(html) {
  const body = main(html);
  const tbody = body.match(/<tbody\b[^>]*>([\s\S]*?)<\/tbody>/);
  const users = [];
  if (tbody) {
    const trRe = /<tr\b([^>]*)>([\s\S]*?)<\/tr>/g;
    let tr;
    while ((tr = trRe.exec(tbody[1]))) {
      const row = tr[2];
      const link = row.match(/href="\/ta\/users\/([^/"'?]+)"/);
      const id = link ? parseIdToken(link[1]) : null;
      const cellHtmls = [];
      const tdRe = /<td\b[^>]*>([\s\S]*?)<\/td>/g;
      let td;
      while ((td = tdRe.exec(row))) cellHtmls.push(td[1]);
      if (cellHtmls.length < 2) continue;

      const userCell = cellHtmls[0] || '';
      // アバターは span.text-gray-700、本名は div.text-gray-900
      const nameFromDiv = text(
        (userCell.match(
          /<div\b[^>]*class="[^"]*text-sm font-medium text-gray-900[^"]*"[^>]*>([\s\S]*?)<\/div>/
        ) || userCell.match(
          /<div\b[^>]*class="[^"]*font-medium[^"]*text-gray-900[^"]*"[^>]*>([\s\S]*?)<\/div>/
        ) || [])[1] || ''
      );
      const emailFromDiv = text(
        (userCell.match(
          /<div\b[^>]*class="[^"]*text-sm text-gray-500[^"]*"[^>]*>([\s\S]*?)<\/div>/
        ) || [])[1] || ''
      );
      const flat = text(userCell);
      const email = emailFromDiv
        || (flat.match(/([^\s]+@[^\s]+)/) || [])[1]
        || null;
      let name = nameFromDiv;
      if (!name) {
        name = email ? flat.replace(email, '').replace(/\s+/g, ' ').trim() : flat;
        // アバター 1 文字が先頭に付くことがある
        if (name.length >= 2 && name[1] === ' ' && name[0] === name[2]) {
          name = name.slice(2).trim();
        }
      }
      if (!name && !email) continue;
      users.push({
        id,
        name: name || email,
        email,
        team: text(cellHtmls[1] || ''),
        status: text(cellHtmls[2] || '')
      });
    }
  }
  return {
    heading: headingText(body) || 'ユーザー一覧 (TA)',
    empty: parseEmptyState(body),
    filters: {
      status: parseFilterOptions(body, 'status')
    },
    users
  };
}

/** `/ta` ダッシュボード。学生と同じ骨格（調整中）。 */
export function parseTaDashboard(html) {
  const body = main(html);
  const withClass = body.match(/<h1\b[^>]*class="[^"]*"[^>]*>([\s\S]*?)<\/h1>/);
  const bare = body.match(/<h1>([\s\S]*?)<\/h1>/);
  return {
    heading: withClass ? text(withClass[1]) || 'TAダッシュボード' : 'TAダッシュボード',
    team: null,
    notice: bare ? text(bare[1]) || null : null
  };
}
