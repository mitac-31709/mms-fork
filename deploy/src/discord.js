/* Discord Incoming Webhook への中継。
 *
 * ブラウザから discord.com へ直接 POST すると CORS で落ちることがあるので、
 * ログイン済みの利用者が自分の Webhook URL を渡して Worker に転送させる。
 * Webhook URL は Worker に保存しない（リクエストのたびに受け取るだけ）。
 */

/** Discord Incoming Webhook の形だけを許す。それ以外は転送しない。 */
export function validateWebhookUrl(raw) {
  if (typeof raw !== 'string') return { ok: false, error: 'Webhook URL が必要です' };
  const url = raw.trim();
  if (!url) return { ok: false, error: 'Webhook URL が必要です' };

  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return { ok: false, error: 'Webhook URL の形が不正です' };
  }

  if (parsed.protocol !== 'https:') {
    return { ok: false, error: 'Webhook URL は https である必要があります' };
  }

  const host = parsed.hostname.toLowerCase();
  if (host !== 'discord.com' && host !== 'discordapp.com'
    && host !== 'canary.discord.com' && host !== 'ptb.discord.com') {
    return { ok: false, error: 'Discord の Webhook URL だけ受け付けます' };
  }

  // /api/webhooks/<snowflake>/<token>
  // トークンは URL-safe に加え、途中の '.' を許す（新しい Webhook トークン）。
  if (!/^\/api\/webhooks\/\d{5,32}\/[A-Za-z0-9._-]{20,200}\/?$/.test(parsed.pathname)) {
    return { ok: false, error: 'Webhook URL のパスが不正です' };
  }

  if (parsed.search || parsed.hash) {
    return { ok: false, error: 'Webhook URL にクエリや断片は付けないでください' };
  }

  return { ok: true, url: `${parsed.origin}${parsed.pathname.replace(/\/$/, '')}` };
}

/** Discord に渡してよい本文だけを残す。未知のキーは落とす。 */
export function sanitizeDiscordBody(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, error: 'JSON の本文が必要です' };
  }

  const out = {};
  if (typeof body.content === 'string') {
    const content = body.content.slice(0, 2000);
    if (content.trim()) out.content = content;
  }
  if (typeof body.username === 'string') {
    const username = body.username.trim().slice(0, 80);
    if (username) out.username = username;
  }
  if (Array.isArray(body.embeds)) {
    out.embeds = body.embeds.slice(0, 10).map(sanitizeEmbed).filter(Boolean);
  }

  if (!out.content && !(out.embeds && out.embeds.length)) {
    return { ok: false, error: 'content か embeds が必要です' };
  }
  return { ok: true, body: out };
}

function sanitizeEmbed(embed) {
  if (!embed || typeof embed !== 'object') return null;
  const out = {};
  if (typeof embed.title === 'string') out.title = embed.title.slice(0, 256);
  if (typeof embed.description === 'string') out.description = embed.description.slice(0, 4096);
  if (typeof embed.url === 'string' && /^https?:\/\//i.test(embed.url)) {
    out.url = embed.url.slice(0, 2048);
  }
  if (typeof embed.color === 'number' && Number.isFinite(embed.color)) {
    out.color = Math.max(0, Math.min(0xffffff, Math.floor(embed.color)));
  }
  if (typeof embed.timestamp === 'string') out.timestamp = embed.timestamp.slice(0, 40);
  if (embed.footer && typeof embed.footer === 'object' && typeof embed.footer.text === 'string') {
    out.footer = { text: embed.footer.text.slice(0, 2048) };
  }
  return out.title || out.description ? out : null;
}

/**
 * Discord の手前は Cloudflare で、User-Agent が空や Workers 既定だと
 * 403 error 1010（bot 署名）で落とす。ブラウザ相当の UA を付ける。
 */
const DISCORD_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

/** Webhook へ転送する。Discord の応答本文は呼び出し側にそのまま返す。 */
export async function forwardDiscord(webhookUrl, body, fetchImpl = fetch) {
  const res = await fetchImpl(webhookUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'User-Agent': DISCORD_UA
    },
    body: JSON.stringify(body)
  });

  const text = await res.text();
  let parsed = null;
  if (text) {
    try { parsed = JSON.parse(text); } catch { /* Discord は空や非 JSON も返す */ }
  }

  return {
    ok: res.status >= 200 && res.status < 300,
    status: res.status,
    body: parsed,
    raw: text
  };
}
