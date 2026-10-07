/* TA 画面パーサの検証。
 *
 *   node --test test/parse-ta.test.mjs
 *
 * 実 HTML は /tmp/live_ta_*.html（取得済み）があればそれを使い、
 * 無ければ合成 HTML で構造だけ確かめる。
 */

import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { test } from 'node:test';

import {
  parseTaDashboard, parseTaOrderDetail, parseTaOrders, parseTaReports,
  parseTaTeams, parseTaUsers, parseUserWithMode, parseViewMode
} from '../src/parse-ta.js';

const live = (name) => {
  const p = `/tmp/${name}`;
  return existsSync(p) ? readFileSync(p, 'utf8') : null;
};

test('ビューモード: TA ナビとバッジから ta と判定する', () => {
  const html = `
    <html><body>
      <span>TAモード</span>
      <a href="/ta/orders">注文</a>
      <form action="/view_mode/switch"><input name="mode" value="student"></form>
    </body></html>`;
  assert.deepEqual(parseViewMode(html), {
    mode: 'ta', badge: 'TAモード', canSwitch: true, canTa: true
  });
});

test('ビューモード: 学生ナビから student と判定する', () => {
  const html = `<a href="/orders">注文</a><a href="/reports">週報</a>`;
  const v = parseViewMode(html);
  assert.equal(v.mode, 'student');
  assert.equal(v.canSwitch, false);
});

const ordersHtml = live('live_ta_orders.html');
if (ordersHtml) {
  test('実 HTML から TA 注文を取れる', () => {
    const parsed = parseTaOrders(ordersHtml);
    assert.equal(parsed.heading, '注文管理');
    assert.ok(parsed.orders.length >= 1);
    const first = parsed.orders[0];
    assert.match(String(first.id), /^[0-9a-f-]{36}$/i);
    assert.ok(first.product);
    assert.ok(first.team);
    assert.ok(!/^\d+\s/.test(first.team), `チームにアバター数字が混ざる: ${first.team}`);
    assert.ok(ORDER_OK.has(first.status), first.status);
    assert.equal(typeof first.unitPriceValue, 'number');
    assert.equal(typeof first.quantityValue, 'number');
  });

  test('実 HTML の利用者は TA モード', () => {
    const user = parseUserWithMode(ordersHtml);
    assert.equal(user.mode, 'ta');
    assert.equal(user.canSwitch, true);
    assert.ok(user.name);
  });
}

const ORDER_OK = new Set(['保留中', '注文済み', '受取可能', '受取済み', 'キャンセル済み']);

const detailHtml = live('ta_order_details.html');
if (detailHtml) {
  test('実 HTML から TA 注文詳細を取れる', () => {
    const d = parseTaOrderDetail(detailHtml);
    assert.match(String(d.id), /^[0-9a-f-]{36}$/i);
    assert.ok(d.product);
    assert.ok(ORDER_OK.has(d.status), d.status);
    assert.ok(d.fields['単価']);
    assert.ok(d.fields['ショップ名']);
  });

  test('実 HTML から TA 注文の履歴を順序のまま取れる', () => {
    const d = parseTaOrderDetail(detailHtml);
    assert.ok(Array.isArray(d.history));
    assert.ok(d.history.length >= 1);
    assert.equal(d.history[0].title, '注文作成');
  });
}

test('合成した TA 注文詳細から履歴を取れる', () => {
  const html = `
    <turbo-frame id="side_panel">
      <h2 class="text-2xl font-bold">部品A</h2>
      <span class="rounded-full">受取可能</span>
      <div><label>単価</label><p>¥100</p></div>
      <h3>注文ステータス履歴</h3>
      <div class="ml-4 flex-1"><p>注文作成</p><p>2026/10/06 22:36</p></div>
      <div class="ml-4 flex-1"><p>注文承認</p><p>注文済み</p></div>
    </turbo-frame>`;
  const d = parseTaOrderDetail(html);
  assert.equal(d.product, '部品A');
  assert.equal(d.status, '受取可能');
  assert.deepEqual(d.history, [
    { title: '注文作成', detail: '2026/10/06 22:36' },
    { title: '注文承認', detail: '注文済み' }
  ]);
});

const reportsHtml = live('live_ta_reports_sub.html') || live('live_ta_reports.html');
if (reportsHtml) {
  test('実 HTML から TA 週報と締切カードを取れる', () => {
    const parsed = parseTaReports(reportsHtml);
    assert.equal(parsed.heading, '週報一覧');
    assert.ok(Array.isArray(parsed.submissions));
    if (parsed.submissions.length) {
      assert.ok(parsed.submissions[0].id);
      assert.ok(parsed.submissions[0].label);
    }
  });
}

const teamsHtml = live('live_ta_teams.html');
if (teamsHtml) {
  test('実 HTML からチーム一覧を取れる', () => {
    const parsed = parseTaTeams(teamsHtml);
    assert.equal(parsed.heading, 'チーム管理');
    assert.ok(parsed.teams.length >= 1);
    assert.ok(parsed.teams[0].id, 'チーム id が取れる');
    assert.ok(parsed.teams[0].name);
  });
}

const usersHtml = live('live_ta_users.html');
if (usersHtml) {
  test('実 HTML からユーザー一覧を取れる（アバターを名前に混ぜない）', () => {
    const parsed = parseTaUsers(usersHtml);
    assert.equal(parsed.heading, 'ユーザー一覧 (TA)');
    assert.ok(parsed.users.length >= 1);
    const u = parsed.users[0];
    assert.ok(u.id);
    assert.ok(u.name.length > 1, u.name);
    assert.ok(u.email?.includes('@'));
  });
}

const dashHtml = live('live_ta.html');
if (dashHtml) {
  test('実 HTML から TA ダッシュボードを取れる', () => {
    assert.deepEqual(parseTaDashboard(dashHtml), {
      heading: 'TAダッシュボード',
      team: null,
      notice: '調整中'
    });
  });
}

test('合成 HTML でも TA 注文行を読める', () => {
  const html = `
  <main>
    <h1>注文管理</h1>
    <table><thead><tr>
      <th></th><th>商品</th><th>チーム</th><th>単価</th><th>数量</th>
      <th>合計</th><th>ステータス</th><th>作成日時</th><th>操作</th>
    </tr></thead>
    <tbody>
      <tr id="order_530743d1-cf3d-44cc-a4d1-a1833b138aa6">
        <td><input type="checkbox" data-order-id="530743d1-cf3d-44cc-a4d1-a1833b138aa6"></td>
        <td><span class="text-blue-700 font-medium">部品A</span></td>
        <td><span>01: チーム</span></td>
        <td>¥100</td><td>2個</td><td>¥200</td>
        <td>注文済み</td><td>10/06 12:00</td><td></td>
      </tr>
    </tbody></table>
  </main>`;
  const parsed = parseTaOrders(html);
  assert.equal(parsed.orders.length, 1);
  assert.equal(parsed.orders[0].product, '部品A');
  assert.equal(parsed.orders[0].team, '01: チーム');
  assert.equal(parsed.orders[0].quantityValue, 2);
  assert.equal(parsed.orders[0].status, '注文済み');
});
