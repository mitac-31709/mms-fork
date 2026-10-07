/* TA チーム一覧。読み取り専用。 */

import { api } from '../api.js';
import { demoTaTeams } from '../demo.js';
import { fmtYen } from '../format.js';
import { dataTable, emptyBlock, h } from '../ui.js';

export const meta = {
  route: '/ta/teams',
  nav: 'チーム',
  title: 'チーム管理',
  mode: 'ta'
};

const state = { q: '', sortKey: 'name', sortDir: 'asc' };

export async function load(ctx, opts = {}) {
  return ctx.demo ? demoTaTeams(opts) : api.taTeams(opts);
}

export function render(data, ctx) {
  const rows = (data.teams || []).map((t) => ({
    id: t.id,
    name: t.name || '',
    members: t.members || '',
    spend: t.spend || '',
    spendValue: typeof t.spendValue === 'number' ? t.spendValue : null,
    pendingInvites: t.pendingInvites || '',
    spendText: fmtYen(t.spendValue, t.spend || '—')
  }));
  const emptyText = data.empty || { title: 'チームがありません', body: '' };

  const p = new URLSearchParams(location.search);
  state.q = p.get('q') || '';
  if (['name', 'spendValue', 'members'].includes(p.get('sort_by'))) {
    state.sortKey = p.get('sort_by');
  }
  state.sortDir = p.get('sort_direction') === 'desc' ? 'desc' : 'asc';

  const listHost = h('div', { class: 'list' });
  const countEl = h('p', { class: 'toolbar__count', role: 'status' });

  const page = h('div', {},
    h('header', { class: 'page-head' },
      h('h1', { class: 'page-head__title', text: data.heading || meta.title })),
    h('div', { class: 'toolbar' },
      h('div', { class: 'field field--search' },
        h('label', { class: 'field__label', for: 'q', text: 'チーム名で絞り込み' }),
        h('input', {
          class: 'input', type: 'search', id: 'q', value: state.q,
          oninput: (e) => { state.q = e.target.value; paint(); syncUrl(); }
        })),
      countEl),
    listHost);

  paint();
  return page;

  function syncUrl() {
    const params = new URLSearchParams();
    if (state.q.trim()) params.set('q', state.q.trim());
    params.set('sort_by', state.sortKey);
    params.set('sort_direction', state.sortDir);
    if (ctx.demo) params.set('demo', '1');
    history.replaceState(null, '', `${location.pathname}?${params}`);
  }

  function visible() {
    const q = state.q.trim().toLowerCase();
    const dir = state.sortDir === 'asc' ? 1 : -1;
    return rows
      .filter((t) => !q || t.name.toLowerCase().includes(q))
      .sort((a, b) => {
        const x = state.sortKey === 'spendValue' ? a.spendValue : a[state.sortKey];
        const y = state.sortKey === 'spendValue' ? b.spendValue : b[state.sortKey];
        if (x === y) return String(a.name).localeCompare(String(b.name));
        if (x == null) return 1;
        if (y == null) return -1;
        if (typeof x === 'number' && typeof y === 'number') return (x - y) * dir;
        return (String(x) > String(y) ? 1 : -1) * dir;
      });
  }

  function paint() {
    const list = visible();
    if (!list.length) {
      listHost.replaceChildren(state.q
        ? emptyBlock({
          title: '条件に合うチームがありません',
          actionLabel: '絞り込みを解除',
          onAction: () => { state.q = ''; paint(); syncUrl(); }
        })
        : emptyBlock(emptyText));
      countEl.textContent = '0 件';
      return;
    }
    listHost.replaceChildren(dataTable({
      caption: 'チーム一覧',
      columns: [
        { key: 'name', label: 'チーム', className: 'table__th--title' },
        { key: 'members', label: '人数', className: 'table__th--status' },
        { key: 'spendValue', label: '使用額', className: 'table__th--status' },
        { key: 'pendingInvites', label: '招待', className: 'table__th--status' }
      ],
      sort: { key: state.sortKey, dir: state.sortDir },
      onSort: (key) => {
        state.sortDir = state.sortKey === key && state.sortDir === 'asc' ? 'desc' : 'asc';
        state.sortKey = key;
        paint();
        syncUrl();
      },
      rows: list.map((t) => ({
        id: t.id || t.name,
        idPrefix: 'team',
        cells: [
          { label: 'チーム', value: t.name },
          { label: '人数', value: t.members || '—' },
          { label: '使用額', value: t.spendText, className: 'cell--num' },
          { label: '招待', value: t.pendingInvites || '—' }
        ]
      }))
    }));
    countEl.textContent = state.q
      ? `${list.length} / ${rows.length} 件`
      : `${rows.length} 件`;
  }
}
