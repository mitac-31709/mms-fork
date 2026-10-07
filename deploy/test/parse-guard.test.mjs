/* パース想定外の検出と Discord 本文。ネットワークは使わない。 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, test } from 'node:test';

import { parseReportsPage, parseReportDetail } from '../src/parse.js';
import {
  parseDashboard, parseEquipments, parseLoans, parseNotifications, parseOrders
} from '../src/parse-pages.js';
import { parseTaOrderDetail } from '../src/parse-ta.js';
import {
  buildParseAlertPayload, expectationPath, htmlSnippet, inspectParse
} from '../src/parse-guard.js';
import { parseFormErrors } from '../src/meister.js';

const here = dirname(fileURLToPath(import.meta.url));
const auth = (name) => readFileSync(join(here, '../../clone/site/auth/', name), 'utf8');

describe('inspectParse · 実 HTML は想定どおり', () => {
  test('週報', () => {
    const html = auth('reports.html');
    const r = inspectParse('/reports', html, parseReportsPage(html));
    assert.equal(r.ok, true, r.reasons.join('; '));
  });

  test('週報詳細の編集画面', () => {
    const html = auth('reports/8b293839-a910-4bd6-b468-4915b9cefd19/edit.html');
    const r = inspectParse(
      '/reports/8b293839-a910-4bd6-b468-4915b9cefd19/edit',
      html,
      parseReportDetail(html)
    );
    assert.equal(r.ok, true, r.reasons.join('; '));
  });

  test('注文', () => {
    const html = auth('orders.html');
    const r = inspectParse('/orders', html, parseOrders(html));
    assert.equal(r.ok, true, r.reasons.join('; '));
  });

  test('ダッシュボード', () => {
    const html = auth('dashboard.html');
    const r = inspectParse('/dashboard', html, parseDashboard(html));
    assert.equal(r.ok, true, r.reasons.join('; '));
  });

  test('機材', () => {
    const html = auth('equipments.html');
    const r = inspectParse('/equipments', html, parseEquipments(html));
    assert.equal(r.ok, true, r.reasons.join('; '));
  });

  test('貸出', () => {
    const html = auth('loans.html');
    const r = inspectParse('/loans', html, parseLoans(html));
    assert.equal(r.ok, true, r.reasons.join('; '));
  });

  test('通知', () => {
    const html = auth('notifications.html');
    const r = inspectParse('/notifications', html, parseNotifications(html));
    assert.equal(r.ok, true, r.reasons.join('; '));
  });
});

describe('inspectParse · 週報詳細', () => {
  const detail = `
    <html><body><main>
    <turbo-frame id="side_panel">
      <h2>第14週 週報</h2>
      <label for="c">今週の活動</label>
      <textarea id="c" data-field-name="content">本文</textarea>
    </turbo-frame>
    </main></body></html>`;

  test('合成した詳細は想定どおり', () => {
    const r = inspectParse('/reports/114', detail, parseReportDetail(detail));
    assert.equal(r.ok, true, r.reasons.join('; '));
  });

  test('data-field-name が落ちたら理由を返す', () => {
    const parsed = parseReportDetail(detail);
    parsed.fields = [];
    const r = inspectParse('/reports/114', detail, parsed);
    assert.equal(r.ok, false);
    assert.match(r.reasons.join('\n'), /content/);
  });
});

describe('inspectParse · TA 注文詳細（Turbo Frame の断片）', () => {
  const path = '/ta/orders/530743d1-cf3d-44cc-a4d1-a1833b138aa6/details';
  const fragment = `
<turbo-frame id="side_panel"> <div class="h-full overflow-y-auto bg-white">
<div class="p-6 space-y-6"> <div class="flex justify-between items-center border-b border-gray-200 pb-4">
<h2 class="text-xl font-bold text-gray-900">注文詳細</h2> </div>
<div class="bg-gradient-to-br from-blue-50 to-purple-50 rounded-2xl p-6 pb-4 mb-6">
<div class="flex items-start justify-between mb-4"> <div>
<h2 class="text-2xl font-bold">アルミ丸棒 φ20</h2>
<span class="rounded-full">注文済み</span>
<a href="/ta/orders/530743d1-cf3d-44cc-a4d1-a1833b138aa6/edit">編集</a>
</div> </div> </div>
<div><label>単価</label><p>¥1,480</p></div>
<div><label>ショップ名</label><p>モノタロウ</p></div>
</div> </div>
</turbo-frame>`;

  test('details パスは注文詳細の想定に寄せる', () => {
    assert.equal(expectationPath(path), '/ta/orders/:id');
  });

  test('<main>/<body> の無い断片は正常', () => {
    const r = inspectParse(path, fragment, parseTaOrderDetail(fragment));
    assert.equal(r.ok, true, r.reasons.join('; '));
  });

  test('商品名が取れない断片は理由を返す', () => {
    const broken = fragment.replace(/<h2 class="text-2xl[^]*?<\/h2>/, '');
    const r = inspectParse(path, broken, parseTaOrderDetail(broken));
    assert.equal(r.ok, false);
    assert.match(r.reasons.join('\n'), /商品名/);
  });

  test('frame 自体が無い断片は器が無いとみなす', () => {
    const bare = '<div><p>ただの断片</p></div>'.repeat(20);
    const r = inspectParse(path, bare, parseTaOrderDetail(bare));
    assert.equal(r.ok, false);
    assert.match(r.reasons.join('\n'), /<main> も <body> も無い/);
  });
});

describe('inspectParse · 想定外を拾う', () => {
  test('列見出しが変わったら理由を返す', () => {
    const html = auth('orders.html').replaceAll('>商品<', '>品名<');
    const parsed = parseOrders(html);
    const r = inspectParse('/orders', html, parsed);
    assert.equal(r.ok, false);
    assert.match(r.reasons.join('\n'), /列見出し/);
  });

  test('空 HTML を拒む', () => {
    const r = inspectParse('/reports', '   ', {});
    assert.equal(r.ok, false);
    assert.match(r.reasons.join('\n'), /空/);
  });

  test('ログイン画面を想定外にする', () => {
    const html = '<html><body><main><form action="/users/sign_in">'
      + '<input name="user[password]"></form></main></body></html>';
    const r = inspectParse('/dashboard', html, parseDashboard(html));
    assert.equal(r.ok, false);
    assert.match(r.reasons.join('\n'), /ログイン画面/);
  });

  test('行のセル数が列と違う', () => {
    const html = auth('orders.html').replace(
      /(<tbody\b[^>]*>)([\s\S]*?)(<\/tbody>)/,
      '$1<tr id="order_1"><td>a</td><td>b</td></tr>$3'
    );
    const parsed = parseOrders(html);
    const r = inspectParse('/orders', html, parsed);
    assert.equal(r.ok, false);
    assert.match(r.reasons.join('\n'), /セル数/);
  });
});

describe('buildParseAlertPayload', () => {
  test('理由と抜粋を載せる', () => {
    const payload = buildParseAlertPayload({
      path: '/orders',
      origin: 'https://meister.tokyo-ct.org/orders',
      reasons: ['列見出しが想定と違う'],
      html: '<main><table><thead><th>意外</th></thead></table></main>'
    });
    assert.equal(payload.username, 'Meister Fork Parser');
    assert.match(payload.embeds[0].description, /列見出し/);
    assert.match(payload.embeds[0].description, /意外/);
  });

  test('authenticity_token を伏せる', () => {
    const snip = htmlSnippet('<input name="authenticity_token" value="SECRET_TOKEN_VALUE_HERE">');
    assert.doesNotMatch(snip, /SECRET_TOKEN/);
    assert.match(snip, /\[redacted\]/);
  });
});

describe('parseFormErrors', () => {
  test('error_explanation の li を拾う', () => {
    const html = `
      <div id="error_explanation">
        <h2>2 errors</h2>
        <ul><li>商品名を入力してください</li><li>単価は不正な値です</li></ul>
      </div>`;
    assert.deepEqual(parseFormErrors(html),
      ['商品名を入力してください', '単価は不正な値です']);
  });

  test('無ければ空', () => {
    assert.deepEqual(parseFormErrors('<html><body>ok</body></html>'), []);
  });
});
