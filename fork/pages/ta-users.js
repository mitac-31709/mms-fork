/* TA ユーザー一覧。読み取り専用。 */

import { api } from '../api.js';
import { demoTaUsers } from '../demo.js';
import { dataTable, emptyBlock, h, statusPill } from '../ui.js';

export const meta = {
  route: '/ta/users',
  nav: 'ユーザー',
  title: 'ユーザー一覧',
  mode: 'ta'
};

const state = { q: '', status: 'all', sortKey: 'name', sortDir: 'asc' };

export async function load(ctx, opts = {}) {
  return ctx.demo ? demoTaUsers(opts) : api.taUsers(opts);
}

export function render(data, ctx) {
  const rows = (data.users || []).map((u) => ({
    id: u.id,
    name: u.name || '',
    email: u.email || '',
    team: u.team || '',
    status: u.status || ''
  }));
  const emptyText = data.empty || { title: 'ユーザーがいません', body: '' };

  const p = new URLSearchParams(location.search);
  state.q = p.get('q') || '';
  state.status = p.get('status') || 'all';
  if (['name', 'team', 'status', 'email'].includes(p.get('sort_by'))) {
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
        h('label', { class: 'field__label', for: 'q', text: '名前・メールで絞り込み' }),
        h('input', {
          class: 'input', type: 'search', id: 'q', value: state.q,
          oninput: (e) => { state.q = e.target.value; paint(); syncUrl(); }
        })),
      h('div', { class: 'field field--status' },
        h('label', { class: 'field__label', for: 'status', text: '状態' }),
        h('span', { class: 'select-wrap' }, h('select', {
          class: 'input select', id: 'status',
          onchange: (e) => { state.status = e.target.value || 'all'; paint(); syncUrl(); }
        },
        h('option', { value: 'all', selected: state.status === 'all' || null, text: 'すべて' }),
        ['有効', '無効'].map((s) => h('option', {
          value: s, selected: state.status === s || null, text: s
        }))))),
      countEl),
    listHost);

  paint();
  return page;

  function syncUrl() {
    const params = new URLSearchParams();
    if (state.q.trim()) params.set('q', state.q.trim());
    if (state.status !== 'all') params.set('status', state.status);
    params.set('sort_by', state.sortKey);
    params.set('sort_direction', state.sortDir);
    if (ctx.demo) params.set('demo', '1');
    history.replaceState(null, '', `${location.pathname}?${params}`);
  }

  function visible() {
    const q = state.q.trim().toLowerCase();
    const dir = state.sortDir === 'asc' ? 1 : -1;
    return rows
      .filter((u) => {
        if (state.status !== 'all' && u.status !== state.status) return false;
        if (q && !(`${u.name} ${u.email} ${u.team}`).toLowerCase().includes(q)) return false;
        return true;
      })
      .sort((a, b) => {
        const x = a[state.sortKey];
        const y = b[state.sortKey];
        if (x === y) return String(a.name).localeCompare(String(b.name));
        return (String(x) > String(y) ? 1 : -1) * dir;
      });
  }

  function paint() {
    const list = visible();
    const filtering = state.q || state.status !== 'all';
    if (!list.length) {
      listHost.replaceChildren(filtering
        ? emptyBlock({
          title: '条件に合うユーザーがいません',
          actionLabel: '絞り込みを解除',
          onAction: () => {
            state.q = '';
            state.status = 'all';
            paint();
            syncUrl();
          }
        })
        : emptyBlock(emptyText));
      countEl.textContent = '0 件';
      return;
    }
    listHost.replaceChildren(dataTable({
      caption: 'ユーザー一覧',
      columns: [
        { key: 'name', label: '名前', className: 'table__th--title' },
        { key: 'email', label: 'メール', className: 'table__th--created' },
        { key: 'team', label: 'チーム', className: 'table__th--created' },
        { key: 'status', label: '状態', className: 'table__th--status' }
      ],
      sort: { key: state.sortKey, dir: state.sortDir },
      onSort: (key) => {
        state.sortDir = state.sortKey === key && state.sortDir === 'asc' ? 'desc' : 'asc';
        state.sortKey = key;
        paint();
        syncUrl();
      },
      rows: list.map((u) => ({
        id: u.id || u.email || u.name,
        idPrefix: 'user',
        cells: [
          { label: '名前', value: u.name || '—' },
          { label: 'メール', value: u.email || '—' },
          { label: 'チーム', value: u.team || '—' },
          { label: '状態', value: u.status ? statusPill(u.status) : '—' }
        ]
      }))
    }));

    countEl.textContent = filtering
      ? `${list.length} / ${rows.length} 件`
      : `${rows.length} 件`;
  }
}
