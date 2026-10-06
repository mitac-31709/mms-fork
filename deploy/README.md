# Cloudflare へのデプロイ

Meister Management System のフォークを Cloudflare Workers（静的資産つき）で公開する。
データは元アプリ（`https://meister.tokyo-ct.org`）から取る。

- 公開 URL: `https://mms-fork.mitac31709.workers.dev`
- Worker 名: `mms-fork`
- アカウント: `Mitac31709@gmail.com's Account`（`ca0ec10c7f6f85ea5700ca86e63e580d`）

**認証は利用者ごと。** 誰でも自分の元アプリのアカウントでログインできる。
Worker は資格情報を保存しない。共有の資格情報も持たない。

## なぜ Worker が要るのか

元アプリは Rails のサーバサイドレンダリングで、**JSON の口がほぼ無い**。

| 元アプリのパス | 返すもの |
| --- | --- |
| `/dashboard` `/reports` `/orders` `/equipments` `/loans` `/notifications` | HTML |
| `/notifications/unread_count` | **JSON**（`{"count":0}`）— 唯一 |
| `/reports/:id/auto_save` | PATCH。本文項目の自動保存。フォークの `PATCH /api/reports/:id` が中継する |

加えてブラウザから直接は呼べない。CORS ヘッダが無く、セッション Cookie は
`HttpOnly` + `SameSite=Lax` なので、別オリジンの静的ページからは送れない。

そこで Worker が間に入る。利用者の資格情報で Devise にログインし、
各画面の HTML を取って JSON にして返す。

```
ブラウザ ──/api/orders──▶ Worker ──セッション + /orders (HTML)──▶ 元アプリ
         ◀────JSON───────         ◀────HTML───────────────────
```

## 認証の仕組み

1. 画面のログインフォームが `POST /api/session` に `{ email, password }` を送る
2. Worker が元アプリの Devise にそのまま中継する
3. 返ってきた Rails のセッション Cookie を **AES-GCM で封印**して、
   自ドメインの `mms_session` Cookie に入れる（`HttpOnly` `Secure` `SameSite=Lax`）
4. 以降の `/api/*` はその Cookie を解いて元アプリを叩く

資格情報は 2 の中継にしか使わず、どこにも保存しない。鍵は `SESSION_SECRET`。
Worker 側にログイン状態を持たないので、認証用の KV / D1 は要らない。

### 画面データのキャッシュ（stale-while-revalidate）

元アプリが遅くても、**2 回目以降はキャッシュを即返し**、裏で取り直す。

| 条件 | 挙動 | `source` |
| --- | --- | --- |
| キャッシュが新しい（45 秒以内） | そのまま返す | `cache` |
| やや古い（〜1 時間） | 返して裏で再取得 | `cache` |
| かなり古い（〜6 時間） | 返して裏で再取得 | `stale` |
| 無い / 期限切れ | 元アプリを待つ。失敗時は最後の成功分 | `live` / `stale` |

区画は**セッション Cookie の SHA-256**。共有キャッシュに他人のデータを載せない。
ブラウザ向け応答は従来どおり `Cache-Control: no-store`。
注文作成とログアウトで該当区画を消す。実装は `src/page-cache.js`。

裏で取り直している応答には `revalidating: true` が付く。クライアントは
`?refresh=1` で元アプリ再取得を待ち、取れたら画面を差し替える。
また、画面を開いたとき Worker はレールから行ける他画面を裏で温める
（fresh ヒット時のみ・1 画面まで。裏更新と同時に積むと `waitUntil` が
キャンセルされキャッシュが更新されない）。
クライアント側もタブ内メモリと先読みで遷移を速くする（`fork/page-store.js`）。

### ログアウトの限界（元アプリの性質）

元アプリのセッションは Rails の `cookie_store` で、中身が Cookie 自体に入っている。
そのため**サインアウトしても発行済みの Cookie 値は無効にならない**。実測:

```
サインアウト後に新しい Cookie で /reports  → 302 → /users/sign_in
サインアウト前に保存した古い Cookie で /reports → 200
```

サーバ側に破棄できる状態が無いので、ここでは直せない。できるのは次の 2 つ。

- 元アプリのサインアウトを成立させ、結果を `DELETE /api/session` の応答に載せる
  （`originSignedOut`）。黙って失敗させない
- 自ドメインの Cookie を確実に消す

封印トークン側に独自の有効期限は付けない。実効の失効は元アプリのセッションと
ログアウト、`SESSION_SECRET` の差し替えに委ねる。
`mms_session` は `HttpOnly` なのでページの JavaScript からは読めない。

## API

| メソッド | パス | 中身 |
| --- | --- | --- |
| `POST` | `/api/session` | ログイン。`{ email, password }` |
| `DELETE` | `/api/session` | ログアウト。`originSignedOut` を返す |
| `GET` | `/api/me` | ログイン中の利用者（表示名は元アプリから読む） |
| `GET` | `/api/dashboard` | ダッシュボード |
| `GET` | `/api/reports` | 週報一覧 |
| `GET` | `/api/reports/:id` | 週報詳細（`/reports/:id/edit` の HTML。id は数字または UUID） |
| `PATCH` | `/api/reports/:id` | 週報の 1 項目を保存（`{ fieldName, content }`） |
| `GET` | `/api/orders` | 注文一覧 |
| `POST` | `/api/orders` | 新しい注文を元アプリへ作成 |
| `GET` | `/api/equipments` | 機材 |
| `GET` | `/api/loans` | 貸出 |
| `GET` | `/api/notifications` | 通知 |
| `GET` | `/api/notifications/unread_count` | 元アプリの JSON をそのまま通す |
| `POST` | `/api/notify/discord` | Discord Incoming Webhook へ即時中継 |
| `POST` | `/api/notify/subscribe` | バックグラウンド購読を登録（KV） |
| `PATCH` | `/api/notify/subscribe` | 購読の Rails Cookie を更新 |
| `DELETE` | `/api/notify/subscribe` | 購読を削除 |
| `POST` | `/api/notify/cron-tick` | Cron から 1 購読を処理（内部トークン必須） |
| `GET` | `/api/health` | 設定の確認（秘密は返さない） |

画面系の応答は共通で `source` `origin` `fetchedAt` を持つ。
`source` は `live`（元アプリから取得） / `cache`（利用者区画のキャッシュ） /
`stale`（古いまま返した／元アプリ失敗時の救済）。
裏更新中は `revalidating: true`。クライアントのライブ更新は `?refresh=1`。
例（`/api/orders`）:

```json
{
  "source": "live",
  "origin": "https://meister.tokyo-ct.org/orders",
  "fetchedAt": "2026-08-05T13:05:00.000Z",
  "columns": [{ "label": "商品" }, { "label": "単価" }, { "label": "数量" },
              { "label": "合計" }, { "label": "ステータス" }, { "label": "作成日" }],
  "empty": { "title": "注文がありません", "body": "新しい注文を作成して始めましょう。" },
  "orders": []
}
```

未ログインは全て `401` + `{ "code": "unauthenticated" }`。

### 変更通知（ブラウザ / Discord）

画面のレール「通知」から、未読が増えたときの転送先を同じ画面で設定できる。

| 届け先 | 動き |
| --- | --- |
| ブラウザ | Notification API。タブ（または OS の通知許可）が必要 |
| Discord | Incoming Webhook。保存時にテスト送信。成功したら **バックグラウンド購読**も登録 |

### タブを閉じても Discord へ送る仕組み

1. Discord 保存成功後、`POST /api/notify/subscribe` が Rails セッション Cookie と Webhook URL を
   `SESSION_SECRET` で封印して KV（`NOTIFY_SUBS`）へ置く
2. Cron（`0 * * * *` = 毎時）が購読 id を列挙し、**1 人ずつ** `/api/notify/cron-tick` へ振り分ける
   （Workers の CPU は呼び出し単位。動的に「1 人 1 Cron」は増やせないが、別 HTTP で枠を分けられる）
3. タブを開いている間はポーリングのついでに Cookie を書き戻し、寿命を延ばす
4. Discord オフ・ログアウトで購読を削除する

元アプリのセッションが失効すると Discord に知らせてから購読を無効化する
（再ログインして Discord を保存し直すと再開）。
資格情報（パスワード）は保存しない。

### Cron の CPU 時間

Cloudflare Workers の Cron は **Free で 10 ms / 回**、**Paid かつ間隔 ≥ 1 時間なら最大 15 分 / 回**。
HTTP リクエストも Free では **10 ms / 回**。`fetch` 待ちは CPU に含まれない。

Cron 本体は id 列挙＋振り分けだけにし、実処理（一覧パース含む）は 1 人 1 リクエストに分ける。
`test/cpu-budget.mjs` の行列は `artifacts/CPU_BUDGET.md`。

未読件数のブラウザ側ポーリングは表示中 60 秒・非表示 5 分。初回の観測は基準値にする
だけで送らない（ログイン直後に既存の未読をまとめて飛ばさない）。バックグラウンド登録時も同様。

Discord の即時中継は `POST /api/notify/discord`（ログイン必須）。
オープンプロキシにしないため `discord.com` / `discordapp.com` の Webhook 形だけを受け付ける。

## 構成

| ファイル | 中身 |
| --- | --- |
| `src/parse.js` | 週報の HTML → JSON。ネットワークに触らない純関数 |
| `src/parse-pages.js` | 他 5 画面と nav の HTML → JSON |
| `src/parse-guard.js` | パース結果が想定どおりかの検査と Discord 本文 |
| `src/meister.js` | Devise ログイン／サインアウト、HTML 取得、注文作成 |
| `src/session.js` | セッション Cookie の封印と開封（AES-GCM） |
| `src/page-cache.js` | 利用者区画の stale-while-revalidate |
| `src/discord.js` | Discord Webhook URL の検証と転送 |
| `src/subscribe.js` | バックグラウンド購読の KV 読み書き |
| `src/background.js` | Cron から回す未読差分 → Discord |
| `src/index.js` | ルーティング、静的資産、scheduled、パース異常の通知 |
| `wrangler.jsonc` | Worker の設定 |
| `build.sh` | `../fork` から公開するファイルだけ `public/` に揃える |
| `test/parse.test.mjs` | 週報のパーサを実 HTML で検証 |
| `test/parse-pages.test.mjs` | 他 5 画面のパーサを実 HTML で検証 |
| `test/parse-guard.test.mjs` | 想定外 HTML の検出と Discord 本文 |
| `test/notify.test.mjs` | Discord 中継と通知差分の純関数 |
| `test/page-cache.test.mjs` | 利用者区画キャッシュの SWR |
| `test/background.test.mjs` | バックグラウンド差分・ペイロードの純関数 |
| `test/cpu-budget.mjs` | Cron 1 回あたりの CPU 概算（`MATRIX=1` で行列） |
| `test/api.test.mjs` | 動いているエンドポイントに対して検証 |
| `test/e2e.py` | ログインから 6 画面・ログアウトまで実ブラウザで通す |

`public/` は生成物なのでコミットしない。`design.md` / `README.md` /
`test_responsive.py` は配らない。

`wrangler.jsonc` の要点。

- `assets.not_found_handling: "single-page-application"` — 画面はクライアント側で
  ルーティングするので、資産に無いパスは `index.html` を返す
- `assets.run_worker_first: ["/api/*"]` — API は必ず Worker に通す。
  資産が先に配られると `/api/*` が SPA フォールバックで `index.html` になる

## デプロイ

```bash
cd deploy
export CLOUDFLARE_ACCOUNT_ID=ca0ec10c7f6f85ea5700ca86e63e580d
./build.sh
npx wrangler deploy
```

秘密は次のとおり。

```bash
printf '%s' "$(python3 -c 'import secrets;print(secrets.token_urlsafe(32))')" \
  | npx wrangler secret put SESSION_SECRET

# パース異常の運用通知（任意）。利用者の「届け先」とは別。
printf '%s' 'https://discord.com/api/webhooks/…' \
  | npx wrangler secret put DISCORD_WEBHOOK
```

鍵を差し替えると、既に発行済みの `mms_session` は全て開けなくなり、
利用者は再ログインになる。漏えいが疑われるときはこれで一括失効できる。

`DISCORD_WEBHOOK` は元アプリの HTML が想定と違うとき（列見出しの変更・パーサ例外など）
にだけ送る。未設定なら通知を飛ばして API は通常どおり動く。

## テスト

```bash
# パーサ（ネットワーク不要）
node --test test/parse.test.mjs test/parse-pages.test.mjs test/parse-guard.test.mjs test/notify.test.mjs test/page-cache.test.mjs

# API。元アプリに実際にログインするので資格情報が必要
MEISTER_EMAIL=... MEISTER_PASSWORD=... node --test test/api.test.mjs
BASE=https://mms-fork.mitac31709.workers.dev \
  MEISTER_EMAIL=... MEISTER_PASSWORD=... node --test test/api.test.mjs

# ログインから 6 画面・ログアウトまで実ブラウザで
MEISTER_EMAIL=... MEISTER_PASSWORD=... python3 test/e2e.py
python3 test/e2e.py --base https://mms-fork.mitac31709.workers.dev
```

ローカル開発は `.dev.vars` を置いて `npx wrangler dev --port 8788`。

```
SESSION_SECRET='...'
```

**値は必ず引用する。** `.dev.vars` は dotenv 形式で読まれるため、引用しないと
`#` 以降が捨てられる。実際にこれで 127 文字のパスワードが 40 文字になり、
元アプリに拒否された。

## 実装で踏んだところ

**ログアウトが元アプリに効いていなかった。** Rails のセッションは Cookie に入って
いて応答ごとに再発行される。CSRF トークンはその応答で返った Cookie と対なので、
元の Cookie で `POST /users/sign_out` を投げると 422 になる。`/dashboard` の応答で
更新された Cookie を使う必要があった。結果を握り潰していたので気づけず、
`DELETE /api/session` の応答に載せるようにした。

**静的資産が Worker より先に配られる。** 既定では資産に一致するリクエストは
Worker を通らない。`run_worker_first` で API だけ先に通す。

**Rails 7 + Turbo はログイン後のリダイレクトに 303 を返す。** 302 だけを見ていて
「応答が想定外」で落ちた。3xx をまとめて受ける。

**422 の理由が 2 通りある。** メールアドレス／パスワードの不一致と CSRF の
不成立が同じ 422 で返る。まとめて「資格情報の拒否」と表示していて原因が読めなかった。

**ログインの入力ミスで既存のセッションが落ちていた。** 401 を一律で Cookie 削除に
していたため。`ApiError` に `clearSession` を持たせ、失効のときだけ落とす。

**デプロイ直後は secret の反映に数秒かかる。** 直後にテストを走らせると
未設定として扱われる瞬間があった。

**テストが本番だけで落ちた。** `node --test` の並行実行で、共有していた Cookie 変数を
書き換えるテストと使うテストが混ざっていた。ローカルは速くて隠れていた。
`describe(..., { concurrency: 1 })` にして、Cookie を書き換えない形に直した。

## 分かっていないこと

**注文・機材・貸出・通知の行は実データで検証できていない。** 週報は
2026-08-31 に 1 件あるアカウントで一覧・詳細・編集を確認した。id は UUID、
本文項目は `/reports/:id/edit` の `data-field-name`（shortnote / progress /
issue / plan、ラベルは 概要 / 進捗 / 課題 / 計画）。詳細画面には本文が無く、
提出期限・作業期間とコメント欄がある。他リストはまだ 0 件。

**書き込みは注文作成と週報の項目保存。** 週報の本文（概要 / 進捗 / 課題 / 計画）は
`PATCH /reports/:id/auto_save` へ、開始日・終了日は編集フォームの PATCH へ送る。
削除は元アプリに送らない。詳細は `/reports/:id/edit` を読んでパネルで編集する。
注文はパネルから作成でき、Worker が `/orders/new` の CSRF トークンを取って元アプリへ POST する。

**TA / 管理者画面はフォークしていない。** 検証に使えたアカウントでは
`/ta/**` `/admin/**` が `/dashboard` にリダイレクトされるため、実物を見ていない。
