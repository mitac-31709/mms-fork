/* バックグラウンド Discord 配信の純関数テスト。 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  buildAuthExpiredPayload, buildDiscordPayload, pickNewNotifications, processSubscription
} from '../src/background.js';
import { buildSubscription, normalizeSubscription } from '../src/subscribe.js';

describe('buildSubscription / normalize', () => {
  test('必須が無ければ null', () => {
    assert.equal(normalizeSubscription({}), null);
    assert.equal(normalizeSubscription(null), null);
  });

  test('新規購読を組める', () => {
    const sub = buildSubscription({
      cookie: 'rails=abc',
      webhookUrl: 'https://discord.com/api/webhooks/1/token'
    });
    assert.ok(sub.id);
    assert.equal(sub.cookie, 'rails=abc');
    assert.equal(sub.primed, false);
    assert.equal(sub.disabled, false);
  });
});

describe('background pickNewNotifications', () => {
  test('初回は送らない', () => {
    const r = pickNewNotifications({
      prev: { primed: false, count: 0, seenIds: [] },
      count: 2,
      notifications: [{ id: 1, read: false }, { id: 2, read: false }]
    });
    assert.equal(r.notify, false);
    assert.equal(r.next.primed, true);
  });

  test('新しい未読だけ送る', () => {
    const r = pickNewNotifications({
      prev: { primed: true, count: 1, seenIds: ['1'] },
      count: 2,
      notifications: [{ id: 1, read: false }, { id: 3, title: '新着', read: false }]
    });
    assert.equal(r.notify, true);
    assert.deepEqual(r.items.map((n) => n.id), [3]);
  });

  test('id が無くても件数の増加は送る', () => {
    const r = pickNewNotifications({
      prev: { primed: true, count: 0, seenIds: [] },
      count: 1,
      notifications: []
    });
    assert.equal(r.notify, true);
    assert.match(r.items[0].body, /0 件から 1 件/);
  });
});

describe('processSubscription', () => {
  test('新着があれば Discord へ送って状態を進める', async () => {
    const sent = [];
    const result = await processSubscription({
      id: 's1',
      cookie: 'c',
      webhookUrl: 'https://discord.com/api/webhooks/1234567890123456789/abcdefghijklmnopqrstuvwx-yz_ABCDE',
      primed: true,
      count: 0,
      seenIds: [],
      disabled: false
    }, {}, {
      unreadCountFn: async () => ({ count: 1 }),
      htmlFn: async () => `
        <main><h1>通知</h1>
          <ul><li id="notification_9" data-notification-id="9" data-read="false">
            <h3>新着</h3><p>本文</p><time datetime="2026-08-05">2026/08/05</time>
          </li></ul>
        </main>`,
      forwardFn: async (url, body) => {
        sent.push({ url, body });
        return { ok: true, status: 204 };
      }
    });
    assert.equal(result.sent, 1);
    assert.equal(sent.length, 1);
    assert.match(sent[0].body.content, /1 件/);
    assert.equal(result.sub.primed, true);
    assert.ok(result.sub.seenIds.includes('9'));
  });

  test('項目 id が取れなくても未読が増えたら Discord へ送る', async () => {
    const sent = [];
    const result = await processSubscription({
      id: 's-count',
      cookie: 'c',
      webhookUrl: 'https://discord.com/api/webhooks/1234567890123456789/abcdefghijklmnopqrstuvwx-yz_ABCDE',
      primed: true,
      count: 0,
      seenIds: [],
      disabled: false
    }, {}, {
      unreadCountFn: async () => ({ count: 1 }),
      htmlFn: async () => '<main><h1>通知</h1><p>通知はありません</p></main>',
      forwardFn: async (_url, body) => {
        sent.push(body);
        return { ok: true, status: 204 };
      }
    });
    assert.equal(result.sent, 1);
    assert.equal(sent.length, 1);
    assert.match(sent[0].embeds[0].title, /未読/);
  });

  test('401 なら購読を無効化し Discord に知らせる', async () => {
    const { ApiError } = await import('../src/meister.js');
    const sent = [];
    const result = await processSubscription({
      id: 's2', cookie: 'c', webhookUrl: 'https://discord.com/api/webhooks/1234567890123456789/abcdefghijklmnopqrstuvwx-yz_ABCDE',
      primed: true, count: 0, seenIds: [], disabled: false
    }, {}, {
      unreadCountFn: async () => { throw new ApiError(401, 'expired', { clearSession: true }); },
      htmlFn: async () => '',
      forwardFn: async (_url, body) => {
        sent.push(body);
        return { ok: true, status: 204 };
      }
    });
    assert.equal(result.sub.disabled, true);
    assert.equal(result.sent, 0);
    assert.match(result.error, /401/);
    assert.equal(sent.length, 1);
    assert.match(sent[0].content, /ログインが切れ/);
    assert.ok(result.sub.authNotifiedAt);
  });

  test('401 でも Discord 失敗なら authNotifiedAt は空のまま無効化する', async () => {
    const { ApiError } = await import('../src/meister.js');
    const result = await processSubscription({
      id: 's3', cookie: 'c', webhookUrl: 'https://discord.com/api/webhooks/1234567890123456789/abcdefghijklmnopqrstuvwx-yz_ABCDE',
      primed: true, count: 0, seenIds: [], disabled: false
    }, {}, {
      unreadCountFn: async () => { throw new ApiError(401, 'expired', { clearSession: true }); },
      htmlFn: async () => '',
      forwardFn: async () => ({ ok: false, status: 500 })
    });
    assert.equal(result.sub.disabled, true);
    assert.equal(result.sub.authNotifiedAt, null);
  });
});

describe('buildAuthExpiredPayload', () => {
  test('再ログインを促す', () => {
    const p = buildAuthExpiredPayload({ origin: 'https://example.test' });
    assert.match(p.content, /ログインが切れ/);
    assert.equal(p.embeds[0].url, 'https://example.test/notifications');
  });
});

describe('cronTickToken', () => {
  test('同じ秘密なら同じトークン', async () => {
    const { cronTickToken, verifyCronTickToken } = await import('../src/background.js');
    const a = await cronTickToken('secret-a');
    const b = await cronTickToken('secret-a');
    assert.equal(a, b);
    assert.equal(await verifyCronTickToken('secret-a', a), true);
    assert.equal(await verifyCronTickToken('secret-a', 'nope'), false);
  });
});

describe('buildDiscordPayload (background)', () => {
  test('フッターにバックグラウンドと書く', () => {
    const p = buildDiscordPayload([{ id: 1, title: 't', body: 'b' }]);
    assert.match(p.embeds[0].footer.text, /バックグラウンド/);
  });
});
