/* Cron から回す Discord バックグラウンド配信。
 *
 * 各購読について元アプリの未読を取り、新しいものだけ Discord へ送る。
 * ブラウザの Watcher と同じ差分ロジック（pickNewNotifications）を使う。
 *
 * Cron 本体は購読 id を列挙して 1 人ずつ HTTP に振り分け、
 * 処理ごとの CPU 枠を分ける（Workers は呼び出し単位で CPU を数える）。
 */

import { forwardDiscord } from './discord.js';
import { ApiError, html, unreadCount } from './meister.js';
import { parseNotifications } from './parse-pages.js';
import {
  listSubscriptionIds, listSubscriptions, putSubscription
} from './subscribe.js';

const ENC = new TextEncoder();

/** クライアントの notify.js と同じ判定。Worker 側に複製して依存を切る。 */
export function pickNewNotifications({ prev, count, notifications }) {
  const items = Array.isArray(notifications) ? notifications : [];
  const seen = new Set((prev.seenIds || []).map(String));
  const countGrew = typeof count === 'number' && count > (prev.count || 0);

  const candidates = items.filter((n) => {
    if (!n || n.id == null) return false;
    if (n.read === true) return false;
    return !seen.has(String(n.id));
  });

  if (!prev.primed) {
    return {
      notify: false,
      items: [],
      next: {
        primed: true,
        count: typeof count === 'number' ? count : items.filter((n) => n.read === false).length,
        seenIds: mergeSeenIds(prev.seenIds, items.map((n) => n.id))
      }
    };
  }

  const shouldNotify = countGrew || candidates.length > 0;
  let fresh = shouldNotify ? candidates : [];

  // 一覧から id が 1 件も取れないとき（UUID 未対応の HTML など）は、
  // 未読件数の増加だけで知らせる。既知 id だけの増加は送らない。
  const identifiable = items.some((n) => n && n.id != null);
  if (prev.primed && countGrew && fresh.length === 0 && !identifiable) {
    fresh = [{
      id: `unread-count-${count}`,
      title: '未読の通知が増えました',
      body: `未読が ${prev.count || 0} 件から ${count} 件になりました。通知一覧を開いて確認してください。`,
      read: false,
      atISO: new Date().toISOString()
    }];
  }

  return {
    notify: fresh.length > 0,
    items: fresh,
    next: {
      primed: true,
      count: typeof count === 'number' ? count : (prev.count || 0) + fresh.length,
      seenIds: mergeSeenIds(prev.seenIds, [
        ...items.map((n) => n.id),
        ...fresh.map((n) => n.id)
      ])
    }
  };
}

function mergeSeenIds(prev, ids) {
  const out = [];
  const set = new Set();
  for (const id of [...(ids || []), ...(prev || [])]) {
    if (id == null) continue;
    const key = String(id);
    if (set.has(key)) continue;
    set.add(key);
    out.push(key);
    if (out.length >= 200) break;
  }
  return out;
}

const DISCORD_COLOR = 0x2f6fed;

export function buildDiscordPayload(items, { origin } = {}) {
  const list = (items || []).slice(0, 5);
  const embeds = list.map((n) => {
    const embed = {
      title: String(n.title || '新しい通知').slice(0, 256),
      color: DISCORD_COLOR,
      footer: { text: 'Meister Management System（バックグラウンド）' }
    };
    if (n.body) embed.description = String(n.body).slice(0, 4096);
    if (n.atISO && !Number.isNaN(Date.parse(n.atISO))) {
      embed.timestamp = new Date(n.atISO).toISOString();
    }
    if (origin) embed.url = `${String(origin).replace(/\/$/, '')}/notifications`;
    return embed;
  });

  const more = (items || []).length - list.length;
  const content = more > 0
    ? `Meister に新しい通知が ${(items || []).length} 件あります（ほか ${more} 件）`
    : `Meister に新しい通知が ${(items || []).length} 件あります`;

  return { username: 'MMS', content, embeds };
}

const AUTH_EXPIRED_COLOR = 0xc4552d;

/** 元アプリのセッションが切れたときの Discord 本文。 */
export function buildAuthExpiredPayload({ origin } = {}) {
  const embed = {
    title: 'ログインの有効期限が切れました',
    description: 'Meister のセッションが無効になったため、バックグラウンドの Discord 通知を止めました。'
      + 'フォークに再ログインし、通知画面で Discord 連携を保存し直すと再開します。',
    color: AUTH_EXPIRED_COLOR,
    timestamp: new Date().toISOString(),
    footer: { text: 'Meister Management System（バックグラウンド）' }
  };
  if (origin) embed.url = `${String(origin).replace(/\/$/, '')}/notifications`;
  return {
    username: 'MMS',
    content: 'Meister のログインが切れたため、バックグラウンドの Discord 通知を止めました。',
    embeds: [embed]
  };
}

function b64url(bytes) {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Cron → 1 人処理 HTTP の共有トークン（SESSION_SECRET から導出）。 */
export async function cronTickToken(secret) {
  if (!secret) throw new Error('SESSION_SECRET が必要です');
  const dig = await crypto.subtle.digest('SHA-256', ENC.encode(`mms-cron-tick:${secret}`));
  return b64url(new Uint8Array(dig));
}

export async function verifyCronTickToken(secret, provided) {
  if (!provided || !secret) return false;
  try {
    const expected = await cronTickToken(secret);
    if (expected.length !== String(provided).length) return false;
    let diff = 0;
    for (let i = 0; i < expected.length; i += 1) {
      diff |= expected.charCodeAt(i) ^ String(provided).charCodeAt(i);
    }
    return diff === 0;
  } catch {
    return false;
  }
}

/** 1 購読を処理する。結果の購読レコード（保存用）を返す。 */
export async function processSubscription(sub, env, {
  unreadCountFn = unreadCount,
  htmlFn = html,
  forwardFn = forwardDiscord,
  origin = 'https://mms-fork.mitac31709.workers.dev',
  now = () => new Date()
} = {}) {
  if (!sub || sub.disabled) {
    return { sub, sent: 0, skipped: true };
  }

  try {
    const { count } = await unreadCountFn(sub.cookie);
    const n = typeof count === 'number' ? count : 0;
    const stamp = now().toISOString();

    const body = await htmlFn(sub.cookie, '/notifications');
    const list = parseNotifications(body).notifications || [];

    const result = pickNewNotifications({
      prev: { primed: sub.primed, count: sub.count, seenIds: sub.seenIds },
      count: n,
      notifications: list
    });

    let sent = 0;
    if (result.notify && result.items.length) {
      const payload = buildDiscordPayload(result.items, { origin });
      const forwarded = await forwardFn(sub.webhookUrl, payload);
      if (!forwarded.ok) {
        throw new Error(`Discord ${forwarded.status}`);
      }
      sent = result.items.length;
    }

    const next = {
      ...sub,
      ...result.next,
      updatedAt: stamp,
      lastOkAt: stamp,
      lastError: null,
      disabled: false
    };
    return { sub: next, sent, skipped: false };
  } catch (e) {
    const message = e instanceof ApiError
      ? `${e.status}: ${e.message}`
      : (e.message || String(e));
    const authFailed = e instanceof ApiError && e.status === 401;
    let authNotifiedAt = sub.authNotifiedAt || null;
    if (authFailed && !authNotifiedAt && sub.webhookUrl) {
      try {
        const forwarded = await forwardFn(sub.webhookUrl, buildAuthExpiredPayload({ origin }));
        if (forwarded?.ok) authNotifiedAt = now().toISOString();
      } catch {
        // 認証切れの知らせが送れなくても購読は止める
      }
    }
    const next = {
      ...sub,
      updatedAt: now().toISOString(),
      lastError: message.slice(0, 300),
      disabled: authFailed,
      authNotifiedAt
    };
    return { sub: next, sent: 0, skipped: false, error: message };
  }
}

/** テスト用。本番 Cron は 1 人ずつ HTTP に振り分ける。 */
export async function runBackgroundNotify(env, deps = {}) {
  const subs = await listSubscriptions(env);
  const summary = { checked: 0, sent: 0, errors: 0, disabled: 0 };

  for (const sub of subs) {
    summary.checked += 1;
    const result = await processSubscription(sub, env, deps);
    await putSubscription(env, result.sub);
    summary.sent += result.sent || 0;
    if (result.error) summary.errors += 1;
    if (result.sub.disabled) summary.disabled += 1;
  }

  return summary;
}

/**
 * Cron から購読 id ごとに別リクエストを起こす。
 * Workers の CPU は呼び出し単位なので、1 人ずつ処理枠を分けられる。
 * （動的に「1 人 1 Cron」を増やすことはできない。Free は Cron 5 本まで。）
 */
export async function dispatchCronTicks(env, ctx, {
  baseUrl = 'https://mms-fork.mitac31709.workers.dev',
  listIds,
  fetchFn = fetch
} = {}) {
  const ids = listIds || await listSubscriptionIds(env);
  const token = await cronTickToken(env.SESSION_SECRET);
  const base = String(baseUrl).replace(/\/$/, '');
  const summary = { dispatched: 0, ids: ids.length };

  for (const id of ids) {
    summary.dispatched += 1;
    const task = fetchFn(`${base}/api/notify/cron-tick`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Cron-Tick': token
      },
      body: JSON.stringify({ id })
    }).then(async (res) => {
      const text = await res.text();
      console.log('cron-tick', id, res.status, text.slice(0, 200));
    }).catch((e) => {
      console.error('cron-tick failed', id, e.message || e);
    });
    if (ctx?.waitUntil) ctx.waitUntil(task);
    else await task;
  }

  return summary;
}
