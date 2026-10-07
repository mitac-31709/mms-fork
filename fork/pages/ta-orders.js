/* TA 注文一覧。
 *
 * 学生の注文画面と同じ骨格（表・絞り込み・詳細パネル）に、
 * チーム列と「注文済み → 受取可能」の一括更新を足す。
 */

import { api } from '../api.js';
import { demoTaOrder, demoTaOrders } from '../demo.js';
import { fmtDate, fmtYen } from '../format.js';
import { dataTable, emptyBlock, h, historyTimeline, metaList, panel, statusPill, toasts } from '../ui.js';

export const meta = {
  route: '/ta/orders',
  nav: '注文',
  title: '注文管理',
  mode: 'ta'
};

const ORDER_STATUSES = ['保留中', '注文済み', '受取可能', '受取済み', 'キャンセル済み'];
const SORT_KEYS = [
  'product', 'team', 'unitPriceValue', 'quantityValue', 'totalValue', 'status', 'createdAt'
];
const state = {
  q: '', status: 'all', team: 'all',
  sortKey: 'createdAt', sortDir: 'desc',
  selectedId: null, selected: new Set()
};

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
  return ctx.demo ? demoTaOrders(opts) : api.taOrders(opts);
}

export function render(data, ctx) {
  const rows = (data.orders || []).map(normalize);
  const emptyText = data.empty || { title: '注文がありません', body: '' };
  const teamOptions = (data.filters?.team || [])
    .filter((o) => o.value)
    .map((o) => o.label);

  readUrl();
  // URL から開いた選択は維持。画面内の選択集合は描画ごとに生きた id だけ残す
  state.selected = new Set(
    [...state.selected].filter((id) => rows.some((r) => sameId(r.id, id)))
  );

  const listHost = h('div', { class: 'list' });
  const countEl = h('p', {
    class: 'toolbar__count', id: 'result-count', role: 'status', 'aria-live': 'polite'
  });
  const summary = h('dl', { class: 'summary' });
  const bulkBar = h('div', { class: 'bulkbar', id: 'ta-bulk' });

  const page = h('div', {},
    h('header', { class: 'page-head' },
      h('h1', { class: 'page-head__title', text: meta.title }),
      summary),
    buildToolbar(),
    bulkBar,
    listHost);

  paint();
  if (state.selectedId != null) openDetail(state.selectedId, { focus: false });
  return page;

  function normalize(o) {
    return {
      id: o.id,
      product: o.product || '',
      team: o.team || '',
      status: o.status || '',
      unitPriceValue: numeric(o.unitPriceValue),
      quantityValue: numeric(o.quantityValue),
      totalValue: numeric(o.totalValue),
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
      case 'team': return o.team;
      case 'status': return o.status;
      case 'createdAt': return o.createdISO || o.createdText;
      default: return o[state.sortKey];
    }
  }

  function filtering() {
    return state.q.trim() !== '' || state.status !== 'all' || state.team !== 'all';
  }

  function visible() {
    const q = state.q.trim().toLowerCase();
    const dir = state.sortDir === 'asc' ? 1 : -1;
    return rows
      .filter((o) => {
        if (state.status !== 'all' && o.status !== state.status) return false;
        if (state.team !== 'all' && o.team !== state.team) return false;
        if (q && !(`${o.product} ${o.team}`).toLowerCase().includes(q)) return false;
        return true;
      })
      .sort((a, b) => {
        const x = sortValue(a);
        const y = sortValue(b);
        if (x === y) return String(a.id ?? '').localeCompare(String(b.id ?? ''));
        if (x == null) return 1;
        if (y == null) return -1;
        if (typeof x === 'number' && typeof y === 'number') return (x - y) * dir;
        return (String(x) > String(y) ? 1 : -1) * dir;
      });
  }

  function readUrl() {
    const p = new URLSearchParams(location.search);
    state.q = p.get('q') || '';
    const status = p.get('status');
    state.status = ORDER_STATUSES.includes(status) ? status : 'all';
    state.team = p.get('team') || 'all';
    const key = p.get('sort_by');
    if (SORT_KEYS.includes(key)) state.sortKey = key;
    state.sortDir = p.get('sort_direction') === 'asc' ? 'asc' : 'desc';
    state.selectedId = parseOrderQueryId(p.get('order_id'));
  }

  function syncUrl() {
    const p = new URLSearchParams();
    if (state.q.trim()) p.set('q', state.q.trim());
    if (state.status !== 'all') p.set('status', state.status);
    if (state.team !== 'all') p.set('team', state.team);
    p.set('sort_by', state.sortKey);
    p.set('sort_direction', state.sortDir);
    if (state.selectedId != null) p.set('order_id', state.selectedId);
    if (ctx.demo) p.set('demo', '1');
    history.replaceState(null, '', `${location.pathname}?${p}`);
  }

  function buildToolbar() {
    const search = h('input', {
      class: 'input', type: 'search', id: 'q', name: 'q',
      placeholder: '商品・チーム', autocomplete: 'off',
      value: state.q,
      oninput: (e) => { state.q = e.target.value; paint(); syncUrl(); }
    });

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
      })));

    const teams = teamOptions.length
      ? teamOptions
      : [...new Set(rows.map((r) => r.team).filter(Boolean))].sort();
    const teamSelect = h('select', {
      class: 'input select', id: 'team', name: 'team',
      onchange: (e) => {
        state.team = e.target.value || 'all';
        paint();
        syncUrl();
      }
    },
      h('option', { value: 'all', selected: state.team === 'all' || null, text: 'すべて' }),
      teams.map((t) => h('option', {
        value: t, selected: state.team === t || null, text: t
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
      ['team:asc', 'チーム名順'], ['product:asc', '商品名順']
    ].map(([value, label]) => h('option', {
      value, selected: value === `${state.sortKey}:${state.sortDir}`
    }, label)));

    return h('div', { class: 'toolbar' },
      h('div', { class: 'field field--search' },
        h('label', { class: 'field__label', for: 'q', text: '絞り込み' }),
        search),
      h('div', { class: 'field field--status' },
        h('label', { class: 'field__label', for: 'status', text: 'ステータス' }),
        h('span', { class: 'select-wrap' }, statusSelect)),
      h('div', { class: 'field field--status' },
        h('label', { class: 'field__label', for: 'team', text: 'チーム' }),
        h('span', { class: 'select-wrap' }, teamSelect)),
      h('div', { class: 'field field--sort' },
        h('label', { class: 'field__label', for: 'sort', text: '並べ替え' }),
        h('span', { class: 'select-wrap' }, sortSelect)),
      countEl);
  }

  function paintBulk() {
    const n = state.selected.size;
    const orderedSelected = [...state.selected]
      .filter((id) => rows.some((r) => sameId(r.id, id) && r.status === '注文済み'));
    bulkBar.replaceChildren(
      h('div', { class: 'bulkbar__body' },
        h('p', {
          class: 'bulkbar__lede',
          text: '選択した注文済みの注文を受取可能に変更できます（他の状態は除外）。'
        }),
        h('div', { class: 'bulkbar__actions' },
          h('button', {
            class: 'btn btn--primary', type: 'button',
            disabled: orderedSelected.length ? null : true,
            onclick: () => runBulk(orderedSelected)
          }, '受取可能にする'),
          h('span', {
            class: 'bulkbar__count',
            text: `選択 ${n} 件（注文済み ${orderedSelected.length} 件）`
          }))));
  }

  async function runBulk(ids) {
    if (!ids.length) return;
    const ok = window.confirm(
      `選択された${ids.length}件の注文済み状態の注文を「受取可能」に変更します。\nよろしいですか？`
    );
    if (!ok) return;
    try {
      if (ctx.demo) {
        for (const id of ids) {
          const row = rows.find((r) => sameId(r.id, id));
          if (row) row.status = '受取可能';
        }
      } else {
        await api.taBulkAvailable(ids);
        ctx.invalidate?.(['/ta/orders', '/ta']);
      }
      state.selected.clear();
      toasts.push(`${ids.length} 件を受取可能にしました`);
      if (ctx.demo) paint();
      else ctx.reload?.();
    } catch (e) {
      toasts.push(e.message || '一括更新に失敗しました');
    }
  }

  function paint() {
    const list = visible();
    paintBulk();

    if (list.length) {
      listHost.replaceChildren(dataTable({
        caption: 'TA 注文一覧。チェックで一括更新、行を開くと詳細が出ます。',
        columns: [
          { key: 'product', label: '商品', className: 'table__th--title' },
          { key: '_check', label: '選択', className: 'table__th--status' },
          { key: 'team', label: 'チーム', className: 'table__th--created' },
          { key: 'unitPriceValue', label: '単価', className: 'table__th--status' },
          { key: 'quantityValue', label: '数量', className: 'table__th--status' },
          { key: 'totalValue', label: '合計', className: 'table__th--status' },
          { key: 'status', label: 'ステータス', className: 'table__th--status' },
          { key: 'createdAt', label: '作成', className: 'table__th--created' }
        ],
        sort: { key: state.sortKey, dir: state.sortDir },
        onSort: (key) => {
          if (key === '_check') return;
          state.sortDir = state.sortKey === key && state.sortDir === 'asc' ? 'desc' : 'asc';
          state.sortKey = key;
          paint();
          syncUrl();
        },
        rows: list.map((o) => ({
          id: o.id,
          idPrefix: 'order',
          selected: sameId(o.id, state.selectedId),
          onOpen: (id) => openDetail(id),
          cells: [
            { label: '商品', value: o.product },
            {
              label: '選択',
              value: h('input', {
                type: 'checkbox',
                class: 'bulk-check',
                checked: state.selected.has(String(o.id)) || null,
                onclick: (e) => e.stopPropagation(),
                onchange: (e) => {
                  const key = String(o.id);
                  if (e.target.checked) state.selected.add(key);
                  else state.selected.delete(key);
                  paintBulk();
                }
              })
            },
            { label: 'チーム', value: o.team || '—' },
            { label: '単価', value: o.unitPriceText, className: 'cell--num' },
            { label: '数量', value: o.quantityText, className: 'cell--num' },
            { label: '合計', value: o.totalText, className: 'cell--num' },
            { label: 'ステータス', value: statusPill(o.status) },
            { label: '作成', value: o.createdText, className: 'cell--num' }
          ]
        }))
      }));
    } else {
      listHost.replaceChildren(filtering()
        ? emptyBlock({
          title: '条件に合う注文がありません',
          body: '検索語やステータス・チームを変えてみてください。',
          actionLabel: '絞り込みを解除',
          onAction: () => {
            state.q = '';
            state.status = 'all';
            state.team = 'all';
            paint();
            syncUrl();
          }
        })
        : emptyBlock(emptyText));
    }

    countEl.textContent = filtering()
      ? `${list.length} / ${rows.length} 件`
      : `${rows.length} 件`;

    const present = ORDER_STATUSES
      .map((label) => [label, rows.filter((o) => o.status === label).length])
      .filter(([, n]) => n > 0);
    summary.replaceChildren(...[
      ...present.map(([label, value]) => [label, value, '']),
      ['合計', rows.length, 'summary__item--total']
    ].map(([label, value, extra]) => h('div', { class: `summary__item ${extra}`.trim() },
      h('dt', { class: 'summary__label', text: label }),
      h('dd', { class: 'summary__value', text: String(value) }))));
  }

  async function openDetail(id, { focus = true } = {}) {
    const o = rows.find((x) => sameId(x.id, id));
    if (!o) return;

    state.selectedId = id;
    paint();
    syncUrl();

    const bodyHost = h('div', { class: 'loading', text: '詳細を読み込み中…' });
    panel.open({
      eyebrow: 'TA注文',
      title: o.product,
      body: bodyHost,
      actions: [
        h('button', {
          class: 'btn btn--secondary', type: 'button',
          onclick: () => panel.close()
        }, '閉じる')
      ],
      onClose: () => {
        state.selectedId = null;
        paint();
        syncUrl();
        return listHost.querySelector(`#order_${CSS.escape(String(id))} .row__open`);
      }
    });

    try {
      const detail = ctx.demo
        ? await demoTaOrder(id)
        : await api.taOrder(id);
      const entries = [
        ['商品', detail.product || o.product || '—'],
        ['チーム', detail.team || o.team || '—'],
        ['ステータス', statusPill(detail.status || o.status)],
        ['合計', detail.total || o.totalText],
        ['チーム累計予算', detail.teamBudget || '—'],
        ...Object.entries(detail.fields || {}).map(([k, v]) => [k, v || '—'])
      ];
      bodyHost.replaceWith(...[metaList(entries), historyTimeline(detail.history)]
        .filter(Boolean));
    } catch (e) {
      bodyHost.replaceWith(metaList([
        ['商品', o.product || '—'],
        ['チーム', o.team || '—'],
        ['単価', o.unitPriceText],
        ['数量', o.quantityText],
        ['合計', o.totalText],
        ['ステータス', statusPill(o.status)],
        ['作成', o.createdText || '—'],
        ['詳細', e.message || '取得できませんでした']
      ]));
    }

    if (!focus) document.activeElement?.blur?.();
  }
}
