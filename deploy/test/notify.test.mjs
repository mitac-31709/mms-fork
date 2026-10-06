/* Discord 中継と通知差分の純関数テスト。ネットワークはモックする。 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, test } from 'node:test';

import {
  forwardDiscord, sanitizeDiscordBody, validateWebhookUrl
} from '../src/discord.js';

const here = dirname(fileURLToPath(import.meta.url));
const notifyUrl = pathToFileURL(join(here, '../../fork/notify.js')).href;
const {
  badgeLabel, buildBrowserNotification, buildDiscordPayload,
  pickNewNotifications
} = await import(notifyUrl);

const GOOD_HOOK =
  'https://discord.com/api/webhooks/1234567890123456789/abcdefghijklmnopqrstuvwx-yz_ABCDE';

describe('validateWebhookUrl', () => {
  test('正しい Discord Webhook を通す', () => {
    const r = validateWebhookUrl(GOOD_HOOK);
    assert.equal(r.ok, true);
    assert.equal(r.url, GOOD_HOOK);
  });

  test('末尾スラッシュは正規化する', () => {
    assert.equal(validateWebhookUrl(GOOD_HOOK + '/').url, GOOD_HOOK);
  });

  test('discordapp.com も通す', () => {
    const url = GOOD_HOOK.replace('discord.com', 'discordapp.com');
    assert.equal(validateWebhookUrl(url).ok, true);
  });

  test('トークン中のドットを許す', () => {
    const url = 'https://discord.com/api/webhooks/1234567890123456789/abcdefghijklmnopqrst.uvwx-yz_ABCDE';
    const r = validateWebhookUrl(url);
    assert.equal(r.ok, true);
    assert.equal(r.url, url);
  });

  test('不正なものを拒む', () => {
    for (const bad of [
      '',
      null,
      'http://discord.com/api/webhooks/1/abc',
      'https://evil.com/api/webhooks/1234567890123456789/abcdefghijklmnopqrstuvwx',
      'https://discord.com/api/webhooks/1/short',
      GOOD_HOOK + '?wait=true',
      GOOD_HOOK + '#x'
    ]) {
      assert.equal(validateWebhookUrl(bad).ok, false, String(bad));
    }
  });
});

describe('sanitizeDiscordBody', () => {
  test('content と embeds を残す', () => {
    const r = sanitizeDiscordBody({
      username: 'MMS',
      content: 'hello',
      embeds: [{ title: 't', description: 'd', color: 1, evil: true }],
      webhookUrl: 'should-drop'
    });
    assert.equal(r.ok, true);
    assert.deepEqual(r.body, {
      username: 'MMS',
      content: 'hello',
      embeds: [{ title: 't', description: 'd', color: 1 }]
    });
  });

  test('空は拒む', () => {
    assert.equal(sanitizeDiscordBody({}).ok, false);
    assert.equal(sanitizeDiscordBody({ embeds: [{}] }).ok, false);
  });
});

describe('forwardDiscord', () => {
  test('指定 URL に POST する', async () => {
    const calls = [];
    const result = await forwardDiscord(GOOD_HOOK, { content: 'hi' }, async (url, init) => {
      calls.push({ url, init });
      return new Response('{}', { status: 200 });
    });
    assert.equal(result.ok, true);
    assert.equal(result.status, 200);
    assert.equal(calls[0].url, GOOD_HOOK);
    assert.equal(calls[0].init.method, 'POST');
    assert.match(calls[0].init.headers['User-Agent'], /Mozilla\/5\.0/);
    assert.equal(JSON.parse(calls[0].init.body).content, 'hi');
  });

  test('Discord の失敗をそのまま返す', async () => {
    const result = await forwardDiscord(GOOD_HOOK, { content: 'hi' }, async () =>
      new Response(JSON.stringify({ message: 'Unknown Webhook' }), { status: 404 }));
    assert.equal(result.ok, false);
    assert.equal(result.status, 404);
    assert.equal(result.body.message, 'Unknown Webhook');
  });
});

describe('pickNewNotifications', () => {
  const items = [
    { id: 1, title: 'a', read: false },
    { id: 2, title: 'b', read: true },
    { id: 3, title: 'c', read: false }
  ];

  test('初回は送らず基準だけ取る', () => {
    const r = pickNewNotifications({
      prev: { primed: false, count: 0, seenIds: [] },
      count: 2,
      notifications: items
    });
    assert.equal(r.notify, false);
    assert.equal(r.items.length, 0);
    assert.equal(r.next.primed, true);
    assert.equal(r.next.count, 2);
    assert.deepEqual(r.next.seenIds, ['1', '2', '3']);
  });

  test('新しい未読だけを返す', () => {
    const r = pickNewNotifications({
      prev: { primed: true, count: 1, seenIds: ['1', '2'] },
      count: 2,
      notifications: items
    });
    assert.equal(r.notify, true);
    assert.deepEqual(r.items.map((n) => n.id), [3]);
    assert.ok(r.next.seenIds.includes('3'));
  });

  test('件数が増えても既知の id だけなら送らない', () => {
    const r = pickNewNotifications({
      prev: { primed: true, count: 1, seenIds: ['1', '2', '3'] },
      count: 5,
      notifications: items
    });
    assert.equal(r.notify, false);
    assert.equal(r.next.count, 5);
  });

  test('id が取れなくても未読件数の増加は届ける', () => {
    const r = pickNewNotifications({
      prev: { primed: true, count: 0, seenIds: [] },
      count: 2,
      notifications: [{ id: null, title: 'お知らせ', read: null }]
    });
    assert.equal(r.notify, true);
    assert.equal(r.items.length, 1);
    assert.match(r.items[0].title, /未読/);
    assert.equal(r.next.count, 2);
  });
});

describe('build payloads', () => {
  test('badgeLabel', () => {
    assert.equal(badgeLabel(0), null);
    assert.equal(badgeLabel(3), '3');
    assert.equal(badgeLabel(100), '99+');
  });

  test('Discord payload', () => {
    const p = buildDiscordPayload([
      { id: 1, title: '週報', body: '期限です', atISO: '2026-08-05' }
    ], { origin: 'https://example.test' });
    assert.equal(p.username, 'MMS');
    assert.match(p.content, /1 件/);
    assert.equal(p.embeds[0].title, '週報');
    assert.equal(p.embeds[0].url, 'https://example.test/notifications');
  });

  test('browser notification', () => {
    const n = buildBrowserNotification({ id: 9, title: 't', body: 'b' });
    assert.equal(n.title, 't');
    assert.equal(n.options.tag, 'mms-notification-9');
  });
});

describe('verifyDiscord', () => {
  test('Webhook が空なら拒む', async () => {
    const { createWatcher } = await import(notifyUrl);
    const watcher = createWatcher({
      getPrefs: () => ({ browser: false, discord: true, webhookUrl: '' }),
      sendDiscord: async () => {},
      unreadCount: async () => ({ count: 0 }),
      notifications: async () => ({ notifications: [] })
    });
    await assert.rejects(() => watcher.verifyDiscord(''), /Webhook URL/);
  });

  test('連携確認のペイロードを Discord へ送る', async () => {
    const { createWatcher } = await import(notifyUrl);
    const sent = [];
    const watcher = createWatcher({
      origin: 'https://example.test',
      getPrefs: () => ({ browser: false, discord: true, webhookUrl: GOOD_HOOK }),
      sendDiscord: async (payload, url) => { sent.push({ payload, url }); },
      unreadCount: async () => ({ count: 0 }),
      notifications: async () => ({ notifications: [] })
    });
    await watcher.verifyDiscord(GOOD_HOOK);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].url, GOOD_HOOK);
    assert.match(sent[0].payload.embeds[0].title, /Discord 連携/);
  });
});

describe('公開ファイルに届け先が入っている', () => {
  test('通知画面モジュールが届け先設定を取り込む', () => {
    const page = readFileSync(join(here, '../../fork/pages/notifications.js'), 'utf8');
    assert.match(page, /renderNotifySettings/);
    assert.match(page, /届け先/);
  });

  test('レールに届け先の別リンクは置かない', () => {
    const html = readFileSync(join(here, '../../fork/index.html'), 'utf8');
    assert.doesNotMatch(html, /id="notify-settings"/);
    assert.match(html, /data-route="\/notifications"/);
  });
});
