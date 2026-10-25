/* 利用者ごとの画面 JSON キャッシュ（stale-while-revalidate）。
 *
 * 元アプリは遅いことがある。キャッシュがあれば即返し、裏で取り直す。
 * ミスのときだけ元アプリを待つ。元アプリ失敗時は古くてもキャッシュを返す。
 *
 * 他人のデータが混ざらないよう、キーにセッション Cookie の SHA-256 を入れる。
 * ブラウザへ返す応答は常に no-store。ここに置くのはエッジ側の私的コピーだけ。
 *
 * Cache API はコロ単位。別 DC ではミスしうるが、そのときは元アプリへ行くだけ。
 */

const ENC = new TextEncoder();

/** この間はキャッシュを「新しい」とみなして再検証しない。 */
export const FRESH_MS = 45_000;
/** この間は古いキャッシュを返しつつ裏で取り直す。 */
export const STALE_WHILE_REVALIDATE_MS = 60 * 60 * 1000;
/** これより古いエントリは通常は使わない（元アプリ失敗時の救済は別）。 */
export const HARD_MAX_MS = 6 * 60 * 60 * 1000;
/** Cache-Control でエッジに残す上限（秒）。鮮度は fetchedAt で自前管理。 */
export const EDGE_MAX_AGE_SEC = 24 * 60 * 60;

const CACHE_ORIGIN = 'https://meister-page-cache.internal';

/** 同一 Isolate 内の同時ミスを 1 本にまとめる。 */
const inflight = new Map();

function hex(bytes) {
  let out = '';
  for (const b of bytes) out += b.toString(16).padStart(2, '0');
  return out;
}

/** セッション Cookie → キャッシュ区画。平文 Cookie は URL に載せない。 */
export async function userCacheKey(cookie) {
  const digest = await crypto.subtle.digest('SHA-256', ENC.encode(String(cookie || '')));
  return hex(new Uint8Array(digest));
}

export function cacheRequest(userKey, path) {
  const p = path.startsWith('/') ? path : `/${path}`;
  return new Request(`${CACHE_ORIGIN}/v1/${userKey}${p}`);
}

export function ageMs(entry, now = Date.now()) {
  const at = Date.parse(entry?.fetchedAt || '');
  if (!Number.isFinite(at)) return Number.POSITIVE_INFINITY;
  return Math.max(0, now - at);
}

/** キャッシュの鮮度帯。miss / fresh / revalidate / expired */
export function freshness(entry, now = Date.now()) {
  if (!entry || typeof entry !== 'object') return 'miss';
  const age = ageMs(entry, now);
  if (age < FRESH_MS) return 'fresh';
  if (age < STALE_WHILE_REVALIDATE_MS) return 'revalidate';
  if (age < HARD_MAX_MS) return 'stale';
  return 'expired';
}

export function withSource(entry, source) {
  return { ...entry, source };
}

async function defaultMatch(req) {
  try {
    return await caches.default.match(req);
  } catch {
    return undefined;
  }
}

async function defaultPut(req, res) {
  try {
    await caches.default.put(req, res);
  } catch (e) {
    console.error('page-cache put failed:', e?.message || e);
  }
}

async function defaultDelete(req) {
  try {
    await caches.default.delete(req);
  } catch {
    // best effort
  }
}

/**
 * @param {{ match?: Function, put?: Function, delete?: Function }} [backend]
 */
export function createPageCache(backend = {}) {
  const match = backend.match || defaultMatch;
  const put = backend.put || defaultPut;
  const del = backend.delete || defaultDelete;

  async function read(userKey, path) {
    const res = await match(cacheRequest(userKey, path));
    if (!res) return null;
    try {
      return await res.json();
    } catch {
      return null;
    }
  }

  async function write(userKey, path, data) {
    const body = JSON.stringify(data);
    const res = new Response(body, {
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': `public, max-age=${EDGE_MAX_AGE_SEC}`
      }
    });
    await put(cacheRequest(userKey, path), res);
  }

  async function invalidate(userKey, paths) {
    await Promise.all((paths || []).map((path) => del(cacheRequest(userKey, path))));
  }

  /**
   * SWR: キャッシュがあれば即返し、必要なら裏で再取得。
   * mode='refresh' のときは元を待って上書きする（クライアントのライブ更新用）。
   * @param {{
   *   userKey: string,
   *   path: string,
   *   fetchFresh: () => Promise<object>,
   *   ctx?: { waitUntil?: (p: Promise<unknown>) => void },
   *   now?: number,
   *   mode?: 'swr' | 'refresh'
   * }} opts
   */
  async function load({ userKey, path, fetchFresh, ctx, now = Date.now(), mode = 'swr' }) {
    const cached = await read(userKey, path);

    const refresh = () => coalesce(`${userKey}:${path}`, async () => {
      const fresh = await fetchFresh();
      const stored = { ...fresh, source: 'live' };
      await write(userKey, path, stored);
      return stored;
    });

    if (mode === 'refresh') {
      try {
        const fresh = await refresh();
        return withSource(fresh, 'live');
      } catch (e) {
        if (cached) return withSource(cached, 'stale');
        throw e;
      }
    }

    const band = freshness(cached, now);

    if (band === 'fresh') {
      return withSource(cached, 'cache');
    }

    if (band === 'revalidate' || band === 'stale') {
      const source = band === 'stale' ? 'stale' : 'cache';
      if (ctx?.waitUntil) ctx.waitUntil(refresh().catch((e) => {
        console.error('page-cache revalidate failed:', path, e?.message || e);
      }));
      else {
        refresh().catch(() => {});
      }
      return { ...withSource(cached, source), revalidating: true };
    }

    // miss / expired: 元アプリを待つ。失敗したら最終手段で古いキャッシュ。
    try {
      const fresh = await refresh();
      return withSource(fresh, 'live');
    } catch (e) {
      if (cached) return withSource(cached, 'stale');
      throw e;
    }
  }

  return { read, write, invalidate, load };
}

function coalesce(key, fn) {
  const existing = inflight.get(key);
  if (existing) return existing;
  const p = Promise.resolve()
    .then(fn)
    .finally(() => {
      if (inflight.get(key) === p) inflight.delete(key);
    });
  inflight.set(key, p);
  return p;
}

/** 既定の Cache API バックエンド。 */
export const pageCache = createPageCache();

/** 注文作成・ビュー切替などでまとめて消す画面。 */
export const PAGE_CACHE_PATHS = [
  '/dashboard',
  '/reports',
  '/orders',
  '/equipments',
  '/loans',
  '/notifications',
  '/notifications/unread_count',
  '/ta',
  '/ta/orders?per_page=100',
  '/ta/reports',
  '/ta/teams',
  '/ta/users?per_page=100'
];
