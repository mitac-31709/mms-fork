/* 元アプリ（Meister Management System）へのアクセス。
 *
 * 元アプリは Rails のサーバサイドレンダリングで、JSON を返すのは
 * `/notifications/unread_count` だけ。他の画面は HTML を取って parse 側で JSON にする。
 *
 * セッションは**利用者ごと**。Worker 側に共有のログイン状態を持たない。
 * 画面 JSON のキャッシュは `page-cache.js` がセッション区画で行う（ここではしない）。
 */

import {
  authenticityToken, csrfToken, looksLikeSignIn, parseIdToken, parseReportFields
} from './parse.js';

export const ORIGIN = 'https://meister.tokyo-ct.org';
const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

export class ApiError extends Error {
  /** clearSession: この 401 でブラウザの Cookie も落とすか。
   *  資格情報の入力ミスで既存のセッションを壊さないため、既定は false。
   *  details: 422 のときなど、画面に並べる追加の文言。 */
  constructor(status, message, { clearSession = false, details = null } = {}) {
    super(message);
    this.status = status;
    this.clearSession = clearSession;
    this.details = details;
  }
}

function sessionCookieFrom(response) {
  const jar = [];
  for (const raw of response.headers.getSetCookie()) {
    const [pair] = raw.split(';');
    if (pair && pair.startsWith('_meister_management_system_session=')) jar.push(pair);
  }
  return jar.length ? jar[jar.length - 1] : null;
}

async function origin(path, init = {}, cookie) {
  const headers = {
    'User-Agent': UA,
    'Accept-Language': 'ja,en-US;q=0.9,en;q=0.8',
    ...(init.headers || {})
  };
  if (cookie) headers.Cookie = cookie;
  return fetch(`${ORIGIN}${path}`, { ...init, headers, redirect: 'manual' });
}

/** 利用者の資格情報で元アプリにログインし、セッション Cookie を返す。
 *  資格情報はここから先に持ち出さない（保存もしない）。 */
export async function signIn(email, password) {
  if (!email || !password) {
    throw new ApiError(400, 'メールアドレスとパスワードを入力してください');
  }

  const formPage = await origin('/users/sign_in', { headers: { Accept: 'text/html' } });
  if (formPage.status !== 200) {
    throw new ApiError(502, `元アプリのサインイン画面が ${formPage.status} を返しました`);
  }
  const preCookie = sessionCookieFrom(formPage);
  const token = authenticityToken(await formPage.text());
  if (!token) throw new ApiError(502, '元アプリの authenticity_token が見つかりません');

  const body = new URLSearchParams({
    authenticity_token: token,
    remember: 'true',
    'user[email]': email,
    'user[password]': password,
    'user[remember_me]': '0',
    commit: 'ログイン'
  });

  const posted = await origin('/users/sign_in', {
    method: 'POST',
    body: body.toString(),
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'text/html',
      Origin: ORIGIN,
      Referer: `${ORIGIN}/users/sign_in`
    }
  }, preCookie);

  // 成功は 3xx（Rails 7 + Turbo は 303）。失敗は 422 だが理由が 2 通りある。
  if (posted.status === 422) {
    const html = await posted.text();
    if (html.includes('メールアドレスまたはパスワードが違います')) {
      throw new ApiError(401, 'メールアドレスまたはパスワードが違います。');
    }
    if (/InvalidAuthenticityToken|authenticity/i.test(html)) {
      throw new ApiError(502, 'CSRF トークンが通りませんでした（セッション Cookie が送れていない）');
    }
    throw new ApiError(502, `ログインが 422 で失敗しました（本文の先頭: ${html.slice(0, 120)}）`);
  }

  const redirected = posted.status >= 300 && posted.status < 400;
  const cookie = sessionCookieFrom(posted) || preCookie;
  if (!redirected || !cookie) {
    throw new ApiError(502, `元アプリのログイン応答が想定外です（${posted.status}）`);
  }
  return cookie;
}

/** 元アプリからログアウトする。
 *
 * 元アプリのセッションは Rails の cookie_store で、中身が Cookie 自体に入っている。
 * そのためサインアウトしても**発行済みの Cookie 値は無効にならない**
 * （実測: サインアウト後に古い Cookie で `/reports` を叩くと 200 が返る）。
 * サーバ側に破棄できる状態が無いので、これは元アプリの性質でここでは直せない。
 *
 * ここでできるのは、サインアウトを element として成立させ、
 * こちらが持っている Cookie を匿名のものに差し替えることまで。
 * 併せて自ドメインの Cookie を消す（呼び出し側）。
 * 結果は握り潰さず応答に載せる。
 */
export async function signOut(cookie) {
  try {
    const page = await origin('/dashboard', { headers: { Accept: 'text/html' } }, cookie);
    const html = await page.text();
    const token = authenticityToken(html, { formAction: '/users/sign_out' })
      || authenticityToken(html);
    if (!token) {
      return { ok: false, reason: `authenticity_token が取れない（/dashboard が ${page.status}）` };
    }

    // Rails のセッションは Cookie に入っていて応答ごとに再発行される。
    // CSRF トークンはその応答で返った Cookie と対なので、更新されていれば
    // そちらを使う。元の Cookie で投げると 422 になる。
    const fresh = sessionCookieFrom(page) || cookie;

    const res = await origin('/users/sign_out', {
      method: 'POST',
      body: new URLSearchParams({ _method: 'delete', authenticity_token: token }).toString(),
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'text/html',
        Origin: ORIGIN,
        Referer: `${ORIGIN}/dashboard`
      }
    }, fresh);

    if (res.status >= 400) {
      return { ok: false, reason: `/users/sign_out が ${res.status}` };
    }

    // サインアウトが通ったかは、応答で返る新しい Cookie が匿名になっているかで見る。
    // 古い Cookie 値が死んだかは見ない（cookie_store なので死なない）。
    const after = sessionCookieFrom(res);
    if (!after || after === fresh) {
      return { ok: false, reason: 'サインアウト後もセッション Cookie が差し替わらない' };
    }

    const probe = await origin('/reports', { headers: { Accept: 'text/html' } }, after);
    const location = probe.headers.get('Location') || '';
    const anonymous = probe.status >= 300 && probe.status < 400
      && location.includes('/users/sign_in');
    return anonymous
      ? { ok: true }
      : { ok: false, reason: `差し替わった Cookie でも /reports が ${probe.status}` };
  } catch (e) {
    return { ok: false, reason: e.message || String(e) };
  }
}

/** ログイン済みのセッションで GET する。
 *  失効していたら 401 を投げる（利用者に再ログインしてもらう）。 */
export async function get(cookie, path, accept = 'text/html') {
  const res = await origin(path, { headers: { Accept: accept } }, cookie);

  if (res.status >= 300 && res.status < 400) {
    const location = res.headers.get('Location') || '';
    if (location.includes('/users/sign_in')) {
      throw new ApiError(401, 'ログインの有効期限が切れました。もう一度ログインしてください。',
        { clearSession: true });
    }
    return { status: res.status, redirectedTo: location, body: '' };
  }

  const body = await res.text();
  if (looksLikeSignIn(body)) {
    throw new ApiError(401, 'ログインの有効期限が切れました。もう一度ログインしてください。',
      { clearSession: true });
  }
  return { status: res.status, redirectedTo: null, body };
}

/** HTML を取る。200 以外は例外にする。 */
export async function html(cookie, path) {
  const res = await get(cookie, path);
  if (res.status !== 200) {
    throw new ApiError(502, `元アプリの ${path} が ${res.status} を返しました`
      + (res.redirectedTo ? `（→ ${res.redirectedTo}）` : ''));
  }
  return res.body;
}

/** 元アプリが唯一 JSON で返す口。 */
export async function unreadCount(cookie) {
  const res = await get(cookie, '/notifications/unread_count', 'application/json');
  if (res.status !== 200) {
    throw new ApiError(502, `元アプリの /notifications/unread_count が ${res.status} を返しました`);
  }
  try {
    return JSON.parse(res.body);
  } catch {
    throw new ApiError(502, '未読通知数の応答が JSON ではありません');
  }
}

const SALES_SITE_TYPES = new Set(['amazon', 'monotaro', 'akizuki', 'other']);

/** Rails のフォームエラーを拾う。実物の失敗画面は見ていないので、
 *  よくある `#error_explanation` / `.field_with_errors` / flash を見る。 */
export function parseFormErrors(html) {
  const errors = [];
  const block = html.match(/id="error_explanation"[^>]*>([\s\S]*?)<\/div>/i)
    || html.match(/class="[^"]*error_explanation[^"]*"[^>]*>([\s\S]*?)<\/div>/i);
  if (block) {
    const liRe = /<li\b[^>]*>([\s\S]*?)<\/li>/gi;
    let m;
    while ((m = liRe.exec(block[1]))) {
      const msg = textFromHtml(m[1]);
      if (msg) errors.push(msg);
    }
  }
  const alert = html.match(/class="[^"]*(?:alert|flash)[^"]*"[^>]*>([\s\S]*?)<\/(?:div|p)>/i);
  if (alert) {
    const msg = textFromHtml(alert[1]);
    if (msg && !errors.includes(msg)) errors.push(msg);
  }
  return errors;
}

function textFromHtml(html) {
  return String(html || '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** 注文を元アプリへ作る。フォームは `/orders/new` の authenticity_token を使う。 */
export async function createOrder(cookie, fields) {
  const productName = String(fields?.productName ?? '').trim();
  const amount = Number(fields?.amount);
  const quantity = Number(fields?.quantity);
  const salesSiteType = String(fields?.salesSiteType ?? '').trim();
  const shopName = String(fields?.shopName ?? '').trim();
  const modelNumber = String(fields?.modelNumber ?? '').trim();
  const productUrl = String(fields?.productUrl ?? '').trim();
  const memo = String(fields?.memo ?? '').trim();

  if (!productName) throw new ApiError(400, '商品名を入力してください');
  if (!Number.isFinite(amount) || amount < 0 || !Number.isInteger(amount)) {
    throw new ApiError(400, '単価は 0 以上の整数で入力してください');
  }
  if (!Number.isFinite(quantity) || quantity < 1 || !Number.isInteger(quantity)) {
    throw new ApiError(400, '数量は 1 以上の整数で入力してください');
  }
  if (!SALES_SITE_TYPES.has(salesSiteType)) {
    throw new ApiError(400, '販売サイトを選んでください');
  }
  if (!shopName) throw new ApiError(400, '販売サイト名を入力してください');
  if (productUrl && !/^https?:\/\//i.test(productUrl)) {
    throw new ApiError(400, '商品 URL は http(s) で始めてください');
  }

  const formPage = await origin('/orders/new', { headers: { Accept: 'text/html' } }, cookie);
  const formHtml = await formPage.text();
  if (formPage.status !== 200 || looksLikeSignIn(formHtml)) {
    throw new ApiError(401, 'ログインの有効期限が切れました。もう一度ログインしてください。',
      { clearSession: true });
  }
  // per-form CSRF: ページ先頭のログアウト用トークンではなく /orders フォームのものを使う。
  const token = authenticityToken(formHtml, { formAction: '/orders' });
  if (!token) throw new ApiError(502, '注文フォームの authenticity_token が見つかりません');

  // CSRF は応答で返った Cookie と対なので、更新されていればそちらを使う。
  const fresh = sessionCookieFrom(formPage) || cookie;

  const body = new URLSearchParams({
    authenticity_token: token,
    'order[product_name]': productName,
    'order[amount]': String(amount),
    'order[quantity]': String(quantity),
    'order[sales_site_type]': salesSiteType,
    'order[shop_name]': shopName,
    'order[model_number]': modelNumber,
    'order[product_url]': productUrl,
    'order[memo]': memo,
    commit: '注文を作成'
  });

  const posted = await origin('/orders', {
    method: 'POST',
    body: body.toString(),
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'text/html',
      Origin: ORIGIN,
      Referer: `${ORIGIN}/orders/new`
    }
  }, fresh);

  if (posted.status >= 300 && posted.status < 400) {
    const location = posted.headers.get('Location') || '';
    return {
      ok: true,
      redirectedTo: location || '/orders',
      cookie: sessionCookieFrom(posted) || fresh
    };
  }

  const htmlBody = await posted.text();
  if (looksLikeSignIn(htmlBody)) {
    throw new ApiError(401, 'ログインの有効期限が切れました。もう一度ログインしてください。',
      { clearSession: true });
  }

  if (/InvalidAuthenticityToken|ActionController::InvalidAuthenticityToken/i.test(htmlBody)) {
    console.error('createOrder CSRF failed:', posted.status, htmlBody.slice(0, 200));
    throw new ApiError(502, 'CSRF トークンが通りませんでした（注文フォームのトークンを確認してください）');
  }

  if (posted.status === 422 || posted.status === 200) {
    const errors = parseFormErrors(htmlBody);
    if (!errors.length) {
      console.error('createOrder rejected:', posted.status, htmlBody.slice(0, 300));
    }
    throw new ApiError(422, errors[0] || '注文を作成できませんでした', {
      details: errors
    });
  }

  throw new ApiError(502, `元アプリの注文作成が ${posted.status} を返しました`);
}

/** 共同編集の auto_save が受け付ける本文項目。 */
const REPORT_TEXT_FIELDS = new Set(['shortnote', 'progress', 'issue', 'plan']);
/** 編集フォームの項目。日付はフォーム PATCH、本文は auto_save。 */
const REPORT_FORM_FIELDS = ['start_at', 'end_at', 'shortnote', 'progress', 'issue', 'plan'];

/**
 * 週報の 1 項目を元アプリへ保存する。
 * 本文（概要 / 進捗 / 課題 / 計画）は `PATCH /reports/:id/auto_save`。
 * 開始日・終了日は編集フォームを、今の値を崩さないように埋めて PATCH する。
 */
export async function saveReportField(cookie, id, fieldName, content) {
  const reportId = parseIdToken(id);
  if (reportId == null) throw new ApiError(400, '週報の id が不正です');
  if (!REPORT_FORM_FIELDS.includes(fieldName)) {
    throw new ApiError(400, 'その項目は保存できません');
  }
  if (typeof content !== 'string') throw new ApiError(400, '保存する内容が必要です');
  if (content.length > 20000) throw new ApiError(400, '本文が長すぎます');

  const editPath = `/reports/${reportId}/edit`;
  const formPage = await origin(editPath, { headers: { Accept: 'text/html' } }, cookie);
  const formHtml = await formPage.text();
  if (formPage.status !== 200 || looksLikeSignIn(formHtml)) {
    throw new ApiError(401, 'ログインの有効期限が切れました。もう一度ログインしてください。',
      { clearSession: true });
  }
  const token = csrfToken(formHtml);
  if (!token) throw new ApiError(502, '週報フォームの authenticity_token が見つかりません');
  const fresh = sessionCookieFrom(formPage) || cookie;

  if (REPORT_TEXT_FIELDS.has(fieldName)) {
    const posted = await origin(`/reports/${reportId}/auto_save`, {
      method: 'PATCH',
      body: JSON.stringify({ field_name: fieldName, content }),
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'X-CSRF-Token': token,
        'X-Requested-With': 'XMLHttpRequest',
        Origin: ORIGIN,
        Referer: `${ORIGIN}${editPath}`
      }
    }, fresh);

    const body = await posted.text();
    if (posted.status === 401 || looksLikeSignIn(body)) {
      throw new ApiError(401, 'ログインの有効期限が切れました。もう一度ログインしてください。',
        { clearSession: true });
    }
    if (posted.status >= 200 && posted.status < 300) {
      let parsed = null;
      if (body) {
        try { parsed = JSON.parse(body); } catch { /* HTML 成功もありうる */ }
      }
      if (parsed && parsed.success === false) {
        throw new ApiError(422, parsed.error || '週報を保存できませんでした');
      }
      return {
        ok: true,
        id: reportId,
        fieldName,
        cookie: sessionCookieFrom(posted) || fresh
      };
    }
    if (posted.status === 422) {
      let parsed = null;
      try { parsed = JSON.parse(body); } catch { /* HTML の 422 もある */ }
      const errors = parsed?.error ? [parsed.error] : parseFormErrors(body);
      throw new ApiError(422, errors[0] || '週報を保存できませんでした', { details: errors });
    }
    if (posted.status !== 404) {
      throw new ApiError(502, `元アプリの自動保存が ${posted.status} を返しました`);
    }
    // 404 のときだけフォーム更新に落とす（auto_save が無い項目）
  }

  // ページ先頭はログアウト用トークンなので、週報フォームのものを使う。
  const formToken = authenticityToken(formHtml, { formAction: `/reports/${reportId}` }) || token;
  const current = {};
  for (const field of parseReportFields(formHtml)) {
    if (REPORT_FORM_FIELDS.includes(field.name)) current[field.name] = field.value || '';
  }
  current[fieldName] = content;

  const params = new URLSearchParams();
  params.set('authenticity_token', formToken);
  params.set('_method', 'patch');
  for (const name of REPORT_FORM_FIELDS) {
    if (current[name] != null) params.set(`report[${name}]`, current[name]);
  }
  params.set('commit', 'レポートを更新');

  const posted = await origin(`/reports/${reportId}`, {
    method: 'POST',
    body: params.toString(),
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'text/html',
      Origin: ORIGIN,
      Referer: `${ORIGIN}${editPath}`
    }
  }, fresh);

  if (posted.status >= 300 && posted.status < 400) {
    return {
      ok: true,
      id: reportId,
      fieldName,
      cookie: sessionCookieFrom(posted) || fresh
    };
  }

  const htmlBody = await posted.text();
  if (looksLikeSignIn(htmlBody)) {
    throw new ApiError(401, 'ログインの有効期限が切れました。もう一度ログインしてください。',
      { clearSession: true });
  }
  if (posted.status === 200) {
    const errors = parseFormErrors(htmlBody);
    if (!errors.length) {
      return {
        ok: true,
        id: reportId,
        fieldName,
        cookie: sessionCookieFrom(posted) || fresh
      };
    }
    throw new ApiError(422, errors[0] || '週報を保存できませんでした', { details: errors });
  }
  if (posted.status === 422) {
    const errors = parseFormErrors(htmlBody);
    throw new ApiError(422, errors[0] || '週報を保存できませんでした', { details: errors });
  }
  throw new ApiError(502, `元アプリの週報更新が ${posted.status} を返しました`);
}

/** 通知ページから CSRF を取り、既読 API を叩くときの共通前段。 */
async function notificationCsrf(cookie) {
  const page = await origin('/notifications', { headers: { Accept: 'text/html' } }, cookie);
  const pageHtml = await page.text();
  if (page.status !== 200 || looksLikeSignIn(pageHtml)) {
    throw new ApiError(401, 'ログインの有効期限が切れました。もう一度ログインしてください。',
      { clearSession: true });
  }
  const token = csrfToken(pageHtml);
  if (!token) throw new ApiError(502, '通知画面の CSRF トークンが見つかりません');
  return { token, cookie: sessionCookieFrom(page) || cookie };
}

/**
 * 1 件を既読にする。元アプリの `PATCH /notifications/:id/mark_as_read`
 * （`notification_list_controller` / `notifications.js` と同じ口）。
 */
export async function markNotificationRead(cookie, id) {
  const nid = parseIdToken(id);
  if (nid == null) throw new ApiError(400, '通知の id が不正です');

  const { token, cookie: fresh } = await notificationCsrf(cookie);
  const posted = await origin(`/notifications/${nid}/mark_as_read`, {
    method: 'PATCH',
    body: '{}',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'text/vnd.turbo-stream.html, application/json, */*',
      'X-CSRF-Token': token,
      'X-Requested-With': 'XMLHttpRequest',
      Origin: ORIGIN,
      Referer: `${ORIGIN}/notifications`
    }
  }, fresh);

  const body = await posted.text();
  if (posted.status === 401 || looksLikeSignIn(body)) {
    throw new ApiError(401, 'ログインの有効期限が切れました。もう一度ログインしてください。',
      { clearSession: true });
  }
  if (posted.status === 404) {
    throw new ApiError(404, 'その通知は見つかりません');
  }
  if (posted.status < 200 || posted.status >= 300) {
    throw new ApiError(502, `元アプリの既読化が ${posted.status} を返しました`);
  }
  return {
    ok: true,
    id: nid,
    cookie: sessionCookieFrom(posted) || fresh
  };
}

/**
 * すべて既読。元アプリの `PATCH /notifications/mark_all_as_read`。
 */
export async function markAllNotificationsRead(cookie) {
  const { token, cookie: fresh } = await notificationCsrf(cookie);
  const posted = await origin('/notifications/mark_all_as_read', {
    method: 'PATCH',
    body: '{}',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'text/vnd.turbo-stream.html, application/json, */*',
      'X-CSRF-Token': token,
      'X-Requested-With': 'XMLHttpRequest',
      Origin: ORIGIN,
      Referer: `${ORIGIN}/notifications`
    }
  }, fresh);

  const body = await posted.text();
  if (posted.status === 401 || looksLikeSignIn(body)) {
    throw new ApiError(401, 'ログインの有効期限が切れました。もう一度ログインしてください。',
      { clearSession: true });
  }
  if (posted.status < 200 || posted.status >= 300) {
    throw new ApiError(502, `元アプリの一括既読が ${posted.status} を返しました`);
  }
  return {
    ok: true,
    cookie: sessionCookieFrom(posted) || fresh
  };
}
