/* TA の注文一覧。
 *
 * 元アプリの `/ta/orders` は 20 件ずつのページで、型番とショップは商品セルの
 * 中に埋まっている。検索欄の説明は「商品名 / ショップ名 / 型番 / メモ」だが、
 * ページの外は検索できない。ここでは全ページをまとめた JSON を、型番・
 * 商品名・ショップ・チームで絞り込む。メモは一覧の HTML に無いので対象にしない。
 */

import { api } from '../api.js';
import { demoTaOrders } from '../demo.js';
import { fmtDate, fmtYen } from '../format.js';
import { dataTable, emptyBlock, h, metaList, panel, statusPill } from '../ui.js';

export const meta = { route: '/ta/orders', nav: 'TA注文', title: '注文管理' };

const SORT_KEYS = [
  'product', 'modelNumber', 'team', 'unitPriceValue', 'quantityValue',
  'totalValue', 'status', 'createdAt'
];
const state = {
  q: '', status: 'all', team: 'all',
  sortKey: 'createdAt', sortDir: 'desc', selectedId: null
};

const numeric = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

export async function load(ctx, opts = {}) {
  return ctx.demo ? demoTaOrders(opts) : api.taOrders(opts);
}

export function render(data, ctx) {
  const rows = (data.orders || []).map(normalize);
  const emptyText = data.empty || { title: '注文がありません', body: '' };
  const statuses = data.statuses?.length
    ? data.statuses.map((s) => s.label)
    : [...new Set(rows.map((o) => o.status).filter(Boolean))];
  const teams = data.teams?.length
    ? data.teams.map((t) => t.label)
    : [...new Set(rows.map((o) => o.team).filter(Boolean))];

  readUrl(statuses, teams);

  const listHost = h('div', { class: 'list' });
  const countEl = h('p', {
    class: 'toolbar__count', id: 'result-count', role: 'status', 'aria-live': 'polite'
  });
  const summary = h('dl', { class: 'summary summary--wrap' });

  const page = h('div', {},
    h('header', { class: 'page-head' },
      h('div', {},
        h('h1', { class: 'page-head__title', text: meta.title })),
      summary),
    buildToolbar(statuses, teams),
    listHost);

  paint();
  if (state.selectedId != null) openDetail(state.selectedId, { focus: false });
  return page;

  function normalize(o) {
    return {
      id: o.id,
      product: o.product || '',
      shopName: o.shopName || '',
      modelNumber: o.modelNumber || '',
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

  function createdRank(o) {
    const clock = String(o.createdText || '').match(/(\d{1,2}):(\d{2})/);
    const minutes = clock ? Number(clock[1]) * 60 + Number(clock[2]) : 0;
    if (o.createdISO) {
      const base = Date.parse(o.createdISO);
      if (Number.isFinite(base)) return base + minutes * 60000;
    }
    const md = String(o.createdText || '').match(/(\d{1,2})\/(\d{1,2})/);
    if (!md) return null;
    return Date.UTC(0, Number(md[1]) - 1, Number(md[2])) + minutes * 60000;
  }

  function sortValue(o) {
    switch (state.sortKey) {
      case 'product': return o.product;
      case 'modelNumber': return o.modelNumber || null;
      case 'team': return o.team || null;
      case 'status': return o.status;
      case 'createdAt': return createdRank(o);
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
        if (!q) return true;
        const hay = [o.product, o.modelNumber, o.shopName, o.team, o.status]
          .join('\n').toLowerCase();
        return hay.includes(q);
      })
      .sort((a, b) => {
        const x = sortValue(a);
        const y = sortValue(b);
        if (x === y) return String(a.id ?? '').localeCompare(String(b.id ?? ''));
        if (x == null || x === '') return 1;
        if (y == null || y === '') return -1;
        if (typeof x === 'number' && typeof y === 'number') return (x - y) * dir;
        return (String(x) > String(y) ? 1 : -1) * dir;
      });
  }

  function readUrl(statusOptions, teamOptions) {
    const p = new URLSearchParams(location.search);
    state.q = p.get('q') || '';
    const status = p.get('status');
    state.status = status && statusOptions.includes(status) ? status : 'all';
    const team = p.get('team');
    state.team = team && teamOptions.includes(team) ? team : 'all';
    const key = p.get('sort_by');
    if (SORT_KEYS.includes(key)) state.sortKey = key;
    state.sortDir = p.get('sort_direction') === 'asc' ? 'asc' : 'desc';
    const id = p.get('order_id');
    state.selectedId = id && /^[0-9a-f-]{8,}$/i.test(id) ? id : null;
  }

  function syncUrl() {
    const p = new URLSearchParams();
    if (state.q.trim()) p.set('q', state.q.trim());
    if (state.status !== 'all') p.set('status', state.status);
    if (state.team !== 'all') p.set('team', state.team);
    p.set('sort_by', state.sortKey);
    p.set('sort_direction', state.sortDir);
    if (state.selectedId) p.set('order_id', state.selectedId);
    if (ctx.demo) p.set('demo', '1');
    history.replaceState(null, '', `${location.pathname}?${p}`);
  }

  function buildToolbar(statusOptions, teamOptions) {
    const search = h('input', {
      class: 'input', type: 'search', id: 'q', name: 'q',
      placeholder: '型番・商品名・ショップ', autocomplete: 'off',
      'aria-describedby': 'q-hint',
      value: state.q,
      oninput: (e) => { state.q = e.target.value; paint(); syncUrl(); }
    });

    const statusSelect = h('select', {
      class: 'input select', id: 'status', name: 'status',
      onchange: (e) => { state.status = e.target.value; paint(); syncUrl(); }
    },
      h('option', { value: 'all', selected: state.status === 'all' }, 'すべて'),
      statusOptions.map((label) => h('option', {
        value: label, selected: state.status === label
      }, label)));

    const teamSelect = h('select', {
      class: 'input select', id: 'team', name: 'team',
      onchange: (e) => { state.team = e.target.value; paint(); syncUrl(); }
    },
      h('option', { value: 'all', selected: state.team === 'all' }, 'すべて'),
      teamOptions.map((label) => h('option', {
        value: label, selected: state.team === label
      }, label)));

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
      ['modelNumber:asc', '型番順'],
      ['product:asc', '商品名順'],
      ['team:asc', 'チーム順']
    ].map(([value, label]) => h('option', {
      value, selected: value === `${state.sortKey}:${state.sortDir}`
    }, label)));

    return h('div', { class: 'toolbar' },
      h('div', { class: 'field field--search' },
        h('label', { class: 'field__label', for: 'q', text: '検索' }),
        search,
        h('p', { class: 'field__hint', id: 'q-hint' },
          '型番・商品名・ショップ・チーム')),
      h('div', { class: 'field field--status' },
        h('label', { class: 'field__label', for: 'status', text: 'ステータス' }),
        h('span', { class: 'select-wrap' }, statusSelect),
        h('p', { class: 'field__hint', 'aria-hidden': 'true' }, '\u00a0')),
      h('div', { class: 'field field--team' },
        h('label', { class: 'field__label', for: 'team', text: 'チーム' }),
        h('span', { class: 'select-wrap' }, teamSelect),
        h('p', { class: 'field__hint', 'aria-hidden': 'true' }, '\u00a0')),
      h('div', { class: 'field field--sort' },
        h('label', { class: 'field__label', for: 'sort', text: '並べ替え' }),
        h('span', { class: 'select-wrap' }, sortSelect),
        h('p', { class: 'field__hint', 'aria-hidden': 'true' }, '\u00a0')),
      countEl);
  }

  function paint() {
    const list = visible();

    if (list.length) {
      listHost.replaceChildren(dataTable({
        caption: 'TA の注文一覧。型番・ショップ・チームでも絞り込めます。行を開くと右に詳細が出ます。',
        columns: [
          { key: 'product', label: '商品', className: 'table__th--title' },
          { key: 'modelNumber', label: '型番', className: 'table__th--model' },
          { key: 'team', label: 'チーム', className: 'table__th--team' },
          { key: 'quantityValue', label: '数量', className: 'table__th--qty' },
          { key: 'status', label: 'ステータス', className: 'table__th--state' },
          { key: 'createdAt', label: '作成日時', className: 'table__th--when' }
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
          idPrefix: 'order',
          selected: o.id === state.selectedId,
          onOpen: (id) => openDetail(id),
          cells: [
            {
              label: '商品',
              value: o.shopName
                ? [o.product, h('span', { class: 'cell__sub', text: o.shopName })]
                : o.product
            },
            {
              label: '型番',
              value: o.modelNumber || '—',
              className: 'cell--model'
            },
            { label: 'チーム', value: o.team || '—', className: 'cell--wrap' },
            { label: '数量', value: o.quantityText, className: 'cell--num' },
            {
              label: 'ステータス',
              value: statusPill(o.status, { doneWhen: ['受取済み'] })
            },
            { label: '作成日時', value: o.createdText || '—', className: 'cell--num' }
          ]
        }))
      }));
      wireKeyboard();
    } else {
      listHost.replaceChildren(filtering()
        ? emptyBlock({
          title: '条件に合う注文がありません',
          body: '型番や商品名、ショップ、チーム、ステータスを変えてみてください。',
          actionLabel: '絞り込みを解除',
          onAction: resetFilters
        })
        : emptyBlock(emptyText));
    }

    const shown = data.truncated && data.total != null
      ? `${filtering() ? `${list.length} / ` : ''}${rows.length} / ${data.total} 件`
      : (filtering() ? `${list.length} / ${rows.length} 件` : `${rows.length} 件`);
    countEl.textContent = shown;

    const chips = [
      ...statuses.map((label) => [label, rows.filter((o) => o.status === label).length, '']),
      ['合計', rows.length, 'summary__item--total']
    ];
    summary.replaceChildren(...chips.map(([label, value, extra]) =>
      h('div', { class: `summary__item ${extra}`.trim() },
        h('dt', { class: 'summary__label', text: label }),
        h('dd', { class: 'summary__value', text: String(value) }))));
  }

  function resetFilters() {
    state.q = '';
    state.status = 'all';
    state.team = 'all';
    const root = listHost.parentElement;
    const input = root?.querySelector('#q');
    if (input) input.value = '';
    const status = root?.querySelector('#status');
    const team = root?.querySelector('#team');
    if (status) status.value = 'all';
    if (team) team.value = 'all';
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

  function statusValueOf(label) {
    return (data.statuses || []).find((item) => item.label === label)?.value || '';
  }

  function openDetail(id, { focus = true } = {}) {
    const o = rows.find((x) => x.id === id);
    if (!o) return;

    state.selectedId = id;
    paint();
    syncUrl();

    const options = data.statuses || [];
    let savedValue = statusValueOf(o.status);
    const errorEl = h('p', { class: 'form-error', id: 'order-status-error', hidden: true });
    const select = h('select', {
      class: 'input select', id: 'order-status', name: 'status',
      onchange: syncSave
    }, [
      savedValue ? null : h('option', { value: '', selected: true }, o.status || '—'),
      ...options.map((item) => h('option', {
        value: item.value,
        selected: item.value === savedValue
      }, item.label))
    ]);
    const saveButton = h('button', {
      class: 'btn btn--primary', type: 'button', id: 'order-status-save',
      disabled: true,
      onclick: () => saveStatus(o, select, saveButton, errorEl)
    }, 'ステータスを更新');

    function syncSave() {
      saveButton.disabled = !select.value || select.value === savedValue;
    }

    async function saveStatus(order, statusSelect, button, error) {
      const next = statusSelect.value;
      const label = options.find((item) => item.value === next)?.label;
      if (!next || !label || next === savedValue) return;
      error.hidden = true;
      button.disabled = true;
      button.dataset.state = 'loading';
      button.textContent = '更新中…';
      try {
        if (!ctx.demo) {
          const result = await api.updateTaOrderStatus(order.id, next);
          if (result?.statusLabel) order.status = result.statusLabel;
          else order.status = label;
        } else {
          order.status = label;
        }
        savedValue = next;
        paint();
      } catch (e) {
        error.textContent = e?.message || 'ステータスを更新できませんでした';
        error.hidden = false;
      } finally {
        button.textContent = 'ステータスを更新';
        delete button.dataset.state;
        syncSave();
      }
    }

    const editor = options.length
      ? h('div', { class: 'form-stack' },
        errorEl,
        h('div', { class: 'field' },
          h('label', { class: 'field__label', for: 'order-status', text: 'ステータス' }),
          h('span', { class: 'select-wrap' }, select)))
      : h('div', {},
        h('span', { class: 'meta__label', text: 'ステータス' }),
        statusPill(o.status, { doneWhen: ['受取済み'] }));

    panel.open({
      eyebrow: 'TA注文',
      title: o.product,
      body: [
        editor,
        metaList([
          ['商品', o.product || '—'],
          ['型番', o.modelNumber || '—'],
          ['ショップ', o.shopName || '—'],
          ['チーム', o.team || '—'],
          ['単価', o.unitPriceText],
          ['数量', o.quantityText],
          ['合計', o.totalText],
          ['作成日時', o.createdText || '—']
        ])
      ],
      actions: options.length
        ? [
          saveButton,
          h('button', {
            class: 'btn btn--secondary', type: 'button', id: 'panel-cancel',
            onclick: () => panel.close()
          }, '閉じる')
        ]
        : [
          h('button', {
            class: 'btn btn--secondary', type: 'button', id: 'panel-cancel',
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

    if (!focus) document.activeElement?.blur?.();
  }
}
