# mms-fork

`https://meister.tokyo-ct.org/reports`（Meister Management System の週報一覧）をクローンし、
UI をより使いやすくしたフォークを作る。デザイン判断は Hallmark スキルに従う。

## フォルダ構成

| パス | 中身 |
| --- | --- |
| `vendor/hallmark/` | Hallmark スキル本体（`nutlope/hallmark` を作業フォルダ内に取り込んだもの） |
| `clone/crawl.py` | サイト全体を取得するクローラ（ログイン → 同一ホストを GET のみで巡回） |
| `clone/serve.py` | 取得物を元サーバと同じ `Content-Type` で配信する |
| `clone/site/` | 取得したページとアセット（`public/` と `auth/`、アセットは共有） |
| `clone/manifest.json` | 取得結果（URL・ステータス・リダイレクト先・保存先） |
| `clone/NOTES.md` | 取得結果と `/reports` の実構造 |
| `audit/HALLMARK_AUDIT.md` | 元 UI を Hallmark の `audit` verb で採点した指摘リスト |
| `fork/` | 改善版の 6 画面 + ログイン。`fork/README.md` に指摘との対応表がある |
| `deploy/` | Cloudflare Workers への公開。元アプリにログインして HTML を JSON にする BFF |

## 公開先

`https://mms-fork.mitac31709.workers.dev`

**誰でも自分の元アプリのアカウントでログインして使える。** フォーク側に共有の
資格情報は無い。データは元アプリから取る。元アプリは Rails のサーバサイド
レンダリングで JSON の口がほぼ無いため、Worker が Devise にログインして
各画面の HTML を JSON に変換している。詳細は `deploy/README.md`。

ログインせずに画面の作りだけ見るなら `?demo=1` を付ける。

## 現在の状態

サイト全体のクローンに加え、2026-08-31 に週報 1 件があるアカウントで
`/reports`・`/reports/:uuid`・`/reports/:uuid/edit` を取り直した。
行 id は UUID。本文の `data-field-name`（概要 / 進捗 / 課題 / 計画）は
**詳細ではなく編集画面**にある。`/ta/**` `/admin/**` は引き続き
`/dashboard` へリダイレクト。詳細は `clone/NOTES.md` を参照。

UI フォークはこの確認できた範囲を土台に、ダッシュボード・注文・機材・貸出・
週報・通知の 6 画面とログイン画面を実装済み。未読が増えたときの
**ブラウザ通知 / Discord 転送**（通知画面の「届け先」）も追加済み。
Discord はタブを閉じても Cron（1 時間ごと）で送り続ける。元アプリのログインが
切れたときも Discord へ知らせる。注文の作成もパネルからできる。HTML パースで
想定外の形を見たときは、Cloudflare シークレット `DISCORD_WEBHOOK` へ運用通知を送る。
週報の詳細は `/reports/:id/edit` を読み、`data-field-name` の項目をパネルで編集できる。
本文は元アプリの自動保存へ送る。
ダッシュボードは元アプリが「調整中」だけなので、週報・注文・貸出・通知から
件数と期限の近い未完了を組む。

## Hallmark の使い方（この作業フォルダ内）

`npx skills add nutlope/hallmark` はリポジトリルートの `.cursor/rules/` に書き込むため、
task 隔離ルールに反する。代わりにスキル本体を `vendor/hallmark/` に取り込み、
`vendor/hallmark/skills/hallmark/SKILL.md` とその `references/` を直接読んで適用する。

```
vendor/hallmark/skills/hallmark/SKILL.md          # 入口
vendor/hallmark/skills/hallmark/references/       # 個別ルール
vendor/hallmark/site/css/tokens.css               # 20 テーマのトークン定義
```

## クロールの実行

```bash
cd clone
python3 crawl.py --out site --max-pages 400
```

1 段目は未ログイン、2 段目はログイン後に巡回する。GET のみ・同一ホスト限定で、
ログアウト、パスワード再設定、既読化、`data-turbo-method` 付きリンクは踏まない。

クローラ自体は Devise を模したローカルサーバでテストしてある。

```bash
python3 test_crawl.py
```

取得済みのページは `serve.py` で開ける。

```bash
cd clone
python3 serve.py
# http://localhost:8080/auth/reports.html   ログイン後の週報一覧
# http://localhost:8080/public/index.html   未ログインのトップ
```

取得した HTML には `<meta charset>` が無く、文字コードは元サーバの
`Content-Type: text/html; charset=utf-8` ヘッダだけで伝えられている。
`python3 -m http.server` だと日本語が文字化けするため、
同じヘッダを返す `serve.py` を使う。

## フォークの実行

デモデータで画面だけ見る。

```bash
cd fork
python3 -m http.server 8081        # http://localhost:8081/?demo=1
```

実データでログインから試す。

```bash
cd deploy
npx wrangler dev --port 8788       # http://127.0.0.1:8788/
```

検証。

```bash
cd fork    && python3 test_responsive.py     # 幅と挙動
cd fork    && python3 test_pages.py          # 値の欠けに対する描画
cd deploy  && node --test test/*.mjs         # パーサと API
cd deploy  && python3 test/e2e.py            # ログインから 6 画面・ログアウト
```
