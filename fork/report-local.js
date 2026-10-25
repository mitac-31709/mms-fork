/* 週報のローカル保存（localStorage）。
 *
 * 公式テンプレート「[チーム番号]-[チーム名]-週報.xlsx」と同じ形で持つ。
 * Worker / 元アプリには一切送らない。ブラウザ内だけ。
 */

const STORAGE_KEY = 'mms-fork.local-reports.v2';
const LEGACY_KEY = 'mms-fork.local-reports.v1';

export const LOCAL_STATUSES = ['下書き', '準備完了'];

/** テンプレートシート「テンプレート」の週ブロック開始行（1-based）。 */
export const WEEK_SLOTS = [
  { key: 'w01', label: '10月第1週', period: '10 / 01 (木) ～ 07 (水)', startRow: 13 },
  { key: 'w02', label: '10月第2週', period: '10 / 08 (木) ～ 14 (水)', startRow: 18 },
  { key: 'w03', label: '10月第3週', period: '10 / 15 (木) ～ 21 (水)', startRow: 23 },
  { key: 'w04', label: '10月第4週', period: '10 / 22 (木) ～ 28 (水)', startRow: 28 },
  { key: 'w05', label: '11月第1週', period: '10 / 29 (木) ～ 11 / 04 (水)', startRow: 33 },
  { key: 'w06', label: '11月第2週', period: '11 / 05 (月) ～ 11 / 10 (火)', startRow: 38 },
  { key: 'w07', label: '12月第1週', period: '11 / 30 (月) ～ 03 (木)', startRow: 44 },
  { key: 'w08', label: '12月第2週', period: '12 / 04 (金) ～ 10 (木)', startRow: 50 },
  { key: 'w09', label: '12月第3週', period: '12 / 11 (金) ～ 17 (木)', startRow: 55 },
  { key: 'w10', label: '12月第4週', period: '12 / 18 (金) ～ 25 (金)', startRow: 60 },
  { key: 'w11', label: '01月第1週', period: '01 / 05 (火) ～ 08 (金)', startRow: 66 },
  { key: 'w12', label: '01月第2週', period: '01 / 11 (月) ～ 15 (金)', startRow: 71 },
  { key: 'w13', label: '01月第3週', period: '01 / 18 (月) ～ 21 (木)', startRow: 76 },
  { key: 'w14', label: '02月第1週', period: '02 /04 (木) ～ 10 (水)', startRow: 82 }
];

export const MEMBER_SLOTS = 5;
export const SUPPORT_SLOTS = 4;

function uuid() {
  if (globalThis.crypto?.randomUUID) return crypto.randomUUID();
  return `local-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function blankMeta() {
  return {
    teamName: '',
    teamNumber: '',
    members: Array.from({ length: MEMBER_SLOTS }, () => ''),
    support: Array.from({ length: SUPPORT_SLOTS }, () => ''),
    overview: '',
    meetingDay: '',
    meetingTime: ''
  };
}

function blankWeek(slot) {
  return {
    key: slot.key,
    label: slot.label,
    period: slot.period,
    startRow: slot.startRow,
    workedAt: '',
    absentees: '',
    progress: '',
    issue: '',
    plan: '',
    originId: null,
    originTitle: null
  };
}

export function blankWeeks() {
  return WEEK_SLOTS.map((slot) => blankWeek(slot));
}

export function documentTitle(doc) {
  const num = String(doc?.meta?.teamNumber || '').trim();
  const name = String(doc?.meta?.teamName || '').trim();
  if (num && name) return `${num}-${name}-週報`;
  if (name) return `${name}-週報`;
  if (doc?.title) return String(doc.title);
  return '無題の週報';
}

function normalizeMeta(raw = {}) {
  const base = blankMeta();
  const src = raw.meta && typeof raw.meta === 'object' ? raw.meta : raw;
  base.teamName = String(src.teamName ?? '').trim();
  base.teamNumber = String(src.teamNumber ?? '').trim();
  base.overview = String(src.overview ?? src.shortnote ?? '').trim();
  base.meetingDay = String(src.meetingDay ?? '').trim();
  base.meetingTime = String(src.meetingTime ?? '').trim();

  const members = Array.isArray(src.members) ? src.members : [];
  base.members = Array.from({ length: MEMBER_SLOTS }, (_, i) => String(members[i] ?? '').trim());
  const support = Array.isArray(src.support) ? src.support : [];
  base.support = Array.from({ length: SUPPORT_SLOTS }, (_, i) => String(support[i] ?? '').trim());
  return base;
}

function normalizeWeek(raw = {}, slot) {
  const base = blankWeek(slot || {
    key: raw.key || 'w00',
    label: raw.label || '週',
    period: raw.period || '',
    startRow: raw.startRow || 0
  });
  return {
    ...base,
    key: String(raw.key || base.key),
    label: String(raw.label || base.label),
    period: String(raw.period || base.period),
    startRow: Number(raw.startRow || base.startRow) || base.startRow,
    workedAt: String(raw.workedAt ?? '').trim(),
    absentees: String(raw.absentees ?? '').trim(),
    progress: String(raw.progress ?? '').trim(),
    issue: String(raw.issue ?? '').trim(),
    plan: String(raw.plan ?? '').trim(),
    originId: raw.originId != null && raw.originId !== ''
      ? (typeof raw.originId === 'number' ? raw.originId : String(raw.originId))
      : null,
    originTitle: raw.originTitle ? String(raw.originTitle) : null
  };
}

function normalizeWeeks(rawWeeks) {
  const byKey = new Map();
  if (Array.isArray(rawWeeks)) {
    for (const w of rawWeeks) {
      if (w?.key) byKey.set(String(w.key), w);
    }
  }
  return WEEK_SLOTS.map((slot) => normalizeWeek(byKey.get(slot.key) || {}, slot));
}

/** 正規化したローカル週報ドキュメント 1 件（テンプレート 1 ファイル分）。 */
export function normalizeLocal(raw = {}) {
  const now = new Date().toISOString();
  // 旧フラット形式（v1）を 1 週目へ取り込む
  const legacyFlat = raw.progress != null || raw.issue != null || raw.plan != null
    || raw.shortnote != null;
  let weeks = normalizeWeeks(raw.weeks);
  if (legacyFlat && !raw.weeks) {
    weeks = normalizeWeeks([{
      key: 'w01',
      progress: raw.progress,
      issue: raw.issue,
      plan: raw.plan,
      workedAt: [raw.start_at, raw.end_at].filter(Boolean).join(' ～ '),
      originId: raw.originId,
      originTitle: raw.originTitle
    }]);
  }
  const meta = normalizeMeta(raw);
  if (!meta.overview && raw.shortnote) meta.overview = String(raw.shortnote);

  const doc = {
    id: raw.id || uuid(),
    title: String(raw.title || '').trim(),
    status: LOCAL_STATUSES.includes(raw.status) ? raw.status : '下書き',
    originId: raw.originId != null && raw.originId !== ''
      ? (typeof raw.originId === 'number' ? raw.originId : String(raw.originId))
      : null,
    originTitle: raw.originTitle ? String(raw.originTitle) : null,
    createdAt: raw.createdAt || now,
    updatedAt: raw.updatedAt || now,
    meta,
    weeks
  };
  if (!doc.title) doc.title = documentTitle(doc);
  return doc;
}

function migrateLegacy() {
  try {
    const legacy = localStorage.getItem(LEGACY_KEY);
    if (!legacy) return null;
    const parsed = JSON.parse(legacy);
    if (!Array.isArray(parsed) || !parsed.length) return null;
    return parsed.map((r) => normalizeLocal(r));
  } catch {
    return null;
  }
}

function readAll() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) return [];
      return parsed.map((r) => normalizeLocal(r));
    }
    const migrated = migrateLegacy();
    if (migrated) {
      writeAll(migrated);
      return migrated;
    }
    return [];
  } catch {
    return [];
  }
}

function writeAll(list) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(list));
}

export function listLocalReports() {
  return readAll().slice().sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
}

export function getLocalReport(id) {
  return readAll().find((r) => String(r.id) === String(id)) || null;
}

export function saveLocalReport(input) {
  const list = readAll();
  const next = normalizeLocal({ ...input, updatedAt: new Date().toISOString() });
  next.title = documentTitle(next);
  if (!input.createdAt && !list.some((r) => String(r.id) === String(next.id))) {
    next.createdAt = next.updatedAt;
  }
  const idx = list.findIndex((r) => String(r.id) === String(next.id));
  if (idx >= 0) list[idx] = { ...list[idx], ...next, createdAt: list[idx].createdAt };
  else list.unshift(next);
  writeAll(list);
  return getLocalReport(next.id);
}

export function createLocalReport(partial = {}) {
  return saveLocalReport(normalizeLocal({
    ...partial,
    id: partial.id || uuid(),
    meta: { ...blankMeta(), ...(partial.meta || {}) },
    weeks: partial.weeks || blankWeeks(),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  }));
}

export function deleteLocalReport(id) {
  const list = readAll();
  const idx = list.findIndex((r) => String(r.id) === String(id));
  if (idx < 0) return null;
  const [removed] = list.splice(idx, 1);
  writeAll(list);
  return removed;
}

export function replaceAllLocalReports(reports) {
  const list = (reports || []).map((r) => normalizeLocal(r));
  writeAll(list);
  return listLocalReports();
}

/** インポート結果を既存とマージ。同じ id は上書き、無しは新規。 */
export function mergeLocalReports(incoming) {
  const list = readAll();
  const byId = new Map(list.map((r) => [String(r.id), r]));
  let created = 0;
  let updated = 0;
  for (const raw of incoming || []) {
    const next = normalizeLocal({
      ...raw,
      updatedAt: new Date().toISOString()
    });
    next.title = documentTitle(next);
    if (byId.has(String(next.id))) {
      const prev = byId.get(String(next.id));
      byId.set(String(next.id), {
        ...prev,
        ...next,
        createdAt: prev.createdAt,
        updatedAt: next.updatedAt
      });
      updated += 1;
    } else {
      if (!raw.id) next.id = uuid();
      byId.set(String(next.id), next);
      created += 1;
    }
  }
  writeAll([...byId.values()]);
  return { created, updated, reports: listLocalReports() };
}

export function clearLocalReports() {
  localStorage.removeItem(STORAGE_KEY);
  localStorage.removeItem(LEGACY_KEY);
}

/* ── 下書き設定（ヘッダー共通値） ────────────────────
 * チーム名・番号・メンバーなどは下書きごとに変わらないので、
 * 1 箇所（プロフィール）で持つ。新規下書きはここから写す。
 */
const PROFILE_KEY = 'mms-fork.local-profile.v1';

export function blankProfile() {
  return {
    teamName: '',
    teamNumber: '',
    members: Array.from({ length: MEMBER_SLOTS }, () => ''),
    support: Array.from({ length: SUPPORT_SLOTS }, () => ''),
    overview: '',
    meetingDay: '',
    meetingTime: '',
    updatedAt: null
  };
}

export function normalizeProfile(raw = {}) {
  const meta = normalizeMeta(raw);
  return {
    teamName: meta.teamName,
    teamNumber: meta.teamNumber,
    members: meta.members,
    support: meta.support,
    overview: meta.overview,
    meetingDay: meta.meetingDay,
    meetingTime: meta.meetingTime,
    updatedAt: raw.updatedAt || null
  };
}

export function getProfile() {
  try {
    const raw = localStorage.getItem(PROFILE_KEY);
    if (!raw) return blankProfile();
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return blankProfile();
    return normalizeProfile(parsed);
  } catch {
    return blankProfile();
  }
}

/** 設定済みかどうか（自動入力の初回実行判定用）。 */
export function hasProfile() {
  try {
    return localStorage.getItem(PROFILE_KEY) != null;
  } catch {
    return false;
  }
}

export function saveProfile(input) {
  const next = normalizeProfile(input || {});
  next.updatedAt = new Date().toISOString();
  localStorage.setItem(PROFILE_KEY, JSON.stringify(next));
  return next;
}

export function clearProfile() {
  localStorage.removeItem(PROFILE_KEY);
}

/**
 * ダッシュボードのチーム行（例「チーム: 10(未定)」）→ { number, name }。
 * 形式が読めないときは全体をチーム名にする。
 */
export function parseTeamLine(line) {
  const s = String(line || '').trim().replace(/^チーム[:：]\s*/, '').trim();
  if (!s) return { number: '', name: '' };
  let m = s.match(/^(\d+)\s*[\(（]\s*(.+?)\s*[\)）]$/);
  if (m) return { number: m[1], name: m[2] };
  m = s.match(/^(\d+)\s*[-：:－―]\s*(.+)$/);
  if (m) return { number: m[1], name: m[2].trim() };
  if (/^\d+$/.test(s)) return { number: s, name: '' };
  return { number: '', name: s };
}

function isBlank(value) {
  return String(value ?? '').trim() === '';
}

/**
 * プロフィールの空欄だけを埋める。ユーザー入力は上書きしない。
 * @returns {string[]} 埋めた項目名（表示用）
 */
export function fillProfileBlanks(profile, patch) {
  const filled = [];
  const p = profile || {};
  const src = patch || {};
  for (const key of ['teamName', 'teamNumber', 'overview', 'meetingDay', 'meetingTime']) {
    if (isBlank(p[key]) && !isBlank(src[key])) {
      p[key] = String(src[key]).trim();
      filled.push(key);
    }
  }
  const fillList = (key, values, labelBase) => {
    const list = Array.isArray(p[key]) ? p[key].slice() : [];
    while (list.length < (key === 'members' ? MEMBER_SLOTS : SUPPORT_SLOTS)) list.push('');
    (values || []).forEach((v) => {
      const text = String(v ?? '').trim();
      if (!text) return;
      if (list.some((e) => String(e || '').trim() === text)) return;
      const idx = list.findIndex((e) => isBlank(e));
      if (idx < 0) return;
      list[idx] = text;
      filled.push(`${labelBase}${idx + 1}`);
    });
    p[key] = list;
  };
  fillList('members', src.members, 'メンバー');
  fillList('support', src.support, 'サポート');
  return filled;
}

/** プロフィール → 新規下書き用の meta。 */
export function profileToMeta(profile) {
  const p = profile || blankProfile();
  return normalizeMeta({
    teamName: p.teamName,
    teamNumber: p.teamNumber,
    members: p.members,
    support: p.support,
    overview: p.overview,
    meetingDay: p.meetingDay,
    meetingTime: p.meetingTime
  });
}

/**
 * 下書きの空欄だけをプロフィールで埋める（既存下書きへの反映用）。
 * @returns 埋めた項目数
 */
export function applyProfileToDoc(doc, profile) {
  if (!doc) return 0;
  const meta = doc.meta || (doc.meta = {});
  const p = profile || {};
  let n = 0;
  for (const key of ['teamName', 'teamNumber', 'overview', 'meetingDay', 'meetingTime']) {
    if (isBlank(meta[key]) && !isBlank(p[key])) {
      meta[key] = String(p[key]).trim();
      n += 1;
    }
  }
  const mergeList = (key, length) => {
    if (!Array.isArray(meta[key])) meta[key] = [];
    (p[key] || []).forEach((v, i) => {
      if (i >= length) return;
      if (isBlank(meta[key][i]) && !isBlank(v)) {
        meta[key][i] = String(v).trim();
        n += 1;
      }
    });
    while (meta[key].length < length) meta[key].push('');
  };
  mergeList('members', MEMBER_SLOTS);
  mergeList('support', SUPPORT_SLOTS);
  return n;
}

/** プロフィールが空っぽかどうか（初回ガイド用）。 */
export function isProfileEmpty(profile) {
  const p = profile || {};
  return isBlank(p.teamName) && isBlank(p.teamNumber) && isBlank(p.overview)
    && (p.members || []).every((m) => isBlank(m))
    && (p.support || []).every((m) => isBlank(m));
}

/** 週ブロック → 元アプリ同期用フィールド。 */
export function weekToFieldList(week, overview = '') {
  return [
    { name: 'shortnote', label: '概要', value: overview || '' },
    { name: 'progress', label: '進捗', value: week?.progress || '' },
    { name: 'issue', label: '課題', value: week?.issue || '' },
    { name: 'plan', label: '計画', value: week?.plan || '' }
  ];
}

/** 記入のある週だけ。 */
export function filledWeeks(doc) {
  return (doc?.weeks || []).filter((w) =>
    w.workedAt || w.absentees || w.progress || w.issue || w.plan);
}

export function weekDisplayLabel(week) {
  if (!week) return '';
  return week.period ? `${week.label}（${week.period}）` : week.label;
}
