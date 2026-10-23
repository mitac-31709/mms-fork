/* 元アプリの残り 5 画面（ダッシュボード / 注文 / 機材 / 貸出 / 通知）と、
 * どの画面にも出る nav の利用者情報を JSON に変換する。
 *
 * `parse.js` と同じ方針。ネットワークに触らない純関数だけを置き、
 * 依存は入れず、HTML は正規表現と手作業で読む（Node でそのまま試せるように）。
 * 共通の小道具（text / toIso / parseColumns / parseEmptyState）は
 * `parse.js` から取り込んで重複させない。
 *
 * **検証できたことと、できなかったこと。**
 * クローンを取得したのは学生アカウントで、注文・機材・貸出・通知の
 * どれも 0 件だった。そのため
 *
 *   - 見出し / リード文 / 列見出し / 空状態の文言 → 実 HTML で検証済み
 *   - 1 件ずつの行・カード・項目の構造 → **一度も見ていない（未検証）**
 *
 * 未検証の部分は各関数の直前にその旨を書く。形を埋めるために値を作らず、
 * 読めなければ null を返して呼び出し側に判断を渡す。
 */

import { text, toIso, parseColumns, parseEmptyState, parseIdToken } from './parse.js';

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

/** ナビに `/ta/orders` があるか。TA だけに出るリンク（学生の実 HTML には無い）。 */
export function canAccessTa(html) {
  return /href="\/ta\/orders(?:\?[^"]*)?"/.test(String(html || ''));
}

/** `/dashboard`。見出しとチーム行と「調整中」だけの画面（実 HTML で検証済み）。
 *  `notice` は class の無い 2 つめの <h1>。
 *  `canTa` はナビのリンクで見る。本文ではなくページ全体を見る。 */
export function parseDashboard(html) {
  const body = main(html);
  const withClass = body.match(/<h1\b[^>]*class="[^"]*"[^>]*>([\s\S]*?)<\/h1>/);
  const bare = body.match(/<h1>([\s\S]*?)<\/h1>/);
  return {
    heading: withClass ? text(withClass[1]) || null : null,
    team: ledeAfterHeading(body),
    notice: bare ? text(bare[1]) || null : null,
    canTa: canAccessTa(html)
  };
}

/** 注文の行。
 *  **未検証**: 取得したアカウントは注文が 0 件で、データの入った行を見ていない。
 *  行を `<tr id="order_<id>">` で引くのは公開されている Stimulus の実装
 *  （`user_order_sidebar_controller` の `#order_<id>`、`side_panel_controller` の
 *  `[id^="order_"], [id^="order_card_"]`）に合わせたもの。
 *  ここでは `<tbody>` の中だけを見るので、モバイル用の `order_card_<id>` とは重複しない。
 *  ステータスは語彙を作らないよう、そのまま素通しする。 */
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

    const idMatch = tr[1].match(/id="order_(\d+)"/);
    const unitPrice = byLabel['単価'] ?? '';
    const quantity = byLabel['数量'] ?? '';
    const total = byLabel['合計'] ?? '';
    const createdAt = byLabel['作成日'] ?? '';

    rows.push({
      id: idMatch ? Number(idMatch[1]) : null,
      product: byLabel['商品'] ?? cells[0] ?? '',
      unitPrice,
      quantity,
      total,
      status: byLabel['ステータス'] ?? '',
      createdAt,
      createdAtISO: toIso(createdAt),
      unitPriceValue: toNumber(unitPrice),
      quantityValue: toNumber(quantity),
      totalValue: toNumber(total),
      cells
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

/** 空欄・ハイフンだけの型番やショップは「無い」。`-` を型番として検索に載せない。 */
function blankField(value) {
  const v = String(value ?? '').trim();
  if (!v || v === '-' || v === '—' || v === '－') return null;
  return v;
}

/** 商品セル。
 *  2026-10-23 に TA の `/ta/orders` で確認した並びは
 *  商品名 span、ショップ span、型番 span（ラベル無し）。
 *  学生の `/orders` は `ショップ: …` `型番: …` とラベル付き。どちらも読む。
 *  クラスは鍵にしない。 */
export function readOrderProductCell(tdHtml) {
  const spans = [];
  const re = /<span\b[^>]*>([\s\S]*?)<\/span>/gi;
  let m;
  while ((m = re.exec(String(tdHtml || '')))) {
    const t = text(m[1]);
    if (t) spans.push(t);
  }

  let shopName = null;
  let modelNumber = null;
  const rest = [];
  for (const s of spans) {
    const shop = s.match(/^ショップ\s*[:：]\s*(.*)$/);
    const model = s.match(/^型番\s*[:：]\s*(.*)$/);
    if (shop) shopName = blankField(shop[1]);
    else if (model) modelNumber = blankField(model[1]);
    else rest.push(s);
  }

  const product = rest[0] || text(tdHtml) || '';
  if (shopName == null && rest.length > 1) shopName = blankField(rest[1]);
  if (modelNumber == null && rest.length > 2) modelNumber = blankField(rest[2]);
  return { product, shopName, modelNumber };
}

/** チーム名。アバターの 1 文字は span ではなく、名前の span だけを取る。 */
function teamName(tdHtml) {
  const spans = [];
  const re = /<span\b[^>]*>([\s\S]*?)<\/span>/gi;
  let m;
  while ((m = re.exec(String(tdHtml || '')))) {
    const t = text(m[1]);
    if (t) spans.push(t);
  }
  const named = spans.filter((s) => [...s].length > 1);
  if (named.length) return named[named.length - 1];
  return text(tdHtml) || '';
}

/** ステータス。絵文字だけのテキストノードは捨て、言葉だけ残す。 */
function statusLabel(tdHtml) {
  const parts = [];
  const re = />([^<]+)</g;
  let m;
  while ((m = re.exec(String(tdHtml || '')))) {
    const t = text(m[1]);
    if (t && /[\p{L}\p{N}]/u.test(t)) parts.push(t);
  }
  return parts.join('') || text(tdHtml) || '';
}

/** 数量「1個」から整数を取る。単位が付いていても null にしない。 */
function quantityNumber(value) {
  const m = String(value ?? '').match(/-?\d+/);
  if (!m) return null;
  const n = Number(m[0]);
  return Number.isFinite(n) ? n : null;
}

/** `<th>` の中の最初の span を列名にする。
 *  チェックボックス列は span が無く、`>` が属性に混ざるので text() すると壊れる。 */
function parseTaColumns(html) {
  const thead = html.match(/<thead[\s\S]*?<\/thead>/);
  if (!thead) return [];
  const out = [];
  const re = /<th\b[\s\S]*?<\/th>/g;
  let m;
  while ((m = re.exec(thead[0]))) {
    const span = m[0].match(/<span\b[^>]*>([\s\S]*?)<\/span>/i);
    const label = span ? text(span[1]) : '';
    if (!label || label === '操作') continue;
    const column = m[0].match(/data-column="([^"]+)"/);
    out.push(column ? { label, column: column[1] } : { label });
  }
  return out;
}

function selectOptions(html, name) {
  const sel = html.match(new RegExp(
    `<select\\b[^>]*\\bname="${name}"[^>]*>([\\s\\S]*?)</select>`, 'i'
  ));
  if (!sel) return [];
  const out = [];
  const re = /<option\b([^>]*)>([\s\S]*?)<\/option>/gi;
  let m;
  while ((m = re.exec(sel[1]))) {
    const value = (m[1].match(/\bvalue="([^"]*)"/) || [])[1] ?? '';
    const label = text(m[2]);
    if (!value || !label || label === 'すべて') continue;
    out.push({ value, label });
  }
  return out;
}

function parseTaTotal(html) {
  const m = html.match(/全\s*<span\b[^>]*>\s*(\d+)\s*<\/span>\s*件中/)
    || html.match(/全\s*(\d+)\s*件/);
  return m ? Number(m[1]) : null;
}

function decodeAttr(value) {
  return String(value)
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

function namedControl(formHtml, name) {
  const inputRe = /<input\b[^>]*>/gi;
  let input;
  while ((input = inputRe.exec(formHtml))) {
    const tag = input[0];
    if ((tag.match(/\bname="([^"]*)"/) || [])[1] !== name) continue;
    const value = (tag.match(/\bvalue="([^"]*)"/) || [])[1];
    return value == null ? '' : decodeAttr(value);
  }
  const area = formHtml.match(
    new RegExp(`<textarea\\b[^>]*\\bname="${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"[^>]*>([\\s\\S]*?)</textarea>`, 'i')
  );
  if (area) return decodeAttr(area[1]);
  return null;
}

/** `/ta/orders/:id/edit` の更新フォーム。
 *  2026-10-23 に TA の編集画面で確認した。ステータスは
 *  `order[status]` の select（保留中 / 注文済み / 受取可能 / 受取済み / キャンセル済み）。
 *  他の項目を空で送ると元の値が消えるので、項目が欠けたら null を返す。 */
export function parseTaOrderForm(html) {
  const formRe = /<form\b([^>]*)>([\s\S]*?)<\/form>/gi;
  let form;
  while ((form = formRe.exec(html || ''))) {
    const action = (form[1].match(/\baction="([^"]*)"/) || [])[1] || '';
    const id = parseIdToken(action.split('/').pop());
    if (!/^\/ta\/orders\/[0-9a-f-]{36}$/i.test(action) || id == null) continue;

    const body = form[2];
    const productName = namedControl(body, 'order[product_name]');
    const amount = namedControl(body, 'order[amount]');
    const quantity = namedControl(body, 'order[quantity]');
    const shopName = namedControl(body, 'order[shop_name]');
    const modelNumber = namedControl(body, 'order[model_number]');
    const productUrl = namedControl(body, 'order[product_url]');
    const memo = namedControl(body, 'order[memo]');
    const select = body.match(/<select\b[^>]*\bname="order\[status\]"[^>]*>([\s\S]*?)<\/select>/i);
    if ([productName, amount, quantity, shopName, modelNumber, productUrl, memo].includes(null)
      || !select) {
      return null;
    }

    const statusOptions = [];
    let status = null;
    const optRe = /<option\b([^>]*)>([\s\S]*?)<\/option>/gi;
    let opt;
    while ((opt = optRe.exec(select[1]))) {
      const value = (opt[1].match(/\bvalue="([^"]*)"/) || [])[1] ?? '';
      const label = text(opt[2]);
      if (!value || !label) continue;
      statusOptions.push({ value, label });
      if (/\bselected\b/.test(opt[1])) status = value;
    }
    if (!status || !statusOptions.length) return null;

    return {
      id,
      action,
      productName,
      amount,
      quantity,
      shopName,
      modelNumber,
      productUrl,
      memo,
      status,
      statusOptions
    };
  }
  return null;
}

/** 何ページ取るか。1 ページの件数と総数から決める。上限で打ち切る。 */
export function taPageCount(total, pageLength, cap = 15) {
  const size = Number(pageLength);
  if (!Number.isFinite(size) || size <= 0) return 1;
  const all = Number.isFinite(total) && total > 0 ? total : size;
  return Math.min(cap, Math.max(1, Math.ceil(all / size)));
}

/** `/ta/orders` の 1 ページ。
 *  2026-10-23 に TA アカウントの実 HTML で確認した。
 *  行 id は UUID（`id="order_<uuid>"`）。`<tbody>` だけを見るので
 *  モバイルの `order_card_` とは重複しない。
 *  型番・ショップは商品セルの中。メモは一覧 HTML に無い。 */
export function parseTaOrders(html) {
  const body = main(html);
  const heading = headingText(body, 'h1');
  const columns = parseTaColumns(body);
  const looksLikeList = heading === '注文管理' || columns.some((c) => c.label === '商品');
  if (!looksLikeList) {
    return {
      access: 'forbidden',
      canTa: false,
      heading,
      columns: [],
      orders: [],
      statuses: [],
      teams: [],
      total: null,
      empty: parseEmptyState(body)
    };
  }

  const labels = columns.map((c) => c.label);
  const tbody = body.match(/<tbody\b[^>]*>([\s\S]*?)<\/tbody>/);
  const orders = [];
  if (tbody) {
    const trRe = /<tr\b([^>]*)>([\s\S]*?)<\/tr>/g;
    let tr;
    while ((tr = trRe.exec(tbody[1]))) {
      const tds = [];
      const tdRe = /<td\b[^>]*>([\s\S]*?)<\/td>/g;
      let td;
      while ((td = tdRe.exec(tr[2]))) tds.push(td[1]);
      let cells = tds;
      if (/<input\b[^>]*type="checkbox"/i.test(cells[0] || '')) cells = cells.slice(1);
      if (cells.length === labels.length + 1) cells = cells.slice(0, labels.length);
      if (!cells.length) continue;

      const byLabel = {};
      labels.forEach((label, i) => { byLabel[label] = cells[i] ?? ''; });

      const idMatch = tr[1].match(/\bid="order_([^"]+)"/)
        || tr[2].match(/\bdata-order-id="([^"]+)"/);
      const productCell = byLabel['商品'] ?? '';
      const { product, shopName, modelNumber } = readOrderProductCell(productCell);
      const unitPrice = text(byLabel['単価'] ?? '');
      const quantity = text(byLabel['数量'] ?? '');
      const total = text(byLabel['合計'] ?? '');
      const createdAt = text(byLabel['作成日時'] ?? byLabel['作成日'] ?? '');
      const status = statusLabel(byLabel['ステータス'] ?? '');

      const aligned = labels.map((label) => {
        if (label === '商品') return product;
        if (label === 'チーム') return teamName(byLabel[label] ?? '');
        if (label === 'ステータス') return status;
        return text(byLabel[label] ?? '');
      });

      orders.push({
        id: idMatch ? parseIdToken(idMatch[1]) : null,
        product,
        shopName,
        modelNumber,
        team: teamName(byLabel['チーム'] ?? ''),
        unitPrice,
        quantity,
        total,
        status,
        createdAt,
        createdAtISO: toIso(createdAt),
        unitPriceValue: toNumber(unitPrice),
        quantityValue: quantityNumber(quantity),
        totalValue: toNumber(total),
        cells: aligned
      });
    }
  }

  return {
    access: 'ok',
    canTa: true,
    heading,
    columns,
    orders,
    statuses: selectOptions(html, 'status'),
    teams: selectOptions(html, 'team_id'),
    total: parseTaTotal(html),
    empty: parseEmptyState(body)
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
 *  **未検証**: 取得したアカウントは通知が 0 件で、項目を 1 件も見ていない。
 *  印は公開されている JS に合わせる（`notification_list_controller` は
 *  `[data-notification-id]` を、`notifications.js` は `dataset.notificationId` を見る）。
 *  `read` は既読/未読の描き分けが分からないので、`data-read` が無ければ null。
 *  真偽値を当てずっぽうで作らない。 */
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

  return {
    id: item.id,
    title: name,
    body: body || null,
    at,
    atISO,
    read: flag ? flag[1] === 'true' : null
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
