/* 残り 5 画面のパーサを、実際に取得した HTML に対して検証する。
 *
 *   node --test test/parse-pages.test.mjs
 *
 * 見出し・リード文・列見出し・空状態の文言は実物
 * （clone/site/auth/*.html）で確かめる。一覧はどれも実物では 0 件で、
 * それがこのアカウントの真実なので「0 件であること」も検証する。
 *
 * 行・カード・項目の構造は実物に 1 件も無いため、実 HTML の器に合成した
 * 中身を差し込んで確かめる。この差分は parse-pages.js に明記してある。
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  parseUser, parseDashboard, parseOrders, parseOrderRows,
  parseEquipments, parseLoans, parseNotifications, toNumber
} from '../src/parse-pages.js';

const here = dirname(fileURLToPath(import.meta.url));
const auth = (name) => readFileSync(join(here, '../../clone/site/auth/', name), 'utf8');

const dashboard = auth('dashboard.html');
const orders = auth('orders.html');
const equipments = auth('equipments.html');
const loans = auth('loans.html');
const notifications = auth('notifications.html');

// ── nav（実 HTML で検証済み） ──

test('実 HTML の nav から利用者を取れる', () => {
  assert.deepEqual(parseUser(dashboard), { name: '三谷 慧介', badge: 'U' });
});

test('nav はどの画面でも同じなので他の画面からも取れる', () => {
  for (const html of [orders, equipments, loans, notifications]) {
    assert.deepEqual(parseUser(html), { name: '三谷 慧介', badge: 'U' });
  }
});

test('nav が無ければ利用者は null（作らない）', () => {
  assert.deepEqual(parseUser('<html><body><h1>調整中</h1></body></html>'),
    { name: null, badge: null });
});

// ── ダッシュボード（実 HTML で検証済み） ──

test('実 HTML からダッシュボードの 3 行を取れる', () => {
  assert.deepEqual(parseDashboard(dashboard), {
    heading: 'ダッシュボード',
    team: 'チーム: 10(未定)',
    notice: '調整中'
  });
});

// ── 注文 ──

test('実 HTML から注文の列見出しを 6 つ取れる', () => {
  assert.deepEqual(parseOrders(orders).columns.map((c) => c.label),
    ['商品', '単価', '数量', '合計', 'ステータス', '作成日']);
});

test('実 HTML から注文の空状態の文言を取れる', () => {
  assert.deepEqual(parseOrders(orders).empty, {
    title: '注文がありません',
    body: '新しい注文を作成して始めましょう。'
  });
});

test('実 HTML の注文は 0 件（取得したアカウントに注文が無い）', () => {
  assert.equal(parseOrders(orders).orders.length, 0);
});

// 行の構造は実物に無いので、実 HTML の tbody に合成して確かめる
const SYNTHETIC_ORDER_ROWS = `
  <tr id="order_12" class="hover">
    <td class="py-4 px-6">USB ケーブル 2m</td>
    <td class="py-4 px-6">¥1,200</td>
    <td class="py-4 px-6">2</td>
    <td class="py-4 px-6">¥2,400</td>
    <td class="py-4 px-6"><span class="badge">承認待ち</span></td>
    <td class="py-4 px-6">2026/08/01</td>
  </tr>
  <tr class="hover">
    <td class="py-4 px-6">見積り中の部品</td>
    <td class="py-4 px-6">お問い合わせください</td>
    <td class="py-4 px-6">—</td>
    <td class="py-4 px-6">未定</td>
    <td class="py-4 px-6"><span class="badge">✓ 承認済み</span></td>
    <td class="py-4 px-6">2026/07/28</td>
  </tr>
`;

const populatedOrders = orders.replace(
  /(<tbody\b[^>]*>)([\s\S]*?)(<\/tbody>)/,
  (_all, open, _inner, close) => `${open}${SYNTHETIC_ORDER_ROWS}${close}`
);

test('注文の行を取れる（合成した行で検証）', () => {
  const parsed = parseOrders(populatedOrders);
  assert.equal(parsed.orders.length, 2);

  const [first] = parsed.orders;
  assert.equal(first.id, 12);
  assert.equal(first.product, 'USB ケーブル 2m');
  assert.equal(first.unitPrice, '¥1,200');
  assert.equal(first.quantity, '2');
  assert.equal(first.total, '¥2,400');
  assert.equal(first.status, '承認待ち');
  assert.equal(first.createdAt, '2026/08/01');
  assert.equal(first.createdAtISO, '2026-08-01');
  assert.equal(first.unitPriceValue, 1200);
  assert.equal(first.quantityValue, 2);
  assert.equal(first.totalValue, 2400);
  assert.deepEqual(first.cells,
    ['USB ケーブル 2m', '¥1,200', '2', '¥2,400', '承認待ち', '2026/08/01']);
});

test('金額が読めない行では null になる（0 や NaN を作らない）', () => {
  const [, second] = parseOrders(populatedOrders).orders;
  assert.equal(second.id, null);              // id="order_<id>" が無い行
  assert.equal(second.unitPriceValue, null);
  assert.equal(second.quantityValue, null);
  assert.equal(second.totalValue, null);
  assert.equal(second.unitPrice, 'お問い合わせください');
});

test('注文のステータスは先頭装飾だけ落として素通し', () => {
  const [, second] = parseOrders(populatedOrders).orders;
  assert.equal(second.status, '承認済み');
});

test('注文の UUID 行 id と現行ステータス絵文字を取れる', () => {
  const uuidRows = `
  <tr id="order_3ef519cc-d396-47e9-bd62-51d8e095562e">
    <td>USB 変換</td><td>¥562</td><td>1</td><td>¥562</td>
    <td><span>⏳ 保留中</span></td><td>2026/10/01 16:19</td>
  </tr>
  <tr id="order_cbaa3201-bdf3-4768-9987-3b51eca518ea">
    <td>サーバ</td><td>¥14,800</td><td>1</td><td>¥14,800</td>
    <td><span>📋 注文済み</span></td><td>2026/09/15 20:32</td>
  </tr>
  <tr id="order_4e6fec2a-085a-4928-b85b-0c004eb0fc30">
    <td>部品</td><td>¥100</td><td>2</td><td>¥200</td>
    <td><span>✅ 受取済み</span></td><td>2026/09/01</td>
  </tr>`;
  const html = orders.replace(
    /(<tbody\b[^>]*>)([\s\S]*?)(<\/tbody>)/,
    (_all, open, _inner, close) => `${open}${uuidRows}${close}`
  );
  const parsed = parseOrders(html);
  assert.equal(parsed.orders.length, 3);
  assert.equal(parsed.orders[0].id, '3ef519cc-d396-47e9-bd62-51d8e095562e');
  assert.equal(parsed.orders[0].status, '保留中');
  assert.equal(parsed.orders[1].status, '注文済み');
  assert.equal(parsed.orders[2].status, '受取済み');
});

test('行があっても列見出しと空状態は壊れない', () => {
  const parsed = parseOrders(populatedOrders);
  assert.equal(parsed.columns.length, 6);
  assert.equal(parsed.empty.title, '注文がありません');
});

test('tbody が無ければ行は 0 件', () => {
  assert.deepEqual(parseOrderRows('<table></table>', []), []);
});

test('金額と数量を数値にできる。読めなければ null', () => {
  assert.equal(toNumber('¥1,200'), 1200);
  assert.equal(toNumber('￥1,200'), 1200);
  assert.equal(toNumber('1,200円'), 1200);
  assert.equal(toNumber('2'), 2);
  assert.equal(toNumber('¥0'), 0);            // 0 は「読めた 0」
  assert.equal(toNumber('—'), null);
  assert.equal(toNumber('未定'), null);
  assert.equal(toNumber('¥1,200（税込）'), null);
  assert.equal(toNumber(''), null);
  assert.equal(toNumber(null), null);
});

// ── 機材 ──

test('実 HTML から機材の見出しとリード文と空状態を取れる', () => {
  const parsed = parseEquipments(equipments);
  assert.equal(parsed.heading, '利用可能な機材');
  assert.equal(parsed.lede, '貸出申請可能な機材一覧');
  // この画面の空状態に <h3> は無く、<p class="text-gray-500 text-lg"> だけ
  assert.deepEqual(parsed.empty, { text: '現在利用可能な機材はありません。' });
});

test('実 HTML の機材は 0 件（grid が空）', () => {
  assert.equal(parseEquipments(equipments).equipments.length, 0);
});

// カードの構造は実物に無いので、実 HTML の grid に合成して確かめる
const SYNTHETIC_EQUIPMENT_CARDS = `
  <div id="equipment_7" class="bg-white rounded-lg shadow p-6">
    <h3 class="text-lg font-medium text-gray-900">オシロスコープ</h3>
    <p class="text-sm text-gray-500">在庫 2 台 / 実験室 A</p>
    <div class="mt-4">
      <a class="text-blue-600" href="/loans/new?equipment_id=7">貸出申請</a>
    </div>
  </div>
  <div class="bg-white rounded-lg shadow p-6">
    <h3 class="text-lg font-medium text-gray-900">はんだごて</h3>
    <p class="text-sm text-gray-500">在庫 0 台</p>
  </div>
`;

const populatedEquipments = equipments.replace(
  /(<div class="grid[^"]*">)([\s\S]*?)(<\/div>)/,
  (_all, open, _inner, close) => `${open}${SYNTHETIC_EQUIPMENT_CARDS}${close}`
);

test('機材のカードを取れる（合成したカードで検証）', () => {
  const parsed = parseEquipments(populatedEquipments);
  assert.equal(parsed.equipments.length, 2);

  assert.deepEqual(parsed.equipments[0], {
    id: 7,
    name: 'オシロスコープ',
    meta: '在庫 2 台 / 実験室 A',
    action: { label: '貸出申請', href: '/loans/new?equipment_id=7' }
  });

  // id もリンクも無いカードは null を返す（作らない）
  assert.deepEqual(parsed.equipments[1], {
    id: null,
    name: 'はんだごて',
    meta: '在庫 0 台',
    action: null
  });
});

// ── 貸出 ──

test('実 HTML から貸出の見出しと 2 つの節を取れる', () => {
  const parsed = parseLoans(loans);
  assert.equal(parsed.heading, '機材貸出');
  assert.equal(parsed.lede, 'チームの現在と過去の機材貸出を確認できます');
  assert.deepEqual(parsed.sections, [
    { key: 'pending', title: '申請中', empty: '申請中の貸出はありません。', items: [] },
    { key: 'active', title: '貸出中', empty: 'アクティブな貸出はありません。', items: [] }
  ]);
});

test('描画されていない「最近の返却」は作らない', () => {
  assert.equal(parseLoans(loans).sections.length, 2);
  assert.ok(!parseLoans(loans).sections.some((s) => s.key === 'returned'));
});

test('「最近の返却」が出てきたら returned として拾う', () => {
  // 実 HTML にはコメント `<!-- 最近の返却 -->` だけがあり、中身は描画されない。
  const withReturned = loans.replace('<!-- 最近の返却 -->', `
  <div class="mt-8">
    <h2 class="text-lg font-medium text-gray-900 mb-4">最近の返却</h2>
    <div class="text-center py-8">
      <div class="text-sm text-gray-500">最近の返却はありません。</div>
    </div>
  </div>`);

  const parsed = parseLoans(withReturned);
  assert.equal(parsed.sections.length, 3);
  assert.deepEqual(parsed.sections[2], {
    key: 'returned', title: '最近の返却', empty: '最近の返却はありません。', items: []
  });
});

test('知らない見出しは section-<n> に落とす', () => {
  const renamed = loans.replace('>貸出中</h2>', '>返却待ち</h2>');
  const parsed = parseLoans(renamed);
  assert.equal(parsed.sections[0].key, 'pending');
  assert.equal(parsed.sections[1].key, 'section-1');
  assert.equal(parsed.sections[1].title, '返却待ち');
});

// 項目の構造は実物に無いので、実 HTML の空メッセージを差し替えて確かめる
const populatedLoans = loans
  .replace('<div class="text-sm text-gray-500">申請中の貸出はありません。</div>', `
    <ul class="divide-y divide-gray-200">
      <li id="loan_31" class="py-4">
        <h3 class="text-sm font-medium text-gray-900">オシロスコープ</h3>
        <p class="text-sm text-gray-500">申請日 2026/08/01 / 三谷 慧介</p>
      </li>
    </ul>`)
  .replace('<div class="text-sm text-gray-500">アクティブな貸出はありません。</div>', `
    <ul class="divide-y divide-gray-200">
      <li class="py-4">
        <h3 class="text-sm font-medium text-gray-900">はんだごて</h3>
        <p class="text-sm text-gray-500">返却期限 2026/08/10</p>
      </li>
    </ul>`);

test('貸出の項目を取れる（合成した項目で検証）', () => {
  const parsed = parseLoans(populatedLoans);

  const pending = parsed.sections[0];
  assert.equal(pending.key, 'pending');
  assert.equal(pending.empty, null);          // 項目があるときは空メッセージを出さない
  assert.deepEqual(pending.items, [
    { id: 31, name: 'オシロスコープ', meta: '申請日 2026/08/01 / 三谷 慧介' }
  ]);

  // id="loan_<id>" が無ければ <li> を数え、id は null にする
  assert.deepEqual(parsed.sections[1].items, [
    { id: null, name: 'はんだごて', meta: '返却期限 2026/08/10' }
  ]);
});

// ── 通知 ──

test('実 HTML から通知の見出しと空状態を取れる', () => {
  const parsed = parseNotifications(notifications);
  assert.equal(parsed.heading, '通知');
  assert.equal(parsed.unreadText, null);      // #unread_count_display が空
  assert.deepEqual(parsed.empty, {
    title: '通知はありません',
    body: '新しい通知が届くとここに表示されます。'
  });
});

test('実 HTML の通知は 0 件（取得したアカウントに通知が無い）', () => {
  assert.equal(parseNotifications(notifications).notifications.length, 0);
});

// 項目の構造は実物に無いので、実 HTML の器に合成して確かめる
const SYNTHETIC_NOTIFICATIONS = `
  <ul class="divide-y divide-gray-200">
    <li data-notification-id="42" class="px-4 py-4">
      <h3 class="text-sm font-medium text-gray-900">週報の締め切りが近づいています</h3>
      <p class="text-sm text-gray-500">第14週の週報は 08/05 までに提出してください。</p>
      <time datetime="2026-08-01T09:30:00+09:00">2026/08/01 09:30</time>
      <button data-notification-read data-notification-id="42">既読にする</button>
    </li>
    <li id="notification_41" data-read="true" class="px-4 py-4">
      <h3 class="text-sm font-medium text-gray-900">貸出が承認されました</h3>
      <p class="text-sm text-gray-500">オシロスコープの貸出申請が承認されました。 2026/07/30</p>
    </li>
  </ul>
`;

const populatedNotifications = notifications
  .replace(/(<div class="bg-white shadow overflow-hidden sm:rounded-md">)([\s\S]*?)(\n  <\/div>)/,
    (_all, open, _inner, close) => `${open}${SYNTHETIC_NOTIFICATIONS}${close}`)
  .replace('<div id="unread_count_display">',
    '<div id="unread_count_display"><p class="text-sm text-gray-600">未読 1 件</p>');

test('通知の項目を取れる（合成した項目で検証）', () => {
  const parsed = parseNotifications(populatedNotifications);
  assert.equal(parsed.unreadText, '未読 1 件');
  assert.equal(parsed.notifications.length, 2);

  // 印は公開 JS が見ている data-notification-id。<time> があれば日時はそこから。
  // data-notification-read ボタンがあれば未読と分かる。
  assert.deepEqual(parsed.notifications[0], {
    id: 42,
    title: '週報の締め切りが近づいています',
    body: '第14週の週報は 08/05 までに提出してください。',
    at: '2026/08/01 09:30',
    atISO: '2026-08-01',
    read: false
  });

  // id="notification_<id>" でも拾える。<time> が無ければ本文中の日付を使う。
  assert.deepEqual(parsed.notifications[1], {
    id: 41,
    title: '貸出が承認されました',
    body: 'オシロスコープの貸出申請が承認されました。',
    at: '2026/07/30',
    atISO: '2026-07-30',
    read: true
  });
});

// ── 見つからないときの振る舞い ──

test('見つからない項目は null（形を埋めるために値を作らない）', () => {
  const blank = '<main></main>';
  assert.deepEqual(parseDashboard(blank), { heading: null, team: null, notice: null });
  assert.deepEqual(parseOrders(blank), { columns: [], empty: null, orders: [] });
  assert.deepEqual(parseEquipments(blank),
    { heading: null, lede: null, empty: null, equipments: [] });
  assert.deepEqual(parseLoans(blank), { heading: null, lede: null, sections: [] });
  assert.deepEqual(parseNotifications(blank),
    { heading: null, unreadText: null, empty: null, notifications: [] });
});

test('通知 id が UUID でも拾える', () => {
  const uuid = '8b293839-a910-4bd6-b468-4915b9cefd19';
  const html = notifications.replace(
    /(<div class="bg-white shadow overflow-hidden sm:rounded-md">)([\s\S]*?)(\n  <\/div>)/,
    (_all, open, _inner, close) => `${open}
    <ul>
      <li data-notification-id="${uuid}" data-read="false">
        <h3>週報の提出期限です</h3>
        <p>10/01 の週報を提出してください。</p>
      </li>
    </ul>${close}`
  );
  const items = parseNotifications(html).notifications;
  assert.equal(items.length, 1);
  assert.equal(items[0].id, uuid);
  assert.equal(items[0].read, false);
  assert.equal(items[0].title, '週報の提出期限です');
});

test('印の無い通知は器の <li> から拾い、id は null にする', () => {
  const unmarked = notifications.replace(
    /(<div class="bg-white shadow overflow-hidden sm:rounded-md">)([\s\S]*?)(\n  <\/div>)/,
    (_all, open, _inner, close) => `${open}
    <ul class="divide-y divide-gray-200">
      <li class="px-4 py-4">
        <h3 class="text-sm font-medium text-gray-900">お知らせ</h3>
        <p class="text-sm text-gray-500">本文</p>
      </li>
    </ul>${close}`
  );

  assert.deepEqual(parseNotifications(unmarked).notifications, [
    { id: null, title: 'お知らせ', body: '本文', at: null, atISO: null, read: null }
  ]);
});
