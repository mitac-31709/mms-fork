#!/usr/bin/env python3
"""フォークの応答性と操作性を実ブラウザで検証する。

Hallmark の slop test のうち、目視でなく機械で確かめられるゲートを見る。

  gate 34 : 320〜1920px のどの幅でも横スクロールが出ない
  gate 49 : ボタン・ナビ・タブのラベルが 2 行に折り返さない
  gate 26 : 操作できる要素に :focus-visible / :active / :disabled が定義されている
  gate 50 : 画像を含む grid トラックが bare 1fr でない（画像が無いので自明に通る）

加えて、フォークで直したと主張している挙動そのものを確認する。
  - 絞り込み・並べ替えでページが再読み込みされない
  - 状態が URL に同期される
  - Escape と背景クリックでパネルが閉じ、フォーカスが呼び出した行へ戻る
  - パネルを閉じても本文が保持される

前提: フォークが http://localhost:8081/ で配信されていること。

静的配信だけの場合 `/api/reports` は 404 になり、画面は同梱のデモデータに落ちる。
その 404 は想定内として無視し、代わりに「デモデータに落ちた」表示が出ているかを見る。
Worker 経由（`../deploy/`）の API そのものは `../deploy/test/api.test.mjs` で検証する。

    python3 test_responsive.py [--base http://localhost:8081/index.html?demo=1]
"""

from __future__ import annotations

import argparse
import sys

from playwright.sync_api import sync_playwright

WIDTHS = [320, 375, 414, 768, 1024, 1280, 1920]
CLICKABLE = ".btn, .rail__link, .sort-btn, .segmented__option span, .toast__action, .icon-btn, .datasource__refresh"

failures: list[str] = []


def check(condition: bool, message: str) -> None:
    if not condition:
        failures.append(message)


def open_reports(page, base: str) -> None:
    """週報一覧を開く。

    画面はクライアント側でルーティングするので、静的配信では `/reports` を
    直接開くと 404 になる。入口を開いてからレールの「週報」を押す。

    1024px 未満ではレールが折りたたまれてリンクが不可視なので、要素の click() を
    直接呼ぶ。ルータは document 上の委譲リスナなので、実際のクリックと同じ経路を通る。
    """
    page.goto(base, wait_until="load")
    page.wait_for_selector("#app:not([hidden])", timeout=15000)
    page.eval_on_selector('a[data-route="/reports"]', "el => el.click()")
    page.wait_for_selector(".row", timeout=15000)


def check_widths(page, base: str) -> None:
    for w in WIDTHS:
        page.set_viewport_size({"width": w, "height": 900})
        open_reports(page, base)

        overflow = page.evaluate(
            "() => document.documentElement.scrollWidth - document.documentElement.clientWidth")
        check(overflow <= 0, f"gate 34: {w}px で横に {overflow}px あふれている")

        # gate 49: クリックできる文字が 2 行に折り返していないか。
        # 要素の高さでは測れない（タッチ領域のために 44px 確保しているため）。
        # テキストノードの矩形の上端が何種類あるかで実際の行数を数える。
        wrapped = page.evaluate("""
          (sel) => {
            const lineCount = (el) => {
              const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
              const tops = new Set();
              let node;
              while ((node = walker.nextNode())) {
                if (!node.textContent.trim()) continue;
                const range = document.createRange();
                range.selectNodeContents(node);
                for (const rect of range.getClientRects()) {
                  if (rect.width > 0) tops.add(Math.round(rect.top / 4));
                }
              }
              return tops.size;
            };
            return [...document.querySelectorAll(sel)]
              .filter(el => el.offsetParent !== null && el.textContent.trim())
              .filter(el => lineCount(el) > 1)
              .map(el => `${el.textContent.trim().slice(0, 20)}(${lineCount(el)}行)`);
          }
        """, CLICKABLE)
        check(not wrapped, f"gate 49: {w}px でラベルが折り返している → {wrapped}")

        # 768px 未満では表がカードに切り替わり、列見出しは隠れる
        thead_shown = page.evaluate(
            "() => getComputedStyle(document.querySelector('.table thead')).display !== 'none'")
        if w < 768:
            check(not thead_shown, f"{w}px でカード表示に切り替わっていない")
        else:
            check(thead_shown, f"{w}px で列見出しが消えている")

        print(f"  {w:>4}px  overflow={overflow}  thead={'表示' if thead_shown else '非表示'}")


def check_states(page, base: str) -> None:
    """gate 26: 8 状態のうちコードに存在すべき 3 つが CSS に書かれているか。"""
    page.set_viewport_size({"width": 1280, "height": 900})
    page.goto(base, wait_until="load")

    # CSS ネスト対応のブラウザでは CSSStyleRule も cssRules を持つ（空の CSSRuleList）。
    # 空でも truthy なので、三項演算子で平坦化すると通常のルールが全部落ちる。再帰で拾う。
    rules = page.evaluate("""
      () => {
        const all = [];
        const walk = (list) => {
          for (const r of list) {
            all.push(r.selectorText || '');
            if (r.cssRules && r.cssRules.length) walk(r.cssRules);
          }
        };
        for (const sheet of document.styleSheets) {
          if (!sheet.href || !sheet.href.includes('app.css')) continue;
          walk(sheet.cssRules);
        }
        return all.join(' | ');
      }
    """)
    for needed in (":focus-visible", ":active", ":disabled", "hover"):
        check(needed in rules, f"gate 26: app.css に {needed} の定義が無い")
    print("  focus-visible / active / disabled / hover: すべて定義あり")


def check_dashboard(page, base: str) -> None:
    """フォーク独自のホーム。元アプリの「調整中」だけでなく他画面の件数を出す。"""
    page.set_viewport_size({"width": 1280, "height": 900})
    page.goto(base, wait_until="load")
    page.wait_for_selector("#app:not([hidden])", timeout=15000)
    page.wait_for_selector(".board__title, .board__empty", timeout=15000)
    view = page.inner_text("#view")
    check("提出が近い週報" in view or "未完了の週報はありません" in view,
          f"ホームに週報の焦点が無い: {view[:400]!r}")
    check("週報 未完了" in view, "ホームに週報の件数がない")
    check("調整中" in view, "元アプリの「調整中」を残していない")
    if page.locator(".board__title").count():
        page.locator(".board__actions .btn--primary").click()
        page.wait_for_selector(".row", timeout=15000)
        check("report_id=" in page.url, f"週報へ深リンクしていない → {page.url}")
        print("  ダッシュボード: 件数と期限の近い週報、開くと report_id が付く")
    else:
        print("  ダッシュボード: 未完了なし（件数だけ）")

    page.set_viewport_size({"width": 320, "height": 900})
    page.goto(base, wait_until="load")
    page.wait_for_selector("#app:not([hidden])", timeout=15000)
    page.wait_for_selector(".board__layout", timeout=15000)
    overflow = page.evaluate(
        "() => document.documentElement.scrollWidth - document.documentElement.clientWidth")
    check(overflow <= 0, f"ダッシュボードが 320px で横に {overflow}px あふれる")


def check_data_source(page, base: str) -> None:
    """データの出どころが必ず画面に出ていること。実データとデモを取り違えないため。"""
    page.set_viewport_size({"width": 1280, "height": 900})
    open_reports(page, base)

    check(page.is_visible("#data-source"), "データの出どころが表示されていない")
    check(page.is_visible("#data-source-refresh"), "取得時刻の横に更新ボタンが無い")
    check(page.inner_text("#data-source-refresh").strip() == "更新",
          "更新ボタンのラベルが『更新』ではない")
    note = page.inner_text("#data-source-note")
    kind = page.get_attribute("#data-source", "data-kind")
    check(kind in ("live", "cache", "stale", "demo"), f"data-kind が想定外: {kind}")
    if kind == "demo":
        check("デモデータ" in note, f"デモなのに表示が {note!r}")
    print(f"  出どころ: {kind} — {note}")

    page.wait_for_function(
        """() => {
          const btn = document.querySelector('#data-source-refresh');
          const note = document.querySelector('#data-source-note');
          return btn && !btn.disabled && note && !note.textContent.includes('裏で更新中');
        }""",
        timeout=8000)
    page.click("#data-source-refresh")
    page.wait_for_function(
        "() => document.querySelector('#data-source-refresh')?.getAttribute('aria-busy') === 'true'",
        timeout=2000)
    page.wait_for_function(
        """() => {
          const btn = document.querySelector('#data-source-refresh');
          const kind = document.querySelector('#data-source')?.dataset.kind;
          return btn && btn.getAttribute('aria-busy') === 'false' && kind === 'live';
        }""",
        timeout=8000)
    print("  更新: 押すと再取得し、出どころが live になる")


def check_behaviour(page, base: str) -> None:
    page.set_viewport_size({"width": 1280, "height": 900})
    open_reports(page, base)

    # 再読み込みされていないことを見るための印をページに付ける
    page.evaluate("() => { window.__alive = true; }")

    total = page.locator(".row").count()
    check(total == 14, f"初期表示が {total} 行（14 行を期待）")

    # 絞り込み
    page.fill("#q", "第1")
    page.wait_for_timeout(120)
    filtered = page.locator(".row").count()
    check(0 < filtered < total, f"絞り込みが効いていない（{filtered} 行）")
    check(page.evaluate("() => window.__alive === true"),
          "絞り込みでページが再読み込みされた")
    check("q=" in page.url, f"絞り込みが URL に同期されていない → {page.url}")
    print(f"  絞り込み: {total} → {filtered} 行、再読み込みなし、URL 同期あり")

    page.fill("#q", "")
    page.wait_for_timeout(120)

    # gate 53: CSS だけのタブ切替でページ先頭へ飛ぶのは、ラジオを
    # position:absolute; top:0 に置いたときの症状。まず構造で確かめる。
    radio_pos = page.evaluate(
        "() => getComputedStyle(document.querySelector('input[name=status]')).position")
    check(radio_pos != "absolute",
          f"gate 53: ステータスのラジオが position:{radio_pos} にある")

    # 次に実際のスクロール挙動。絞り込みで文書が短くなった分は
    # ブラウザが正当にクリップするので、その分は許容して比較する。
    page.evaluate("() => window.scrollTo(0, 200)")
    page.wait_for_timeout(60)
    before = page.evaluate("() => window.scrollY")
    page.locator('.segmented__option:has-text("未完了") span').click()
    page.wait_for_timeout(180)
    after, max_scroll = page.evaluate(
        "() => [window.scrollY, Math.max(0, document.documentElement.scrollHeight - window.innerHeight)]")
    check(after == min(before, max_scroll),
          f"gate 53: ステータス切替でスクロールが飛んだ {before}→{after}"
          f"（この時点の最大スクロール {max_scroll}）")
    open_rows = page.locator(".row").count()
    check(open_rows == 4, f"未完了の件数が {open_rows} 件（4 件を期待）")
    print(f"  ステータス絞り込み: 4 行、ラジオは position:{radio_pos}、"
          f"スクロール {before}→{after}（最大 {max_scroll}）")

    page.locator('.segmented__option:has-text("すべて") span').click()
    page.wait_for_timeout(120)
    page.evaluate("() => window.scrollTo(0, 0)")

    # 列ソート。aria-sort が列見出しセルに付き、向きが反転すること
    page.click('.sort-btn[data-sort="title"]')
    page.wait_for_timeout(120)
    asc = page.get_attribute(".table__th--title", "aria-sort")
    page.click('.sort-btn[data-sort="title"]')
    page.wait_for_timeout(120)
    desc = page.get_attribute(".table__th--title", "aria-sort")
    check(asc == "ascending" and desc == "descending",
          f"ソートの向きが反転しない（{asc} → {desc}）")
    check("sort_by=title" in page.url, f"ソートが URL に同期されていない → {page.url}")
    check(page.evaluate("() => window.__alive === true"), "ソートでページが再読み込みされた")
    print(f"  ソート: {asc} → {desc}、再読み込みなし、URL 同期あり")

    # 並べ替えを戻す
    page.select_option("#sort", "due:asc")
    page.wait_for_timeout(120)

    # 詳細パネル。Escape で閉じ、フォーカスが呼び出した行へ戻ること
    first = page.locator(".row__open").first
    title = first.inner_text()
    first.click()
    page.wait_for_timeout(500)
    check(page.is_visible("#panel"), "パネルが開かない")
    check(page.is_visible("#scrim"), "背景の暗幕が出ない")
    check(page.get_attribute("#panel", "role") == "dialog", "パネルに role=dialog が無い")
    check(page.get_attribute("#panel", "aria-modal") == "true", "パネルに aria-modal が無い")
    check(page.inner_text("#panel-title") == title,
          f"パネルの見出しが行と一致しない（{page.inner_text('#panel-title')} vs {title}）")
    check("report_id=" in page.url, f"report_id が URL に無い → {page.url}")

    # 本文を書き換えてから閉じ、開き直したときに保持されているか
    page.fill("#panel-text", "検証用に書き換えた本文")
    page.wait_for_timeout(700)
    check(page.inner_text("#save-state") == "保存しました",
          f"自動保存の表示が出ない → {page.inner_text('#save-state')}")

    page.keyboard.press("Escape")
    page.wait_for_timeout(300)
    check(not page.is_visible("#panel"), "Escape でパネルが閉じない")
    focused = page.evaluate("() => document.activeElement?.textContent?.trim()")
    check(focused == title, f"閉じた後のフォーカスが呼び出した行に戻らない → {focused!r}")
    print(f"  パネル: Escape で閉じ、フォーカスは「{focused}」に復帰")

    first.click()
    page.wait_for_timeout(500)
    check(page.input_value("#panel-text") == "検証用に書き換えた本文",
          "開き直したときに本文が保持されていない")
    print("  パネル: 閉じても本文を保持")

    # 背景クリックで閉じる
    page.click("#scrim", position={"x": 20, "y": 20})
    page.wait_for_timeout(300)
    check(not page.is_visible("#panel"), "背景クリックでパネルが閉じない")
    print("  パネル: 背景クリックで閉じる")

    # 「/」で検索欄へ
    page.keyboard.press("/")
    page.wait_for_timeout(120)
    check(page.evaluate("() => document.activeElement?.id") == "q",
          "「/」で検索欄にフォーカスが移らない")
    print("  ショートカット: 「/」で検索欄へ")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--base", default="http://localhost:8081/index.html?demo=1")
    args = ap.parse_args()

    def on_console(m):
        if m.type != "error":
            return
        # 静的配信では /api/* が無い。404 は想定内で、画面はデモデータに落ちる。
        url = (m.location or {}).get("url", "")
        if "/api/" in url:
            return
        failures.append(f"console {m.type}: {m.text} ({url})")

    with sync_playwright() as pw:
        browser = pw.chromium.launch(channel="chrome")
        page = browser.new_page()
        page.on("console", on_console)
        page.on("pageerror", lambda e: failures.append(f"pageerror: {e}"))

        print("--- 幅ごとの検証 ---")
        check_widths(page, args.base)
        print("--- 状態の定義 ---")
        check_states(page, args.base)
        print("--- データの出どころ ---")
        check_data_source(page, args.base)
        print("--- ダッシュボード ---")
        check_dashboard(page, args.base)
        print("--- 挙動の検証 ---")
        check_behaviour(page, args.base)

        browser.close()

    print()
    if failures:
        for f in failures:
            print(f"FAIL: {f}")
        return 1
    print("PASS: 320-1920px の横あふれなし・ラベル折り返しなし・"
          "状態定義あり・再読み込みなしの絞り込みとソート・"
          "パネルの Escape / 背景クリック / フォーカス復帰 / 内容保持")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
