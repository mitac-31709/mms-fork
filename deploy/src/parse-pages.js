/* 元アプリの残り 5 画面（ダッシュボード / 注文 / 機材 / 貸出 / 通知）と、
 * どの画面にも出る nav の利用者情報を JSON に変換する。
 *
 * `parse.js` と同じ方針。ネットワークに触らない純関数だけを置き、
 * 依存は入れず、HTML は正規表現と手作業で読む（Node でそのまま試せるように）。
 * 共通の小道具（text / toIso / parseColumns / parseEmptyState）は
 * `parse.js` から取り込んで重複させない。
 *
 * **検証できたことと、できなかったこと。**
 * 2026-10 時点の学生/TA アカウントで取り直した結果:
 *
 *   - 注文の行 id は UUID。ステータスは
 *     保留中 / 注文済み / 受取可能 / 受取済み / キャンセル済み
 *   - 通知は 1 件以上あり、`PATCH .../mark_as_read` が使える
 *   - 機材・貸出のカード行は引き続き空のことがある
 *
 * 読めなければ null を返して呼び出し側に判断を渡す。
 */

import {
  extractSidePanel, parseOrderHistory, text, toIso,
  parseColumns, parseEmptyState, parseIdToken
} from './parse.js';

/** 注文ステータスの現行語彙（学生・TA 共通）。 */
const ORDER_STATUSES = ['保留中', '注文済み', '受取可能', '受取済み', 'キャンセル済み'];

/** 「¥1,200」「1,200円」「2」を数値にする。読めなければ null。
 *  0 と「読めなかった」を混ぜないため、NaN も 0 も作らない。 */
export function toNumber(value) {
  if (value == null) return null;
  const stripped = String(value).replace(/[¥￥円,，\s]/g, '');
  if (!/^-?\d+(?:\.\d+)?$/.test(stripped)) return null;
  return Number(stripped);
}

/** nav と共通ヘッダを避けるため、<main> の中だけを見る。無ければ全体。 */
function main(html) {
  const m = html.match(/<main\b[^>]*>([\s\S]*)<\/main>/i);
  return m ? m[1] : html;
}

/** 開始位置から、同じタグの入れ子を数えて閉じタグまでを切り出す */
function sliceFrom(html, start, tag) {
  const re = new RegExp(`<${tag}\\b|</${tag}\\s*>`, 'gi');
  re.lastIndex = start;
  let depth = 1;
  let m;
  while ((m = re.exec(html))) {
    depth += m[0][1] === '/' ? -1 : 1;
    if (depth === 0) return { inner: html.slice(start, m.index), end: re.lastIndex };
  }
  return { inner: html.slice(start), end: html.length };
}

/** 開きタグに openRe がマッチする要素の中身を返す。openRe は `>` まで含めること */
function elementInner(html, openRe, tag) {
  const open = openRe.exec(html);
  if (!open) return null;
  return sliceFrom(html, open.index + open[0].length, tag).inner;
}

/** 指定タグの要素を、最も外側だけ順に返す */
function elementsOfTag(html, tag) {
  const out = [];
  const openRe = new RegExp(`<${tag}\\b[^>]*>`, 'gi');
  let m;
  while ((m = openRe.exec(html))) {
    const { inner, end } = sliceFrom(html, m.index + m[0].length, tag);
    out.push({ html: m[0] + inner, attrs: m[0], inner });
    openRe.lastIndex = end;
  }
  return out;
}

/** 器の直下に並ぶ子要素。一覧は同じ partial の繰り返しなので、
 *  最初の子と同じタグ名のものだけを数える。 */
function repeatedChildren(inner) {
  const first = inner.match(/<(\w+)\b[^>]*>/);
  if (!first) return [];
  return elementsOfTag(inner, first[1]);
}

/** 開きタグの属性が attrRe にマッチする要素を、最も外側だけ返す。
 *  attrRe は id を捕捉に取ること。mapId の既定は数字（貸出）。
 *  通知は UUID もあるので parseIdToken を渡す。 */
function markedElements(html, attrRe, mapId = (raw) => (raw == null ? null : Number(raw))) {
  const out = [];
  const openRe = /<(\w+)\b([^>]*)>/g;
  let m;
  while ((m = openRe.exec(html))) {
    const found = m[2].match(attrRe);
    if (!found) continue;
    const id = found.slice(1).find((v) => v != null);
    const { inner, end } = sliceFrom(html, m.index + m[0].length, m[1]);
    out.push({ id: mapId(id), html: m[0] + inner, inner });
    openRe.lastIndex = end;
  }
  return out;
}

/** 最初の見出しの中身。level は 'h1' や 'h2' */
function headingText(html, level) {
  const m = html.match(new RegExp(`<${level}\\b[^>]*>([\\s\\S]*?)</${level}>`, 'i'));
  return m ? text(m[1]) || null : null;
}

/** 最初の <h1> の直後に来る <p>。見出しのリード文はどの画面もこの位置にある。
 *  間に別の見出しが挟まったら、それはリード文ではないので拾わない。 */
function ledeAfterHeading(html) {
  const h1 = html.match(/<h1\b[^>]*>[\s\S]*?<\/h1>/);
  if (!h1) return null;
  const rest = html.slice(h1.index + h1[0].length);
  const p = rest.match(/<p\b[^>]*>([\s\S]*?)<\/p>/);
  if (!p || /<h[1-6]\b/i.test(rest.slice(0, p.index))) return null;
  return text(p[1]) || null;
}

/** カード / 項目を「名前らしい要素」と「残り」に分ける。
 *  **未検証**: 実データが 1 件も無く、名前がどの要素に入るのか見ていない。
 *  h1〜h4 があればそれ、無ければ最初の <p> を名前とみなす。 */
function splitCard(html) {
  const heading = html.match(/<(h[1-4])\b[^>]*>([\s\S]*?)<\/\1>/i);
  const para = html.match(/<p\b[^>]*>([\s\S]*?)<\/p>/);
  const source = heading ? heading[0] : para ? para[0] : null;
  const name = heading ? text(heading[2]) : para ? text(para[1]) : null;
  return { name: name || null, rest: source ? html.replace(source, ' ') : html };
}

/** 操作系（リンク・ボタン）を落とした残りのテキスト */
function metaText(html) {
  const rest = html
    .replace(/<a\b[\s\S]*?<\/a>/gi, ' ')
    .replace(/<button\b[\s\S]*?<\/button>/gi, ' ');
  return text(rest) || null;
}

/** 最初のリンクを { label, href } にする */
function firstLink(html) {
  const m = html.match(/<a\b[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/i);
  if (!m) return null;
  return { label: text(m[2]) || null, href: m[1] };
}

/** nav の利用者。どの認証済み画面にも同じ形で入っている（実 HTML で検証済み）。
 *  見つからない項目は null を返す。 */
export function parseUser(html) {
  const target = (name) => {
    const re = new RegExp(`<(\\w+)\\b[^>]*data-mobile-menu-target="${name}"[^>]*>([\\s\\S]*?)</\\1>`);
    const m = html.match(re);
    return m ? text(m[2]) || null : null;
  };
  return { name: target('userName'), badge: target('userBadge') };
}

/** `/dashboard`。見出しとチーム行と「調整中」だけの画面（実 HTML で検証済み）。
 *  `notice` は class の無い 2 つめの <h1>。 */
export function parseDashboard(html) {
  const body = main(html);
  const withClass = body.match(/<h1\b[^>]*class="[^"]*"[^>]*>([\s\S]*?)<\/h1>/);
  const bare = body.match(/<h1>([\s\S]*?)<\/h1>/);
  return {
    heading: withClass ? text(withClass[1]) || null : null,
    team: ledeAfterHeading(body),
    notice: bare ? text(bare[1]) || null : null
  };
}

/** 注文ステータスの先頭装飾（絵文字・✓○）を外す。
 *  語彙自体は作らず、表示用の印だけ落とす（週報の `✓ 完了` → `完了` と同じ）。 */
export function cleanOrderStatus(value) {
  return String(value || '')
    .replace(/^(?:[✓○×]|⏳|📋|✅|📦|❌|🚫)\s*/u, '')
    .trim();
}

/** 注文の行。
 *  行 id は数字または UUID（`id="order_<id>"`）。Stimulus の
 *  `#order_<id>` / `[id^="order_"], [id^="order_card_"]` に合わせる。
 *  `<tbody>` だけを見るので、モバイル用の `order_card_<id>` とは重複しない。
 *  ステータス語彙は素通し。先頭の絵文字や ✓○ だけ落とす。 */
export function parseOrderRows(html, columns) {
  const tbody = main(html).match(/<tbody\b[^>]*>([\s\S]*?)<\/tbody>/);
  if (!tbody) return [];

  const labels = columns.map((c) => c.label);
  const rows = [];
  const trRe = /<tr\b([^>]*)>([\s\S]*?)<\/tr>/g;
  let tr;
  while ((tr = trRe.exec(tbody[1]))) {
    const cells = [];
    const tdRe = /<td\b[^>]*>([\s\S]*?)<\/td>/g;
    let td;
    while ((td = tdRe.exec(tr[2]))) cells.push(text(td[1]));
    if (!cells.length) continue;

    const byLabel = {};
    labels.forEach((label, i) => { byLabel[label] = cells[i] ?? ''; });

    const idMatch = tr[1].match(/id="order_([^"]+)"/);
    const unitPrice = byLabel['単価'] ?? '';
    const quantity = byLabel['数量'] ?? '';
    const total = byLabel['合計'] ?? '';
    // 学生画面は「作成日」、TA 画面は「作成日時」。どちらでも拾う。
    const createdAt = byLabel['作成日'] ?? byLabel['作成日時'] ?? '';
    const statusRaw = byLabel['ステータス'] ?? '';
    const status = cleanOrderStatus(statusRaw);

    rows.push({
      id: idMatch ? parseIdToken(idMatch[1]) : null,
      product: byLabel['商品'] ?? cells[0] ?? '',
      unitPrice,
      quantity,
      total,
      status,
      createdAt,
      createdAtISO: toIso(createdAt),
      unitPriceValue: toNumber(unitPrice),
      quantityValue: toNumber(quantity),
      totalValue: toNumber(total),
      cells: cells.map((c, i) => (labels[i] === 'ステータス' ? status : c))
    });
  }
  return rows;
}

/** `/orders` の HTML 全体を JSON にする。
 *  列見出しと空状態の文言は実 HTML で検証済み。行は上のとおり未検証。 */
export function parseOrders(html) {
  const body = main(html);
  const columns = parseColumns(body);
  return {
    columns,
    empty: parseEmptyState(body),
    orders: parseOrderRows(body, columns)
  };
}

/** 学生の注文詳細 `/orders/:id`。
 *
 * TA の `/ta/orders/:id/details` と同じ器（side_panel の断片、
 * 実 HTML は全ページのこともある）。商品・ステータス・チーム・合計・
 * 項目（label/p 対）・チーム累計予算・注文ステータス履歴を取る。
 * 項目名は HTML の label を素通しし、語彙を作らない。
 */
export function parseOrderDetail(html) {
  const frame = /<turbo-frame\b[^>]*\bside_panel\b/i.test(String(html || ''))
    ? extractSidePanel(html)
    : String(html || '');
  const body = frame;
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
  for (const label of ['単価', '数量', '販売サイトタイプ', 'ショップ名', '型番', '商品URL', 'メモ']) {
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
    (body.match(/\/orders\/([^/"'?]+)/) || [])[1]
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
    history: parseOrderHistory(body),
    editHref: id ? `/orders/${id}/edit` : null
  };
}

/** 機材のカード。
 *  **未検証**: 取得したアカウントでは grid が空で、カードを 1 枚も見ていない。
 *  grid の直下に同じタグの子が並ぶ、という前提だけで数えている。
 *  `id` はカードの中に `id="equipment_<id>"` があれば拾い、無ければ null。 */
export function parseEquipmentCards(html) {
  const grid = elementInner(main(html), /<div\b[^>]*class="[^"]*\bgrid\b[^"]*"[^>]*>/, 'div');
  if (!grid) return [];

  return repeatedChildren(grid).map((card) => {
    const { name, rest } = splitCard(card.html);
    const idMatch = card.html.match(/id="equipment_(\d+)"/);
    return {
      id: idMatch ? Number(idMatch[1]) : null,
      name,
      meta: metaText(rest),
      action: firstLink(card.html)
    };
  });
}

/** `/equipments` の HTML 全体を JSON にする。
 *  空状態は <h3> を持たず `text-center py-12` の中の
 *  `<p class="text-gray-500 text-lg">` だけ（実 HTML で検証済み）。 */
export function parseEquipments(html) {
  const body = main(html);
  const emptyMatch = body.match(
    /<div\b[^>]*class="[^"]*\btext-center\b[^"]*"[^>]*>\s*<p\b[^>]*class="[^"]*\btext-gray-500\b[^"]*"[^>]*>([\s\S]*?)<\/p>/
  );
  const emptyText = emptyMatch ? text(emptyMatch[1]) || null : null;

  return {
    heading: headingText(body, 'h1'),
    lede: ledeAfterHeading(body),
    empty: emptyText ? { text: emptyText } : null,
    equipments: parseEquipmentCards(body)
  };
}

/** 節の見出しから key を決める。実 HTML に出るのは 申請中 と 貸出中 の 2 つ。
 *  「最近の返却」はコメントだけで描画されていないが、出たときに拾えるようにしておく。
 *  知らない見出しは並び順（0 始まり）で `section-<n>` に落とす。 */
const LOAN_SECTION_KEYS = {
  申請中: 'pending',
  貸出中: 'active',
  最近の返却: 'returned'
};

/** 貸出の項目。
 *  **未検証**: 取得したアカウントは貸出が 0 件で、項目を 1 件も見ていない。
 *  器が `<ul><li>` なのかカードの羅列なのか分からないので、
 *  `id="loan_<id>"` / `data-loan-id` の印を先に探し、無ければ `<li>` を数える。 */
function parseLoanItems(section) {
  const marked = markedElements(section, /id="loan_(\d+)"|data-loan-id="(\d+)"/);
  const found = marked.length
    ? marked
    : elementsOfTag(section, 'li').map((li) => ({ id: null, html: li.html }));

  return found.map((item) => {
    const { name, rest } = splitCard(item.html);
    return { id: item.id, name, meta: metaText(rest) };
  });
}

/** 節の空メッセージ。実 HTML は
 *  `<div class="text-center py-8"><div class="text-sm text-gray-500">…</div></div>`。 */
function loanEmptyMessage(section, hasItems) {
  const tight = section.match(
    /<div\b[^>]*class="[^"]*\btext-center\b[^"]*"[^>]*>\s*<div\b[^>]*class="[^"]*\btext-gray-500\b[^"]*"[^>]*>([\s\S]*?)<\/div>/
  );
  if (tight) return text(tight[1]) || null;
  if (hasItems) return null;
  const loose = section.match(/<div\b[^>]*class="[^"]*\btext-gray-500\b[^"]*"[^>]*>([\s\S]*?)<\/div>/);
  return loose ? text(loose[1]) || null : null;
}

/** `/loans` の HTML 全体を JSON にする。
 *  見出し・リード文・節の見出し・空メッセージは実 HTML で検証済み。
 *  節の範囲は次の <h2> まで（最後の節はページ末尾まで）。 */
export function parseLoans(html) {
  const body = main(html);
  const h2Re = /<h2\b[^>]*>([\s\S]*?)<\/h2>/g;
  const marks = [];
  let m;
  while ((m = h2Re.exec(body))) {
    marks.push({ title: text(m[1]), from: m.index + m[0].length });
  }

  const sections = marks.map((mark, i) => {
    const to = i + 1 < marks.length ? marks[i + 1].from : body.length;
    const slice = body.slice(mark.from, to);
    const items = parseLoanItems(slice);
    return {
      key: LOAN_SECTION_KEYS[mark.title] || `section-${i}`,
      title: mark.title,
      empty: loanEmptyMessage(slice, items.length > 0),
      items
    };
  });

  return {
    heading: headingText(body, 'h1'),
    lede: ledeAfterHeading(body),
    sections
  };
}

/** 通知の 1 件。
 *  印は公開されている JS に合わせる（`notification_list_controller` は
 *  `[data-notification-id]` を、`notifications.js` は `dataset.notificationId` を見る）。
 *  `read` は次の順で決める。真偽値を当てずっぽうで作らない。
 *    1. `data-read="true|false"`
 *    2. 未読向けの `data-notification-read`（既読ボタン）があれば未読
 *    3. どちらも無ければ null（わからない） */
function parseNotificationItem(item) {
  const { name, rest } = splitCard(item.html);

  const time = item.html.match(/<time\b([^>]*)>([\s\S]*?)<\/time>/i);
  const datetime = time ? (time[1].match(/datetime="([^"]*)"/) || [])[1] : null;
  const plain = item.html.match(/\d{4}\s*[\/年.-]\s*\d{1,2}\s*[\/月.-]\s*\d{1,2}日?(?:\s+\d{1,2}:\d{2})?/);
  const at = time ? text(time[2]) || null : plain ? plain[0].trim() : null;
  const atISO = datetime && /^\d{4}-\d{2}-\d{2}/.test(datetime) ? datetime.slice(0, 10) : toIso(at);

  let body = metaText(time ? rest.replace(time[0], ' ') : rest);
  if (body && at && !time) body = body.replace(at, ' ').replace(/\s+/g, ' ').trim() || null;

  const flag = item.html.match(/data-read="(true|false)"/);
  let read = null;
  if (flag) read = flag[1] === 'true';
  else if (/\bdata-notification-read\b/.test(item.html)) read = false;

  return {
    id: item.id,
    title: name,
    body: body || null,
    at,
    atISO,
    read
  };
}

/** 通知の一覧。印が付いた要素を先に探し、無ければ器の中の <li> を数える。
 *  id は数字または UUID。元アプリの他モデルが UUID なので、数字だけだと取りこぼす。 */
export function parseNotificationItems(html) {
  const body = main(html);
  const marked = markedElements(
    body,
    /id="notification_([^"]+)"|data-notification-id="([^"]+)"/,
    (raw) => parseIdToken(raw)
  );
  if (marked.length) return marked.map(parseNotificationItem);

  const list = elementInner(body, /<div\b[^>]*class="[^"]*\bbg-white\b[^"]*"[^>]*>/, 'div');
  if (!list) return [];
  return elementsOfTag(list, 'li').map((li) => parseNotificationItem({ id: null, html: li.html }));
}

/** `/notifications` の HTML 全体を JSON にする。
 *  見出しと空状態の文言は実 HTML で検証済み。
 *  `#unread_count_display` は実 HTML では中身が空（未読 0 件）なので null になる。 */
export function parseNotifications(html) {
  const body = main(html);
  const display = elementInner(body, /<div\b[^>]*id="unread_count_display"[^>]*>/, 'div');
  return {
    heading: headingText(body, 'h1'),
    unreadText: display ? text(display) || null : null,
    empty: parseEmptyState(body),
    notifications: parseNotificationItems(body)
  };
}
