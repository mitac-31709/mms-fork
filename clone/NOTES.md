# クローン結果と `/reports` の構造

取得日: 2026-08-05 / 取得スクリプト: `crawl.py` / 結果: `manifest.json`

## 取得できたもの

`crawl.py` は 2 段構成。1 段目は未ログインで巡回し、2 段目は Devise に
ログインしてから巡回する。ログイン後は `/` と `/users/sign_in` が
`/dashboard` に飛ぶため、公開状態の姿は先に取らないと失われる。

```
--- 未ログイン ---
  200 https://meister.tokyo-ct.org/
  200 https://meister.tokyo-ct.org/users/sign_in
  assets: 36 参照 / 36 新規取得
login: ログイン成功（着地: https://meister.tokyo-ct.org/dashboard）
--- ログイン後 ---
  200 /dashboard  /reports  /reports/new  /orders  /orders/new  /loans
  200 /equipments  /notifications  /notifications/unread_count
  200 /ta  /ta/reports  /ta/orders  /admin  /admin/reports  /admin/orders  /admin/users
  200 /
  assets: 36 参照 / 0 新規取得
pages=19 assets=36
```

| 保存先 | 中身 |
| --- | --- |
| `site/public/` | 未ログイン時の `/` と `/users/sign_in` |
| `site/auth/` | ログイン後に到達できる全ページ（16 パス） |
| `site/assets/` | ページが参照するアセット 36 件（内容ハッシュ付きなので両フェーズで共有） |

ページは `/assets/...` の絶対パスで参照するため、`site/` をドキュメントルートに
すればどちらのフェーズもそのまま開ける。ただし配信には `serve.py` を使う。

```bash
cd clone && python3 serve.py
# http://localhost:8080/auth/reports.html
# http://localhost:8080/public/index.html
```

### `python3 -m http.server` では日本語が文字化けする

取得した HTML には `<meta charset>` が**一つも無い**。文字コードは
HTTP ヘッダだけで伝えられている。

```
$ curl -sSI https://meister.tokyo-ct.org/users/sign_in | grep -i content-type
content-type: text/html; charset=utf-8
```

`python3 -m http.server` はこのヘッダを付けないため、ブラウザが latin-1 と
解釈して全ての日本語が mojibake になる（実際にブラウザで確認して踏んだ）。
HTML に `<meta charset>` を足せば直るが、それはクローンを元と別物にする改変なので、
配信側でヘッダを揃える `serve.py` を用意した。

## ログインしたアカウントの権限と状態

一般ユーザー（学生）の権限。2026-08-05 の初回取得ではどのリストも 0 件だった。
2026-08-31 に同じ系統のアカウントで取り直すと、**週報が 1 件**あった。
注文・貸出・機材・通知は引き続き空。`/ta/**` `/admin/**` は全て `/dashboard` に
リダイレクト（権限なし）。`/reports/new` も `/reports` にリダイレクト。

- ダッシュボードは「チーム: 10(未定)」「調整中」
- 週報・注文・貸出・機材・通知はすべて空状態の表示
- `/ta/**` `/admin/**` は全て `/dashboard` にリダイレクト（権限なし）。ただし中身に差がある。
  - `/admin/users` は 15,299 バイトで、ダッシュボードの上に
    **「管理者権限が必要です」** のフラッシュが付く。つまりこのルートは存在し、
    権限で弾かれたことが分かる
  - `/admin` `/admin/reports` `/admin/orders` `/ta` `/ta/reports` `/ta/orders` は
    `dashboard.html` と**バイト単位で同一**（14,464 バイト）。フラッシュも出ない。
    ルートが存在して黙ってリダイレクトされたのか、そもそも無いのかは区別できない
  - このため、あるパスの応答が「ダッシュボードとして解析できた」ことは
    権限のある画面に到達した証拠にはならない
- `/reports/new` も `/reports` にリダイレクト（作成権限なし。週報は管理者が締め切りを
  設定して初めて現れる旨が空状態の文言に書かれている）

そのため取得できたのは**画面の骨格・ナビゲーション・列見出し・空状態**まで。
データ行が入った状態の見た目、TA / 管理者画面、詳細スライドオーバーの中身は
このアカウントでは確認できない。

## `/reports`（週報一覧）の実構造

`site/auth/reports.html` より。

- ヘッダ: `MMS` / ダッシュボード / 注文 / 機材 / 貸出 / 週報 / 通知ベル / ユーザーメニュー
- ページ見出し: 「週報一覧」
- 集計チップ: 未完了 `1` ・ 完了 `0` ・ 合計 `1`（2026-08-31。初回は全て 0）
- テーブル列: **タイトル / 期間 / ステータス / 期限 / 作成日**
- 行 id は UUID。`id="report_<uuid>"` と `data-report-url="/reports/<uuid>"`。
  クリックは `handleRowClick(event, this.dataset.reportUrl)`（Stimulus の
  `#report_<数字>` ではない）
- タイトルセルは見出しとチーム名が分かれる（例: `10/01のレポート` /
  `10: (未定)`）。期間は `期間未設定` のことがある。期限・作成日は
  `YYYY/MM/DD HH:MM`
- 空状態: 「週報がありません」＋「管理者によって新しいレポートの締め切りが設定されると、
  ここにレポートが表示されます。」（行が 0 件のときだけ）
- 空状態は 2 回出力される（デスクトップのテーブルとモバイルのカードリストで別々のマークアップ）
- Stimulus: `data-controller="user-report-sidebar report-sidebar"` と
  `data-controller="side-panel"`、詳細用の `id="side_panel"`

### ソート UI は一般ユーザー画面には無い

`sortable_table_controller` は公開されている JS には含まれるが、
取得したどのページにも `data-controller="sortable-table"` は無い。
`data-column` 属性も出現しない。TA / 管理者画面でのみ使われていると考えられる。

| ページ | 使われている Stimulus コントローラ |
| --- | --- |
| `/reports` | `dropdown` `mobile-menu` `notifications` `side-panel` `user-report-sidebar report-sidebar` |
| `/orders` | `dropdown` `mobile-menu` `notifications` `side-panel` `user-order-sidebar` |
| `/loans` `/equipments` `/dashboard` | `dropdown` `mobile-menu` `notifications` |
| `/notifications` | `dropdown` `mobile-menu` `notifications` `notification-list` |

## クローラの検証

`test_crawl.py` は Devise を模したローカルサーバを立てて `crawl.py` を通しで走らせる。
確認しているのは、ログイン成功時に全ページを辿れること、未ログイン時の姿を別に残すこと、
アセットをフェーズ間で重複させないこと、除外パスを踏まないこと、外部ホストを取得しないこと、
認証失敗時に終了コード 2 を返すこと。

```
$ python3 test_crawl.py
--- 認証あり ---
--- 未ログイン ---
  200 http://127.0.0.1:34545/
  200 http://127.0.0.1:34545/users/sign_in
  assets: 1 参照 / 1 新規取得
login: ログイン成功（着地: http://127.0.0.1:34545/reports）
--- ログイン後 ---
  200 /reports  /notifications  /reports/1  /reports/2   (他は 404)
  assets: 0 参照 / 0 新規取得
pages=20 assets=1
--- 認証なし ---
login: サーバがメールアドレス／パスワードを拒否
pages=2 assets=1

PASS: 認証後の全ページ巡回・除外パス・外部ホスト除外・失敗時の終了コード
```

このテストで「ログイン後の着地ページを巡回の起点に入れていないため、認証が通っても
中身に到達できない」欠陥が見つかり修正した。トップページは未ログインでも同じ内容を
返すので、着地ページを起点にしないと 1 ページも辿れなかった。

## 安全側の作り

- GET のみ
- 同一ホスト限定
- ログアウト、パスワード再設定（メールが飛ぶ）、既読化、`data-turbo-method` 付きリンクは踏まない
- リクエスト間に待ちを入れる

## アプリの技術構成

`site/public/index.html` より。

- Rails + Propshaft + importmap
- Hotwire（`@hotwired/turbo-rails`, `@hotwired/stimulus`）
- ActionCable（`channels/report_edit_channel`）
- Tailwind CSS（`site/assets/tailwind-c5b5d75e.css`、149 KB のビルド済み）+ DaisyUI（`--bc` 変数を参照）
- フォント: Inter のみ（Google Fonts、weight 100–900 を全部読み込み）
- `<body data-theme="light">` — DaisyUI のテーマ属性

## 公開 JS から読み取れる挙動

HTML では空状態しか見えないが、Rails の importmap がビルド済み JS を全ページ共通で
公開しているため、データが入ったときの挙動と TA / 管理者画面の作りは読める。

### 1. 一覧はテーブル、行 ID は `report_<id>`

`site/assets/controllers/user_report_sidebar_controller-297ca574.js`:

```js
document.querySelectorAll('[id^="report_"]').forEach(...)
const row = document.querySelector(`#report_${reportId}`)
row.classList.add('bg-blue-50', 'ring-2', 'ring-blue-500', 'ring-opacity-50')
row.scrollIntoView({ behavior: 'smooth', block: 'center' })
```

選択行は `bg-blue-50` + 青い ring でハイライトされ、スクロールで中央に寄る。

### 2. ソートはフルページ遷移（TA / 管理者画面のみ）

取得した一般ユーザー画面には `data-controller="sortable-table"` が無い。
以下はこのコントローラが使われる画面での挙動。

`site/assets/controllers/sortable_table_controller-ad879dee.js`:

```js
url.searchParams.set('sort_by', column)
url.searchParams.set('sort_direction', direction)
url.searchParams.set('page', '1')
window.location.href = url.toString()   // ← Turbo を経由しない
```

- ソート状態は `sort_by` / `sort_direction` クエリ
- ソートするとページが 1 に戻り、**画面全体がリロードされる**
- ソートアイコンは `.sort-icon` に `innerHTML` で SVG を差し込む方式
- ページネーションは `page` クエリ

### 3. 詳細は右からのスライドオーバー（`#side_panel`）

`site/assets/controllers/side_panel_controller-1d75203f.js`:

```js
panel.classList.remove("translate-x-full"); panel.classList.add("translate-x-0")   // 開く
panel.classList.remove("translate-x-0");    panel.classList.add("translate-x-full") // 閉じる
setTimeout(() => { panel.innerHTML = ""; panel.removeAttribute('src') }, 300)
```

- Turbo Frame `#side_panel` に `src` を設定して詳細を読み込む
- 閉じると 300ms 後に中身を破棄し `src` も消す（＝再度開くと毎回フェッチし直す）
- `turbo:before-visit` でページ遷移のたびに強制的に閉じる
- URL の `report_id` クエリでディープリンク可能

### 4. ロール別に 3 つの名前空間

`site/assets/controllers/report_sidebar_controller-90fbfeb9.js`:

```js
if (path.startsWith('/admin'))   detailsUrl = `/admin/reports/${reportId}`
else if (path.startsWith('/ta')) detailsUrl = `/ta/reports/${reportId}`
else                             detailsUrl = `/reports/${reportId}`
```

一般ユーザー / TA / 管理者で別画面。`user_` `ta_` `admin_` の 3 つのサイドバー
コントローラはハイライト処理までほぼ同一コードで重複している。

### 5. 週報フォームは項目単位の共同編集

`site/assets/controllers/collaborative_edit_controller-ca4cedf0.js`:

- `data-field-name` を持つ入力ごとに ActionCable でロックを取る
- `focus` でロック取得、`blur` で解放、他人が編集中なら `field.blur()` で弾く
- 入力を debounce して `POST /reports/<id>/auto_save` に自動保存
- 状態は CSS クラスで表現（`site/assets/application-7e8bcb07.css`）
  - `.field-locked`（赤）他人が編集中
  - `.field-owned`（緑）自分が編集中
  - `.field-updated-by-other`（紫 + `pulse-purple` アニメーション）
  - `.auto-save-indicator` は画面右下固定で saving / saved / error

### 6. 通知

`site/assets/notifications-9c18f17a.js`:

- `GET /notifications/unread_count` を **5 分間隔**でポーリング
- バッジは `#notification-badge`、99 超は `99+`
- `PATCH /notifications/:id/mark_as_read`、`PATCH /notifications/mark_all_as_read`

### 7. その他の共通挙動

- `mobile_menu_controller` — `#mobile-menu` を `max-height` で開閉（CSS 側で 500px 上限）
- `dropdown_controller` — ヘッダのユーザーメニュー
- `flash_message_controller` — フラッシュの自動消去
- `.timeline` / `.timeline-item` — 詳細パネル内の履歴表示
- 削除は `confirm()` のネイティブダイアログ（`side_panel_controller#resetBeforeDelete`）

## まだわかっていないこと

一般ユーザー権限で確認できたのは週報 1 件まで。以下は未確認。

- 完了済みの行、期間が入っている行、コメントがある詳細
- 注文・貸出・機材・通知にデータが入った状態
- TA / 管理者画面（`/ta/**` `/admin/**` は全て `/dashboard` にリダイレクト）
- ソート UI の実際の見た目と `data-column` の値
- フィルタ・検索 UI の有無

### 週報の詳細と編集（2026-08-31 確認）

- `/reports/<uuid>`（詳細）: タイトル、ステータス、チーム名、提出期限、作業期間、
  コメント欄。本文項目は無い（`<!-- Report Content -->` は空）
- `/reports/<uuid>/edit`: `data-controller="collaborative-edit"`。
  `data-field-name` は `shortnote` `progress` `issue` `plan`
  （ラベル: 概要 / 進捗 / 課題 / 計画）。開始日・終了日は `report[start_at]` /
  `report[end_at]`（datetime-local、data-field-name 無し）
- フォークの `GET /api/reports/:id` は本文を取るため **edit を読む**

UI フォークは確認できた範囲を土台にする。未確認部分は JS から読める挙動に合わせる。
