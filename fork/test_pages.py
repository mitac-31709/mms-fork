#!/usr/bin/env python3
"""画面モジュールを、実データにしか出ない形に対して検証する。

`?demo=1` の同梱データは「きれいな形」しか含まない。実際の元アプリからは
値が欠けた形が来る。

  - 通知の `read` が `null`（既読かどうか判定できない）
  - 通知の `unreadText` が `null`（元アプリの未読表示は空の器だけ）
  - 機材の `action` に貸出申請リンクがある / `meta` が `null`
  - 注文の金額が数値にならない（`お問い合わせください` など）
  - どのリストも 0 件

これらはデモを何度動かしても通らない経路なので、payload を直接渡して確かめる。
`test_responsive.py` が幅と操作を見るのに対して、こちらは値の欠けに対する描画を見る。

前提: フォークが http://localhost:8081/ で配信されていること。

    python3 test_pages.py [--base http://localhost:8081/index.html?demo=1]
"""

from __future__ import annotations

import argparse
import json

from playwright.sync_api import sync_playwright

TODAY = "2026-08-05"
failures: list[str] = []


def check(condition: bool, message: str) -> None:
    if not condition:
        failures.append(message)


SETUP = """
() => {
  window.__haltAppPaint = true;
  window.__render = async (mod, data, demo) => {
    const m = await import(`./pages/${mod}.js`);
    const ctx = {
      demo,
      today: new Date('%s' + 'T00:00:00'),
      navigate() {},
      reload() {},
      watcher: { sendTest: async () => [], verifyDiscord: async () => [] }
    };
    document.getElementById('view').replaceChildren(m.render(data, ctx));
    return { meta: m.meta };
  };
}
""" % TODAY


def render(page, module: str, data: dict, demo: bool = False):
    return page.evaluate(
        "async ([mod, data, demo]) => window.__render(mod, data, demo)",
        [module, data, demo])


def wrap(payload: dict, source: str = "live") -> dict:
    return {"source": source, "fetchedAt": "2026-08-05T04:00:00.000Z", **payload}


# ── 通知 ───────────────────────────────────────────
def check_notifications(page) -> None:
    empty = {"title": "通知はありません", "body": "新しい通知が届くとここに表示されます。"}

    # read が null。既読かどうかを主張してはいけない。
    # 既読操作の検証はデモ経路（API 無しでもローカル更新）で行う。
    render(page, "notifications", wrap({
        "heading": "通知",
        "unreadText": None,
        "empty": empty,
        "notifications": [
            {"id": 5, "title": "判定できない通知", "body": "本文",
             "at": "2026/08/01", "atISO": "2026-08-01", "read": None},
            {"id": 6, "title": "未読の通知", "body": None,
             "at": None, "atISO": "2026-07-30", "read": False}
        ]
    }), demo=True)
    items = page.locator("#view .item")
    check(items.count() == 2, f"通知が {items.count()} 件（2 件を期待）")
    check("item--unread" not in (items.nth(0).get_attribute("class") or ""),
          "read が null なのに未読の印が付いている")
    check("item--unread" in (items.nth(1).get_attribute("class") or ""),
          "read が false なのに未読の印が付かない")
    check(page.locator("#view .page-head__lede").count() == 0,
          "unreadText が null なのにリード文が出ている")
    # at が null でも atISO から日付を出す
    check("2026" in items.nth(1).inner_text(),
          f"at が null のとき atISO から日付を出していない: {items.nth(1).inner_text()!r}")

    # read が null の項目を開いたら、状態は — にする
    items.nth(0).click()
    page.wait_for_selector("#panel:not([hidden])", timeout=5000)
    panel = page.inner_text("#panel-body")
    check("—" in panel, f"read が null なのに状態を断定している: {panel!r}")
    # id があり未既読確定でないなら「既読にする」を出せる
    check(page.locator("#panel-mark-read").count() == 1,
          "既読ボタンがパネルに無い")
    page.keyboard.press("Escape")
    page.wait_for_selector("#panel", state="hidden", timeout=5000)

    # 未読を開いて既読にする（デモ）
    items.nth(1).click()
    page.wait_for_selector("#panel:not([hidden])", timeout=5000)
    page.locator("#panel-mark-read").click()
    page.wait_for_selector("#panel", state="hidden", timeout=5000)
    check("item--unread" not in (page.locator("#view .item").nth(1).get_attribute("class") or ""),
          "既読にしたあとも未読の印が残っている")
    check(page.locator("#mark-all-read").count() == 1, "すべて既読ボタンが無い")

    # 0 件
    render(page, "notifications", wrap({
        "heading": "通知", "unreadText": None, "empty": empty, "notifications": []
    }))
    check(page.locator("#view .empty").count() == 1, "通知の空状態が出ない")
    check(page.inner_text("#view .empty__title") == empty["title"], "空状態の見出しが違う")
    check(page.inner_text("#view .empty__body") == empty["body"], "空状態の本文が違う")
    check(page.locator("#mark-all-read").count() == 0, "0 件なのにすべて既読が出ている")
    check(page.locator("#notify-settings").count() == 1, "届け先セクションが出ない")
    check("届け先" in page.inner_text("#notify-settings"), "届け先の見出しが無い")
    # 初回（intro 未記録）は開いて機能を見せる
    page.evaluate("() => localStorage.removeItem('mms.notify.introSeen.v1')")
    page.evaluate("() => localStorage.removeItem('mms.notify.v1')")
    render(page, "notifications", wrap({
        "heading": "通知", "unreadText": None, "empty": empty, "notifications": []
    }))
    check(page.locator("#notify-settings-panel").is_visible(),
          "初回なのに届け先フォームが閉じている")
    check(page.inner_text("#notify-settings-toggle") == "閉じる",
          "初回のトグル文言が『閉じる』ではない")
    limits = page.inner_text("#notify-browser-limits")
    check("ブラウザ通知の制限" in limits, "ブラウザ通知の制限見出しが無い")
    check("タブ" in limits and "閉じる" in limits, "ブラウザ通知の制限本文が足りない")
    # 閉じると「見た」と覚え、どちらもオフのままでも次回は折りたたみ
    page.locator("#notify-settings-toggle").click()
    check(page.locator("#notify-settings-panel").is_hidden(),
          "閉じても届け先フォームが開いたまま")
    check(page.evaluate("() => localStorage.getItem('mms.notify.introSeen.v1')") == "1",
          "閉じたあと introSeen が残らない")
    render(page, "notifications", wrap({
        "heading": "通知", "unreadText": None, "empty": empty, "notifications": []
    }))
    check(page.locator("#notify-settings-panel").is_hidden(),
          "初回を閉じたあとも届け先フォームが開いている")
    check(page.inner_text("#notify-settings-toggle") == "設定する",
          "2 回目のトグル文言が『設定する』ではない")
    page.locator("#notify-settings-toggle").click()
    check(page.locator("#notify-settings-panel").is_visible(),
          "設定するを押しても届け先フォームが開かない")
    print("  通知: read=null / 既読化 / unreadText=null / at=null / 0 件 / 届け先初回のみオープン")


# ── 機材 ───────────────────────────────────────────
def check_equipments(page) -> None:
    render(page, "equipments", wrap({
        "heading": "利用可能な機材",
        "lede": "貸出申請可能な機材一覧",
        "empty": {"text": "現在利用可能な機材はありません。"},
        "equipments": [
            {"id": 3, "name": "トルクレンチ", "meta": "工具 · 在庫 1",
             "action": {"label": "貸出申請", "href": "/loans/new?equipment_id=3"}},
            {"id": 4, "name": "メタの無い機材", "meta": None, "action": None}
        ]
    }))
    cards = page.locator("#view .card")
    check(cards.count() == 2, f"機材が {cards.count()} 件（2 件を期待）")
    check(cards.nth(1).locator(".card__meta").count() == 0,
          "meta が null なのに空の meta を出している")

    link = cards.nth(0).locator(".card__foot a")
    check(link.count() == 1, "action があるのにリンクが出ていない")
    href = link.get_attribute("href") or ""
    check(href.startswith("https://meister.tokyo-ct.org/"),
          f"相対 href を元アプリに解決していない: {href}")
    check(link.get_attribute("target") == "_blank", "別タブで開く指定が無い")
    check("noopener" in (link.get_attribute("rel") or ""), "rel に noopener が無い")
    check("元アプリ" in link.inner_text(),
          f"フォークの外へ出ることが分かるラベルになっていない: {link.inner_text()!r}")
    check(page.evaluate(
        "() => getComputedStyle(document.querySelector('#view .card__foot a'))"
        ".textDecorationLine") == "none", "ボタン型リンクに下線が出ている")
    check(cards.nth(1).locator(".card__foot").count() == 0,
          "action が null なのに操作欄を出している")

    render(page, "equipments", wrap({
        "heading": "利用可能な機材", "lede": "貸出申請可能な機材一覧",
        "empty": {"text": "現在利用可能な機材はありません。"}, "equipments": []
    }))
    check(page.locator("#view .empty").count() == 1, "機材の空状態が出ない")
    check(page.locator("#view .empty__title").count() == 0,
          "機材の空状態に元アプリには無い見出しを足している")
    print("  機材: action あり / meta=null / 0 件（見出し無し）")


# ── 注文 ───────────────────────────────────────────
def check_orders(page) -> None:
    columns = [{"label": s} for s in
               ["商品", "単価", "数量", "合計", "ステータス", "作成日"]]
    empty = {"title": "注文がありません", "body": "新しい注文を作成して始めましょう。"}

    render(page, "orders", wrap({
        "columns": columns, "empty": empty,
        "orders": [
            {"id": "3ef519cc-d396-47e9-bd62-51d8e095562e",
             "product": "見積の品", "unitPrice": "お問い合わせください",
             "quantity": "—", "total": "—", "status": "保留中",
             "createdAt": "2026/08/01", "createdAtISO": "2026-08-01",
             "unitPriceValue": None, "quantityValue": None, "totalValue": None},
            {"id": 2, "product": "無償提供", "unitPrice": "¥0", "quantity": "1",
             "total": "¥0", "status": "受取済み", "createdAt": "2026/07/30",
             "createdAtISO": "2026-07-30",
             "unitPriceValue": 0, "quantityValue": 1, "totalValue": 0}
        ]
    }))
    rows = page.locator("#view .row")
    check(rows.count() == 2, f"注文が {rows.count()} 件（2 件を期待）")
    first = rows.nth(0).inner_text()
    check("お問い合わせください" in first,
          f"数値にできない金額を元の文字列で出していない: {first!r}")
    check("¥0" not in first, f"数値にできない金額を ¥0 にしている: {first!r}")
    # 0 は正当な値。null と混同して落としてはいけない。
    check("¥0" in rows.nth(1).inner_text(),
          f"0 円を出せていない: {rows.nth(1).inner_text()!r}")
    check("status--pending" in (rows.nth(0).locator(".status").get_attribute("class") or ""),
          "保留中に色付きステータスが付いていない")
    check("status--received" in (rows.nth(1).locator(".status").get_attribute("class") or ""),
          "受取済みに色付きステータスが付いていない")
    check(page.locator("#status").count() == 1, "ステータスの select が無い")

    render(page, "orders", wrap({"columns": columns, "empty": empty, "orders": []}))
    check(page.locator("#view .empty").count() == 1, "注文の空状態が出ない")
    check(page.inner_text("#view .empty__title") == empty["title"], "空状態の見出しが違う")
    print("  注文: 金額が読めない行 / 0 円 / UUID / 色付きステータス / 0 件")


# ── 貸出 ───────────────────────────────────────────
def check_loans(page) -> None:
    render(page, "loans", wrap({
        "heading": "機材貸出",
        "lede": "チームの現在と過去の機材貸出を確認できます",
        "sections": [
            {"key": "pending", "title": "申請中", "empty": "申請中の貸出はありません。",
             "items": []},
            {"key": "active", "title": "貸出中", "empty": "アクティブな貸出はありません。",
             "items": [{"id": 9, "name": "ノギス", "meta": "07/29 から"}]}
        ]
    }))
    heads = page.locator("#view .section__title")
    check(heads.count() == 2, f"節が {heads.count()} 個（2 個を期待）")
    body = page.inner_text("#view")
    check("申請中の貸出はありません。" in body, "空の節に元アプリの文言が出ていない")
    check("アクティブな貸出はありません。" not in body,
          "項目がある節に空状態の文言を出している")
    check(page.locator("#view .item").count() == 1, "項目が描画されていない")

    # 描画されていない節を勝手に作らないこと
    render(page, "loans", wrap({
        "heading": "機材貸出", "lede": "リード",
        "sections": [{"key": "pending", "title": "申請中", "empty": "無し", "items": []}]
    }))
    check(page.locator("#view .section__title").count() == 1,
          "渡していない節を作っている")
    print("  貸出: 空の節と項目のある節 / 節を作らない")


# ── ダッシュボード ──────────────────────────────────
def check_dashboard(page) -> None:
    payload = wrap({"heading": "ダッシュボード", "team": "チーム: 10(未定)", "notice": "調整中"})

    render(page, "dashboard", payload, demo=False)
    live = page.inner_text("#view .disclaimer")
    render(page, "dashboard", dict(payload, source="demo"), demo=True)
    demo = page.inner_text("#view .disclaimer")
    check(live != demo, "実データとデモで注記が同じ（実データを「ダミー」と書いてしまう）")
    check("ダミー" not in live, f"実データの注記が「ダミー」と言っている: {live!r}")
    check("ダミー" in demo, f"デモの注記が「ダミー」と言っていない: {demo!r}")
    check("調整中" in page.inner_text("#view .notice"), "調整中の表示が出ていない")

    # 他画面の実データが来たら、件数と未完了の週報を出す。無い面は作らない。
    render(page, "dashboard", wrap({
        "heading": "ダッシュボード", "team": "チーム: 10(未定)", "notice": "調整中",
        "reports": {
            "counts": {"未完了": 1, "完了": 0, "合計": 1},
            "reports": [{
                "id": "8b293839-a910-4bd6-b468-4915b9cefd19",
                "title": "10/01のレポート", "status": "未完了",
                "due": "2026/10/01 17:00", "dueISO": "2026-10-01"
            }]
        },
        "orders": {"orders": []},
        "loans": {"sections": [
            {"title": "申請中", "items": []},
            {"title": "貸出中", "items": []}
        ]},
        "unread": {"count": 0}
    }), demo=False)
    view = page.inner_text("#view")
    check("10/01のレポート" in view, f"未完了の週報がホームに出ていない: {view!r}")
    check("週報 未完了" in view, "週報の件数がホームに無い")
    check("未読の通知" in view, "未読件数がホームに無い")
    check(page.locator("#view .board__tally-value").nth(0).inner_text() == "1",
          "週報未完了の件数が 1 ではない")
    # 注文が 0 件なら「進行中の注文」の節は出さない（0 件の嘘のリストを作らない）
    check("進行中の注文" not in view, "注文 0 件なのに進行中の注文リストを出している")
    check("未完了の注文" not in view, "注文 0 件なのに旧「未完了の注文」リストを出している")
    page.set_viewport_size({"width": 320, "height": 900})
    overflow = page.evaluate(
        "() => document.documentElement.scrollWidth - document.documentElement.clientWidth")
    check(overflow <= 0, f"ダッシュボードが 320px で横に {overflow}px あふれる")
    page.set_viewport_size({"width": 1280, "height": 900})
    print("  ダッシュボード: 注記を出どころで書き分ける / 他画面の件数と週報")


# ── 週報 ───────────────────────────────────────────
def check_reports(page) -> None:
    columns = [{"label": s} for s in
               ["タイトル", "期間", "ステータス", "期限", "作成日"]]
    empty = {
        "title": "週報がありません",
        "body": "管理者によって新しいレポートの締め切りが設定されると、ここにレポートが表示されます。"
    }

    render(page, "reports", wrap({
        "columns": columns, "empty": empty, "counts": {"未完了": 1, "完了": 0, "合計": 1},
        "reports": [{
            "id": "8b293839-a910-4bd6-b468-4915b9cefd19",
            "title": "10/01のレポート", "subtitle": "10: (未定)",
            "period": "期間未設定",
            "status": "未完了", "due": "2026/10/01 17:00", "createdAt": "2026/08/24 13:48",
            "dueISO": "2026-10-01", "createdAtISO": "2026-08-24",
            "periodStartISO": None, "periodEndISO": None,
            "body": "",
            "fields": [
                {"name": "shortnote", "label": "概要", "value": "測定をやり直し中。",
                 "lockedBy": None},
                {"name": "start_at", "label": "開始日", "value": "2026-10-01T09:00",
                 "lockedBy": None},
                {"name": "end_at", "label": "終了日", "value": "2026-10-07T18:00",
                 "lockedBy": None}
            ],
            "meta": [{"label": "提出期限", "value": "2026/10/01 17:00"}],
            "timeline": [],
            "detailLoaded": True
        }]
    }), demo=False)
    page.locator(".row__open").first.click()
    page.wait_for_timeout(200)
    body = page.inner_text("#panel")
    check("概要" in body, f"元アプリの項目名が出ていない: {body!r}")
    check(page.input_value("#panel-text") == "測定をやり直し中。",
          f"詳細の本文が出ていない: {page.input_value('#panel-text')!r}")
    check(page.locator("#panel-save").count() == 1,
          "実データでも保存ボタンが必要")
    readonly = page.locator("#panel-text").get_attribute("readonly")
    check(readonly is None, f"本文が読み取り専用になっている: {readonly!r}")
    check("自動で保存" in body, f"自動保存の案内が無い: {body!r}")
    check("作成開始日" in body and "作成終了日" in body,
          f"作成日の表示名が違う: {body!r}")
    check("10: (未定)" in page.inner_text("#view"),
          "タイトル下のチーム名が出ていない")
    page.locator("#panel-save").click()
    page.wait_for_selector("#panel", state="hidden", timeout=5000)
    row = page.locator("#view tbody tr").first.inner_text()
    check("10/01" in row and "10/07" in row,
          f"保存後に一覧の期間が更新されない: {row!r}")
    print("  週報: 詳細の項目名を素通し / 実データも編集できる / UUID 行 / 保存で閉じて一覧更新")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--base", default="http://localhost:8081/index.html?demo=1")
    args = ap.parse_args()

    errors: list[str] = []

    with sync_playwright() as pw:
        browser = pw.chromium.launch(channel="chrome")
        page = browser.new_page(viewport={"width": 1280, "height": 900})

        def on_console(m):
            if m.type != "error":
                return
            url = (m.location or {}).get("url", "")
            if "/api/" in url:      # 静的配信では /api が無い。想定内。
                return
            errors.append(f"{m.type}: {m.text} ({url})")

        page.on("console", on_console)
        page.on("pageerror", lambda e: errors.append(f"pageerror: {e}"))

        page.goto(args.base, wait_until="load")
        page.wait_for_selector("#app:not([hidden])", timeout=15000)
        page.evaluate(SETUP)

        check_notifications(page)
        check_equipments(page)
        check_orders(page)
        check_loans(page)
        check_dashboard(page)
        check_reports(page)

        browser.close()

    failures.extend(f"console: {e}" for e in errors)

    print()
    if failures:
        for f in failures:
            print(f"FAIL: {f}")
        return 1
    print("PASS: 実データにしか出ない形（read=null・unreadText=null・action あり・"
          "meta=null・金額が読めない・0 円・0 件・節の増減）に対する描画")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
