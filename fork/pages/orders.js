/* 注文一覧。
 *
 * 週報一覧（`reports.js`）と同じ作りにしてある。表・絞り込み・並べ替え・
 * 詳細パネルの挙動を画面ごとに変えると、行き来したときに覚え直しになる。
 *
 * 週報との違いは 3 つ。
 *  1. 期限が無いので、既定の並びは作成日の新しい順。
 *  2. 詳細は読み取りだけ。削除も編集も置かない。
 *  3. 「新しい注文」はこのパネルで作る。実データは Worker 経由で元アプリへ POST。
 *
 * ステータス語彙は元アプリの現行どおり:
 *  保留中 / 注文済み / 受取可能 / 受取済み / キャンセル済み
 * （以前の 未完了 / 完了 も読み取り用に残す）。
 */

import { api } from '../api.js';
import { demoOrders } from '../demo.js';
import { fmtDate, fmtYen } from '../format.js';
import { dataTable, emptyBlock, h, metaList, panel, statusPill, toasts } from '../ui.js';

export const meta = { route: '/orders', nav: '注文', title: '注文' };

/** 元アプリの status フィルタ（TA 画面の select）と同じ並び。 */
const ORDER_STATUSES = ['保留中', '注文済み', '受取可能', '受取済み', 'キャンセル済み'];
/** 旧語彙。まだ残っているデータやデモ互換用。 */
const LEGACY_STATUSES = ['未完了', '完了'];
const ALL_FILTER_STATUSES = [...ORDER_STATUSES, ...LEGACY_STATUSES];

const SORT_KEYS = [
  'product', 'unitPriceValue', 'quantityValue', 'totalValue', 'status', 'createdAt'
];
const state = { q: '', status: 'all', sortKey: 'createdAt', sortDir: 'desc', selectedId: null };

/** 元アプリの `sales_site_controller` と同じ対応。 */
const SALES_SITES = [
  { value: 'amazon', label: 'Amazon', shopName: 'Amazon' },
  { value: 'monotaro', label: 'モノタロウ', shopName: 'モノタロウ' },
  { value: 'akizuki', label: '秋月電子通商', shopName: '秋月電子通商' },
  { value: 'other', label: 'その他', shopName: '' }
];

const numeric = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

function sameId(a, b) {
  if (a == null || b == null) return false;
  return String(a) === String(b);
}

function parseOrderQueryId(raw) {
  if (!raw) return null;
  if (/^\d+$/.test(raw)) {
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? n : null;
  }
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(raw)) {
    return raw.toLowerCase();
  }
  return null;
}

export async function load(ctx, opts = {}) {
  return ctx.demo ? demoOrders(opts) : api.orders(opts);
}

export function render(data, ctx) {
  const rows = (data.orders || []).map(normalize);
  const emptyText = data.empty || { title: '注文がありません', body: '' };
  // デモで追加した行の次の id。実データでは使わない。
  let nextDemoId = Math.max(0, ...rows.map((o) => (typeof o.id === 'number' ? o.id : 0))) + 1;

  readUrl();

  const listHost = h('div', { class: 'list' });
  const countEl = h('p', {
    class: 'toolbar__count', id: 'result-count', role: 'status', 'aria-live': 'polite'
  });
  const summary = h('dl', { class: 'summary' });

  const page = h('div', {},
    h('header', { class: 'page-head' },
      h('h1', { class: 'page-head__title', text: meta.title }),
      summary,
      h('button', {
        class: 'btn btn--primary', type: 'button', id: 'new-order', onclick: openNewOrder
      }, '新しい注文')),
    buildToolbar(),
    listHost);

  paint();
  if (state.selectedId != null) openDetail(state.selectedId, { focus: false });
  return page;

  // ── 状態 ────────────────────────────────────────
  function normalize(o) {
    return {
      id: o.id,
      product: o.product || '',
      status: o.status || '',
      unitPriceValue: numeric(o.unitPriceValue),
      quantityValue: numeric(o.quantityValue),
      totalValue: numeric(o.totalValue),
      // 数値にできない値は元の文字列を残す。¥0 と書くと元データと違うことになる。
      unitPriceText: fmtYen(o.unitPriceValue, o.unitPrice || '—'),
      totalText: fmtYen(o.totalValue, o.total || '—'),
      quantityText: o.quantity
        || (numeric(o.quantityValue) != null ? String(o.quantityValue) : '—'),
      createdISO: o.createdAtISO ?? null,
      createdText: o.createdAt || fmtDate(o.createdAtISO)
    };
  }

  function sortValue(o) {
    switch (state.sortKey) {
      case 'product': return o.product;
      case 'status': return o.status;
      case 'createdAt': return o.createdISO || o.createdText;
      default: return o[state.sortKey];   // 金額と数量は数値のまま比べる
    }
  }

  function filtering() {
    return state.q.trim() !== '' || state.status !== 'all';
  }

  function visible() {
    const q = state.q.trim().toLowerCase();
    const dir = state.sortDir === 'asc' ? 1 : -1;
    return rows
      .filter((o) => {
        if (state.status !== 'all' && o.status !== state.status) return false;
        if (q && !o.product.toLowerCase().includes(q)) return false;
        return true;
      })
      .sort((a, b) => {
        const x = sortValue(a);
        const y = sortValue(b);
        if (x === y) return String(a.id ?? '').localeCompare(String(b.id ?? ''));
        // 値が取れなかった行は向きによらず末尾に置く。先頭に来ると読み始めが空になる。
        if (x == null) return 1;
        if (y == null) return -1;
        if (typeof x === 'number' && typeof y === 'number') return (x - y) * dir;
        return (String(x) > String(y) ? 1 : -1) * dir;
      });
  }

  // ── URL 同期。リンクを共有できる状態を保つ ─────────
  function readUrl() {
    const p = new URLSearchParams(location.search);
    state.q = p.get('q') || '';
    const status = p.get('status');
    state.status = ALL_FILTER_STATUSES.includes(status) ? status : 'all';
    const key = p.get('sort_by');
    if (SORT_KEYS.includes(key)) state.sortKey = key;
    state.sortDir = p.get('sort_direction') === 'asc' ? 'asc' : 'desc';
    state.selectedId = parseOrderQueryId(p.get('order_id'));
  }

  function syncUrl() {
    const p = new URLSearchParams();
    if (state.q.trim()) p.set('q', state.q.trim());
    if (state.status !== 'all') p.set('status', state.status);
    p.set('sort_by', state.sortKey);
    p.set('sort_direction', state.sortDir);
    if (state.selectedId != null) p.set('order_id', state.selectedId);
    if (ctx.demo) p.set('demo', '1');
    history.replaceState(null, '', `${location.pathname}?${p}`);
  }

  // ── ツールバー ──────────────────────────────────
  function buildToolbar() {
    const search = h('input', {
      class: 'input', type: 'search', id: 'q', name: 'q',
      placeholder: 'アルミ', autocomplete: 'off', 'aria-describedby': 'q-hint',
      value: state.q,
      oninput: (e) => { state.q = e.target.value; paint(); syncUrl(); }
    });

    // ステータスは 5 値あるので、週報の 2 値セグメントではなく select にする
    // （元アプリの TA 画面と同じ語彙・同じ操作感）。
    const statusSelect = h('select', {
      class: 'input select', id: 'status', name: 'status',
      onchange: (e) => {
        state.status = e.target.value || 'all';
        paint();
        syncUrl();
      }
    },
      h('option', { value: 'all', selected: state.status === 'all' || null, text: 'すべて' }),
      ORDER_STATUSES.map((s) => h('option', {
        value: s, selected: state.status === s || null, text: s
      })),
      // 一覧に旧語彙が残っているときだけ選択肢に出す
      LEGACY_STATUSES
        .filter((s) => rows.some((o) => o.status === s) || state.status === s)
        .map((s) => h('option', {
          value: s, selected: state.status === s || null, text: s
        })));

    const sortSelect = h('select', {
      class: 'input select', id: 'sort', name: 'sort',
      onchange: (e) => {
        const [key, dir] = e.target.value.split(':');
        state.sortKey = key;
        state.sortDir = dir;
        paint();
        syncUrl();
      }
    }, [
      ['createdAt:desc', '作成が新しい順'], ['createdAt:asc', '作成が古い順'],
      ['totalValue:desc', '合計が大きい順'], ['totalValue:asc', '合計が小さい順'],
      ['product:asc', '商品名順']
    ].map(([value, label]) => h('option', {
      value, selected: value === `${state.sortKey}:${state.sortDir}`
    }, label)));

    return h('div', { class: 'toolbar' },
      h('div', { class: 'field field--search' },
        h('label', { class: 'field__label', for: 'q', text: '商品名で絞り込み' }),
        search,
        h('p', { class: 'field__hint', id: 'q-hint' }, h('kbd', { text: '/' }), ' で移動')),
      h('div', { class: 'field field--status' },
        h('label', { class: 'field__label', for: 'status', text: 'ステータス' }),
        h('span', { class: 'select-wrap' }, statusSelect),
        h('p', { class: 'field__hint', 'aria-hidden': 'true' }, '\u00a0')),
      h('div', { class: 'field field--sort' },
        h('label', { class: 'field__label', for: 'sort', text: '並べ替え' }),
        h('span', { class: 'select-wrap' }, sortSelect),
        h('p', { class: 'field__hint', 'aria-hidden': 'true' }, '\u00a0')),
      countEl);
  }

  // ── 描画 ────────────────────────────────────────
  function paint() {
    const list = visible();

    if (list.length) {
      listHost.replaceChildren(dataTable({
        caption: '注文の一覧。列見出しのボタンで並べ替えできます。行を開くと右に詳細が出ます。',
        columns: [
          // 列幅は既存の指定（--status 7rem / --created 8rem）を数の列に流用する。
          { key: 'product', label: '商品', className: 'table__th--title' },
          { key: 'unitPriceValue', label: '単価', className: 'table__th--status' },
          { key: 'quantityValue', label: '数量', className: 'table__th--status' },
          { key: 'totalValue', label: '合計', className: 'table__th--status' },
          { key: 'status', label: 'ステータス', className: 'table__th--status' },
          { key: 'createdAt', label: '作成日', className: 'table__th--created' }
        ],
        sort: { key: state.sortKey, dir: state.sortDir },
        onSort: (key) => {
          state.sortDir = state.sortKey === key && state.sortDir === 'asc' ? 'desc' : 'asc';
          state.sortKey = key;
          paint();
          syncUrl();
          listHost.querySelector(`.sort-btn[data-sort="${key}"]`)?.focus();
        },
        rows: list.map((o) => ({
          id: o.id,
          idPrefix: 'order',        // 元 UI の行 ID 規約を保つ
          selected: sameId(o.id, state.selectedId),
          onOpen: (id) => openDetail(id),
          cells: [
            { label: '商品', value: o.product },
            { label: '単価', value: o.unitPriceText, className: 'cell--num' },
            { label: '数量', value: o.quantityText, className: 'cell--num' },
            { label: '合計', value: o.totalText, className: 'cell--num' },
            { label: 'ステータス', value: statusPill(o.status) },
            { label: '作成日', value: o.createdText, className: 'cell--num' }
          ]
        }))
      }));
      wireKeyboard();
    } else {
      // 絞り込みで 0 件になったのか、そもそも 0 件なのかを言い分ける
      listHost.replaceChildren(filtering()
        ? emptyBlock({
          title: '条件に合う注文がありません',
          body: '検索語やステータスを変えてみてください。',
          actionLabel: '絞り込みを解除',
          onAction: resetFilters
        })
        : emptyBlock(emptyText));
    }

    countEl.textContent = filtering()
      ? `${list.length} / ${rows.length} 件`
      : `${rows.length} 件`;

    // 集計は元アプリに出ている語彙を優先。0 件の語彙は出さない。
    const present = ORDER_STATUSES
      .map((label) => [label, rows.filter((o) => o.status === label).length])
      .filter(([, n]) => n > 0);
    if (!present.length) {
      for (const label of LEGACY_STATUSES) {
        const n = rows.filter((o) => o.status === label).length;
        if (n) present.push([label, n]);
      }
    }
    summary.replaceChildren(...[
      ...present.map(([label, value]) => [label, value, '']),
      ['合計', rows.length, 'summary__item--total']
    ].map(([label, value, extra]) => h('div', { class: `summary__item ${extra}`.trim() },
      h('dt', { class: 'summary__label', text: label }),
      h('dd', { class: 'summary__value', text: String(value) }))));
  }

  function resetFilters() {
    state.q = '';
    state.status = 'all';
    const input = listHost.parentElement?.querySelector('#q');
    if (input) input.value = '';
    const statusEl = listHost.parentElement?.querySelector('#status');
    if (statusEl) statusEl.value = 'all';
    paint();
    syncUrl();
    input?.focus();
  }

  function wireKeyboard() {
    const body = listHost.querySelector('#rows');
    if (!body) return;
    body.addEventListener('keydown', (e) => {
      if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp' && e.key !== 'j' && e.key !== 'k') return;
      e.preventDefault();
      const buttons = [...body.querySelectorAll('.row__open')];
      if (!buttons.length) return;
      const delta = e.key === 'ArrowDown' || e.key === 'j' ? 1 : -1;
      const current = buttons.indexOf(document.activeElement);
      const next = current < 0 ? 0
        : Math.min(buttons.length - 1, Math.max(0, current + delta));
      buttons[next].focus();
    });
  }

  // ── 詳細パネル。元アプリに書き込み口が無いので読むだけ ──
  function openDetail(id, { focus = true } = {}) {
    const o = rows.find((x) => sameId(x.id, id));
    if (!o) return;

    state.selectedId = id;
    paint();
    syncUrl();

    panel.open({
      eyebrow: '注文',
      title: o.product,
      body: metaList([
        ['商品', o.product || '—'],
        ['単価', o.unitPriceText],
        ['数量', o.quantityText],
        ['合計', o.totalText],
        ['ステータス', statusPill(o.status)],
        ['作成日', o.createdText || '—']
      ]),
      actions: [
        h('button', {
          class: 'btn btn--secondary', type: 'button', id: 'panel-cancel',
          onclick: () => panel.close()
        }, '閉じる')
      ],
      onClose: () => {
        state.selectedId = null;
        paint();
        syncUrl();
        // フォーカスを呼び出した行へ返す
        return listHost.querySelector(`#order_${CSS.escape(String(id))} .row__open`)
          || listHost.querySelector(`#order_${id} .row__open`);
      }
    });

    if (!focus) document.activeElement?.blur?.();
  }

  // ── 新しい注文。元アプリの /orders/new と同じ項目 ──
  function openNewOrder() {
    const errorEl = h('p', { class: 'form-error', id: 'order-form-error', hidden: true });
    const totalEl = h('span', { class: 'order-total__value', id: 'order-total', text: '¥0' });

    const productInput = h('input', {
      class: 'input', type: 'text', id: 'order_product_name', name: 'productName',
      required: true, placeholder: '商品名を入力', autocomplete: 'off'
    });
    const amountInput = h('input', {
      class: 'input', type: 'number', id: 'order_amount', name: 'amount',
      required: true, step: '1', min: '0', placeholder: '単価を入力',
      oninput: updateTotal
    });
    const quantityInput = h('input', {
      class: 'input', type: 'number', id: 'order_quantity', name: 'quantity',
      required: true, step: '1', min: '1', value: '1', placeholder: '数量を入力',
      oninput: updateTotal
    });
    const siteSelect = h('select', {
      class: 'input select', id: 'order_sales_site_type', name: 'salesSiteType',
      required: true, onchange: onSiteChange
    },
      h('option', { value: '', text: '選択してください' }),
      SALES_SITES.map((s) => h('option', {
        value: s.value, selected: s.value === 'amazon' || null, text: s.label
      })));
    const shopInput = h('input', {
      class: 'input', type: 'text', id: 'order_shop_name', name: 'shopName',
      required: true, value: 'Amazon', readonly: true,
      placeholder: '販売サイトを選択すると自動入力されます'
    });
    const modelInput = h('input', {
      class: 'input', type: 'text', id: 'order_model_number', name: 'modelNumber',
      placeholder: '型番を入力', autocomplete: 'off'
    });
    const urlInput = h('input', {
      class: 'input', type: 'url', id: 'order_product_url', name: 'productUrl',
      placeholder: 'https://…', autocomplete: 'off'
    });
    const memoInput = h('textarea', {
      class: 'input textarea', id: 'order_memo', name: 'memo', rows: 4,
      placeholder: '追加のメモや仕様（任意）'
    });

    const submitBtn = h('button', {
      class: 'btn btn--primary', type: 'button', id: 'panel-submit-order',
      onclick: () => submitOrder({
        productInput, amountInput, quantityInput, siteSelect, shopInput,
        modelInput, urlInput, memoInput, errorEl, submitBtn
      })
    }, '注文を作成');

    function updateTotal() {
      const amount = Number(amountInput.value) || 0;
      const quantity = Number(quantityInput.value) || 0;
      totalEl.textContent = `¥${(amount * quantity).toLocaleString('ja-JP')}`;
    }

    function onSiteChange() {
      const site = SALES_SITES.find((s) => s.value === siteSelect.value);
      if (!site) {
        shopInput.value = '';
        shopInput.readOnly = true;
        return;
      }
      if (site.value === 'other') {
        shopInput.readOnly = false;
        shopInput.value = '';
        shopInput.placeholder = '販売サイト名を入力してください';
        shopInput.focus();
      } else {
        shopInput.readOnly = true;
        shopInput.value = site.shopName;
        shopInput.placeholder = '販売サイトを選択すると自動入力されます';
      }
    }

    updateTotal();

    panel.open({
      eyebrow: '注文',
      title: '新しい注文',
      body: [
        h('p', {
          class: 'disclaimer',
          text: ctx.demo
            ? 'デモモードでは一覧にだけ追加します。元アプリには送りません。'
            : '入力内容は元アプリの注文として作成されます。'
        }),
        errorEl,
        h('form', {
          class: 'form-stack', id: 'order-create-form',
          onsubmit: (e) => {
            e.preventDefault();
            submitBtn.click();
          }
        },
          field('order_product_name', '商品名', productInput, true),
          h('div', { class: 'form-row' },
            field('order_amount', '単価', amountInput, true),
            field('order_quantity', '数量', quantityInput, true)),
          h('div', { class: 'order-total' },
            h('span', { class: 'order-total__label', text: '合計金額' }),
            totalEl),
          field('order_sales_site_type', '販売サイト',
            h('span', { class: 'select-wrap' }, siteSelect), true),
          field('order_shop_name', '販売サイト名', shopInput, true),
          field('order_model_number', '型番', modelInput, false),
          field('order_product_url', '商品 URL', urlInput, false),
          field('order_memo', 'メモ', memoInput, false))
      ],
      actions: [
        submitBtn,
        h('button', {
          class: 'btn btn--secondary', type: 'button', id: 'panel-cancel',
          onclick: () => panel.close()
        }, 'キャンセル')
      ]
    });
  }

  function field(id, label, control, required) {
    return h('div', { class: 'field' },
      h('label', { class: 'field__label', for: id },
        label, required ? h('span', { class: 'field__req', text: '必須' }) : null),
      control);
  }

  async function submitOrder(parts) {
    const {
      productInput, amountInput, quantityInput, siteSelect, shopInput,
      modelInput, urlInput, memoInput, errorEl, submitBtn
    } = parts;

    const showError = (msg) => {
      errorEl.textContent = msg;
      errorEl.hidden = false;
    };
    errorEl.hidden = true;

    const fields = {
      productName: productInput.value.trim(),
      amount: Number(amountInput.value),
      quantity: Number(quantityInput.value),
      salesSiteType: siteSelect.value,
      shopName: shopInput.value.trim(),
      modelNumber: modelInput.value.trim(),
      productUrl: urlInput.value.trim(),
      memo: memoInput.value.trim()
    };

    if (!fields.productName) return showError('商品名を入力してください');
    if (!Number.isFinite(fields.amount) || fields.amount < 0 || !Number.isInteger(fields.amount)) {
      return showError('単価は 0 以上の整数で入力してください');
    }
    if (!Number.isFinite(fields.quantity) || fields.quantity < 1 || !Number.isInteger(fields.quantity)) {
      return showError('数量は 1 以上の整数で入力してください');
    }
    if (!fields.salesSiteType) return showError('販売サイトを選んでください');
    if (!fields.shopName) return showError('販売サイト名を入力してください');
    if (fields.productUrl && !/^https?:\/\//i.test(fields.productUrl)) {
      return showError('商品 URL は http(s) で始めてください');
    }

    submitBtn.disabled = true;
    submitBtn.dataset.state = 'loading';
    submitBtn.textContent = '作成中…';

    try {
      if (ctx.demo) {
        const created = normalize({
          id: nextDemoId++,
          product: fields.productName,
          unitPrice: `¥${fields.amount.toLocaleString('ja-JP')}`,
          quantity: String(fields.quantity),
          total: `¥${(fields.amount * fields.quantity).toLocaleString('ja-JP')}`,
          status: '保留中',
          createdAt: fmtDate(new Date().toISOString().slice(0, 10)),
          createdAtISO: new Date().toISOString().slice(0, 10),
          unitPriceValue: fields.amount,
          quantityValue: fields.quantity,
          totalValue: fields.amount * fields.quantity
        });
        rows.unshift(created);
        panel.close();
        paint();
        toasts.push(`「${created.product}」を追加しました（デモ）`);
        openDetail(created.id);
        return;
      }

      await api.createOrder(fields);
      panel.close();
      toasts.push(`「${fields.productName}」を作成しました`);
      // 一覧・ダッシュボードのメモリを捨てて元アプリから取り直す。
      ctx.invalidate?.(['/orders', '/dashboard']);
      ctx.reload();
    } catch (e) {
      showError(e.message || '注文を作成できませんでした');
      submitBtn.disabled = false;
      delete submitBtn.dataset.state;
      submitBtn.textContent = '注文を作成';
    }
  }
}
