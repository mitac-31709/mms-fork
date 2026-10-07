/* Worker の `/api/*` を叩く薄い層。
 *
 * 元アプリは JSON をほとんど返さないので、Worker が HTML を JSON に変換している。
 * ここはその口を呼ぶだけ。デモモードのときは `demo.js` が同じ形を返す。
 *
 * opts.refresh === true のときは Worker に元アプリ再取得を強制する
 * （キャッシュ表示のあと、クライアントがライブ更新するとき）。
 */

export class Unauthenticated extends Error {}

async function request(path, init = {}) {
  const refresh = Boolean(init.refresh);
  const opts = { ...init };
  delete opts.refresh;

  let url = path;
  if (refresh) {
    const u = new URL(path, location.origin);
    u.searchParams.set('refresh', '1');
    url = u.pathname + u.search;
  }

  const res = await fetch(url, {
    ...opts,
    headers: { Accept: 'application/json', ...(opts.headers || {}) }
  });

  let body = null;
  try {
    body = await res.json();
  } catch {
    // JSON でない応答（静的配信で /api が無い等）はステータスだけで判断する
  }

  if (res.status === 401) throw new Unauthenticated(body?.error || 'ログインしてください');
  if (!res.ok) throw new Error(body?.error || `HTTP ${res.status}`);
  return body;
}

export const api = {
  me: () => request('/api/me'),
  login: (email, password) => request('/api/session', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password })
  }),
  logout: () => request('/api/session', { method: 'DELETE' }),

  /** TA / 学生ビュー切替。成功すると user.mode が返る。 */
  switchViewMode: (mode) => request('/api/view_mode', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ mode })
  }),

  dashboard: (opts) => request('/api/dashboard', opts),
  reports: (opts) => request('/api/reports', opts),
  report: (id, opts) => request(`/api/reports/${encodeURIComponent(id)}`, opts),
  /** 週報の 1 項目を元アプリへ保存する。本文は auto_save、日付はフォーム更新。 */
  saveReportField: (id, fieldName, content) => request(`/api/reports/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ fieldName, content })
  }),
  orders: (opts) => request('/api/orders', opts),
  /** 注文詳細（注文ステータス履歴つき）。元アプリの `/orders/:id` を読む。 */
  order: (id, opts) => request(`/api/orders/${encodeURIComponent(id)}`, opts),
  equipments: (opts) => request('/api/equipments', opts),
  loans: (opts) => request('/api/loans', opts),
  notifications: (opts) => request('/api/notifications', opts),
  unreadCount: (opts) => request('/api/notifications/unread_count', opts),
  /** 1 件を既読にする。Worker が元アプリの mark_as_read を中継する。 */
  markNotificationRead: (id) => request(
    `/api/notifications/${encodeURIComponent(id)}/mark_as_read`,
    { method: 'PATCH' }
  ),
  /** すべて既読。 */
  markAllNotificationsRead: () => request('/api/notifications/mark_all_as_read', {
    method: 'PATCH'
  }),

  // ── TA ──────────────────────────────────────────
  taDashboard: (opts) => request('/api/ta', opts),
  taOrders: (opts) => request('/api/ta/orders', opts),
  taOrder: (id, opts) => request(`/api/ta/orders/${encodeURIComponent(id)}`, opts),
  taBulkAvailable: (orderIds) => request('/api/ta/orders/bulk_update_status', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ orderIds, status: 'available' })
  }),
  taReports: (opts = {}) => {
    const refresh = Boolean(opts.refresh);
    const submissionId = opts.submissionId || opts.submission_id || null;
    const u = new URL('/api/ta/reports', location.origin);
    if (submissionId) u.searchParams.set('submission_id', submissionId);
    if (refresh) u.searchParams.set('refresh', '1');
    return request(u.pathname + u.search);
  },
  /** TA 週報の詳細（読み取り専用）。元アプリの `/ta/reports/:id` を読む。 */
  taReport: (id, opts) => request(`/api/ta/reports/${encodeURIComponent(id)}`, opts),
  taTeams: (opts) => request('/api/ta/teams', opts),
  taUsers: (opts) => request('/api/ta/users', opts),

  /** Discord Incoming Webhook へ Worker 経由で送る。即時中継（URL は残さない）。 */
  notifyDiscord: (webhookUrl, payload) => request('/api/notify/discord', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ webhookUrl, payload })
  }),

  /** タブ閉鎖後も Discord へ送る購読を登録する（Webhook とセッションを KV に封印）。 */
  subscribeNotify: (webhookUrl, id = null) => request('/api/notify/subscribe', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ webhookUrl, id })
  }),

  /** 開いている間に Rails Cookie を書き戻す。 */
  refreshNotifySubscription: (id) => request('/api/notify/subscribe', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id })
  }),

  unsubscribeNotify: (id) => request('/api/notify/subscribe', {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id })
  }),

  /** 元アプリへ新しい注文を作る。Worker が Devise セッションで中継する。 */
  createOrder: (fields) => request('/api/orders', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(fields)
  })
};
