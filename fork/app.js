/* フォークの入口。認証・ルーティング・シェルの配線だけを持つ。
 * 各画面の中身は `pages/*.js` にある。
 *
 * データは Worker の `/api/*` から取る。元アプリは Rails のサーバサイド
 * レンダリングで JSON をほとんど返さないので、Worker が HTML を JSON にしている。
 * `?demo=1` を付けたときと、`/api/*` が無い静的配信のときは同梱のデモデータに落ちる。
 *
 * キャッシュ表示のあとは `?refresh=1` で裏取得し、取れたら画面を差し替える。
 * 取得時刻の横の「更新」でも同じ再取得を起こせる。
 * レールから行ける他画面は先読みして遷移を速くする。
 */

import { Unauthenticated, api } from './api.js';
import {
  DEMO_FRESH_MS, DEMO_TA_USER, DEMO_USER, demoNotifications, demoUnreadCount,
  resetDemoCache
} from './demo.js';
import { fmtTime } from './format.js';
import {
  badgeLabel, clearState, createWatcher, loadPrefs, savePrefs, showBrowserNotification
} from './notify.js';
import {
  contentChanged, forget, forgetAll, reachableRoutes, recall, remember
} from './page-store.js';
import { h, panel, toasts, wirePanel } from './ui.js';

import * as dashboard from './pages/dashboard.js';
import * as orders from './pages/orders.js';
import * as equipments from './pages/equipments.js';
import * as loans from './pages/loans.js';
import * as reports from './pages/reports.js';
import * as notifications from './pages/notifications.js';
import * as taDashboard from './pages/ta-dashboard.js';
import * as taOrders from './pages/ta-orders.js';
import * as taReports from './pages/ta-reports.js';
import * as taTeams from './pages/ta-teams.js';
import * as taUsers from './pages/ta-users.js';

const STUDENT_PAGES = [dashboard, orders, equipments, loans, reports, notifications];
const TA_PAGES = [taDashboard, taOrders, taReports, taTeams, taUsers];
const PAGES = [...STUDENT_PAGES, ...TA_PAGES];
const BY_ROUTE = new Map(PAGES.map((p) => [p.meta.route, p]));
const STUDENT_ROUTES = STUDENT_PAGES.map((p) => p.meta.route);
const TA_ROUTES = TA_PAGES.map((p) => p.meta.route);

const STUDENT_NAV = [
  ['/dashboard', 'ダッシュボード'],
  ['/orders', '注文'],
  ['/equipments', '機材'],
  ['/loans', '貸出'],
  ['/reports', '週報']
];
const TA_NAV = [
  ['/ta', 'TAホーム'],
  ['/ta/orders', '注文'],
  ['/ta/reports', '週報'],
  ['/ta/teams', 'チーム'],
  ['/ta/users', 'ユーザー']
];

const el = {
  signin: document.getElementById('signin'),
  signinForm: document.getElementById('signin-form'),
  signinError: document.getElementById('signin-error'),
  signinSubmit: document.getElementById('signin-submit'),
  app: document.getElementById('app'),
  view: document.getElementById('view'),
  source: document.getElementById('data-source'),
  sourceNote: document.getElementById('data-source-note'),
  sourceRefresh: document.getElementById('data-source-refresh'),
  badge: document.getElementById('notification-badge'),
  userName: document.getElementById('user-name'),
  userMeta: document.getElementById('user-meta'),
  logout: document.getElementById('logout'),
  navToggle: document.getElementById('nav-toggle'),
  nav: document.getElementById('rail-nav'),
  railList: document.getElementById('rail-list'),
  modeSwitch: document.getElementById('mode-switch')
};

/** いまのビューモード（学生 / TA）。ログイン応答と切替で更新する。 */
let currentUser = null;

/** デモモードかどうかは URL で決める。以後の画面遷移でも維持する。 */
const isDemo = () => new URLSearchParams(location.search).get('demo') === '1';

function viewMode() {
  // ログイン／切替後の user.mode を最優先（デモの /ta URL に引っ張られない）
  if (currentUser?.mode === 'ta' || currentUser?.mode === 'student') {
    return currentUser.mode;
  }
  // 未ログインのデモで /ta 以下を直開きしたときだけ TA
  if (isDemo() && location.pathname.startsWith('/ta')) return 'ta';
  return 'student';
}

function defaultRoute() {
  return viewMode() === 'ta' ? '/ta' : '/dashboard';
}

function routesForMode(mode = viewMode()) {
  return mode === 'ta' ? TA_ROUTES : STUDENT_ROUTES;
}

const ctx = {
  get demo() { return isDemo(); },
  get user() { return currentUser; },
  today: new Date(),
  navigate,
  reload: () => render(currentRoute()),
  invalidate: (routes) => {
    for (const r of routes || []) forget(r);
  }
};
ctx.today.setHours(0, 0, 0, 0);

// ── データの出どころ表示 ──────────────────────────────
let refreshSeq = 0;

function applyRefreshBusy(busy) {
  el.sourceRefresh.disabled = busy;
  el.sourceRefresh.setAttribute('aria-busy', busy ? 'true' : 'false');
  if (busy) el.sourceRefresh.dataset.state = 'loading';
  else el.sourceRefresh.removeAttribute('data-state');
}

function setSource(kind, note) {
  el.source.dataset.kind = kind;
  el.sourceNote.textContent = note;
  el.source.hidden = false;
}

function noteFor(data) {
  const prefix = ctx.demo ? 'デモ · ' : '';
  const at = fmtTime(data?.fetchedAt);
  if (data?.source === 'live') {
    const label = ctx.demo ? '最新データ' : '元アプリのデータ';
    return ['live', `${prefix}${label}${at ? ` · ${at} 取得` : ''}`];
  }
  if (data?.revalidating) {
    return ['cache', `${prefix}キャッシュ${at ? ` · ${at} 取得` : ''}（裏で更新中）`];
  }
  if (data?.source === 'cache') {
    return ['cache', `${prefix}キャッシュ${at ? ` · ${at} 取得` : ''}`];
  }
  if (data?.source === 'stale') {
    return ['stale', `${prefix}前回のデータ${at ? ` · ${at} 取得` : ''}（更新待ち）`];
  }
  if (ctx.demo || data?.source === 'demo') {
    return ['demo', 'デモデータ（?demo=1）'];
  }
  return ['demo', 'デモデータ'];
}

function paint(route, data) {
  if (window.__haltAppPaint) return;
  const page = BY_ROUTE.get(route);
  if (!page || !data) return;
  const [kind, note] = noteFor(data);
  setSource(kind, note);
  el.view.replaceChildren(page.render(data, ctx));
}

// ── ルーティング ────────────────────────────────────
function currentRoute() {
  const path = location.pathname.replace(/\/+$/, '') || defaultRoute();
  if (BY_ROUTE.has(path)) return path;
  return defaultRoute();
}

function keepQuery(path) {
  const next = new URL(path, location.origin);
  if (new URLSearchParams(location.search).get('demo') === '1') {
    next.searchParams.set('demo', '1');
  }
  return `${next.pathname}${next.search}`;
}

function rebuildNav() {
  if (!el.railList) return;
  const mode = viewMode();
  const items = mode === 'ta' ? TA_NAV : STUDENT_NAV;
  el.railList.replaceChildren(...items.map(([route, label]) => h('li', {},
    h('a', { class: 'rail__link', href: route, 'data-route': route, text: label }))));

  if (el.modeSwitch) {
    const can = Boolean(currentUser?.canSwitch || currentUser?.canTa || isDemo());
    el.modeSwitch.hidden = !can;
    el.modeSwitch.textContent = mode === 'ta' ? '学生ビューへ' : 'TAビューへ';
    el.modeSwitch.dataset.mode = mode === 'ta' ? 'student' : 'ta';
  }

  const wordmark = document.querySelector('.wordmark');
  if (wordmark) {
    const home = defaultRoute();
    wordmark.setAttribute('href', home);
    wordmark.dataset.route = home;
  }
}

function navigate(path, { replace = false } = {}) {
  // パネルは URL を書き換える前に閉じる。閉じる処理が自分の画面の
  // クエリを同期するので、後で閉じると遷移先の URL に混ざる。
  panel.close({ silent: true });
  const url = keepQuery(path);
  if (replace) history.replaceState(null, '', url);
  else history.pushState(null, '', url);
  render(currentRoute());
}

function markNav(route) {
  document.querySelectorAll('.rail__link[data-route]').forEach((link) => {
    const active = link.dataset.route === route;
    link.classList.toggle('is-current', active);
    if (active) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  });
}

function errorBlock(message, onRetry) {
  return h('div', { class: 'empty' },
    h('p', { class: 'empty__title', text: '読み込めませんでした' }),
    h('p', { class: 'empty__body', text: message }),
    h('button', {
      class: 'btn btn--secondary empty__reset', type: 'button', onclick: onRetry
    }, 'もう一度試す'));
}

let renderToken = 0;
let prefetchGen = 0;

async function render(route) {
  const page = BY_ROUTE.get(route);
  if (!page) return;

  const token = ++renderToken;
  markNav(route);
  panel.close({ silent: true });
  document.title = `${page.meta.title} — Meister Management System`;

  // タブ内メモリがあれば即描画（遷移を待たせない）
  const mem = recall(route);
  if (mem) {
    applyRefreshBusy(Boolean(mem.revalidating || mem.source === 'stale'));
    paint(route, mem);
  } else {
    applyRefreshBusy(false);
    el.view.replaceChildren(h('p', { class: 'loading', text: '読み込み中…' }));
  }

  let data;
  try {
    data = await page.load(ctx);
  } catch (e) {
    if (token !== renderToken) return;
    if (e instanceof Unauthenticated) return showSignIn(e.message);
    applyRefreshBusy(false);
    if (!mem) {
      el.view.replaceChildren(errorBlock(e.message, () => render(route)));
      setSource('demo', `元アプリから取得できず（${e.message}）`);
    }
    return;
  }
  if (token !== renderToken) return;

  remember(route, data);
  const willRefresh = Boolean(data.revalidating || data.source === 'stale');
  if (willRefresh) applyRefreshBusy(true);
  if (contentChanged(mem, data) || !mem) paint(route, data);
  else setSource(...noteFor(data));

  // キャッシュ表示なら元を取り直して、取れたら画面を差し替える（デモも同じ）
  if (willRefresh) liveRefresh(route, token);

  prefetchReachable(route);
}

/** 取得時刻の横の「更新」。鮮度に関係なく元から取り直す。 */
function requestRefresh() {
  if (el.sourceRefresh.disabled) return;
  // 進行中の render() が古いキャッシュで上書きしないよう世代を進める
  liveRefresh(currentRoute(), ++renderToken);
}

/** 裏で refresh=1 し、今の画面なら DOM を更新する。 */
async function liveRefresh(route, token) {
  const page = BY_ROUTE.get(route);
  if (!page) return;
  const seq = ++refreshSeq;
  if (token === renderToken && currentRoute() === route) applyRefreshBusy(true);
  try {
    const fresh = await page.load(ctx, { refresh: true });
    if (token !== renderToken || currentRoute() !== route) {
      remember(route, fresh);
      return;
    }
    const prev = recall(route);
    remember(route, fresh);
    if (contentChanged(prev, fresh) || prev?.source !== 'live') paint(route, fresh);
    else setSource(...noteFor(fresh));
  } catch (e) {
    if (e instanceof Unauthenticated) return showSignIn(e.message);
    // 裏更新の失敗は今の表示を残す
  } finally {
    if (seq === refreshSeq && token === renderToken && currentRoute() === route) {
      applyRefreshBusy(false);
    }
  }
}

/** レールから行ける他画面を先に温める（メモリ + Worker キャッシュ）。 */
function prefetchReachable(fromRoute) {
  const gen = ++prefetchGen;
  const routes = reachableRoutes(routesForMode(), fromRoute);

  const run = async () => {
    for (const route of routes) {
      if (gen !== prefetchGen) return;
      const page = BY_ROUTE.get(route);
      if (!page) continue;
      // 直近メモリがあり新しそうなら飛ばす
      const mem = recall(route);
      if (mem?.fetchedAt) {
        const freshMs = ctx.demo ? DEMO_FRESH_MS : 45_000;
        const age = Date.now() - Date.parse(mem.fetchedAt);
        if (Number.isFinite(age) && age < freshMs) continue;
      }
      try {
        const data = await page.load(ctx);
        if (gen !== prefetchGen) return;
        remember(route, data);
      } catch {
        // 先読み失敗は無視（遷移時に改めて取る）
      }
    }
  };

  if (typeof requestIdleCallback === 'function') {
    requestIdleCallback(() => { run(); }, { timeout: 2000 });
  } else {
    setTimeout(run, 0);
  }
}

// ── ログイン ────────────────────────────────────────
function clearClientCaches() {
  forgetAll();
  resetDemoCache();
}

function showSignIn(message) {
  el.app.hidden = true;
  el.signin.hidden = false;
  el.source.hidden = true;
  clearClientCaches();
  if (message) {
    el.signinError.textContent = message;
    el.signinError.hidden = false;
  }
  document.title = 'ログイン — Meister Management System';
  document.getElementById('email').focus();
}

function showApp(user) {
  currentUser = user || null;
  el.signin.hidden = true;
  el.app.hidden = false;
  el.userName.textContent = user?.name || '';
  const metaBits = [];
  if (user?.badge) metaBits.push(user.badge);
  if (user?.mode === 'ta') metaBits.push('TA');
  el.userMeta.textContent = metaBits.join(' · ');
  rebuildNav();
  startNotifyWatcher();
}

async function switchMode(nextMode) {
  if (nextMode !== 'ta' && nextMode !== 'student') return;
  if (viewMode() === nextMode) return;

  if (ctx.demo) {
    currentUser = nextMode === 'ta' ? { ...DEMO_TA_USER } : { ...DEMO_USER };
    clearClientCaches();
    showApp(currentUser);
    navigate(defaultRoute(), { replace: true });
    return;
  }

  el.modeSwitch.disabled = true;
  try {
    const { user } = await api.switchViewMode(nextMode);
    clearClientCaches();
    showApp(user);
    navigate(defaultRoute(), { replace: true });
  } catch (e) {
    toasts.push(e.message || 'ビュー切替に失敗しました');
  } finally {
    el.modeSwitch.disabled = false;
  }
}

el.signinForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const email = document.getElementById('email').value.trim();
  const password = document.getElementById('password').value;

  el.signinError.hidden = true;
  el.signinSubmit.dataset.state = 'loading';
  try {
    const { user } = await api.login(email, password);
    document.getElementById('password').value = '';
    clearClientCaches();
    showApp(user);
    navigate(currentRoute(), { replace: true });
  } catch (err) {
    el.signinError.textContent = err.message;
    el.signinError.hidden = false;
    document.getElementById('password').select();
  } finally {
    delete el.signinSubmit.dataset.state;
  }
});

el.logout.addEventListener('click', async () => {
  stopNotifyWatcher();
  clearState();
  clearClientCaches();
  const prefs = loadPrefs();
  if (prefs.subscriptionId) {
    try {
      await api.unsubscribeNotify(prefs.subscriptionId);
    } catch {
      // ベストエフォート
    }
    savePrefs({ ...prefs, subscriptionId: null, discord: false });
  }

  // デモモードのログアウトはデモを抜ける。?demo=1 を残すとまた入ってしまう。
  // 静的配信では boot が ?demo=1 に戻すので、遷移せずログイン画面を出す。
  if (ctx.demo) {
    history.replaceState(null, '', '/dashboard');
    showSignIn(null);
    return;
  }

  try {
    await api.logout();
  } catch {
    // 元アプリ側のログアウトが失敗しても、こちらのセッションは落とす
  }
  location.href = '/dashboard';
});

// ── 変更通知の監視 ──────────────────────────────────
function setBadge(count) {
  const label = badgeLabel(count);
  if (label) {
    el.badge.textContent = label;
    el.badge.hidden = false;
  } else {
    el.badge.hidden = true;
  }
}

const watcher = createWatcher({
  origin: location.origin,
  getPrefs: loadPrefs,
  isVisible: () => document.visibilityState !== 'hidden',
  onBadge: setBadge,
  unreadCount: async () => {
    if (ctx.demo) return demoUnreadCount();
    // キャッシュのままだと未読の増加を見逃して Discord に届かない。
    const result = await api.unreadCount({ refresh: true });
    // ポーリングのついでに購読の Cookie を更新（タブを閉じたあともしばらく使えるように）
    refreshBackgroundSubscription();
    return result;
  },
  notifications: async () => {
    if (ctx.demo) return demoNotifications();
    return api.notifications({ refresh: true });
  },
  showBrowser: showBrowserNotification,
  sendDiscord: async (payload, webhookUrl) => {
    if (ctx.demo) {
      try {
        await api.notifyDiscord(webhookUrl, payload);
      } catch (e) {
        if (e instanceof Unauthenticated) {
          throw new Error('Discord へ送るにはログインが必要です（Worker 経由）');
        }
        throw e;
      }
      return;
    }
    await api.notifyDiscord(webhookUrl, payload);
  }
});

// 通知画面の届け先設定から参照する。
ctx.watcher = watcher;

/** タブが開いている間、購読の Rails Cookie を書き戻して寿命を延ばす。 */
async function refreshBackgroundSubscription() {
  if (ctx.demo) return;
  const prefs = loadPrefs();
  if (!prefs.discord || !prefs.subscriptionId) return;
  try {
    await api.refreshNotifySubscription(prefs.subscriptionId);
  } catch {
    // 失効や欠落は次の保存で作り直す
  }
}

function startNotifyWatcher() {
  watcher.stop();
  watcher.start();
  refreshBackgroundSubscription();
}

function stopNotifyWatcher() {
  watcher.stop();
}

// ── シェルの配線 ────────────────────────────────────
document.addEventListener('click', (e) => {
  const link = e.target.closest('a[data-route]');
  if (!link) return;
  if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
  e.preventDefault();
  navigate(link.dataset.route);
  el.nav.classList.remove('is-open');
  el.navToggle.setAttribute('aria-expanded', 'false');
});

window.addEventListener('popstate', () => render(currentRoute()));

el.navToggle.addEventListener('click', () => {
  const open = el.nav.classList.toggle('is-open');
  el.navToggle.setAttribute('aria-expanded', String(open));
});

if (el.modeSwitch) {
  el.modeSwitch.addEventListener('click', () => {
    switchMode(el.modeSwitch.dataset.mode || 'ta');
  });
}

wirePanel();

el.sourceRefresh.addEventListener('click', requestRefresh);

// ── 起動 ───────────────────────────────────────────
async function boot() {
  if (ctx.demo) {
    const demoUser = location.pathname.startsWith('/ta')
      ? { ...DEMO_TA_USER }
      : { ...DEMO_USER };
    showApp(demoUser);
    render(currentRoute());
    return;
  }

  try {
    const { user } = await api.me();
    showApp(user);
    // TA モードなのに学生 URL のままならホームへ寄せない（深いリンクを残す）。
    // 未知パスだけ defaultRoute に落ちる。
    render(currentRoute());
  } catch (e) {
    if (e instanceof Unauthenticated) {
      showSignIn(null);
      return;
    }
    // `/api` が無い静的配信ではログインできない。デモに落として理由を出す。
    const demoUser = location.pathname.startsWith('/ta')
      ? { ...DEMO_TA_USER }
      : { ...DEMO_USER };
    showApp(demoUser);
    setSource('demo', `デモデータ · 元アプリに接続できず（${e.message}）`);
    history.replaceState(null, '', `${currentRoute()}?demo=1`);
    render(currentRoute());
  }
}

boot();
