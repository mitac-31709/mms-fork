/* パーサを、実際に取得した HTML に対して検証する。
 *
 *   node --test test/parse.test.mjs
 *
 * 集計・列見出し・行は実物（clone/site/auth/reports.html）で確かめる。
 * 詳細の本文項目は `/reports/:id/edit`、タイトルは `/reports/:id`。
 * 数字 id の行は実 HTML の tbody に合成して、従来の形も壊していないことを見る。
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  parseReportsPage, parseCounts, parseColumns, parseEmptyState,
  parseRows, parseReportDetail, parseOrderHistory, extractSidePanel, toIso, splitRange,
  looksLikeSignIn, authenticityToken, text, parseIdToken
} from '../src/parse.js';

const here = dirname(fileURLToPath(import.meta.url));
const REPORTS = join(here, '../../clone/site/auth/reports.html');
const SIGN_IN = join(here, '../../clone/site/public/users/sign_in.html');
const LIVE_ID = '8b293839-a910-4bd6-b468-4915b9cefd19';
const REPORT_SHOW = join(here, `../../clone/site/auth/reports/${LIVE_ID}.html`);
const REPORT_EDIT = join(here, `../../clone/site/auth/reports/${LIVE_ID}/edit.html`);

const html = readFileSync(REPORTS, 'utf8');
const signInHtml = readFileSync(SIGN_IN, 'utf8');
const showHtml = readFileSync(REPORT_SHOW, 'utf8');
const editHtml = readFileSync(REPORT_EDIT, 'utf8');

test('実 HTML から列見出しを 5 つ取れる', () => {
  const columns = parseColumns(html);
  assert.deepEqual(columns.map((c) => c.label),
    ['タイトル', '期間', 'ステータス', '期限', '作成日']);
});

test('実 HTML から集計を取れる', () => {
  assert.deepEqual(parseCounts(html), { 未完了: 1, 完了: 0, 合計: 1 });
});

test('行がある実 HTML には空状態の見出しが無い', () => {
  assert.equal(parseEmptyState(html), null);
});

test('空状態の文言を取れる（見出しと本文の組）', () => {
  const emptyHtml = '<h3>週報がありません</h3>\n'
    + '<p>管理者によって新しいレポートの締め切りが設定されると、ここにレポートが表示されます。</p>';
  assert.deepEqual(parseEmptyState(emptyHtml), {
    title: '週報がありません',
    body: '管理者によって新しいレポートの締め切りが設定されると、ここにレポートが表示されます。'
  });
});

test('実 HTML の行は UUID の 1 件', () => {
  const parsed = parseReportsPage(html);
  assert.equal(parsed.reports.length, 1);
  const row = parsed.reports[0];
  assert.equal(row.id, LIVE_ID);
  assert.equal(row.title, '10/01のレポート');
  assert.equal(row.subtitle, '10: (未定)');
  assert.equal(row.period, '期間未設定');
  assert.equal(row.status, '未完了');
  assert.equal(row.due, '2026/10/01 17:00');
  assert.equal(row.createdAt, '2026/08/24 13:48');
  assert.equal(row.dueISO, '2026-10-01');
  assert.equal(row.createdAtISO, '2026-08-24');
  assert.equal(row.periodStartISO, null);
  assert.equal(row.periodEndISO, null);
});

test('parseIdToken は数字と UUID を分け、card_ を捨てる', () => {
  assert.equal(parseIdToken('114'), 114);
  assert.equal(parseIdToken(LIVE_ID), LIVE_ID);
  assert.equal(parseIdToken(LIVE_ID.toUpperCase()), LIVE_ID);
  assert.equal(parseIdToken('card_' + LIVE_ID), null);
  assert.equal(parseIdToken('new'), null);
});

test('ログイン画面を判別できる', () => {
  assert.equal(looksLikeSignIn(signInHtml), true);
  assert.equal(looksLikeSignIn(html), false);
});

test('authenticity_token を取り出せる', () => {
  const token = authenticityToken(signInHtml);
  assert.equal(typeof token, 'string');
  assert.ok(token.length > 40, `token が短い: ${token}`);
});

test('注文フォームの authenticity_token はログアウト用と別（per-form CSRF）', () => {
  const ordersNew = readFileSync(
    join(here, '../../clone/site/auth/orders/new.html'), 'utf8'
  );
  const first = authenticityToken(ordersNew);
  const forOrders = authenticityToken(ordersNew, { formAction: '/orders' });
  const forLogout = authenticityToken(ordersNew, { formAction: '/users/sign_out' });

  assert.equal(typeof forOrders, 'string');
  assert.ok(forOrders.length > 40);
  assert.equal(typeof forLogout, 'string');
  assert.ok(forLogout.length > 40);
  assert.notEqual(forOrders, forLogout,
    '注文フォームとログアウトで同じトークンだと per-form CSRF を見誤る');
  // 先頭一致はログアウト側（ナビが先にある）
  assert.equal(first, forLogout);
});

test('value が name より前でも authenticity_token を取れる', () => {
  const html = '<form action="/orders" method="post">'
    + '<input type="hidden" value="TOKEN_VALUE_HERE_PADDED_XXX" name="authenticity_token" />'
    + '</form>';
  assert.equal(authenticityToken(html, { formAction: '/orders' }),
    'TOKEN_VALUE_HERE_PADDED_XXX');
});

test('日付を ISO に寄せられる', () => {
  assert.equal(toIso('2026/08/05'), '2026-08-05');
  assert.equal(toIso('2026-8-5'), '2026-08-05');
  assert.equal(toIso('2026年8月5日'), '2026-08-05');
  assert.equal(toIso('08/05'), null);              // 年が無いので補えない
  assert.equal(toIso('08/05', '2026'), '2026-08-05');
  assert.equal(toIso(''), null);
});

test('期間の両端を分けられる', () => {
  assert.deepEqual(splitRange('05/04 – 05/10'), ['05/04', '05/10']);
  assert.deepEqual(splitRange('2026/05/04 - 2026/05/10'), ['2026/05/04', '2026/05/10']);
  assert.deepEqual(splitRange(''), [null, null]);
});

test('タグを落としてテキストにできる', () => {
  assert.equal(text('<span class="a">✓ 完了</span>'), '✓ 完了');
  assert.equal(text('<td>\n  2026/08/05\n  <span>△ 本日締切</span>\n</td>'),
    '2026/08/05 △ 本日締切');
});

// ── 行の構造は実物に無いので、実 HTML の tbody に合成して確かめる ──
const SYNTHETIC_ROWS = `
  <tr id="report_114" class="hover">
    <td class="py-4 px-6"><a href="/reports/114">第14週 週報</a></td>
    <td class="py-4 px-6">07/27 – 08/02</td>
    <td class="py-4 px-6"><span class="badge">未完了</span></td>
    <td class="py-4 px-6">2026/08/05</td>
    <td class="py-4 px-6">2026/07/28</td>
  </tr>
  <tr id="report_113" class="hover">
    <td class="py-4 px-6"><a href="/reports/113">第13週 週報</a></td>
    <td class="py-4 px-6">07/20 – 07/26</td>
    <td class="py-4 px-6"><span class="badge">完了</span></td>
    <td class="py-4 px-6">2026/07/29</td>
    <td class="py-4 px-6">2026/07/21</td>
  </tr>
`;

const populated = html.replace(
  /(<tbody\b[^>]*>)([\s\S]*?)(<\/tbody>)/,
  (_all, open, _inner, close) => `${open}${SYNTHETIC_ROWS}${close}`
);

test('行を取れる（合成した行で検証）', () => {
  const parsed = parseReportsPage(populated);
  assert.equal(parsed.reports.length, 2);

  const [first, second] = parsed.reports;
  assert.equal(first.id, 114);
  assert.equal(first.title, '第14週 週報');
  assert.equal(first.period, '07/27 – 08/02');
  assert.equal(first.status, '未完了');
  assert.equal(first.due, '2026/08/05');
  assert.equal(first.createdAt, '2026/07/28');
  assert.equal(first.dueISO, '2026-08-05');
  assert.equal(first.createdAtISO, '2026-07-28');
  // 期間は年を省いた表記。期限の年で補う。
  assert.equal(first.periodStartISO, '2026-07-27');
  assert.equal(first.periodEndISO, '2026-08-02');

  assert.equal(second.id, 113);
  assert.equal(second.status, '完了');
});

test('行があっても集計と列見出しは壊れない', () => {
  const parsed = parseReportsPage(populated);
  assert.deepEqual(parsed.counts, { 未完了: 1, 完了: 0, 合計: 1 });
  assert.equal(parsed.columns.length, 5);
});

test('ステータスの前に付くグリフを落とす', () => {
  const withGlyph = html.replace(
    /(<tbody\b[^>]*>)([\s\S]*?)(<\/tbody>)/,
    (_a, open, _b, close) => `${open}
      <tr id="report_1">
        <td>第1週 週報</td><td>04/06 – 04/12</td>
        <td><span>✓ 完了</span></td><td>2026/04/15</td><td>2026/04/07</td>
      </tr>${close}`
  );
  assert.equal(parseRows(withGlyph, parseColumns(withGlyph))[0].status, '完了');
});

// ── 詳細。実 HTML が無いので Stimulus の印に合わせた合成 HTML で検証する ──
const SYNTHETIC_DETAIL = `
<html><body>
<main>
  <turbo-frame id="side_panel">
    <div data-controller="collaborative-edit"
         data-collaborative-edit-report-id-value="114"
         data-collaborative-edit-current-user-id-value="1"
         data-collaborative-edit-current-user-name-value="三谷 慧介"
         data-collaborative-edit-initial-locks-value="[{&quot;field_name&quot;:&quot;next_week&quot;,&quot;user_id&quot;:2,&quot;user_name&quot;:&quot;岸 洋輔&quot;}]">
      <h2>第14週 週報</h2>
      <dl>
        <dt>期間</dt><dd>07/27 – 08/02</dd>
        <dt>ステータス</dt><dd>未完了</dd>
        <dt>期限</dt><dd>2026/08/05</dd>
      </dl>
      <div>
        <label for="report_content">今週の活動</label>
        <textarea id="report_content" data-collaborative-edit-target="field"
                  data-field-name="content">位置決め精度の測定をやり直し中。</textarea>
      </div>
      <div>
        <label for="report_next_week">来週の予定</label>
        <textarea id="report_next_week" data-collaborative-edit-target="field"
                  data-field-name="next_week">検査データをまとめる。</textarea>
      </div>
      <div class="timeline">
        <div class="timeline-item">
          <time datetime="2026-07-28">2026/07/28</time>
          作成されました
        </div>
      </div>
    </div>
  </turbo-frame>
</main>
</body></html>
`;

test('詳細の Turbo Frame を切り出せる', () => {
  const inner = extractSidePanel(SYNTHETIC_DETAIL);
  assert.match(inner, /collaborative-edit/);
  assert.doesNotMatch(inner, /<main/);
});

test('詳細から項目・メタ・履歴・ロックを取れる（合成 HTML）', () => {
  const parsed = parseReportDetail(SYNTHETIC_DETAIL);
  assert.equal(parsed.id, 114);
  assert.equal(parsed.title, '第14週 週報');
  assert.deepEqual(parsed.meta.map((m) => m.label), ['期間', 'ステータス', '期限']);
  assert.equal(parsed.fields.length, 2);
  assert.equal(parsed.fields[0].name, 'content');
  assert.equal(parsed.fields[0].label, '今週の活動');
  assert.equal(parsed.fields[0].value, '位置決め精度の測定をやり直し中。');
  assert.equal(parsed.fields[1].name, 'next_week');
  assert.equal(parsed.fields[1].label, '来週の予定');
  assert.equal(parsed.fields[1].lockedBy, '岸 洋輔');
  assert.equal(parsed.lockedBy, '岸 洋輔');
  assert.equal(parsed.timeline.length, 1);
  assert.equal(parsed.timeline[0].atISO, '2026-07-28');
  assert.match(parsed.timeline[0].text, /作成/);
});

test('frame が無い詳細 HTML でも項目を取れる', () => {
  const parsed = parseReportDetail(`
    <h2>週報</h2>
    <label for="a">本文</label>
    <textarea id="a" data-field-name="content">hello &amp; world</textarea>
  `);
  assert.equal(parsed.fields[0].value, 'hello & world');
  assert.equal(parsed.fields[0].label, '本文');
});

test('実 HTML の編集画面から項目を取れる', () => {
  const parsed = parseReportDetail(editHtml);
  assert.equal(parsed.id, LIVE_ID);
  assert.equal(parsed.title, null); // 見出しは「週報編集」（画面名）
  assert.deepEqual(parsed.fields.map((f) => f.name),
    ['start_at', 'end_at', 'shortnote', 'progress', 'issue', 'plan']);
  assert.deepEqual(parsed.fields.map((f) => f.label),
    ['開始日', '終了日', '概要', '進捗', '課題', '計画']);
  assert.ok(parsed.meta.some((m) => m.label === '提出期限' && m.value === '2026/10/01 17:00'));
});

test('実 HTML の詳細画面は本文項目を持たずタイトルを返す', () => {
  const parsed = parseReportDetail(showHtml);
  assert.equal(parsed.id, LIVE_ID);
  assert.equal(parsed.title, '10/01のレポート');
  assert.equal(parsed.fields.length, 0);
  assert.ok(parsed.meta.some((m) => m.label === '提出期限'));
  assert.ok(parsed.meta.some((m) => m.label === '作業期間' && m.value === '期間未設定'));
});

// ── 注文ステータス履歴 ──
// 元アプリの注文詳細にある Timeline。週報の `.timeline-item` とは器が違う
//（`注文ステータス履歴` の見出し + `ml-4 flex-1` の塊）。

test('注文ステータス履歴の 2 段（太字タイトル + 細字補足）を順序のまま取る', () => {
  const html = `
    <h3>注文ステータス履歴</h3>
    <div class="ml-4 flex-1"><p class="font-bold">注文作成</p><p>2026/10/01 16:19</p></div>
    <div class="ml-4 flex-1"><p class="font-bold">注文承認</p><p>注文済み</p></div>`;
  assert.deepEqual(parseOrderHistory(html), [
    { title: '注文作成', detail: '2026/10/01 16:19' },
    { title: '注文承認', detail: '注文済み' }
  ]);
});

test('見出しが無ければ空（週報など履歴の無い画面）', () => {
  assert.deepEqual(parseOrderHistory('<main><h1>週報</h1></main>'), []);
});

test('履歴の後のコメント節は範囲外', () => {
  const html = `
    <h3>注文ステータス履歴</h3>
    <div class="ml-4 flex-1"><p>注文作成</p><p>2026/10/01</p></div>
    <!-- Comments -->
    <div class="ml-4 flex-1"><p>コメント投稿</p><p>本文</p></div>`;
  assert.deepEqual(parseOrderHistory(html), [
    { title: '注文作成', detail: '2026/10/01' }
  ]);
});
