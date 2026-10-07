/* ローカル週報（公式テンプレート形式）の純関数テスト。
 *
 *   node --test test_local_reports.mjs
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { inflateRawSync } from 'node:zlib';
import { test, beforeEach } from 'node:test';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => { store.set(k, String(v)); },
  removeItem: (k) => { store.delete(k); }
};

// Node に fetch テンプレート用のモック
const here = dirname(fileURLToPath(import.meta.url));
const templateBuf = readFileSync(join(here, 'assets/weekly-report-template.xlsx'));
globalThis.fetch = async (url) => {
  const href = String(url);
  if (href.includes('weekly-report-template.xlsx')) {
    return {
      ok: true,
      status: 200,
      arrayBuffer: async () => templateBuf.buffer.slice(
        templateBuf.byteOffset,
        templateBuf.byteOffset + templateBuf.byteLength
      )
    };
  }
  throw new Error(`unexpected fetch: ${href}`);
};

const {
  applyProfileToDoc, blankProfile, clearLocalReports, createLocalReport,
  deleteLocalReport, documentTitle, filledWeeks, fillProfileBlanks, getProfile,
  hasProfile,   isProfileEmpty, listLocalReports, mergeLocalReports, parseTeamLine,
  profileToMeta, saveLocalReport, saveProfile, WEEK_SLOTS
} = await import('./report-local.js');
const { documentToWorkbookArray, roundTripDocument, workbookToDocument } =
  await import('./report-excel.js');
const XLSX = await import('./vendor/xlsx.mjs');

beforeEach(() => {
  store.clear();
  clearLocalReports();
});

test('新規作成でテンプレート週スロットが揃う', () => {
  const r = createLocalReport({ meta: { teamName: 'サンプル', teamNumber: '01' } });
  assert.ok(r.id);
  assert.equal(r.weeks.length, WEEK_SLOTS.length);
  assert.equal(documentTitle(r), '01-サンプル-週報');
  assert.equal(listLocalReports().length, 1);
});

test('保存はサーバーを経由せず localStorage にだけ書く', () => {
  createLocalReport({ meta: { teamName: 'A' } });
  const raw = localStorage.getItem('mms-fork.local-reports.v2');
  assert.ok(raw.includes('A'));
  assert.equal(JSON.parse(raw).length, 1);
});

test('削除とマージ', () => {
  const a = createLocalReport({ id: 'id-a', meta: { teamName: 'A' } });
  createLocalReport({ id: 'id-b', meta: { teamName: 'B' } });
  deleteLocalReport(a.id);
  assert.equal(listLocalReports().length, 1);
  const { created, updated } = mergeLocalReports([
    { id: 'id-b', meta: { teamName: 'B2', overview: 'x' } },
    { meta: { teamName: 'C' } }
  ]);
  assert.equal(updated, 1);
  assert.equal(created, 1);
  assert.equal(listLocalReports().find((r) => r.id === 'id-b').meta.teamName, 'B2');
});

test('テンプレート Excel の往復で週フィールドが残る', async () => {
  const r = saveLocalReport({
    id: 'uuid-1',
    status: '下書き',
    meta: {
      teamName: '往復チーム',
      teamNumber: '07',
      overview: '作品の概要文',
      meetingDay: '木',
      meetingTime: '16時30分～18時00分',
      members: ['クラス：1年　氏名：太郎', '', '', '', ''],
      support: ['', '', '', '']
    },
    weeks: [{
      key: 'w01',
      workedAt: '10月2日 15時～17時',
      absentees: 'なし',
      progress: '進捗文',
      issue: '問題点文',
      plan: '予定文'
    }]
  });

  const back = await roundTripDocument(r, templateBuf.buffer.slice(
    templateBuf.byteOffset,
    templateBuf.byteOffset + templateBuf.byteLength
  ));
  assert.equal(back.meta.teamName, '往復チーム');
  assert.equal(back.meta.teamNumber, '07');
  assert.equal(back.meta.overview, '作品の概要文');
  assert.equal(back.meta.meetingDay, '木');
  const w1 = back.weeks.find((w) => w.key === 'w01');
  assert.equal(w1.progress, '進捗文');
  assert.equal(w1.issue, '問題点文');
  assert.equal(w1.plan, '予定文');
  assert.equal(w1.absentees, 'なし');
  assert.match(w1.workedAt, /10月2日/);
  assert.equal(filledWeeks(back).length, 1);
});

test('空テンプレートを読むとプレースホルダーは空扱い', async () => {
  const wb = XLSX.read(templateBuf, { type: 'buffer' });
  const doc = workbookToDocument(wb, { XLSX });
  assert.equal(doc.meta.teamName, '');
  assert.equal(doc.meta.teamNumber, '');
  assert.equal(doc.meta.members.every((m) => m === ''), true);
  assert.equal(doc.weeks.every((w) => !w.progress && !w.issue && !w.plan), true);
});

test('documentToWorkbookArray が xlsx バイナリを返す', async () => {
  const r = createLocalReport({
    meta: { teamName: 'T', teamNumber: '2', overview: '概要' }
  });
  const arr = await documentToWorkbookArray(r);
  assert.ok(arr.byteLength > 1000 || arr.length > 1000);
  const wb = XLSX.read(arr, { type: 'array' });
  assert.ok(wb.SheetNames.includes('テンプレート'));
});

/** テンプレート xlsx のローカルヘッダを展開する（書式比較用）。 */
function unzipXlsx(buf) {
  const u8 = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  const out = new Map();
  let off = 0;
  const u16 = (o) => u8[o] | (u8[o + 1] << 8);
  const u32 = (o) => (u8[o] | (u8[o + 1] << 8) | (u8[o + 2] << 16) | (u8[o + 3] << 24)) >>> 0;
  while (off + 30 <= u8.length && u32(off) === 0x04034b50) {
    const method = u16(off + 8);
    const csize = u32(off + 18);
    const nlen = u16(off + 26);
    const elen = u16(off + 28);
    const name = new TextDecoder().decode(u8.subarray(off + 30, off + 30 + nlen));
    const start = off + 30 + nlen + elen;
    const compressed = u8.subarray(start, start + csize);
    const raw = method === 0 ? compressed : inflateRawSync(compressed);
    out.set(name, Buffer.from(raw));
    off = start + csize;
  }
  return out;
}

test('空の書き出しはテンプレートそのもの', async () => {
  const blank = await documentToWorkbookArray(createLocalReport({ meta: {} }));
  assert.ok(Buffer.from(blank).equals(templateBuf));
});

test('書き出しはテンプレートの書式・ふりがな・列幅を残す', async () => {
  const r = createLocalReport({
    meta: {
      teamName: '往復チーム',
      teamNumber: '07',
      overview: '概要\n2行目',
      meetingDay: '木',
      members: ['1年 太郎']
    },
    weeks: [{ key: 'w01', progress: '進捗文' }]
  });
  const out = unzipXlsx(await documentToWorkbookArray(r));
  const src = unzipXlsx(templateBuf);

  for (const [name, bytes] of src) {
    if (name === 'xl/worksheets/sheet1.xml' || name === 'xl/sharedStrings.xml') continue;
    assert.ok(out.get(name)?.equals(bytes), `テンプレートと違う: ${name}`);
  }

  const sheet = out.get('xl/worksheets/sheet1.xml').toString('utf8');
  const original = src.get('xl/worksheets/sheet1.xml').toString('utf8');
  assert.match(sheet, /mergeCells count="106"/);
  assert.match(sheet, /width="22\.83203125"/);
  assert.match(sheet, /ht="44\.5"/);
  // 進捗を書いたセルは元のスタイル番号 s="8" のまま
  assert.match(sheet, /<c r="D15" s="8" t="s"><v>\d+<\/v><\/c>/);
  // 空欄の欠席者は空のスタイル付きセルのまま
  assert.match(sheet, /<c r="D14" s="13"\/>/);
  // 触っていない見出しのふりがな定義は共有文字列に残る
  assert.match(out.get('xl/sharedStrings.xml').toString('utf8'), /<rPh /);
  assert.ok(original.includes('mergeCells count="106"'));

  const wb = XLSX.read(await documentToWorkbookArray(r), { type: 'array' });
  const doc = workbookToDocument(wb, { XLSX, id: r.id });
  assert.equal(doc.meta.teamName, '往復チーム');
  assert.equal(doc.meta.overview, '概要\n2行目');
  assert.equal(doc.meta.members[0], '1年 太郎');
  assert.equal(doc.weeks.find((w) => w.key === 'w01').progress, '進捗文');
  assert.equal(doc.meta.meetingDay, '木');
});

test('チーム行のパース', () => {
  assert.deepEqual(parseTeamLine('チーム: 10(未定)'), { number: '10', name: '未定' });
  assert.deepEqual(parseTeamLine('チーム：01：RYKT'), { number: '01', name: 'RYKT' });
  assert.deepEqual(parseTeamLine('チーム: 02-うめおにぎり'), { number: '02', name: 'うめおにぎり' });
  assert.deepEqual(parseTeamLine('07'), { number: '07', name: '' });
  assert.deepEqual(parseTeamLine(''), { number: '', name: '' });
});

test('プロフィールの保存と空欄埋めは入力を上書きしない', () => {
  assert.equal(hasProfile(), false);
  assert.equal(isProfileEmpty(blankProfile()), true);
  saveProfile({ teamName: '自チーム', members: ['1年 A'] });
  assert.equal(hasProfile(), true);
  const p = getProfile();
  assert.equal(p.teamName, '自チーム');
  const filled = fillProfileBlanks(p, {
    teamName: '上書きチーム', teamNumber: '03', members: ['1年 A', '1年 B']
  });
  assert.ok(!filled.includes('teamName'));
  assert.ok(filled.includes('teamNumber'));
  assert.ok(filled.includes('メンバー2'));
  assert.equal(p.teamName, '自チーム');
  assert.equal(p.members[1], '1年 B');
});

test('新規下書きはプロフィールの写しで始まる', () => {
  saveProfile({ teamName: 'T', teamNumber: '9', members: ['1年 A'] });
  const r = createLocalReport({ meta: profileToMeta(getProfile()) });
  assert.equal(r.meta.teamName, 'T');
  assert.equal(r.meta.members[0], '1年 A');
  assert.equal(documentTitle(r), '9-T-週報');
});

test('プロフィールの既存下書きへの反映は空欄だけ', () => {
  const r = createLocalReport({ meta: { teamName: '旧', overview: '' } });
  const n = applyProfileToDoc(r, {
    teamName: '新', teamNumber: '5', overview: '概要文', members: [], support: []
  });
  assert.equal(r.meta.teamName, '旧');
  assert.equal(r.meta.teamNumber, '5');
  assert.equal(r.meta.overview, '概要文');
  assert.ok(n >= 2);
});

test('ファイル名はテンプレート通り', async () => {
  const { documentFilename } = await import('./report-excel.js');
  assert.equal(
    documentFilename({ meta: { teamNumber: '01', teamName: 'RYKT' } }),
    '01-RYKT-週報.xlsx'
  );
  assert.equal(
    documentFilename({ meta: { teamNumber: '', teamName: '' } }),
    '[チーム番号]-[チーム名]-週報.xlsx'
  );
  assert.equal(
    documentFilename({ meta: { teamNumber: '02', teamName: '' } }),
    '02-[チーム名]-週報.xlsx'
  );
  assert.equal(
    documentFilename({ meta: { teamNumber: 'a/b', teamName: 'x:y' } }),
    'a_b-x_y-週報.xlsx'
  );
});
