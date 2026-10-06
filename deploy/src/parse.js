/* 元アプリの `/reports` の HTML を JSON に変換する。
 *
 * Meister Management System は Rails のサーバサイドレンダリングで、週報一覧に
 * JSON の口が無い（`/reports` は HTML を返す）。JSON API を持つのは
 * `/notifications/unread_count` だけ。そのため一覧はここで HTML から組み立てる。
 *
 * ネットワークに触らない純関数だけを置く。実際に取得した HTML
 * （`../clone/site/auth/reports.html` と `/reports/:id` `/reports/:id/edit`）に
 * 対して test/parse.test.mjs で検証する。
 *
 * 実 HTML（2026-08-31）: 行 id は UUID（`id="report_<uuid>"` +
 * `data-report-url="/reports/<uuid>"`）。本文の `data-field-name` は
 * **詳細ではなく編集画面** `/reports/:id/edit` にある。
 */

const TAG = /<[^>]*>/g;
const WS = /\s+/g;

/** タグを落として空白を詰める */
export function text(html) {
  if (!html) return '';
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(TAG, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(WS, ' ')
    .trim();
}

/** ログイン画面が返ってきていないか（セッション切れの判定に使う） */
export function looksLikeSignIn(html) {
  return /name="user\[password\]"/.test(html) || /action="\/users\/sign_in"/.test(html);
}

/** `<input name="authenticity_token" …>` から value を取る（属性順は問わない）。 */
function tokenValueFromInput(tag) {
  if (!tag || !/\bname="authenticity_token"/i.test(tag)) return null;
  const m = tag.match(/\bvalue="([^"]+)"/i);
  return m ? m[1] : null;
}

/**
 * authenticity_token を取り出す。
 *
 * Rails はフォームごとに別トークンを出しうる（per-form CSRF）。
 * ページ先頭のログアウト用フォームのトークンを取ると、注文作成などは 422 になる。
 * `formAction` を渡したら、その action の <form> 内のトークンを使う。
 */
export function authenticityToken(html, { formAction } = {}) {
  if (!html) return null;

  if (formAction) {
    const formRe = /<form\b[^>]*>[\s\S]*?<\/form>/gi;
    let formMatch;
    while ((formMatch = formRe.exec(html))) {
      const form = formMatch[0];
      const open = form.match(/^<form\b[^>]*>/i)?.[0] || '';
      const action = open.match(/\baction="([^"]*)"/i)?.[1];
      if (action !== formAction) continue;
      const inputRe = /<input\b[^>]*>/gi;
      let inputMatch;
      while ((inputMatch = inputRe.exec(form))) {
        const token = tokenValueFromInput(inputMatch[0]);
        if (token) return token;
      }
    }
  }

  const inputRe = /<input\b[^>]*>/gi;
  let inputMatch;
  while ((inputMatch = inputRe.exec(html))) {
    const token = tokenValueFromInput(inputMatch[0]);
    if (token) return token;
  }
  return null;
}

/** Rails の CSRF。自動保存は meta の csrf-token を X-CSRF-Token に載せる。 */
export function csrfToken(html) {
  const meta = String(html || '').match(/<meta\b[^>]*name="csrf-token"[^>]*>/i);
  if (meta) {
    const content = meta[0].match(/\bcontent="([^"]+)"/);
    if (content) return content[1];
  }
  return authenticityToken(html);
}

/** 集計チップ「未完了 0」「完了 0」「合計 0」 */
export function parseCounts(html) {
  const counts = { 未完了: null, 完了: null, 合計: null };
  const re = /<span>\s*(未完了|完了|合計)\s+(\d+)\s*<\/span>/g;
  let m;
  while ((m = re.exec(html))) {
    counts[m[1]] = Number(m[2]);
  }
  return counts;
}

/** 列見出し。ソート可否の判定にも使えるよう data-column があれば拾う */
export function parseColumns(html) {
  const thead = html.match(/<thead[\s\S]*?<\/thead>/);
  if (!thead) return [];
  const out = [];
  const re = /<th\b([^>]*)>([\s\S]*?)<\/th>/g;
  let m;
  while ((m = re.exec(thead[0]))) {
    const label = text(m[2]);
    if (!label) continue;
    const column = m[1].match(/data-column="([^"]+)"/);
    out.push(column ? { label, column: column[1] } : { label });
  }
  return out;
}

/** 空状態の見出しと本文 */
export function parseEmptyState(html) {
  const m = html.match(/<h3\b[^>]*>([^<]+)<\/h3>\s*<p\b[^>]*>([^<]+)<\/p>/);
  if (!m) return null;
  return { title: text(m[1]), body: text(m[2]) };
}

/** 「2026/07/22」「2026-07-22」「07/22」を ISO(YYYY-MM-DD) に寄せる。
 *  年が無い表記は年を補えないので null を返す。 */
export function toIso(value, fallbackYear) {
  if (!value) return null;
  const ymd = value.match(/(\d{4})\s*[\/年.-]\s*(\d{1,2})\s*[\/月.-]\s*(\d{1,2})/);
  if (ymd) {
    const [, y, mo, d] = ymd;
    return `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  }
  const md = value.match(/^\s*(\d{1,2})\s*[\/月.-]\s*(\d{1,2})/);
  if (md && fallbackYear) {
    const [, mo, d] = md;
    return `${fallbackYear}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  }
  return null;
}

/** 「05/04 – 05/10」「2026/05/04 - 2026/05/10」の両端を返す */
export function splitRange(value) {
  if (!value) return [null, null];
  const parts = value.split(/[–—~〜\-]|から|to/).map((s) => s.trim()).filter(Boolean);
  if (parts.length < 2) return [value.trim() || null, null];
  return [parts[0], parts[parts.length - 1]];
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** 行 id / パス断片を JSON の id にする。数字は Number、UUID は文字列。 */
export function parseIdToken(raw) {
  if (raw == null) return null;
  const value = String(raw).trim();
  if (!value || value.startsWith('card_')) return null;
  if (/^\d+$/.test(value)) return Number(value);
  if (UUID_RE.test(value)) return value.toLowerCase();
  return null;
}

function rowIdFromAttrs(attrs) {
  const fromId = attrs.match(/\bid="report_([^"]+)"/);
  if (fromId) {
    const id = parseIdToken(fromId[1]);
    if (id != null) return id;
  }
  const fromUrl = attrs.match(/\bdata-report-url="\/reports\/([^"?#]+)"/);
  if (fromUrl) return parseIdToken(fromUrl[1]);
  return null;
}

/** タイトルセル。実 HTML は見出し span とチーム名 span が並ぶ。
 *  CSS クラスは鍵にせず、空でない span / リンクの順で取る。 */
function cellTitle(tdHtml) {
  const spans = [];
  const re = /<span\b[^>]*>([\s\S]*?)<\/span>/gi;
  let m;
  while ((m = re.exec(tdHtml))) {
    const t = text(m[1]);
    if (t) spans.push(t);
  }
  if (spans.length) {
    return { title: spans[0], subtitle: spans[1] || null };
  }
  const a = tdHtml.match(/<a\b[^>]*>([\s\S]*?)<\/a>/i);
  if (a) return { title: text(a[1]), subtitle: null };
  return { title: text(tdHtml), subtitle: null };
}

function isUnsetPeriod(value) {
  return !value || /^期間未設定$/.test(value);
}

/** tbody の行を配列にする。列は見出しの順（タイトル/期間/ステータス/期限/作成日）。 */
export function parseRows(html, columns) {
  const tbody = html.match(/<tbody\b[^>]*>([\s\S]*?)<\/tbody>/);
  if (!tbody) return [];

  const labels = columns.map((c) => c.label);
  const rows = [];
  const trRe = /<tr\b([^>]*)>([\s\S]*?)<\/tr>/g;
  let tr;
  while ((tr = trRe.exec(tbody[1]))) {
    const attrs = tr[1];
    const inner = tr[2];

    const rawCells = [];
    const tdRe = /<td\b[^>]*>([\s\S]*?)<\/td>/g;
    let td;
    while ((td = tdRe.exec(inner))) rawCells.push(td[1]);
    if (!rawCells.length) continue;

    const cells = rawCells.map((html) => text(html));
    const byLabel = {};
    labels.forEach((label, i) => { byLabel[label] = cells[i] ?? ''; });

    const titled = cellTitle(rawCells[0] || '');
    const title = titled.title || byLabel['タイトル'] || cells[0] || '';
    const period = byLabel['期間'] ?? '';
    const status = byLabel['ステータス'] ?? '';
    const due = byLabel['期限'] ?? '';
    const createdAt = byLabel['作成日'] ?? '';

    const dueISO = toIso(due);
    const createdAtISO = toIso(createdAt);
    // 期間は年を省いた「05/04 – 05/10」形式が想定される。期限の年で補う。
    const year = (dueISO || createdAtISO || '').slice(0, 4) || null;
    const unset = isUnsetPeriod(period);
    const [from, to] = unset ? [null, null] : splitRange(period);

    rows.push({
      id: rowIdFromAttrs(attrs),
      title,
      subtitle: titled.subtitle,
      period,
      status: status.replace(/^[✓○]\s*/, ''),
      due,
      createdAt,
      dueISO,
      createdAtISO,
      periodStartISO: unset ? null : toIso(from, year),
      periodEndISO: unset ? null : toIso(to, year),
      cells
    });
  }
  return rows;
}

/** `/reports` の HTML 全体を JSON にする */
export function parseReportsPage(html) {
  const columns = parseColumns(html);
  return {
    columns,
    counts: parseCounts(html),
    empty: parseEmptyState(html),
    reports: parseRows(html, columns)
  };
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

function unescapeAttr(value) {
  return String(value || '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
    .replace(/&amp;/g, '&');
}

function headingText(html, level) {
  const m = html.match(new RegExp(`<${level}\\b[^>]*>([\\s\\S]*?)</${level}>`, 'i'));
  return m ? text(m[1]) || null : null;
}

/** `#side_panel` の Turbo Frame があれば中身、無ければ HTML 全体。
 *  元アプリは一覧から `src="/reports/:id"` でこの frame に詳細を載せる。 */
export function extractSidePanel(html) {
  if (!html) return '';
  const openRe = /<turbo-frame\b[^>]*\bid="side_panel"[^>]*>/i;
  const open = openRe.exec(html);
  if (!open) return html;
  return sliceFrom(html, open.index + open[0].length, 'turbo-frame').inner;
}

function findFieldLabel(html, fieldId, fieldIndex) {
  if (fieldId) {
    const escaped = fieldId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const forRe = new RegExp(
      `<label\\b[^>]*\\bfor="${escaped}"[^>]*>([\\s\\S]*?)</label>`,
      'i'
    );
    const m = html.match(forRe);
    if (m) return text(m[1]) || null;
  }
  const before = html.slice(Math.max(0, fieldIndex - 1200), fieldIndex);
  const labels = [...before.matchAll(/<label\b[^>]*>([\s\S]*?)<\/label>/gi)];
  if (labels.length) return text(labels[labels.length - 1][1]) || null;
  const heads = [...before.matchAll(/<(h[2-4])\b[^>]*>([\s\S]*?)<\/\1>/gi)];
  if (heads.length) return text(heads[heads.length - 1][2]) || null;
  return null;
}

const SKIP_INPUT_TYPES = new Set(['hidden', 'submit', 'button', 'reset', 'file', 'image']);

function fieldValue(tag, attrs, html, openIndex, openLength) {
  if (tag === 'textarea') {
    const { inner } = sliceFrom(html, openIndex + openLength, 'textarea');
    return unescapeAttr(inner).trim();
  }
  if (tag === 'select') {
    const { inner } = sliceFrom(html, openIndex + openLength, 'select');
    const selected = inner.match(/<option\b[^>]*\bselected\b[^>]*>([\s\S]*?)<\/option>/i)
      || inner.match(/<option\b[^>]*\bselected\b[^>]*\bvalue="([^"]*)"/i);
    if (selected) {
      return unescapeAttr(selected[1] || '').trim();
    }
    return unescapeAttr((attrs.match(/\bvalue="([^"]*)"/) || [])[1] || '').trim();
  }
  return unescapeAttr((attrs.match(/\bvalue="([^"]*)"/) || [])[1] || '').trim();
}

/** 入力を文書順で取る。`data-field-name` を優先し、無ければ `report[…]`。
 *  実 HTML の編集画面は shortnote/progress/issue/plan に data-field-name、
 *  開始日・終了日は report[start_at]/report[end_at] だけ。 */
export function parseReportFields(html) {
  const out = [];
  const seen = new Set();
  const openRe = /<(textarea|input|select)\b([^>]*)>/gi;
  let m;
  while ((m = openRe.exec(html))) {
    const tag = m[1].toLowerCase();
    const attrs = m[2];
    const type = ((attrs.match(/\btype="([^"]*)"/) || [])[1] || '').toLowerCase();
    if (SKIP_INPUT_TYPES.has(type)) continue;

    const dataName = (attrs.match(/\bdata-field-name="([^"]+)"/) || [])[1];
    const reportName = (attrs.match(/\bname="report\[([^\]]+)\]"/) || [])[1];
    const name = dataName || reportName;
    if (!name || seen.has(name) || name === 'id') continue;
    seen.add(name);

    const id = (attrs.match(/\bid="([^"]+)"/) || [])[1] || null;
    out.push({
      name,
      label: findFieldLabel(html, id, m.index),
      value: fieldValue(tag, attrs, html, m.index, m[0].length),
      lockedBy: null
    });
  }

  // data-field-name が入力以外（入れ物）に付いている場合。
  const wrapRe = /<(\w+)\b([^>]*\bdata-field-name="([^"]+)"[^>]*)>/gi;
  while ((m = wrapRe.exec(html))) {
    const tag = m[1].toLowerCase();
    if (tag === 'textarea' || tag === 'input' || tag === 'select') continue;
    const name = m[3];
    if (!name || seen.has(name)) continue;
    const { inner } = sliceFrom(html, m.index + m[0].length, tag);
    const nestedTa = inner.match(/<textarea\b[^>]*>([\s\S]*?)<\/textarea>/i);
    const nestedIn = inner.match(/<input\b([^>]*)>/i);
    let value = '';
    if (nestedTa) value = unescapeAttr(nestedTa[1]).trim();
    else if (nestedIn) {
      value = unescapeAttr((nestedIn[1].match(/\bvalue="([^"]*)"/) || [])[1] || '').trim();
    } else {
      continue;
    }
    seen.add(name);
    const id = (m[2].match(/\bid="([^"]+)"/) || [])[1] || null;
    out.push({
      name,
      label: findFieldLabel(html, id, m.index),
      value,
      lockedBy: null
    });
  }
  return out;
}

function parseInitialLocks(html) {
  const m = html.match(/data-collaborative-edit-initial-locks-value="([^"]*)"/);
  if (!m) return [];
  try {
    const parsed = JSON.parse(unescapeAttr(m[1]));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function parseDefinitionList(html) {
  const out = [];
  const re = /<dt\b[^>]*>([\s\S]*?)<\/dt>\s*<dd\b[^>]*>([\s\S]*?)<\/dd>/gi;
  let m;
  while ((m = re.exec(html))) {
    const label = text(m[1]);
    const value = text(m[2]);
    if (!label) continue;
    out.push({ label, value: value || null });
  }
  return out;
}

/** 詳細／編集で確認できたラベル「提出期限」「作業期間」。語彙は HTML から取る。 */
function parseKeyedMeta(html) {
  const out = [];
  const seen = new Set();
  const colon = /<(?:p|div)\b[^>]*>\s*(提出期限|作業期間)\s*[:：]\s*([\s\S]*?)<\/(?:p|div)>/gi;
  let m;
  while ((m = colon.exec(html))) {
    const label = m[1];
    if (seen.has(label)) continue;
    seen.add(label);
    out.push({ label, value: text(m[2]) || null });
  }
  const span = /<span\b[^>]*>\s*(提出期限|作業期間)\s*<\/span>/gi;
  while ((m = span.exec(html))) {
    const label = m[1];
    if (seen.has(label)) continue;
    const after = html.slice(m.index + m[0].length, m.index + m[0].length + 800);
    const block = after.match(/<(?:div|p)\b[^>]*>([\s\S]*?)<\/(?:div|p)>/);
    seen.add(label);
    out.push({ label, value: block ? (text(block[1]) || null) : null });
  }
  return out;
}

function mergeMeta(html) {
  const out = [];
  const seen = new Set();
  for (const item of [...parseDefinitionList(html), ...parseKeyedMeta(html)]) {
    if (!item.label || seen.has(item.label)) continue;
    seen.add(item.label);
    out.push(item);
  }
  return out;
}

const FRAME_CHROME_TITLES = new Set(['週報詳細', '週報編集']);

function reportTitle(html) {
  const re = /<h2\b[^>]*>([\s\S]*?)<\/h2>/gi;
  let m;
  while ((m = re.exec(html))) {
    const t = text(m[1]);
    if (t && !FRAME_CHROME_TITLES.has(t)) return t;
  }
  const h1 = headingText(html, 'h1');
  if (h1 && !FRAME_CHROME_TITLES.has(h1)) return h1;
  return null;
}

function extractReportId(html) {
  if (!html) return null;
  const collab = html.match(/data-collaborative-edit-report-id-value="([^"]+)"/);
  if (collab) {
    const id = parseIdToken(collab[1]);
    if (id != null) return id;
  }
  const row = html.match(/\bid="report_([^"]+)"/);
  if (row) {
    const id = parseIdToken(row[1]);
    if (id != null) return id;
  }
  const path = html.match(/\/reports\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|\d+)/i);
  return path ? parseIdToken(path[1]) : null;
}

function parseTimeline(html) {
  const out = [];
  const openRe = /<(\w+)\b[^>]*class="[^"]*\btimeline-item\b[^"]*"[^>]*>/gi;
  let m;
  while ((m = openRe.exec(html))) {
    const { inner, end } = sliceFrom(html, m.index + m[0].length, m[1]);
    const time = inner.match(/<time\b([^>]*)>([\s\S]*?)<\/time>/i);
    const datetime = time ? (time[1].match(/datetime="([^"]*)"/) || [])[1] : null;
    const at = time ? text(time[2]) || null : null;
    let body = text(time ? inner.replace(time[0], ' ') : inner) || null;
    out.push({
      at,
      atISO: datetime && /^\d{4}-\d{2}-\d{2}/.test(datetime) ? datetime.slice(0, 10) : toIso(at),
      text: body
    });
    openRe.lastIndex = end;
  }
  return out;
}

/** `/reports/:id` または `/reports/:id/edit` の詳細。
 *  本文項目（`data-field-name`）は編集画面にある。詳細画面はタイトル・
 *  提出期限・作業期間・コメント欄で、編集フォームは持たない。
 *  項目名は HTML の label を素通しし、語彙を作らない。 */
export function parseReportDetail(html) {
  const frame = extractSidePanel(html);
  const fields = parseReportFields(frame);
  const locks = parseInitialLocks(frame);
  for (const lock of locks) {
    const fieldName = lock?.field_name || lock?.fieldName;
    const userName = lock?.user_name || lock?.userName || null;
    if (!fieldName || !userName) continue;
    const field = fields.find((f) => f.name === fieldName);
    if (field && !field.lockedBy) field.lockedBy = userName;
  }
  const body = fields.map((f) => f.value).filter((v) => v && v.trim()).join('\n\n') || null;
  const locked = fields.find((f) => f.lockedBy);
  return {
    id: extractReportId(frame) ?? extractReportId(html),
    title: reportTitle(frame),
    meta: mergeMeta(frame),
    fields,
    timeline: parseTimeline(frame),
    body,
    lockedBy: locked?.lockedBy || null
  };
}
