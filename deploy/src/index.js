/* Meister Management System フォークの Worker。
 *
 * - `POST /api/session`    利用者の資格情報で元アプリにログインする
 * - `DELETE /api/session`  ログアウトする
 * - `GET  /api/me`         ログイン中の利用者
 * - `GET  /api/<page>`     元アプリの画面を JSON にして返す
 * - `GET  /api/reports/:id` 週報の詳細（`/reports/:id/edit` の HTML。本文項目は編集画面にある）
 * - `PATCH /api/reports/:id` 週報の 1 項目を元アプリへ保存する（auto_save / フォーム）
 * - `POST /api/orders`     新しい注文を元アプリへ作る
 * - `PATCH /api/notifications/:id/mark_as_read`  通知を既読にする
 * - `PATCH /api/notifications/mark_all_as_read`  通知をすべて既読にする
 * - `POST /api/notify/discord`  即時の Discord 中継
 * - `POST /api/notify/subscribe`  タブ閉鎖後も Discord へ送る購読を KV に登録
 * - `DELETE /api/notify/subscribe`  購読を削除
 * - Cron `0 * * * *`      購読 id を列挙し、1 人ずつ `/api/notify/cron-tick` へ振り分け
 *
 * 資格情報は保存しない。元アプリのセッション Cookie を AES-GCM で封印して
 * 自ドメインの Cookie に入れる（`src/session.js`）。
 * 画面 JSON は利用者区画の stale-while-revalidate（`src/page-cache.js`）。
 * バックグラウンド配信用に、同じ封印で「Rails Cookie + Webhook URL」を
 * KV（NOTIFY_SUBS）へ置く。Discord オフまたはログアウトで消す。
 *
 * パースで想定外の HTML を見たときは、Cloudflare シークレットの
 * `DISCORD_WEBHOOK` へ運用向けの通知を送る（利用者の届け先とは別）。
 */

import {
  dispatchCronTicks, processSubscription, verifyCronTickToken
} from './background.js';
import { forwardDiscord, sanitizeDiscordBody, validateWebhookUrl } from './discord.js';
import {
  ApiError, createOrder, html, markAllNotificationsRead, markNotificationRead,
  saveReportField, signIn, signOut, unreadCount
} from './meister.js';
import {
  FRESH_MS, PAGE_CACHE_PATHS, STALE_WHILE_REVALIDATE_MS,
  freshness, pageCache, userCacheKey
} from './page-cache.js';
import { parseIdToken, parseReportsPage, parseReportDetail } from './parse.js';
import {
  parseDashboard, parseEquipments, parseLoans, parseNotifications,
  parseOrders, parseUser
} from './parse-pages.js';
import { buildParseAlertPayload, inspectParse } from './parse-guard.js';
import {
  clearCookieHeader, currentSession, seal, setCookieHeader
} from './session.js';
import {
  buildSubscription, deleteSubscription, getSubscription, putSubscription
} from './subscribe.js';

const json = (data, status = 200, headers = {}) =>
  new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      ...headers
    }
  });

/** セッションが無い・壊れている・期限切れ。壊れた Cookie を送り続けさせない。 */
const unauthorized = () =>
  json({ error: 'ログインしてください', code: 'unauthenticated' }, 401,
    { 'Set-Cookie': clearCookieHeader() });

/** 同じ path+理由の連続通知を抑える。Isolate 単位のベストエフォート。 */
const ALERT_COOLDOWN_MS = 5 * 60 * 1000;
const recentAlerts = new Map();

function shouldSkipAlert(key) {
  const now = Date.now();
  const last = recentAlerts.get(key) || 0;
  if (now - last < ALERT_COOLDOWN_MS) return true;
  recentAlerts.set(key, now);
  if (recentAlerts.size > 40) {
    for (const [k, t] of recentAlerts) {
      if (now - t >= ALERT_COOLDOWN_MS) recentAlerts.delete(k);
    }
  }
  return false;
}

/** パース異常を DISCORD_WEBHOOK へ送る。失敗しても API 応答は止めない。 */
async function alertParseAnomaly(env, { path, origin, reasons, html: body, error }) {
  const webhookRaw = env.DISCORD_WEBHOOK;
  if (!webhookRaw) return;

  const key = `${path}|${error || ''}|${(reasons || []).join(';')}`;
  if (shouldSkipAlert(key)) return;

  const validated = validateWebhookUrl(String(webhookRaw));
  if (!validated.ok) {
    console.error('DISCORD_WEBHOOK の形が不正:', validated.error);
    return;
  }

  const payload = buildParseAlertPayload({ path, origin, reasons, html: body, error });
  const sanitized = sanitizeDiscordBody(payload);
  if (!sanitized.ok) {
    console.error('パース異常の Discord 本文が不正:', sanitized.error);
    return;
  }

  try {
    const result = await forwardDiscord(validated.url, sanitized.body);
    if (!result.ok) {
      console.error('パース異常の Discord 送信に失敗:', result.status, result.raw?.slice?.(0, 200));
    }
  } catch (e) {
    console.error('パース異常の Discord 送信で例外:', e.message || e);
  }
}

/** 元アプリの 1 画面を取って JSON にする。想定外なら Discord へ知らせる。 */
async function pageLive(cookie, path, parse, env) {
  const body = await html(cookie, path);
  const origin = `https://meister.tokyo-ct.org${path}`;
  let parsed;
  try {
    parsed = parse(body);
  } catch (e) {
    await alertParseAnomaly(env, {
      path, origin, reasons: ['パーサが例外を投げた'], html: body, error: e.message || String(e)
    });
    throw new ApiError(502, `元アプリの ${path} を読めませんでした（${e.message || e}）`);
  }

  const check = inspectParse(path, body, parsed);
  if (!check.ok) {
    await alertParseAnomaly(env, { path, origin, reasons: check.reasons, html: body });
  }

  return {
    source: 'live',
    origin,
    fetchedAt: new Date().toISOString(),
    parseWarning: check.ok ? null : check.reasons,
    ...parsed
  };
}

/** 利用者区画のキャッシュ付き。遅延はミス時だけ。 */
async function page(cookie, path, parse, env, ctx, { refresh = false } = {}) {
  const userKey = await userCacheKey(cookie);
  const result = await pageCache.load({
    userKey,
    path,
    ctx: refresh ? null : ctx, // refresh は自分で待つ。二重の waitUntil 再取得は不要
    mode: refresh ? 'refresh' : 'swr',
    fetchFresh: () => pageLive(cookie, path, parse, env)
  });

  // 裏更新中に warm まで waitUntil に積むと、元アプリが遅くて枠を食い、
  // 本番ログどおり revalidate のキャッシュ書き込みまでキャンセルされる。
  // 温めるのは fresh ヒットのときだけ（クライアントの先読みもある）。
  if (!refresh && ctx?.waitUntil && result?.source === 'cache' && !result.revalidating) {
    ctx.waitUntil(warmReachable(cookie, path, env).catch((e) => {
      console.error('warmReachable failed:', e?.message || e);
    }));
  }

  return result;
}

/** 現在画面以外の一覧を Cache API に載せる。既に新しければ飛ばす。
 *  waitUntil 枠を食い潰さないよう、1 リクエストあたり最大 1 画面だけ温める。 */
async function warmReachable(cookie, currentPath, env) {
  const userKey = await userCacheKey(cookie);
  for (const [originPath, parse] of Object.values(PAGES)) {
    if (originPath === currentPath) continue;
    const cached = await pageCache.read(userKey, originPath);
    const band = freshness(cached);
    if (band === 'fresh' || band === 'revalidate') continue;
    try {
      await pageCache.load({
        userKey,
        path: originPath,
        mode: 'swr',
        fetchFresh: () => pageLive(cookie, originPath, parse, env)
      });
    } catch (e) {
      console.error('warm page failed:', originPath, e?.message || e);
    }
    return; // 1 画面だけ。残りはクライアント先読みか次のリクエストへ
  }
}

async function handleSessionCreate(request, env) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'JSON の本文が必要です' }, 400);
  }

  const email = String(body?.email ?? '').trim();
  const password = String(body?.password ?? '');
  const cookie = await signIn(email, password);

  let user = { name: null, badge: null };
  try {
    user = parseUser(await html(cookie, '/dashboard')) || user;
  } catch {
    // 表示名が取れなくてもログインは成立させる
  }

  const token = await seal(
    { cookie, name: user.name, badge: user.badge },
    env.SESSION_SECRET
  );
  return json({ user }, 200, { 'Set-Cookie': setCookieHeader(token) });
}

async function handleSessionDelete(request, env) {
  const session = await currentSession(request, env);
  if (session?.cookie) {
    const userKey = await userCacheKey(session.cookie);
    await pageCache.invalidate(userKey, PAGE_CACHE_PATHS);
  }
  const result = session?.cookie ? await signOut(session.cookie) : { ok: true };
  return json({ ok: true, originSignedOut: result.ok, reason: result.reason ?? null },
    200, { 'Set-Cookie': clearCookieHeader() });
}

const PAGES = {
  '/api/dashboard': ['/dashboard', parseDashboard],
  '/api/reports': ['/reports', parseReportsPage],
  '/api/orders': ['/orders', parseOrders],
  '/api/equipments': ['/equipments', parseEquipments],
  '/api/loans': ['/loans', parseLoans],
  '/api/notifications': ['/notifications', parseNotifications]
};

async function handleDiscordNotify(request) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'JSON の本文が必要です' }, 400);
  }

  const webhook = validateWebhookUrl(body?.webhookUrl);
  if (!webhook.ok) return json({ error: webhook.error }, 400);

  const payload = sanitizeDiscordBody(body?.payload ?? body);
  if (!payload.ok) return json({ error: payload.error }, 400);

  const result = await forwardDiscord(webhook.url, payload.body);
  if (!result.ok) {
    const detail = discordFailureDetail(result);
    return json({
      error: detail
        ? `Discord への送信に失敗しました（${result.status}: ${detail}）`
        : `Discord への送信に失敗しました（${result.status}）`,
      discordStatus: result.status,
      discord: result.body
    }, 502);
  }
  return json({ ok: true, discordStatus: result.status });
}

function discordFailureDetail(result) {
  const message = result?.body && typeof result.body === 'object'
    ? (result.body.message || result.body.error || '')
    : '';
  const raw = typeof result?.raw === 'string' ? result.raw : '';
  const text = String(message || raw).replace(/\s+/g, ' ').trim();
  if (!text) return '';
  if (/error code:\s*1010/i.test(text)) {
    return 'Cloudflare がリクエストを拒否しました（error 1010）';
  }
  return text.slice(0, 180);
}

async function handleOrderCreate(request, env) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'JSON の本文が必要です' }, 400);
  }

  const session = await currentSession(request, env);
  if (!session) return unauthorized();

  const result = await createOrder(session.cookie, body);
  const headers = {};
  if (result.cookie && result.cookie !== session.cookie) {
    const token = await seal(
      {
        cookie: result.cookie,
        name: session.name,
        badge: session.badge
      },
      env.SESSION_SECRET
    );
    headers['Set-Cookie'] = setCookieHeader(token);
  }

  // 注文一覧・ダッシュボードはすぐ古くなるので利用者区画だけ落とす。
  const userKey = await userCacheKey(result.cookie || session.cookie);
  await pageCache.invalidate(userKey, ['/orders', '/dashboard']);

  return json({
    ok: true,
    redirectedTo: result.redirectedTo,
    productName: String(body?.productName ?? '').trim()
  }, 201, headers);
}

/** 週報の 1 項目を元アプリへ保存する。 */
async function handleReportFieldSave(request, env, rawId) {
  const id = parseIdToken(rawId);
  if (id == null) return json({ error: 'そのような口はありません' }, 404);

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'JSON の本文が必要です' }, 400);
  }

  const session = await currentSession(request, env);
  if (!session) return unauthorized();

  const fieldName = typeof body?.fieldName === 'string' ? body.fieldName.trim() : '';
  const content = typeof body?.content === 'string' ? body.content : null;
  const result = await saveReportField(session.cookie, id, fieldName, content);

  const headers = {};
  if (result.cookie && result.cookie !== session.cookie) {
    const token = await seal(
      {
        cookie: result.cookie,
        name: session.name,
        badge: session.badge
      },
      env.SESSION_SECRET
    );
    headers['Set-Cookie'] = setCookieHeader(token);
  }

  const userKey = await userCacheKey(result.cookie || session.cookie);
  await pageCache.invalidate(userKey, [`/reports/${id}/edit`, '/reports']);

  return json({ ok: true, id: result.id, fieldName: result.fieldName }, 200, headers);
}

/** 通知の既読化後に Cookie を更新し、通知系キャッシュを落とす。 */
async function withSessionRefresh(session, env, result, body) {
  const headers = {};
  if (result.cookie && result.cookie !== session.cookie) {
    const token = await seal(
      {
        cookie: result.cookie,
        name: session.name,
        badge: session.badge
      },
      env.SESSION_SECRET
    );
    headers['Set-Cookie'] = setCookieHeader(token);
  }
  const userKey = await userCacheKey(result.cookie || session.cookie);
  await pageCache.invalidate(userKey, ['/notifications', '/notifications/unread_count']);
  return json(body, 200, headers);
}

async function handleNotificationMarkRead(request, env, rawId) {
  const id = parseIdToken(rawId);
  if (id == null) return json({ error: 'そのような口はありません' }, 404);

  const session = await currentSession(request, env);
  if (!session) return unauthorized();

  const result = await markNotificationRead(session.cookie, id);
  return withSessionRefresh(session, env, result, { ok: true, id: result.id });
}

async function handleNotificationMarkAllRead(request, env) {
  const session = await currentSession(request, env);
  if (!session) return unauthorized();

  const result = await markAllNotificationsRead(session.cookie);
  return withSessionRefresh(session, env, result, { ok: true });
}

/** タブ閉鎖後も Discord へ送る購読を登録 / 更新する。 */
async function handleSubscribe(request, env, session) {
  if (!env.NOTIFY_SUBS) {
    return json({ error: 'バックグラウンド配信が設定されていません' }, 503);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'JSON の本文が必要です' }, 400);
  }

  const webhook = validateWebhookUrl(body?.webhookUrl);
  if (!webhook.ok) return json({ error: webhook.error }, 400);

  const existingId = typeof body?.id === 'string' ? body.id.trim() : '';
  const prev = existingId ? await getSubscription(env, existingId) : null;

  let primed = prev?.primed ?? false;
  let count = prev?.count ?? 0;
  let seenIds = prev?.seenIds ?? [];
  if (!prev) {
    try {
      const unread = await unreadCount(session.cookie);
      count = typeof unread.count === 'number' ? unread.count : 0;
      const parsed = parseNotifications(await html(session.cookie, '/notifications'));
      seenIds = (parsed.notifications || [])
        .map((n) => n.id)
        .filter((id) => id != null)
        .map(String)
        .slice(0, 200);
      primed = true;
    } catch {
      primed = false;
      count = 0;
      seenIds = [];
    }
  }

  const sub = buildSubscription({
    id: prev?.id || existingId || undefined,
    cookie: session.cookie,
    webhookUrl: webhook.url,
    prev: { ...prev, primed, count, seenIds }
  });
  await putSubscription(env, sub);

  return json({
    ok: true,
    id: sub.id,
    background: true,
    primed: sub.primed,
    lastError: sub.lastError
  });
}

async function handleUnsubscribe(request, env) {
  if (!env.NOTIFY_SUBS) return json({ ok: true });

  let body = {};
  try {
    body = await request.json();
  } catch {
    // id が無ければ何もしない
  }
  const id = typeof body?.id === 'string' ? body.id.trim() : '';
  if (id) await deleteSubscription(env, id);
  return json({ ok: true });
}

/** 開いているタブから Rails Cookie を購読へ書き戻す（寿命を延ばす）。 */
async function handleSubscribeRefresh(request, env, session) {
  if (!env.NOTIFY_SUBS) {
    return json({ error: 'バックグラウンド配信が設定されていません' }, 503);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'JSON の本文が必要です' }, 400);
  }
  const id = typeof body?.id === 'string' ? body.id.trim() : '';
  if (!id) return json({ error: '購読 id が必要です' }, 400);

  const prev = await getSubscription(env, id);
  if (!prev) return json({ error: '購読が見つかりません', code: 'missing' }, 404);

  const sub = buildSubscription({
    id,
    cookie: session.cookie,
    webhookUrl: prev.webhookUrl,
    prev
  });
  await putSubscription(env, sub);
  return json({ ok: true, id: sub.id, disabled: sub.disabled, lastError: sub.lastError });
}

/** Cron から振り分けられた 1 購読の処理。別 HTTP 呼び出しなので CPU 枠が分かれる。 */
async function handleCronTick(request, env) {
  if (!env.NOTIFY_SUBS) {
    return json({ error: 'バックグラウンド配信が設定されていません' }, 503);
  }
  const ok = await verifyCronTickToken(
    env.SESSION_SECRET,
    request.headers.get('X-Cron-Tick')
  );
  if (!ok) return json({ error: 'forbidden', code: 'forbidden' }, 403);

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'JSON の本文が必要です' }, 400);
  }
  const id = typeof body?.id === 'string' ? body.id.trim() : '';
  if (!id) return json({ error: '購読 id が必要です' }, 400);

  const sub = await getSubscription(env, id);
  if (!sub) return json({ error: '購読が見つかりません', code: 'missing' }, 404);

  const result = await processSubscription(sub, env, {
    origin: new URL(request.url).origin
  });
  await putSubscription(env, result.sub);
  return json({
    ok: true,
    id: result.sub.id,
    sent: result.sent || 0,
    disabled: result.sub.disabled,
    error: result.error || null
  });
}

async function handleApi(request, url, env, ctx) {
  const path = url.pathname;

  if (path === '/api/session') {
    if (request.method === 'POST') return handleSessionCreate(request, env);
    if (request.method === 'DELETE') return handleSessionDelete(request, env);
    return json({ error: 'POST か DELETE を使ってください' }, 405,
      { Allow: 'POST, DELETE' });
  }

  if (path === '/api/health') {
    return json({
      ok: true,
      origin: 'https://meister.tokyo-ct.org',
      sessionSecret: Boolean(env.SESSION_SECRET),
      auth: 'per-user',
      cache: {
        strategy: 'stale-while-revalidate',
        scope: 'per-session',
        freshMs: FRESH_MS,
        staleWhileRevalidateMs: STALE_WHILE_REVALIDATE_MS
      },
      notify: {
        discordProxy: true,
        background: Boolean(env.NOTIFY_SUBS),
        cron: '0 * * * *',
        cronFanOut: true,
        parseAlertWebhook: Boolean(env.DISCORD_WEBHOOK)
      }
    });
  }

  if (path === '/api/notify/discord') {
    if (request.method !== 'POST') {
      return json({ error: 'POST を使ってください' }, 405, { Allow: 'POST' });
    }
    const session = await currentSession(request, env);
    if (!session) return unauthorized();
    return handleDiscordNotify(request);
  }

  if (path === '/api/notify/subscribe') {
    const session = await currentSession(request, env);
    if (!session) return unauthorized();
    if (request.method === 'POST') return handleSubscribe(request, env, session);
    if (request.method === 'DELETE') return handleUnsubscribe(request, env);
    if (request.method === 'PATCH') return handleSubscribeRefresh(request, env, session);
    return json({ error: 'POST / PATCH / DELETE を使ってください' }, 405,
      { Allow: 'POST, PATCH, DELETE' });
  }

  if (path === '/api/notify/cron-tick') {
    if (request.method !== 'POST') {
      return json({ error: 'POST を使ってください' }, 405, { Allow: 'POST' });
    }
    return handleCronTick(request, env);
  }

  if (path === '/api/orders' && request.method === 'POST') {
    return handleOrderCreate(request, env);
  }

  if (path === '/api/notifications/mark_all_as_read' && request.method === 'PATCH') {
    return handleNotificationMarkAllRead(request, env);
  }

  const notifMark = path.match(/^\/api\/notifications\/([^/]+)\/mark_as_read$/);
  if (notifMark && request.method === 'PATCH') {
    return handleNotificationMarkRead(request, env, notifMark[1]);
  }

  const reportWrite = path.match(/^\/api\/reports\/([^/]+)$/);
  if (reportWrite && request.method === 'PATCH') {
    return handleReportFieldSave(request, env, reportWrite[1]);
  }

  if (request.method !== 'GET') {
    return json({ error: 'GET のみ受け付けます' }, 405, { Allow: 'GET' });
  }

  const session = await currentSession(request, env);
  if (!session) return unauthorized();

  if (path === '/api/me') {
    return json({ user: { name: session.name ?? null, badge: session.badge ?? null } });
  }

  const reportMatch = path.match(/^\/api\/reports\/([^/]+)$/);
  if (reportMatch) {
    const id = parseIdToken(reportMatch[1]);
    if (id == null) return json({ error: 'そのような口はありません' }, 404);
    // 本文の data-field-name は詳細ではなく編集画面にある。
    const originPath = `/reports/${id}/edit`;
    const refresh = url.searchParams.get('refresh') === '1';
    return json(await page(
      session.cookie, originPath, parseReportDetail, env, ctx, { refresh }
    ));
  }

  if (path === '/api/notifications/unread_count') {
    const userKey = await userCacheKey(session.cookie);
    const refresh = url.searchParams.get('refresh') === '1';
    const data = await pageCache.load({
      userKey,
      path: '/notifications/unread_count',
      ctx: refresh ? null : ctx,
      mode: refresh ? 'refresh' : 'swr',
      fetchFresh: async () => {
        const unread = await unreadCount(session.cookie);
        return {
          source: 'live',
          fetchedAt: new Date().toISOString(),
          ...unread
        };
      }
    });
    return json(data);
  }

  const target = PAGES[path];
  if (!target) return json({ error: 'そのような口はありません' }, 404);
  const refresh = url.searchParams.get('refresh') === '1';
  return json(await page(session.cookie, target[0], target[1], env, ctx, { refresh }));
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (!url.pathname.startsWith('/api/')) return env.ASSETS.fetch(request);

    try {
      return await handleApi(request, url, env, ctx);
    } catch (e) {
      const status = e instanceof ApiError ? e.status : 500;
      const payload = { error: e.message || String(e) };
      if (Array.isArray(e?.details) && e.details.length) payload.details = e.details;
      if (status !== 401) return json(payload, status);

      payload.code = 'unauthenticated';
      return e.clearSession
        ? json(payload, 401, { 'Set-Cookie': clearCookieHeader() })
        : json(payload, 401);
    }
  },

  async scheduled(_controller, env, ctx) {
    // 1 Cron ですべて処理せず、購読ごとに別 HTTP（別 CPU 枠）へ振る。
    ctx.waitUntil((async () => {
      const summary = await dispatchCronTicks(env, ctx, {
        baseUrl: 'https://mms-fork.mitac31709.workers.dev'
      });
      console.log('notify-cron-dispatch', JSON.stringify(summary));
    })());
  }
};
