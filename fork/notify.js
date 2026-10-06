/* 変更通知の届け先。
 *
 * 元アプリの未読件数が増えたら、ブラウザの Notification と Discord Webhook へ
 * 届ける。ブラウザ側の設定は localStorage。Discord のバックグラウンド配信は
 * Worker の KV 購読（封印したセッション + Webhook）でタブ閉鎖後も動く。
 *
 * 初回の観測は基準値にするだけで送らない。ログイン直後に既存の未読を
 * まとめて飛ばさないため。
 */

const PREFS_KEY = 'mms.notify.v1';
const STATE_KEY = 'mms.notify.state.v1';
/** 届け先フォームを初回だけ開いたことを覚える。 */
const INTRO_KEY = 'mms.notify.introSeen.v1';

/** 表示中は 60 秒、隠れているときは 5 分。元アプリの 5 分ポーリングを下限に。 */
export const POLL_VISIBLE_MS = 60_000;
export const POLL_HIDDEN_MS = 300_000;

/** Cobalt アクセントに近い Discord embed 色 */
export const DISCORD_COLOR = 0x2f6fed;

export const DEFAULT_PREFS = Object.freeze({
  browser: false,
  discord: false,
  webhookUrl: '',
  subscriptionId: null
});

export function loadPrefs(storage = localStorage) {
  try {
    const raw = storage.getItem(PREFS_KEY);
    if (!raw) return { ...DEFAULT_PREFS };
    const parsed = JSON.parse(raw);
    return {
      browser: Boolean(parsed?.browser),
      discord: Boolean(parsed?.discord),
      webhookUrl: typeof parsed?.webhookUrl === 'string' ? parsed.webhookUrl : '',
      subscriptionId: typeof parsed?.subscriptionId === 'string' && parsed.subscriptionId
        ? parsed.subscriptionId
        : null
    };
  } catch {
    return { ...DEFAULT_PREFS };
  }
}

export function savePrefs(prefs, storage = localStorage) {
  const next = {
    browser: Boolean(prefs.browser),
    discord: Boolean(prefs.discord),
    webhookUrl: typeof prefs.webhookUrl === 'string' ? prefs.webhookUrl.trim() : '',
    subscriptionId: typeof prefs.subscriptionId === 'string' && prefs.subscriptionId
      ? prefs.subscriptionId
      : null
  };
  storage.setItem(PREFS_KEY, JSON.stringify(next));
  return next;
}

/** 届け先の説明を一度でも見たか（閉じる／保存で true）。 */
export function hasSeenDeliveryIntro(storage = localStorage) {
  try {
    return storage.getItem(INTRO_KEY) === '1';
  } catch {
    return false;
  }
}

export function markDeliveryIntroSeen(storage = localStorage) {
  try {
    storage.setItem(INTRO_KEY, '1');
  } catch {
    // private mode などでは覚えられないが、操作自体は続行する
  }
}

export function loadState(storage = sessionStorage) {
  try {
    const raw = storage.getItem(STATE_KEY);
    if (!raw) return { primed: false, count: 0, seenIds: [] };
    const parsed = JSON.parse(raw);
    return {
      primed: Boolean(parsed?.primed),
      count: Number.isFinite(parsed?.count) ? parsed.count : 0,
      seenIds: Array.isArray(parsed?.seenIds)
        ? parsed.seenIds.map(String).slice(0, 200)
        : []
    };
  } catch {
    return { primed: false, count: 0, seenIds: [] };
  }
}

export function saveState(state, storage = sessionStorage) {
  const next = {
    primed: Boolean(state.primed),
    count: Number.isFinite(state.count) ? state.count : 0,
    seenIds: Array.isArray(state.seenIds) ? state.seenIds.map(String).slice(0, 200) : []
  };
  storage.setItem(STATE_KEY, JSON.stringify(next));
  return next;
}

export function clearState(storage = sessionStorage) {
  storage.removeItem(STATE_KEY);
}

/** 未読件数と通知一覧から「新しく届いたもの」を取り出す。 */
export function pickNewNotifications({ prev, count, notifications }) {
  const items = Array.isArray(notifications) ? notifications : [];
  const seen = new Set((prev.seenIds || []).map(String));
  const countGrew = typeof count === 'number' && count > (prev.count || 0);

  // 未読と分かるもの、または id が新規のもの。read === true は既読なので除外。
  const candidates = items.filter((n) => {
    if (!n || n.id == null) return false;
    if (n.read === true) return false;
    return !seen.has(String(n.id));
  });

  // 初回は基準を取るだけ。既存の未読を飛ばさない。
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

  // 件数が増えていなくても、新しい id が来ていれば届ける。
  const shouldNotify = countGrew || candidates.length > 0;
  let fresh = shouldNotify ? candidates : [];

  // 一覧から id が 1 件も取れないときは、未読件数の増加だけで届ける。
  // 既知の id しか無いのに件数だけ増えた場合は送らない（二重送信を避ける）。
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

export function badgeLabel(count) {
  if (!count || count <= 0) return null;
  return count <= 99 ? String(count) : '99+';
}

export function buildDiscordPayload(items, { origin } = {}) {
  const list = (items || []).slice(0, 5);
  const embeds = list.map((n) => {
    const embed = {
      title: String(n.title || '新しい通知').slice(0, 256),
      color: DISCORD_COLOR,
      footer: { text: 'Meister Management System' }
    };
    if (n.body) embed.description = String(n.body).slice(0, 4096);
    if (n.atISO || n.at) {
      const iso = n.atISO || null;
      if (iso && !Number.isNaN(Date.parse(iso))) embed.timestamp = new Date(iso).toISOString();
    }
    if (origin) embed.url = `${origin.replace(/\/$/, '')}/notifications`;
    return embed;
  });

  const more = (items || []).length - list.length;
  const content = more > 0
    ? `Meister に新しい通知が ${(items || []).length} 件あります（ほか ${more} 件）`
    : `Meister に新しい通知が ${(items || []).length} 件あります`;

  return {
    username: 'MMS',
    content,
    embeds
  };
}

export function buildBrowserNotification(item) {
  return {
    title: String(item?.title || 'Meister の新しい通知'),
    options: {
      body: item?.body ? String(item.body) : '通知一覧を開いて確認してください。',
      tag: item?.id != null ? `mms-notification-${item.id}` : 'mms-notification',
      renotify: true
    }
  };
}

/**
 * 未読の監視。バッジ更新と届け先への送信をまとめる。
 *
 * deps:
 *   unreadCount() → { count }
 *   notifications() → { notifications }
 *   sendDiscord(payload) → Promise
 *   showBrowser(item) → void
 *   onBadge(count) → void
 *   getPrefs() → prefs
 *   now() → number
 *   isVisible() → boolean
 */
export function createWatcher(deps) {
  let timer = null;
  let inFlight = false;
  let stopped = true;

  async function tick() {
    if (inFlight || stopped) return;
    inFlight = true;
    try {
      const { count } = await deps.unreadCount();
      const n = typeof count === 'number' ? count : 0;
      deps.onBadge?.(n);

      const prefs = deps.getPrefs();
      const wantDelivery = prefs.browser || prefs.discord;
      if (!wantDelivery) {
        // 届け先がオフでも基準は進めておく。オンにした瞬間に既存分を飛ばさない。
        const prev = loadState();
        if (!prev.primed) {
          saveState({ primed: true, count: n, seenIds: prev.seenIds });
        } else {
          saveState({ ...prev, count: n });
        }
        return;
      }

      let list = [];
      try {
        const data = await deps.notifications();
        list = data?.notifications || [];
      } catch {
        // 一覧が取れなくても件数のバッジは更新済み。届けは次の周期に回す。
        return;
      }

      const prev = loadState();
      const result = pickNewNotifications({ prev, count: n, notifications: list });
      saveState(result.next);

      if (!result.notify) return;

      if (prefs.browser) {
        for (const item of result.items) {
          try { deps.showBrowser?.(item); } catch { /* 権限拒否など */ }
        }
      }
      if (prefs.discord && prefs.webhookUrl) {
        try {
          await deps.sendDiscord(buildDiscordPayload(result.items, {
            origin: deps.origin || ''
          }), prefs.webhookUrl);
        } catch (e) {
          // Discord 失敗はバッジ更新を止めない。原因はコンソールに残す。
          console.error('Discord 通知の送信に失敗:', e?.message || e);
        }
      }
    } catch {
      // 未ログインや一時的な失敗は次の周期へ
    } finally {
      inFlight = false;
    }
  }

  function schedule() {
    if (stopped) return;
    clearTimeout(timer);
    const ms = deps.isVisible?.() === false ? POLL_HIDDEN_MS : POLL_VISIBLE_MS;
    timer = setTimeout(async () => {
      await tick();
      schedule();
    }, ms);
  }

  function onVisibility() {
    if (stopped) return;
    // タブが戻ってきたらすぐ一度見て、間隔も張り直す。
    if (deps.isVisible?.() !== false) tick();
    schedule();
  }

  return {
    async start() {
      stopped = false;
      if (typeof document !== 'undefined') {
        document.addEventListener('visibilitychange', onVisibility);
      }
      await tick();
      schedule();
    },
    stop() {
      stopped = true;
      clearTimeout(timer);
      timer = null;
      if (typeof document !== 'undefined') {
        document.removeEventListener('visibilitychange', onVisibility);
      }
    },
    /** 設定画面の「テスト送信」用。基準値は動かさない。 */
    async sendTest(sample, { browser = true, discord = true } = {}) {
      const prefs = deps.getPrefs();
      const items = sample || [{
        id: 'test',
        title: '通知のテスト',
        body: 'ブラウザと Discord の届け先が動いているか確認するテストです。',
        atISO: new Date().toISOString(),
        read: false
      }];
      if (browser && prefs.browser) {
        for (const item of items) deps.showBrowser?.(item);
      }
      if (discord && prefs.discord && prefs.webhookUrl) {
        await deps.sendDiscord(buildDiscordPayload(items, {
          origin: deps.origin || ''
        }), prefs.webhookUrl);
      }
      return items;
    },
    /**
     * Discord 連携の確認。指定 URL へテストを送り、失敗したら例外を投げる。
     * 保存前に呼び、届くこと確認できてから設定を残す。
     */
    async verifyDiscord(webhookUrl) {
      const url = typeof webhookUrl === 'string' ? webhookUrl.trim() : '';
      if (!url) throw new Error('Discord の Webhook URL が必要です。');
      const items = [{
        id: 'discord-verify',
        title: 'Discord 連携の確認',
        body: 'Meister からの通知がこのチャンネルに届いています。このメッセージが見えていれば連携は成功です。',
        atISO: new Date().toISOString(),
        read: false
      }];
      await deps.sendDiscord(buildDiscordPayload(items, {
        origin: deps.origin || ''
      }), url);
      return items;
    },
    tick
  };
}

export async function requestBrowserPermission() {
  if (typeof Notification === 'undefined') {
    return { ok: false, permission: 'unsupported' };
  }
  if (Notification.permission === 'granted') {
    return { ok: true, permission: 'granted' };
  }
  if (Notification.permission === 'denied') {
    return { ok: false, permission: 'denied' };
  }
  const permission = await Notification.requestPermission();
  return { ok: permission === 'granted', permission };
}

export function showBrowserNotification(item) {
  if (typeof Notification === 'undefined') return null;
  if (Notification.permission !== 'granted') return null;
  const { title, options } = buildBrowserNotification(item);
  const note = new Notification(title, options);
  note.onclick = () => {
    try { window.focus(); } catch { /* ignore */ }
    note.close();
    if (location.pathname !== '/notifications') {
      // アプリのルータへは app.js 側の navigate を使う。ここでは URL だけ合わせる。
      const params = new URLSearchParams(location.search);
      const keep = params.get('demo') === '1' ? '?demo=1' : '';
      history.pushState(null, '', `/notifications${keep}`);
      window.dispatchEvent(new PopStateEvent('popstate'));
    }
  };
  return note;
}
