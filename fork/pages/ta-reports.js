/* TA 週報一覧。締切（submission）カードで対象を選び、チーム列付きの表を出す。 */

import { api } from '../api.js';
import { DEMO_TODAY, demoTaReports } from '../demo.js';
import { fmtDate } from '../format.js';
import { dataTable, dueCell, emptyBlock, h, statusPill } from '../ui.js';

export const meta = {
  route: '/ta/reports',
  nav: '週報',
  title: '週報一覧',
  mode: 'ta'
};

const SORT_KEYS = ['team', 'title', 'status', 'due'];
const state = {
  q: '', status: 'all', team: 'all',
  sortKey: 'due', sortDir: 'asc',
  submissionId: null
};

function sameId(a, b) {
  if (a == null || b == null) return false;
  return String(a) === String(b);
}

export async function load(ctx, opts = {}) {
  const p = new URLSearchParams(location.search);
  const submissionId = p.get('submission_id') || opts.submissionId || null;
  const loadOpts = { ...opts, submissionId };
  return ctx.demo ? demoTaReports(loadOpts) : api.taReports(loadOpts);
}

export function render(data, ctx) {
  const today = ctx.demo ? new Date(`${DEMO_TODAY}T00:00:00`) : ctx.today;
  const rows = (data.reports || []).map(normalize);
  const submissions = data.submissions || [];
  const emptyText = data.empty || {
    title: '締切を選択してください',
    body: 'ヘッダーの締切カードをクリックすると、その締切の週報一覧が表示されます。'
  };
  const teamOptions = (data.filters?.team || [])
    .filter((o) => o.value)
    .map((o) => o.label);

  readUrl();

  const listHost = h('div', { class: 'list' });
  const countEl = h('p', {
    class: 'toolbar__count', id: 'result-count', role: 'status', 'aria-live': 'polite'
  });
  const subHost = h('div', { class: 'subcards', id: 'ta-submissions' });

  const page = h('div', {},
    h('header', { class: 'page-head' },
      h('h1', { class: 'page-head__title', text: data.heading || meta.title })),
    subHost,
    buildToolbar(),
    listHost);

  paintSubs();
  paint();
  return page;

  function normalize(r) {
    return {
      id: r.id,
      team: r.team || '',
      title: r.title || '',
      period: r.period || '',
      status: r.status || '',
      dueISO: r.dueISO ?? null,
      dueText: r.due || fmtDate(r.dueISO)
    };
  }

  function readUrl() {
    const p = new URLSearchParams(location.search);
    state.q = p.get('q') || '';
    state.status = p.get('status') || 'all';
    state.team = p.get('team') || 'all';
    const key = p.get('sort_by');
    if (SORT_KEYS.includes(key)) state.sortKey = key;
    state.sortDir = p.get('sort_direction') === 'desc' ? 'desc' : 'asc';
    state.submissionId = p.get('submission_id') || null;
  }

  function syncUrl() {
    const p = new URLSearchParams();
    if (state.submissionId) p.set('submission_id', state.submissionId);
    if (state.q.trim()) p.set('q', state.q.trim());
    if (state.status !== 'all') p.set('status', state.status);
    if (state.team !== 'all') p.set('team', state.team);
    p.set('sort_by', state.sortKey);
    p.set('sort_direction', state.sortDir);
    if (ctx.demo) p.set('demo', '1');
    history.replaceState(null, '', `${location.pathname}?${p}`);
  }

  function paintSubs() {
    if (!submissions.length) {
      subHost.replaceChildren();
      return;
    }
    subHost.replaceChildren(
      h('div', { class: 'subcards__row' },
        submissions.map((s) => h('button', {
          class: `subcard${sameId(s.id, state.submissionId) || s.selected ? ' is-selected' : ''}`,
          type: 'button',
          onclick: () => selectSubmission(s.id)
        },
        h('span', { class: 'subcard__when', text: s.when || s.label }),
        s.progress && h('span', { class: 'subcard__progress', text: s.progress }),
        s.overdue && h('span', { class: 'subcard__flag', text: '期限切れ' }))),
        state.submissionId && h('button', {
          class: 'btn btn--secondary', type: 'button',
          onclick: () => selectSubmission(null)
        }, 'クリア')));
  }

  function selectSubmission(id) {
    state.submissionId = id;
    syncUrl();
    ctx.reload?.();
  }

  function buildToolbar() {
    const statuses = [...new Set(rows.map((r) => r.status).filter(Boolean))];
    const teams = teamOptions.length
      ? teamOptions
      : [...new Set(rows.map((r) => r.team).filter(Boolean))].sort();

    return h('div', { class: 'toolbar' },
      h('div', { class: 'field field--search' },
        h('label', { class: 'field__label', for: 'q', text: 'タイトルで絞り込み' }),
        h('input', {
          class: 'input', type: 'search', id: 'q', value: state.q,
          oninput: (e) => { state.q = e.target.value; paint(); syncUrl(); }
        })),
      h('div', { class: 'field field--status' },
        h('label', { class: 'field__label', for: 'status', text: 'ステータス' }),
        h('span', { class: 'select-wrap' }, h('select', {
          class: 'input select', id: 'status',
          onchange: (e) => { state.status = e.target.value || 'all'; paint(); syncUrl(); }
        },
        h('option', { value: 'all', selected: state.status === 'all' || null, text: 'すべて' }),
        statuses.map((s) => h('option', {
          value: s, selected: state.status === s || null, text: s
        }))))),
      h('div', { class: 'field field--status' },
        h('label', { class: 'field__label', for: 'team', text: 'チーム' }),
        h('span', { class: 'select-wrap' }, h('select', {
          class: 'input select', id: 'team',
          onchange: (e) => { state.team = e.target.value || 'all'; paint(); syncUrl(); }
        },
        h('option', { value: 'all', selected: state.team === 'all' || null, text: 'すべて' }),
        teams.map((t) => h('option', {
          value: t, selected: state.team === t || null, text: t
        }))))),
      countEl);
  }

  function visible() {
    const q = state.q.trim().toLowerCase();
    const dir = state.sortDir === 'asc' ? 1 : -1;
    return rows
      .filter((r) => {
        if (state.status !== 'all' && r.status !== state.status) return false;
        if (state.team !== 'all' && r.team !== state.team) return false;
        if (q && !(`${r.title} ${r.team}`).toLowerCase().includes(q)) return false;
        return true;
      })
      .sort((a, b) => {
        const key = state.sortKey;
        const x = key === 'due' ? (a.dueISO || a.dueText) : a[key];
        const y = key === 'due' ? (b.dueISO || b.dueText) : b[key];
        if (x === y) return String(a.id ?? '').localeCompare(String(b.id ?? ''));
        if (x == null) return 1;
        if (y == null) return -1;
        return (String(x) > String(y) ? 1 : -1) * dir;
      });
  }

  function paint() {
    const list = visible();
    const filtering = state.q || state.status !== 'all' || state.team !== 'all';

    if (!state.submissionId && !rows.length && emptyText) {
      listHost.replaceChildren(emptyBlock(emptyText));
      countEl.textContent = '';
      return;
    }

    if (list.length) {
      listHost.replaceChildren(dataTable({
        caption: 'TA 週報一覧',
        columns: [
          { key: 'team', label: 'チーム', className: 'table__th--created' },
          { key: 'title', label: 'タイトル', className: 'table__th--title' },
          { key: 'status', label: 'ステータス', className: 'table__th--status' },
          { key: 'due', label: '期限', className: 'table__th--created' }
        ],
        sort: { key: state.sortKey, dir: state.sortDir },
        onSort: (key) => {
          state.sortDir = state.sortKey === key && state.sortDir === 'asc' ? 'desc' : 'asc';
          state.sortKey = key;
          paint();
          syncUrl();
        },
        rows: list.map((r) => {
          const due = dueCell(r.dueISO, r.dueText, {
            done: r.status === '完了',
            today
          });
          return {
            id: r.id,
            idPrefix: 'report',
            cells: [
              { label: 'チーム', value: r.team || '—' },
              { label: 'タイトル', value: r.title || '—' },
              { label: 'ステータス', value: statusPill(r.status) },
              { label: '期限', value: due.nodes, tone: due.tone }
            ]
          };
        })
      }));
    } else {
      listHost.replaceChildren(filtering
        ? emptyBlock({
          title: '条件に合う週報がありません',
          body: '絞り込みを変えてみてください。',
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

    countEl.textContent = filtering
      ? `${list.length} / ${rows.length} 件`
      : `${rows.length} 件`;
  }
}
