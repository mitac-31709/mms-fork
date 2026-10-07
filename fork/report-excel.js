/* ローカル週報 ↔ 公式テンプレート Excel（.xlsx）。
 *
 * fork/assets/weekly-report-template.xlsx（シート「テンプレート」）を埋める／読む。
 * SheetJS は fork/vendor/xlsx.mjs を使う（CDN 不要）。
 */

import {
  WEEK_SLOTS, documentTitle, normalizeLocal, MEMBER_SLOTS, SUPPORT_SLOTS
} from './report-local.js';

const TEMPLATE_URL = new URL('./assets/weekly-report-template.xlsx', import.meta.url);
const XLSX_URL = new URL('./vendor/xlsx.mjs', import.meta.url);
const SHEET_NAME = 'テンプレート';

const PLACEHOLDER_MEMBER = 'クラス：　　　氏名：';
const PLACEHOLDER_WORKED = '月　　日　　時　　分　～　　時　　分';
const PLACEHOLDER_MEETING_TIME = '時　　分　～　　時　　分';
const PLACEHOLDER_TEAM_NUM = '−';

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

function setCellText(ws, r1, c0, value) {
  const addr = cellAddr(r1, c0);
  const prev = ws[addr];
  const text = value == null ? '' : String(value);
  if (!text) {
    if (prev) {
      ws[addr] = { t: 's', v: '' };
    }
    return;
  }
  ws[addr] = {
    t: 's',
    v: text,
    ...(prev?.s ? { s: prev.s } : {})
  };
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

function writeValue(ws, r1, c0, value, placeholder) {
  const text = String(value || '').trim();
  setCellText(ws, r1, c0, text || placeholder || '');
}

function writeMeetingDay(ws, value) {
  const text = String(value || '').trim();
  setCellText(ws, 10, 2, text ? `曜日：${text}` : '曜日：');
}

/** ドキュメント → テンプレート workbook を埋めた ArrayBuffer。 */
export async function documentToWorkbookArray(doc) {
  const XLSX = await loadXlsx();
  const template = await loadTemplateBuffer();
  const wb = XLSX.read(template, { type: 'array' });
  const sheetName = wb.SheetNames.includes(SHEET_NAME) ? SHEET_NAME : wb.SheetNames[0];
  const ws = wb.Sheets[sheetName];
  if (!ws) throw new Error('テンプレートシートがありません');

  const d = normalizeLocal(doc);
  const meta = d.meta;

  writeValue(ws, 3, 2, meta.teamName, '');
  writeValue(ws, 3, 7, meta.teamNumber, PLACEHOLDER_TEAM_NUM);

  for (let i = 0; i < MEMBER_SLOTS; i += 1) {
    const cell = MEMBER_CELLS[i];
    if (!cell) break;
    writeValue(ws, cell.r, cell.c, meta.members[i], PLACEHOLDER_MEMBER);
  }
  for (let i = 0; i < SUPPORT_SLOTS; i += 1) {
    const cell = SUPPORT_CELLS[i];
    if (!cell) break;
    writeValue(ws, cell.r, cell.c, meta.support[i], PLACEHOLDER_MEMBER);
  }

  writeValue(ws, 9, 2, meta.overview, '');
  writeMeetingDay(ws, meta.meetingDay);
  writeValue(ws, 10, 3, meta.meetingTime, PLACEHOLDER_MEETING_TIME);

  const byKey = new Map((d.weeks || []).map((w) => [w.key, w]));
  for (const slot of WEEK_SLOTS) {
    const week = byKey.get(slot.key) || {};
    const r = slot.startRow;
    writeValue(ws, r, 3, week.workedAt, PLACEHOLDER_WORKED);
    writeValue(ws, r + 1, 3, week.absentees, '');
    writeValue(ws, r + 2, 3, week.progress, '');
    writeValue(ws, r + 3, 3, week.issue, '');
    writeValue(ws, r + 4, 3, week.plan, '');
  }

  return XLSX.write(wb, { bookType: 'xlsx', type: 'array' });
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

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}

function safeFilename(name) {
  return String(name || '週報')
    .replace(/[\\/:*?"<>|]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);
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
  const filename = `${safeFilename(documentTitle(doc)) || `mms-weekly-${stamp()}`}.xlsx`;
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
