/* 商品URLから商品画像の URL を取る。
 *
 * 一覧 HTML に商品URLは無い。詳細の「商品URL」を読み、そのページから画像を決める。
 * 秋月電子は商品コードがパスに入っているので、ページを取らずに画像 URL を組む。
 * Amazon は landingImage、その他は og:image / twitter:image。
 *
 * 商品URLは注文に入力された外部 URL なので、取得前に私設アドレスを拒む。
 */

const BLOCKED_HOST = /^(localhost|.*\.localhost|.*\.local|.*\.internal|metadata\.google\.internal)$/i;

function decodeAttr(value) {
  return String(value || '')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

function isPrivateIp(host) {
  const v4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const n = v4.slice(1).map(Number);
    if (n.some((part) => part > 255)) return true;
    const [a, b] = n;
    if (a === 0 || a === 10 || a === 127) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;
    return false;
  }
  if (host.includes(':')) {
    const h = host.toLowerCase();
    return h === '::1' || h.startsWith('fc') || h.startsWith('fd') || h.startsWith('fe80');
  }
  return false;
}

/** http(s) の公開 URL だけ通す。通らなければ null。 */
export function publicProductUrl(raw) {
  if (!raw) return null;
  let url;
  try {
    url = new URL(String(raw).trim());
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  if (url.username || url.password) return null;
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (!host || BLOCKED_HOST.test(host) || isPrivateIp(host)) return null;
  return url;
}

function absoluteHttp(candidate, pageUrl) {
  if (!candidate) return null;
  let absolute;
  try {
    absolute = new URL(candidate, pageUrl).href;
  } catch {
    return null;
  }
  return publicProductUrl(absolute)?.href || null;
}

/** 秋月の商品 URL は画像パスに変換できる。それ以外は null（ページを見る）。 */
export function directImageUrl(productUrl) {
  const url = publicProductUrl(productUrl);
  if (!url) return null;
  const code = url.pathname.match(/^\/catalog\/g\/g(\d+)\/?$/);
  if ((url.hostname === 'akizukidenshi.com' || url.hostname.endsWith('.akizukidenshi.com')) && code) {
    return `https://akizukidenshi.com/img/goods/L/${code[1]}.jpg`;
  }
  return null;
}

function metaContent(html, key, expected) {
  const re = /<meta\b[^>]*>/gi;
  let tag;
  while ((tag = re.exec(html))) {
    const attr = tag[0].match(new RegExp(`\\b${key}="([^"]*)"`, 'i'));
    if (!attr || attr[1].toLowerCase() !== expected) continue;
    const content = tag[0].match(/\bcontent="([^"]*)"/i);
    if (content) return decodeAttr(content[1]);
  }
  return null;
}

/** Amazon のメイン画像。ロゴや CSS は拾わない。 */
function amazonImage(html) {
  const landing = html.match(/id="landingImage"[^>]*data-a-dynamic-image="([^"]+)"/i)
    || html.match(/id="landingImage"[^>]*data-old-hires="([^"]+)"/i);
  if (landing) {
    const decoded = decodeAttr(landing[1]);
    const url = decoded.match(/https:\/\/m\.media-amazon\.com\/images\/I\/[^"&\s]+/);
    if (url) return url[0];
  }
  const hires = html.match(/data-old-hires="(https:\/\/m\.media-amazon\.com\/images\/I\/[^"]+)"/i);
  return hires ? hires[1] : null;
}

/** 商品ページ HTML から画像 URL を1つ。無ければ null。 */
export function productImageFromHtml(html, pageUrl) {
  const source = String(html || '');
  const amazon = amazonImage(source);
  const og = metaContent(source, 'property', 'og:image')
    || metaContent(source, 'name', 'twitter:image')
    || metaContent(source, 'name', 'twitter:image:src');
  return absoluteHttp(amazon || og || directImageUrl(pageUrl), pageUrl);
}

const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const MAX_HTML = 2_000_000;
const MAX_HOPS = 4;

async function readPublicHtml(productUrl) {
  let current = publicProductUrl(productUrl);
  if (!current) return null;
  for (let hop = 0; hop < MAX_HOPS; hop += 1) {
    let res;
    try {
      res = await fetch(current.href, {
        redirect: 'manual',
        headers: {
          'User-Agent': UA,
          Accept: 'text/html',
          'Accept-Language': 'ja,en;q=0.8'
        },
        signal: AbortSignal.timeout(15000)
      });
    } catch {
      return null;
    }
    if (res.status >= 300 && res.status < 400) {
      const next = publicProductUrl(new URL(res.headers.get('Location') || '', current).href);
      if (!next) return null;
      current = next;
      continue;
    }
    if (res.status !== 200) return null;
    const type = res.headers.get('Content-Type') || '';
    if (type && !/text\/html|application\/xhtml/i.test(type)) return null;
    const body = await res.text();
    if (body.length > MAX_HTML) return { finalUrl: current.href, body: body.slice(0, MAX_HTML) };
    return { finalUrl: current.href, body };
  }
  return null;
}

/** 商品URLに対応する画像 URL。取れなければ imageUrl は null。 */
export async function fetchProductImage(productUrl) {
  const page = publicProductUrl(productUrl);
  if (!page) return { productUrl: null, imageUrl: null };
  const direct = directImageUrl(page.href);
  if (direct) return { productUrl: page.href, imageUrl: direct };
  const html = await readPublicHtml(page.href);
  if (!html) return { productUrl: page.href, imageUrl: null };
  return {
    productUrl: page.href,
    imageUrl: productImageFromHtml(html.body, html.finalUrl)
  };
}
