/* ローカル週報 ↔ 公式テンプレート Excel（.xlsx）。
 *
 * 書き出しは fork/assets/weekly-report-template.xlsx の zip を残し、
 * 埋めるセルの文字列だけ差し替える（書式・結合・列幅・ふりがなを落とさない）。
 * 読み込みは SheetJS（fork/vendor/xlsx.mjs、CDN 不要）。
 */

import {
  WEEK_SLOTS, normalizeLocal, MEMBER_SLOTS, SUPPORT_SLOTS
} from './report-local.js';

const TEMPLATE_URL = new URL('./assets/weekly-report-template.xlsx', import.meta.url);
const XLSX_URL = new URL('./vendor/xlsx.mjs', import.meta.url);
const SHEET_NAME = 'テンプレート';
const SHEET_PART = 'xl/worksheets/sheet1.xml';
const SST_PART = 'xl/sharedStrings.xml';

/** メンバー／サポート欄のセル（列は 0-based、行は 1-based）。 */
const MEMBER_CELLS = [
  { r: 4, c: 2 }, { r: 4, c: 5 },
  { r: 5, c: 2 }, { r: 5, c: 5 },
  { r: 6, c: 2 }
];
const SUPPORT_CELLS = [
  { r: 7, c: 2 }, { r: 7, c: 5 },
  { r: 8, c: 2 }, { r: 8, c: 5 }
];

let xlsxPromise = null;
let templatePromise = null;

async function loadXlsx() {
  if (!xlsxPromise) {
    xlsxPromise = import(XLSX_URL).catch((e) => {
      xlsxPromise = null;
      throw e;
    });
  }
  return xlsxPromise;
}

async function loadTemplateBuffer() {
  if (!templatePromise) {
    templatePromise = fetch(TEMPLATE_URL).then(async (res) => {
      if (!res.ok) throw new Error(`テンプレートを取得できません（${res.status}）`);
      return res.arrayBuffer();
    }).catch((e) => {
      templatePromise = null;
      throw e;
    });
  }
  return templatePromise;
}

function cellAddr(r1, c0) {
  // SheetJS encode: r/c 0-based
  const col = String.fromCharCode(65 + c0);
  return `${col}${r1}`;
}

function getCellText(ws, r1, c0) {
  const cell = ws[cellAddr(r1, c0)];
  if (!cell || cell.v == null) return '';
  return String(cell.v);
}

/* ── テンプレート xlsx を値だけ埋める ─────────────────
 * SheetJS の書き出しは書式・結合・列幅・行高・ふりがな・customXml を落とす。
 * 公式テンプレートの zip はそのまま残し、埋めるセルの共有文字列だけ差し替える。
 */

function crc32(u8) {
  let c = 0xffffffff;
  for (let i = 0; i < u8.length; i += 1) {
    c ^= u8[i];
    for (let k = 0; k < 8; k += 1) {
      c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
    }
  }
  return (c ^ 0xffffffff) >>> 0;
}

function readU16(u8, o) {
  return u8[o] | (u8[o + 1] << 8);
}

function readU32(u8, o) {
  return (u8[o] | (u8[o + 1] << 8) | (u8[o + 2] << 16) | (u8[o + 3] << 24)) >>> 0;
}

function concatBytes(parts) {
  const n = parts.reduce((s, p) => s + p.length, 0);
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

async function inflateRaw(u8) {
  const stream = new Blob([u8]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function deflateRaw(u8) {
  const stream = new Blob([u8]).stream().pipeThrough(new CompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** ローカルヘッダだけ読む。中央ディレクトリは書き戻すときに作り直す。 */
function parseZip(u8) {
  const entries = [];
  let off = 0;
  while (off + 30 <= u8.length && readU32(u8, off) === 0x04034b50) {
    const verNeed = readU16(u8, off + 4);
    const flag = readU16(u8, off + 6);
    const method = readU16(u8, off + 8);
    const time = readU16(u8, off + 10);
    const date = readU16(u8, off + 12);
    const crc = readU32(u8, off + 14);
    const csize = readU32(u8, off + 18);
    const usize = readU32(u8, off + 22);
    const nlen = readU16(u8, off + 26);
    const elen = readU16(u8, off + 28);
    const name = new TextDecoder().decode(u8.subarray(off + 30, off + 30 + nlen));
    const extra = u8.slice(off + 30 + nlen, off + 30 + nlen + elen);
    const start = off + 30 + nlen + elen;
    entries.push({
      verNeed, flag, method, time, date, crc, csize, usize, name, extra,
      compressed: u8.slice(start, start + csize)
    });
    off = start + csize;
  }
  return entries;
}

function buildZip(entries) {
  const nameEnc = new TextEncoder();
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const e of entries) {
    const nameBytes = nameEnc.encode(e.name);
    const extra = e.extra || new Uint8Array(0);
    const local = new Uint8Array(30 + nameBytes.length + extra.length);
    const dv = new DataView(local.buffer);
    dv.setUint32(0, 0x04034b50, true);
    dv.setUint16(4, e.verNeed, true);
    dv.setUint16(6, e.flag, true);
    dv.setUint16(8, e.method, true);
    dv.setUint16(10, e.time, true);
    dv.setUint16(12, e.date, true);
    dv.setUint32(14, e.crc, true);
    dv.setUint32(18, e.csize, true);
    dv.setUint32(22, e.usize, true);
    dv.setUint16(26, nameBytes.length, true);
    dv.setUint16(28, extra.length, true);
    local.set(nameBytes, 30);
    local.set(extra, 30 + nameBytes.length);

    const central = new Uint8Array(46 + nameBytes.length);
    const cv = new DataView(central.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 0x002d, true);
    cv.setUint16(6, e.verNeed, true);
    cv.setUint16(8, e.flag, true);
    cv.setUint16(10, e.method, true);
    cv.setUint16(12, e.time, true);
    cv.setUint16(14, e.date, true);
    cv.setUint32(16, e.crc, true);
    cv.setUint32(20, e.csize, true);
    cv.setUint32(24, e.usize, true);
    cv.setUint16(28, nameBytes.length, true);
    cv.setUint32(42, offset, true);
    central.set(nameBytes, 46);

    locals.push(local, e.compressed);
    centrals.push(central);
    offset += local.length + e.compressed.length;
  }
  const cd = concatBytes(centrals);
  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, entries.length, true);
  ev.setUint16(10, entries.length, true);
  ev.setUint32(12, cd.length, true);
  ev.setUint32(16, offset, true);
  return concatBytes([...locals, cd, eocd]);
}

async function zipEntryText(entry) {
  const raw = entry.method === 0 ? entry.compressed : await inflateRaw(entry.compressed);
  return new TextDecoder().decode(raw);
}

async function putZipText(entries, name, text) {
  const entry = entries.find((e) => e.name === name);
  if (!entry) throw new Error(`テンプレートに ${name} がありません`);
  const data = new TextEncoder().encode(text);
  const compressed = await deflateRaw(data);
  entry.compressed = compressed;
  entry.csize = compressed.length;
  entry.usize = data.length;
  entry.crc = crc32(data);
  entry.method = 8;
  entry.extra = new Uint8Array(0);
}

function decodeXml(s) {
  return String(s)
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

function escapeXml(s) {
  return String(s)
    .replace(/[^\u0009\u000A\u000D\u0020-\uD7FF\uE000-\uFFFD]/g, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/** 共有文字列の表示テキスト。ふりがな（rPh）は含めない。 */
function visibleSharedString(si) {
  const cleaned = si
    .replace(/<rPh\b[\s\S]*?<\/rPh>/g, '')
    .replace(/<phoneticPr\b[^>]*\/>/g, '');
  return [...cleaned.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)]
    .map((m) => decodeXml(m[1]))
    .join('');
}

function cellSlice(xml, addr) {
  const token = `<c r="${addr}"`;
  const at = xml.indexOf(token);
  if (at < 0) return null;
  const gt = xml.indexOf('>', at);
  if (gt < 0) return null;
  const selfClosing = xml[gt - 1] === '/';
  const end = selfClosing ? gt + 1 : xml.indexOf('</c>', gt) + 4;
  return { at, end, raw: xml.slice(at, end), selfClosing, gt };
}

function currentStringIndex(xml, addr) {
  const cell = cellSlice(xml, addr);
  if (!cell || !/\bt="s"/.test(cell.raw)) return null;
  const v = cell.raw.match(/<v>(\d+)<\/v>/);
  return v ? Number(v[1]) : null;
}

function replaceCell(xml, addr, index) {
  const cell = cellSlice(xml, addr);
  if (!cell) throw new Error(`テンプレートにセル ${addr} がありません`);
  const attrs = cell.selfClosing
    ? xml.slice(cell.at + `<c r="${addr}"`.length, cell.gt - 1)
    : xml.slice(cell.at + `<c r="${addr}"`.length, cell.gt);
  const kept = attrs.replace(/\s*\bt="[^"]*"/, '');
  const next = `<c r="${addr}"${kept} t="s"><v>${index}</v></c>`;
  return xml.slice(0, cell.at) + next + xml.slice(cell.end);
}

function makeSharedString(text) {
  const escaped = escapeXml(text);
  const space = /[\n\r\t]|^\s|\s$/.test(text) ? ' xml:space="preserve"' : '';
  return `<si><t${space}>${escaped}</t></si>`;
}

/**
 * セルアドレス → 書き込む表示文字列。
 * 空はテンプレートのまま（プレースホルダとふりがなを残す）。
 * 既存の共有文字列と一致するときはその index を使い、ふりがなも残す。
 */
function applyCellText(sheetXml, sstXml, updates) {
  const sis = [...sstXml.matchAll(/<si\b[^>]*>[\s\S]*?<\/si>/g)].map((m) => m[0]);
  const indexByText = new Map();
  sis.forEach((si, i) => {
    const text = visibleSharedString(si);
    if (!indexByText.has(text)) indexByText.set(text, i);
  });

  let sheet = sheetXml;
  const fresh = [];
  let extraRefs = 0;
  for (const [addr, text] of updates) {
    let idx = indexByText.get(text);
    if (idx == null) {
      idx = sis.length + fresh.length;
      indexByText.set(text, idx);
      fresh.push(makeSharedString(text));
    }
    const cur = currentStringIndex(sheet, addr);
    if (cur === idx) continue;
    if (cur == null) extraRefs += 1;
    sheet = replaceCell(sheet, addr, idx);
  }

  if (!fresh.length && sheet === sheetXml) {
    return { sheet, sst: sstXml, changed: false };
  }

  let sst = sstXml;
  if (fresh.length) sst = sst.replace('</sst>', `${fresh.join('')}</sst>`);
  if (fresh.length || extraRefs) {
    sst = sst.replace(
      /(<sst\b[^>]*?\bcount=")(\d+)("\s+uniqueCount=")(\d+)(")/,
      (_all, a, count, mid, unique, tail) => (
        `${a}${Number(count) + extraRefs}${mid}${Number(unique) + fresh.length}${tail}`
      )
    );
  }
  return { sheet, sst, changed: true };
}

/** テンプレートのバイト列に updates（Map<アドレス, 文字列>）を埋めて返す。 */
async function fillTemplate(templateBytes, updates) {
  const bytes = templateBytes instanceof Uint8Array
    ? templateBytes
    : new Uint8Array(templateBytes);
  if (!updates.size) return bytes.slice();

  const entries = parseZip(bytes);
  const sheetEntry = entries.find((e) => e.name === SHEET_PART);
  const sstEntry = entries.find((e) => e.name === SST_PART);
  if (!sheetEntry || !sstEntry) throw new Error('テンプレートのシートが読めません');

  const applied = applyCellText(
    await zipEntryText(sheetEntry),
    await zipEntryText(sstEntry),
    updates
  );
  if (!applied.changed) return bytes.slice();

  await putZipText(entries, SHEET_PART, applied.sheet);
  await putZipText(entries, SST_PART, applied.sst);
  return buildZip(entries);
}

function isPlaceholder(text, kind) {
  const s = String(text || '').replace(/\r\n/g, '\n').trim();
  if (!s) return true;
  if (kind === 'member' || kind === 'support') {
    const compact = s.replace(/[\s　]/g, '');
    return compact === 'クラス：氏名：' || compact === 'クラス:氏名:'
      || /^クラス[：:]氏名[：:]?$/.test(compact);
  }
  if (kind === 'worked') {
    return /月/.test(s) && /日/.test(s) && /時/.test(s) && /分/.test(s) && !/\d/.test(s);
  }
  if (kind === 'meetingDay') {
    return /^曜日[：:]\s*$/.test(s);
  }
  if (kind === 'meetingTime') {
    return /時/.test(s) && /分/.test(s) && /[～~]/.test(s) && !/\d/.test(s);
  }
  if (kind === 'teamNumber') {
    return s === '−' || s === '-' || s === '–' || s === '—';
  }
  return false;
}

function readValue(ws, r1, c0, kind) {
  const text = getCellText(ws, r1, c0).replace(/\r\n/g, '\n').trim();
  if (isPlaceholder(text, kind)) return '';
  if (kind === 'meetingDay') {
    return text.replace(/^曜日[：:]\s*/, '').trim();
  }
  return text;
}

/** 空の欄はテンプレートのプレースホルダ（ふりがなつき）を残す。 */
function putText(updates, r1, c0, value) {
  const text = String(value ?? '').replace(/\r\n/g, '\n').trim();
  if (text) updates.set(cellAddr(r1, c0), text);
}

/** ドキュメント → 公式テンプレートを値だけ埋めた xlsx。 */
export async function documentToWorkbookArray(doc) {
  const template = new Uint8Array(await loadTemplateBuffer());
  const d = normalizeLocal(doc);
  const meta = d.meta;
  const updates = new Map();

  putText(updates, 3, 2, meta.teamName);
  putText(updates, 3, 7, meta.teamNumber);

  for (let i = 0; i < MEMBER_SLOTS; i += 1) {
    const cell = MEMBER_CELLS[i];
    if (!cell) break;
    putText(updates, cell.r, cell.c, meta.members[i]);
  }
  for (let i = 0; i < SUPPORT_SLOTS; i += 1) {
    const cell = SUPPORT_CELLS[i];
    if (!cell) break;
    putText(updates, cell.r, cell.c, meta.support[i]);
  }

  putText(updates, 9, 2, meta.overview);
  const meetingDay = String(meta.meetingDay || '').trim();
  if (meetingDay) updates.set('C10', `曜日：${meetingDay}`);
  putText(updates, 10, 3, meta.meetingTime);

  const byKey = new Map((d.weeks || []).map((w) => [w.key, w]));
  for (const slot of WEEK_SLOTS) {
    const week = byKey.get(slot.key) || {};
    const r = slot.startRow;
    putText(updates, r, 3, week.workedAt);
    putText(updates, r + 1, 3, week.absentees);
    putText(updates, r + 2, 3, week.progress);
    putText(updates, r + 3, 3, week.issue);
    putText(updates, r + 4, 3, week.plan);
  }

  return fillTemplate(template, updates);
}

/** workbook / sheet → ローカルドキュメント 1 件。 */
export function workbookToDocument(wb, opts = {}) {
  const XLSX = opts.XLSX;
  const sheetName = wb.SheetNames.includes(SHEET_NAME)
    ? SHEET_NAME
    : wb.SheetNames[0];
  const ws = wb.Sheets[sheetName];
  if (!ws) throw new Error('シートがありません');

  // テンプレ見出しが無ければ旧フラット形式を試す
  const titleCell = getCellText(ws, 2, 1);
  if (!/活動進捗報告書|週報/.test(titleCell) && XLSX) {
    const aoa = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '', raw: false });
    const flat = legacyAoaToDocuments(aoa);
    if (flat.length) return flat[0];
  }

  const members = MEMBER_CELLS.map((cell) => readValue(ws, cell.r, cell.c, 'member'));
  const support = SUPPORT_CELLS.map((cell) => readValue(ws, cell.r, cell.c, 'support'));

  const weeks = WEEK_SLOTS.map((slot) => {
    const r = slot.startRow;
    return {
      key: slot.key,
      label: slot.label,
      period: slot.period,
      startRow: slot.startRow,
      workedAt: readValue(ws, r, 3, 'worked'),
      absentees: readValue(ws, r + 1, 3, null),
      progress: readValue(ws, r + 2, 3, null),
      issue: readValue(ws, r + 3, 3, null),
      plan: readValue(ws, r + 4, 3, null)
    };
  });

  return normalizeLocal({
    id: opts.id,
    status: opts.status || '下書き',
    originId: opts.originId || null,
    originTitle: opts.originTitle || null,
    meta: {
      teamName: readValue(ws, 3, 2, null),
      teamNumber: readValue(ws, 3, 7, 'teamNumber'),
      members,
      support,
      overview: readValue(ws, 9, 2, null),
      meetingDay: readValue(ws, 10, 2, 'meetingDay'),
      meetingTime: readValue(ws, 10, 3, 'meetingTime')
    },
    weeks
  });
}

/** 旧フラット列形式（互換）。 */
function legacyAoaToDocuments(aoa) {
  if (!Array.isArray(aoa) || aoa.length < 2) return [];
  const headers = aoa[0].map((h) => String(h ?? '').trim());
  const idx = {};
  const aliases = {
    id: ['ローカルID', 'id', 'ID'],
    title: ['タイトル'],
    status: ['ステータス'],
    shortnote: ['概要'],
    progress: ['進捗'],
    issue: ['課題', '問題点'],
    plan: ['計画', '次回までの予定'],
    originId: ['同期先ID'],
    originTitle: ['同期先タイトル']
  };
  for (const [key, names] of Object.entries(aliases)) {
    for (const name of names) {
      const i = headers.indexOf(name);
      if (i >= 0) { idx[key] = i; break; }
    }
  }
  if (idx.title == null && idx.shortnote == null && idx.progress == null) return [];

  const out = [];
  for (const line of aoa.slice(1)) {
    if (!Array.isArray(line) || line.every((c) => String(c ?? '').trim() === '')) continue;
    const get = (key) => {
      const i = idx[key];
      return i == null ? '' : String(line[i] ?? '').trim();
    };
    if (!get('title') && !get('shortnote') && !get('progress') && !get('issue') && !get('plan')) {
      continue;
    }
    out.push(normalizeLocal({
      id: get('id') || undefined,
      title: get('title') || undefined,
      status: get('status') || '下書き',
      originId: get('originId') || null,
      originTitle: get('originTitle') || null,
      meta: { overview: get('shortnote') },
      weeks: [{
        key: 'w01',
        progress: get('progress'),
        issue: get('issue'),
        plan: get('plan'),
        originId: get('originId') || null,
        originTitle: get('originTitle') || null
      }]
    }));
  }
  return out;
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.rel = 'noopener';
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function safeFilename(name) {
  return String(name || '週報')
    .replace(/[\\/:*?"<>|]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);
}

/**
 * テンプレート通りのファイル名 `[チーム番号]-[チーム名]-週報.xlsx`。
 * 未設定の欄はプレースホルダのまま残す（後から埋められるように）。
 */
export function documentFilename(doc) {
  const num = String(doc?.meta?.teamNumber || '').trim();
  const name = String(doc?.meta?.teamName || '').trim();
  const numPart = num || '[チーム番号]';
  const namePart = name || '[チーム名]';
  return `${safeFilename(`${numPart}-${namePart}-週報`)}.xlsx`;
}

/**
 * ドキュメント 1 件（または配列の先頭）を公式テンプレートで .xlsx 出力。
 * @returns {{ format: 'xlsx', filename: string }}
 */
export async function exportReportsExcel(reports) {
  const list = Array.isArray(reports) ? reports : [reports];
  const doc = list[0];
  if (!doc) throw new Error('書き出す週報がありません');

  const data = await documentToWorkbookArray(doc);
  const filename = documentFilename(doc);
  downloadBlob(
    new Blob([data], {
      type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    }),
    filename
  );
  return { format: 'xlsx', filename };
}

/**
 * File（.xlsx）→ ローカル週報ドキュメント配列。
 */
export async function importReportsExcel(file) {
  if (!file) throw new Error('ファイルを選んでください');
  const name = String(file.name || '').toLowerCase();
  const buf = await file.arrayBuffer();
  const XLSX = await loadXlsx();

  if (name.endsWith('.csv') || name.endsWith('.txt')) {
    const text = new TextDecoder('utf-8').decode(buf);
    const aoa = parseCsv(text);
    const docs = legacyAoaToDocuments(aoa);
    if (!docs.length) throw new Error('取り込める週報がありません（公式テンプレートの .xlsx を推奨）');
    return docs;
  }

  const wb = XLSX.read(buf, { type: 'array' });
  const doc = workbookToDocument(wb, { XLSX });
  return [doc];
}

function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = '';
  let i = 0;
  let inQuotes = false;
  const s = String(text || '').replace(/^\uFEFF/, '');
  while (i < s.length) {
    const ch = s[i];
    if (inQuotes) {
      if (ch === '"') {
        if (s[i + 1] === '"') { cell += '"'; i += 2; continue; }
        inQuotes = false;
        i += 1;
        continue;
      }
      cell += ch;
      i += 1;
      continue;
    }
    if (ch === '"') { inQuotes = true; i += 1; continue; }
    if (ch === ',') { row.push(cell); cell = ''; i += 1; continue; }
    if (ch === '\n') {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
      i += 1;
      continue;
    }
    if (ch === '\r') { i += 1; continue; }
    cell += ch;
    i += 1;
  }
  if (cell.length || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

/** テスト用：テンプレート往復（ブラウザ外では template buffer を渡す）。 */
export async function roundTripDocument(doc, templateBuffer) {
  const XLSX = await loadXlsx();
  if (templateBuffer) {
    templatePromise = Promise.resolve(templateBuffer);
  }
  const arr = await documentToWorkbookArray(doc);
  const wb = XLSX.read(arr, { type: 'array' });
  return workbookToDocument(wb, { XLSX, id: doc.id, status: doc.status });
}
