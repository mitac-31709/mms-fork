/* Worker の API を、実際に動いているエンドポイントに対して検証する。
 *
 *   node --test test/api.test.mjs                          # 既定は wrangler dev
 *   BASE=https://... node --test test/api.test.mjs          # 本番に対して
 *
 * 元アプリに実際にログインするので資格情報が必要。環境変数から読む。
 *   MEISTER_EMAIL / MEISTER_PASSWORD（または Meister_MailAddress / Meister_Password）
 *
 * 認証は利用者ごと。Worker は資格情報を持たず、元アプリのセッション Cookie を
 * 暗号化して自ドメインの Cookie に入れるだけ。
 *
 * 取得したアカウントに週報がある場合は行の形と詳細も検証する。
 * 0 件なら空状態だけを見る。
 */

import assert from 'node:assert/strict';
import { before, describe, test } from 'node:test';

const BASE = (process.env.BASE || 'http://127.0.0.1:8788').replace(/\/$/, '');
const EMAIL = process.env.MEISTER_EMAIL || process.env.Meister_MailAddress;
const PASSWORD = process.env.MEISTER_PASSWORD || process.env.Meister_Password;

if (!EMAIL || !PASSWORD) {
  throw new Error('MEISTER_EMAIL / MEISTER_PASSWORD が必要です');
}

let cookie = null;

const get = (path, init = {}) => fetch(`${BASE}${path}`, {
  ...init,
  headers: {
    Accept: 'application/json',
    ...(cookie ? { Cookie: cookie } : {}),
    ...(init.headers || {})
  },
  redirect: 'manual'
});

/** セッションを送らない版。共有変数を書き換えないため別に持つ。 */
const getNoAuth = (path, init = {}) => fetch(`${BASE}${path}`, {
  ...init,
  headers: { Accept: 'application/json', ...(init.headers || {}) },
  redirect: 'manual'
});

const login = (email, password) => fetch(`${BASE}/api/session`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
  body: JSON.stringify({ email, password }),
  redirect: 'manual'
});

// 1 つのセッションを共有するので直列に走らせる。並行だと
// Cookie を使うテストと使わないテストが混ざって落ちる（本番で実際に踏んだ）。
describe('Worker API', { concurrency: 1 }, () => {

before(async () => {
  const res = await login(EMAIL, PASSWORD);
  assert.equal(res.status, 200, `ログインに失敗: ${await res.clone().text()}`);
  cookie = (res.headers.get('set-cookie') || '').split(';')[0];
});

test('/api/health は資格情報を持たず利用者ごとの認証だと報告する', async () => {
  const res = await fetch(`${BASE}/api/health`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(body.auth, 'per-user');
  assert.equal(body.sessionSecret, true, 'SESSION_SECRET が未設定');
  assert.equal(body.cache?.strategy, 'stale-while-revalidate');
  assert.equal(body.cache?.scope, 'per-session');
  assert.equal(body.notify?.discordProxy, true, 'Discord 中継の印が無い');
  assert.equal(typeof body.notify?.parseAlertWebhook, 'boolean',
    'パース異常通知 Webhook の有無が無い');
  assert.equal(body.credentials, undefined,
    'Worker が元アプリの資格情報を持ってしまっている');
});

test('セッション無しでは全ての取得口が 401', async () => {
  for (const path of ['/api/me', '/api/dashboard', '/api/reports', '/api/reports/1',
    '/api/orders',
    '/api/equipments', '/api/loans', '/api/notifications',
    '/api/notifications/unread_count']) {
    const res = await getNoAuth(path);
    assert.equal(res.status, 401, `${path} が ${res.status}`);
    assert.equal((await res.json()).code, 'unauthenticated', `${path} の code`);
  }
});

test('誤った資格情報は元アプリの文言をそのまま返す', async () => {
  const res = await login(EMAIL, 'definitely-not-the-password');
  assert.equal(res.status, 401);
  assert.match((await res.json()).error, /メールアドレスまたはパスワードが違います/);
  assert.equal(res.headers.get('set-cookie'), null, '失敗したのに Cookie を焼いている');
});

test('メールアドレスかパスワードが空なら 400', async () => {
  assert.equal((await login('', PASSWORD)).status, 400);
  assert.equal((await login(EMAIL, '')).status, 400);
});

test('ログインで焼く Cookie は HttpOnly / Secure / SameSite=Lax', async () => {
  const res = await login(EMAIL, PASSWORD);
  const raw = res.headers.get('set-cookie') || '';
  assert.match(raw, /^mms_session=/);
  assert.match(raw, /HttpOnly/);
  assert.match(raw, /Secure/);
  assert.match(raw, /SameSite=Lax/);
});

test('/api/me は元アプリから読んだ表示名を返す', async () => {
  const res = await get('/api/me');
  assert.equal(res.status, 200);
  const { user } = await res.json();
  assert.ok(user.name && user.name.trim(), `表示名が空: ${JSON.stringify(user)}`);
});

test('改竄した Cookie は 401 になり、こちらの Cookie も落とす', async () => {
  const res = await getNoAuth('/api/reports', { headers: { Cookie: 'mms_session=aaaa.bbbb' } });
  assert.equal(res.status, 401);
  assert.match(res.headers.get('set-cookie') || '', /mms_session=;/);
});

const assertLiveOrCached = (body, path) => {
  assert.ok(['live', 'cache', 'stale'].includes(body.source),
    `${path} の source が想定外: ${body.source}`);
  assert.ok(body.fetchedAt, `${path} に fetchedAt が無い`);
};

test('/api/dashboard', async () => {
  const body = await (await get('/api/dashboard')).json();
  assertLiveOrCached(body, '/api/dashboard');
  assert.equal(body.heading, 'ダッシュボード');
  assert.match(body.team, /^チーム:/);
  assert.ok(body.notice, '調整中の表示が取れていない');
});

test('/api/reports は列見出しと集計を元 HTML から取る', async () => {
  const body = await (await get('/api/reports')).json();
  assertLiveOrCached(body, '/api/reports');
  assert.deepEqual(body.columns.map((c) => c.label),
    ['タイトル', '期間', 'ステータス', '期限', '作成日']);
  for (const k of ['未完了', '完了', '合計']) {
    assert.equal(typeof body.counts[k], 'number', `counts.${k}`);
  }
  if (body.reports.length === 0) {
    assert.equal(body.empty?.title, '週報がありません');
  }
  assert.equal(body.reports.length, body.counts.合計, '行数と合計が食い違う');
  for (const r of body.reports) {
    assert.ok(['未完了', '完了'].includes(r.status), `想定外のステータス: ${r.status}`);
    assert.ok(r.id != null, 'id が無い');
    assert.ok(r.title, 'title が空');
  }
});

test('/api/reports/:id は編集画面の項目を返す', async () => {
  const list = await (await get('/api/reports')).json();
  if (!list.reports.length) {
    assert.ok(true, '週報が 0 件なので詳細はスキップ');
    return;
  }
  const id = list.reports[0].id;
  const res = await get(`/api/reports/${id}`);
  assert.equal(res.status, 200, await res.clone().text());
  const body = await res.json();
  assertLiveOrCached(body, `/api/reports/${id}`);
  assert.equal(String(body.id), String(id));
  assert.ok(Array.isArray(body.fields), 'fields が無い');
  const names = body.fields.map((f) => f.name);
  for (const want of ['shortnote', 'progress', 'issue', 'plan']) {
    assert.ok(names.includes(want), `${want} が無い: ${names.join(',')}`);
  }
  for (const f of body.fields) {
    assert.ok(f.label, `${f.name} の label が空`);
  }
});

test('/api/orders は列見出し 6 つと空状態を取る', async () => {
  const body = await (await get('/api/orders')).json();
  assertLiveOrCached(body, '/api/orders');
  assert.deepEqual(body.columns.map((c) => c.label),
    ['商品', '単価', '数量', '合計', 'ステータス', '作成日']);
  assert.ok(Array.isArray(body.orders));
  if (body.orders.length === 0) {
    assert.equal(body.empty?.title, '注文がありません');
  }
  for (const o of body.orders) {
    for (const k of ['unitPriceValue', 'quantityValue', 'totalValue']) {
      assert.ok(o[k] === null || typeof o[k] === 'number',
        `${k} が数値でも null でもない: ${o[k]}`);
      assert.ok(!Number.isNaN(o[k]), `${k} が NaN`);
    }
    assert.ok(o.id == null || typeof o.id === 'number' || typeof o.id === 'string',
      `id の型が不正: ${o.id}`);
    if (o.status) {
      const known = [
        '保留中', '注文済み', '受取可能', '受取済み', 'キャンセル済み',
        '未完了', '完了'
      ];
      // 未知の語彙も素通しはするが、現行の既知語彙なら印が落ちていること
      if (known.includes(o.status) || /保留|注文|受取|キャンセル|完了/.test(o.status)) {
        assert.ok(!/^[⏳📋✅📦❌]/.test(o.status), `ステータスの絵文字が残っている: ${o.status}`);
      }
    }
  }
});

test('/api/notifications の既読化口がある', async () => {
  const list = await (await get('/api/notifications')).json();
  assertLiveOrCached(list, '/api/notifications');
  assert.ok(Array.isArray(list.notifications));
  if (!list.notifications.length) {
    // 0 件でも一括既読は通る想定
    const res = await get('/api/notifications/mark_all_as_read', { method: 'PATCH' });
    assert.equal(res.status, 200, await res.clone().text());
    const body = await res.json();
    assert.equal(body.ok, true);
    return;
  }
  const target = list.notifications.find((n) => n.id != null && n.read !== true)
    || list.notifications.find((n) => n.id != null);
  if (!target) {
    assert.ok(true, '既読化できる通知が無い');
    return;
  }
  const res = await get(
    `/api/notifications/${encodeURIComponent(target.id)}/mark_as_read`,
    { method: 'PATCH' }
  );
  assert.equal(res.status, 200, await res.clone().text());
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(String(body.id), String(target.id));
});

test('/api/equipments', async () => {
  const body = await (await get('/api/equipments')).json();
  assertLiveOrCached(body, '/api/equipments');
  assert.equal(body.heading, '利用可能な機材');
  assert.equal(body.lede, '貸出申請可能な機材一覧');
  assert.match(body.empty.text, /現在利用可能な機材はありません/);
  assert.ok(Array.isArray(body.equipments));
});

test('/api/loans は描画されている節だけを返す', async () => {
  const body = await (await get('/api/loans')).json();
  assertLiveOrCached(body, '/api/loans');
  assert.equal(body.heading, '機材貸出');
  assert.deepEqual(body.sections.map((s) => s.key), ['pending', 'active']);
  assert.deepEqual(body.sections.map((s) => s.title), ['申請中', '貸出中']);
  for (const s of body.sections) assert.ok(Array.isArray(s.items));
});

test('/api/notifications', async () => {
  const body = await (await get('/api/notifications')).json();
  assertLiveOrCached(body, '/api/notifications');
  assert.equal(body.heading, '通知');
  assert.equal(body.empty.title, '通知はありません');
  assert.ok(Array.isArray(body.notifications));
  for (const n of body.notifications) {
    assert.ok(n.read === null || typeof n.read === 'boolean',
      `read が boolean でも null でもない: ${n.read}`);
  }
});

test('2 回目の画面取得はキャッシュから即返す（source=cache）', async () => {
  const first = await (await get('/api/dashboard')).json();
  assertLiveOrCached(first, '/api/dashboard#1');
  const second = await (await get('/api/dashboard')).json();
  assert.equal(second.source, 'cache',
    `2 回目がキャッシュになっていない: ${second.source}`);
  assert.equal(second.fetchedAt, first.fetchedAt);
  assert.equal(second.heading, first.heading);
});

test('/api/notifications/unread_count は元アプリの JSON をそのまま通す', async () => {
  const body = await (await get('/api/notifications/unread_count')).json();
  assert.equal(typeof body.count, 'number');
});

test('/api/notify/discord はセッション無しだと 401', async () => {
  const res = await getNoAuth('/api/notify/discord', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      webhookUrl: 'https://discord.com/api/webhooks/1234567890123456789/abcdefghijklmnopqrstuvwx-yz_ABCDE',
      payload: { content: 'x' }
    })
  });
  assert.equal(res.status, 401);
});

test('/api/notify/discord は不正な Webhook を 400 で拒む', async () => {
  const res = await get('/api/notify/discord', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      webhookUrl: 'https://example.com/hooks/1',
      payload: { content: 'x' }
    })
  });
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /Discord/);
});

test('/api/notify/discord 以外のメソッドは 405', async () => {
  const res = await get('/api/notify/discord');
  assert.equal(res.status, 405);
  assert.equal(res.headers.get('allow'), 'POST');
});

test('知らない口は 404、週報への POST は 405、注文への不正メソッドは 405', async () => {
  assert.equal((await get('/api/nope')).status, 404);
  const posted = await get('/api/reports', { method: 'POST' });
  assert.equal(posted.status, 405);
  assert.equal(posted.headers.get('allow'), 'GET');
  const putOrders = await get('/api/orders', { method: 'PUT' });
  assert.equal(putOrders.status, 405);
});

test('/api/orders への POST はログイン必須', async () => {
  const res = await getNoAuth('/api/orders', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      productName: 'x', amount: 1, quantity: 1,
      salesSiteType: 'amazon', shopName: 'Amazon'
    })
  });
  assert.equal(res.status, 401);
});

test('/api/orders への POST は不正な本文を 400 で拒む', async () => {
  const res = await get('/api/orders', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ productName: '', amount: 1, quantity: 1 })
  });
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /商品名|販売サイト/);
});

test('/api/session は POST と DELETE 以外を拒む', async () => {
  const res = await get('/api/session');
  assert.equal(res.status, 405);
  assert.equal(res.headers.get('allow'), 'POST, DELETE');
});

test('画面はログイン前でも配られる（ログイン画面を出すため）', async () => {
  const res = await fetch(`${BASE}/`);
  assert.equal(res.status, 200);
  const body = await res.text();
  assert.match(body, /Meister Management System/);
  assert.match(body, /id="signin"/);
});

test('失敗したログインは既存のセッションを壊さない', async () => {
  const before = (await get('/api/me')).status;
  assert.equal(before, 200);
  await login(EMAIL, 'definitely-not-the-password');
  assert.equal((await get('/api/me')).status, 200,
    'ログインを間違えたら既存のセッションが落ちた');
});

// 最後に流す。以降のテストはセッションを使えない。
test('ログアウトで Cookie が落ち、元アプリ側のサインアウトも通る', async () => {
  const res = await get('/api/session', { method: 'DELETE' });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('set-cookie') || '', /mms_session=;/,
    'こちらの Cookie を消していない');

  const body = await res.json();
  assert.equal(body.originSignedOut, true,
    `元アプリのサインアウトが通っていない: ${body.reason}`);

  // 元アプリは Rails の cookie_store なので、発行済みの Cookie 値は
  // サインアウトしても無効にならない。実測で確認済みの元アプリの性質であり、
  // ここで直せるものではない。ブラウザは Set-Cookie に従うのでログアウトできる。
  // 手元に値を持ち続けた場合は、元アプリの cookie_store の性質上まだ通る。
  // Worker 側の封印トークンに独自期限は付けていない。
  const stillWorks = await get('/api/reports');
  assert.equal(stillWorks.status, 200,
    '元アプリの挙動が変わった可能性がある。README の但し書きを見直すこと');
});

});
