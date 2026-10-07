/* 週報（提出用＋下書き統合）。
 *
 * 1 画面 2 タブ。
 *   提出用 … 元アプリの週報一覧。期限・詳細編集・下書きへのコピー。
 *   下書き … このブラウザだけの公式テンプレート文書。新規作成・Excel 入出力・
 *            週単位で提出用への同期（PUSH）。
 *
 * 以前の /local-reports はここに統合。あの URL はリダイレクト用に残す。
 * URL は ?tab=origin|local と両タブの絞り込みを両方保持する。
 */

import { api } from '../api.js';
import { DEMO_TODAY, demoReports, demoReport } from '../demo.js';
import { dueRest, fmtDate, fmtShort, fmtTime } from '../format.js';
import {
  createLocalReport, deleteLocalReport, documentTitle, filledWeeks,
  listLocalReports, LOCAL_STATUSES, MEMBER_SLOTS, mergeLocalReports,
  saveLocalReport, SUPPORT_SLOTS, weekDisplayLabel, weekToFieldList
} from '../report-local.js';
import { exportReportsExcel, importReportsExcel } from '../report-excel.js';
import { dataTable, dueCell, emptyBlock, h, metaList, panel, statusPill, toasts } from '../ui.js';

export const meta = { route: '/reports', nav: '週報', title: '週報' };

const ORIGIN_SORT_KEYS = ['title', 'periodStart', 'status', 'due', 'createdAt'];
const LOCAL_SORTS = [
  ['updatedAt:desc', '更新が新しい順'],
  ['updatedAt:asc', '更新が古い順'],
  ['title:asc', 'タイトル順']
];

const o = { q: '', status: 'all', sortKey: 'due', sortDir: 'asc', selectedId: null };
const l = { q: '', status: 'all', sort: 'updatedAt:desc', selectedId: null };
let tab = 'origin';

function sameId(a, b) {
  if (a == null || b == null) return false;
  return String(a) === String(b);
}

function parseReportQueryId(raw) {
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
  const origin = ctx.demo ? await demoReports(opts) : await api.reports(opts);
  return {
    source: origin.source || 'local',
    fetchedAt: origin.fetchedAt || new Date().toISOString(),
    revalidating: origin.revalidating,
    origin,
    localDocs: listLocalReports()
  };
}

export function render(data, ctx) {
  const today = ctx.demo ? new Date(`${DEMO_TODAY}T00:00:00`) : ctx.today;

  let originRows = (data.origin?.reports || []).map(normalizeOrigin);
  const serverCounts = data.origin?.counts?.合計 != null ? data.origin.counts : null;
  const originEmpty = data.origin?.empty || { title: '週報がありません', body: '' };
  let localRows = [...(data.localDocs || listLocalReports())];

  readUrl();

  const tabHost = h('div', { class: 'tabbody' });
  const tabsEl = h('div', { class: 'tabs', role: 'tablist', 'aria-label': '週報の切り替え' });
  const fileInput = h('input', {
    type: 'file',
    accept: '.xlsx,.xls,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    hidden: true,
    onchange: onImportFile
  });

  const page = h('div', {},
    h('header', { class: 'page-head' },
      h('div', {},
        h('h1', { class: 'page-head__title', text: '週報' }),
        h('p', {
          class: 'page-head__lede',
          text: '提出は元アプリへ。下書きはこのブラウザに。'
        })),
      h('div', { class: 'page-head__actions' },
        h('button', {
          class: 'btn btn--primary', type: 'button', id: 'local-new',
          onclick: () => {
            const created = createLocalReport({});
            refreshLocal();
            setTab('local');
            openEditor(created.id);
          }
        }, '下書きを書く'))),
    tabsEl,
    tabHost,
    fileInput);

  paintTabs();
  paintTab();
  if (tab === 'origin' && o.selectedId != null) openDetail(o.selectedId, { focus: false });
  if (tab === 'local' && l.selectedId) openEditor(l.selectedId, { focus: false });
  return page;

  // ── URL ───────────────────────────────────────────
  function readUrl() {
    const p = new URLSearchParams(location.search);
    tab = p.get('tab') === 'local' ? 'local' : 'origin';
    o.q = p.get('q') || '';
    const ost = p.get('status');
    o.status = ost === '未完了' || ost === '完了' ? ost : 'all';
    const okey = p.get('sort_by');
    if (ORIGIN_SORT_KEYS.includes(okey)) o.sortKey = okey;
    o.sortDir = p.get('sort_direction') === 'desc' ? 'desc' : 'asc';
    o.selectedId = parseReportQueryId(p.get('report_id'));
    l.q = p.get('lq') || '';
    const lst = p.get('lstatus');
    l.status = LOCAL_STATUSES.includes(lst) ? lst : 'all';
    const lsort = p.get('lsort');
    if (LOCAL_SORTS.some(([v]) => v === lsort)) l.sort = lsort;
    l.selectedId = p.get('local_id') || null;
  }

  function syncUrl() {
    const p = new URLSearchParams();
    if (tab === 'local') p.set('tab', 'local');
    if (o.q.trim()) p.set('q', o.q.trim());
    if (o.status !== 'all') p.set('status', o.status);
    p.set('sort_by', o.sortKey);
    p.set('sort_direction', o.sortDir);
    if (o.selectedId) p.set('report_id', o.selectedId);
    if (l.q.trim()) p.set('lq', l.q.trim());
    if (l.status !== 'all') p.set('lstatus', l.status);
    if (l.sort !== 'updatedAt:desc') p.set('lsort', l.sort);
    if (l.selectedId) p.set('local_id', l.selectedId);
    if (ctx.demo) p.set('demo', '1');
    history.replaceState(null, '', `${location.pathname}?${p}`);
  }

  function setTab(next) {
    tab = next;
    paintTabs();
    paintTab();
    syncUrl();
  }

  function paintTabs() {
    const openCount = originRows.filter((r) => r.status === '未完了').length;
    const draftCount = localRows.length;
    tabsEl.replaceChildren(
      h('button', {
        class: `tabs__tab${tab === 'origin' ? ' is-active' : ''}`,
        type: 'button', role: 'tab', ariaSelected: tab === 'origin' ? 'true' : 'false',
        onclick: () => setTab('origin')
      },
      h('span', { text: '提出用' }),
      h('span', {
        class: 'tabs__count',
        text: openCount ? `未完了 ${openCount}` : `${originRows.length} 件`
      })),
      h('button', {
        class: `tabs__tab${tab === 'local' ? ' is-active' : ''}`,
        type: 'button', role: 'tab', ariaSelected: tab === 'local' ? 'true' : 'false',
        onclick: () => setTab('local')
      },
      h('span', { text: '下書き' }),
      h('span', { class: 'tabs__count', text: `${draftCount} 件` }))
    );
  }

  function paintTab() {
    paintTabs();
    if (tab === 'local') {
      tabHost.replaceChildren(renderLocalTab());
    } else {
      tabHost.replaceChildren(renderOriginTab());
    }
  }

  function refreshLocal() {
    localRows = listLocalReports();
  }

  // ══ 提出用タブ ════════════════════════════════════
  function normalizeOrigin(r) {
    const dueISO = r.dueISO ?? null;
    const startISO = r.periodStartISO ?? null;
    const endISO = r.periodEndISO ?? null;
    return {
      id: r.id,
      title: r.title || '',
      subtitle: r.subtitle || '',
      status: r.status || '',
      dueISO,
      createdISO: r.createdAtISO ?? null,
      startISO,
      endISO,
      periodText: r.period
        || (startISO && endISO ? `${fmtShort(startISO)} – ${fmtShort(endISO)}` : ''),
      dueText: r.due || fmtDate(dueISO),
      createdText: r.createdAt || fmtDate(r.createdAtISO),
      body: r.body ?? '',
      lockedBy: r.lockedBy || null,
      fields: Array.isArray(r.fields) ? r.fields.map((f) => ({
        name: f.name || 'content',
        label: f.label || '本文',
        value: f.value ?? '',
        lockedBy: f.lockedBy || null
      })) : null,
      meta: Array.isArray(r.meta) ? r.meta : null,
      timeline: Array.isArray(r.timeline) ? r.timeline : null,
      detailLoaded: Boolean(r.detailLoaded)
    };
  }

  function originSortValue(r) {
    switch (o.sortKey) {
      case 'title': return r.title;
      case 'periodStart': return r.startISO || r.periodText;
      case 'status': return r.status;
      case 'createdAt': return r.createdISO || r.createdText;
      default: return r.dueISO || r.dueText;
    }
  }

  function originVisible() {
    const q = o.q.trim().toLowerCase();
    const dir = o.sortDir === 'asc' ? 1 : -1;
    return originRows
      .filter((r) => {
        if (o.status !== 'all' && r.status !== o.status) return false;
        if (!q) return true;
        return `${r.title} ${r.periodText}`.toLowerCase().includes(q);
      })
      .sort((a, b) => {
        const x = originSortValue(a) ?? '';
        const y = originSortValue(b) ?? '';
        if (x === y) return String(a.id ?? '').localeCompare(String(b.id ?? ''), 'en');
        return (x > y ? 1 : -1) * dir;
      });
  }

  function nextDue() {
    return originRows
      .filter((r) => r.status === '未完了')
      .slice()
      .sort((a, b) => String(a.dueISO || '').localeCompare(String(b.dueISO || '')))[0] || null;
  }

  function renderOriginTab() {
    const list = originVisible();
    const filtering = o.q.trim() !== '' || o.status !== 'all';
    const counts = serverCounts || {
      未完了: originRows.filter((r) => r.status === '未完了').length,
      完了: originRows.filter((r) => r.status === '完了').length,
      合計: originRows.length
    };
    const focus = !filtering ? nextDue() : null;

    const countEl = h('p', {
      class: 'toolbar__count', role: 'status', 'aria-live': 'polite',
      text: filtering ? `${list.length} / ${originRows.length} 件` : `${originRows.length} 件`
    });

    const host = h('div', { class: 'list' });
    const wrap = h('div', {},
      focus ? heroCard(focus) : null,
      h('div', { class: 'toolbar' },
        h('div', { class: 'field field--search' },
          h('label', { class: 'field__label', for: 'q', text: '絞り込み' }),
          h('input', {
            class: 'input', type: 'search', id: 'q', value: o.q,
            placeholder: 'タイトル・期間で検索',
            oninput: (e) => {
              o.q = e.target.value;
              paintTab();
              syncUrl();
            }
          }),
          h('p', { class: 'field__hint', id: 'q-hint' }, h('kbd', { text: '/' }), ' で移動')),
        h('fieldset', { class: 'field field--status' },
          h('legend', { class: 'field__label', text: 'ステータス' }),
          h('div', { class: 'segmented' },
            [['all', `すべて ${counts.合計 ?? originRows.length}`],
              ['未完了', `未完了 ${counts.未完了 ?? 0}`],
              ['完了', `完了 ${counts.完了 ?? 0}`]]
              .map(([value, label]) => h('label', { class: 'segmented__option' },
                h('input', {
                  type: 'radio', name: 'status', value,
                  checked: o.status === value,
                  onchange: () => {
                    o.status = value;
                    paintTab();
                    syncUrl();
                  }
                }),
                h('span', {}, label)))),
          h('p', { class: 'field__hint', 'aria-hidden': 'true' }, ' ')),
        h('div', { class: 'field field--sort' },
          h('label', { class: 'field__label', for: 'sort', text: '並べ替え' }),
          h('span', { class: 'select-wrap' }, h('select', {
            class: 'input select', id: 'sort',
            onchange: (e) => {
              const [key, dir] = e.target.value.split(':');
              o.sortKey = key;
              o.sortDir = dir;
              paintTab();
              syncUrl();
            }
          }, [
            ['due:asc', '期限が近い順'], ['due:desc', '期限が遠い順'],
            ['createdAt:desc', '作成が新しい順'], ['title:asc', 'タイトル順']
          ].map(([value, label]) => h('option', {
            value, selected: value === `${o.sortKey}:${o.sortDir}`
          }, label)))),
          h('p', { class: 'field__hint', 'aria-hidden': 'true' }, ' ')),
        countEl),
      host,
      h('p', {
        class: 'disclaimer',
        text: ctx.demo
          ? '提出用はダミー表示です。下書きタブはこのブラウザに保存されます。'
          : '提出用は元アプリの一覧です。本文の変更は自動保存で元アプリへ送ります。'
      }));

    if (!list.length) {
      host.replaceChildren(filtering
        ? emptyBlock({
          title: '条件に合う週報がありません',
          body: '検索語やステータスを変えてみてください。',
          actionLabel: '絞り込みを解除',
          onAction: () => {
            o.q = '';
            o.status = 'all';
            paintTab();
            syncUrl();
          }
        })
        : emptyBlock(originEmpty));
      return wrap;
    }

    host.replaceChildren(dataTable({
      caption: '提出用の週報一覧。行を開くと右に詳細が出ます。',
      columns: [
        { key: 'title', label: 'タイトル', className: 'table__th--title' },
        { key: 'periodStart', label: '期間', className: 'table__th--period' },
        { key: 'status', label: 'ステータス', className: 'table__th--status' },
        { key: 'due', label: '期限', className: 'table__th--due' },
        { key: 'createdAt', label: '作成日', className: 'table__th--created' }
      ],
      sort: { key: o.sortKey, dir: o.sortDir },
      onSort: (key) => {
        o.sortDir = o.sortKey === key && o.sortDir === 'asc' ? 'desc' : 'asc';
        o.sortKey = key;
        paintTab();
        syncUrl();
      },
      rows: list.map((r) => {
        const due = dueCell(r.dueISO, r.dueText, { done: r.status === '完了', today });
        return {
          id: r.id,
          idPrefix: 'report',
          selected: sameId(r.id, o.selectedId),
          onOpen: (id) => openDetail(id),
          cells: [
            {
              label: 'タイトル',
              value: r.subtitle
                ? [r.title, h('span', { class: 'cell__sub', text: r.subtitle })]
                : r.title
            },
            { label: '期間', value: r.periodText, className: 'cell--num' },
            { label: 'ステータス', value: statusPill(r.status) },
            { label: '期限', value: due.nodes, className: 'cell--num', tone: due.tone },
            { label: '作成日', value: r.createdText, className: 'cell--num' }
          ]
        };
      })
    }));
    return wrap;
  }

  function heroCard(focus) {
    const rest = dueRest(focus.dueISO, today);
    const dueLine = [
      focus.due || fmtDate(focus.dueISO) || null,
      rest ? `${rest.glyph ? `${rest.glyph} ` : ''}${rest.text}` : null
    ].filter(Boolean).join(' · ');
    return h('section', { class: 'hero', 'aria-label': '次に提出する週報' },
      h('div', { class: 'hero__body' },
        h('p', { class: 'hero__kicker', text: '次に提出する週報' }),
        h('h2', { class: 'hero__title', text: focus.title || '週報' }),
        h('p', {
          class: 'hero__due',
          text: dueLine || '期限なし'
        })),
      h('div', { class: 'hero__actions' },
        h('button', {
          class: 'btn btn--primary', type: 'button',
          onclick: () => openDetail(focus.id)
        }, '開いて書く'),
        h('button', {
          class: 'btn btn--secondary', type: 'button',
          onclick: () => copyOriginToLocal(focus)
        }, '下書きにコピー')));
  }

  // ── 提出用の詳細 ────────────────────────────────
  const saveTimers = new Map();
  const dirtyFields = new Set();
  const datesTouched = new Set();

  function applyDetail(r, detail) {
    if (!detail || typeof detail !== 'object') return;
    if (detail.title) r.title = detail.title;
    if (typeof detail.body === 'string') r.body = detail.body;
    if (detail.lockedBy) r.lockedBy = detail.lockedBy;
    if (Array.isArray(detail.fields)) {
      r.fields = detail.fields.map((f) => ({
        name: f.name || 'content',
        label: f.label || '本文',
        value: f.value ?? '',
        lockedBy: f.lockedBy || null
      }));
      if (!r.body) r.body = r.fields.map((f) => f.value).filter(Boolean).join('\n\n');
    }
    if (Array.isArray(detail.meta)) r.meta = detail.meta;
    if (Array.isArray(detail.timeline)) r.timeline = detail.timeline;
    r.detailLoaded = true;
  }

  function fieldList(r) {
    if (Array.isArray(r.fields) && r.fields.length) return r.fields;
    return [{ name: 'content', label: '本文', value: r.body || '', lockedBy: r.lockedBy || null }];
  }

  function displayLabel(f) {
    if (f.name === 'start_at') return '作成開始日';
    if (f.name === 'end_at') return '作成終了日';
    return f.label || '本文';
  }

  function isoDate(value) {
    const m = String(value || '').trim().match(/^(\d{4}-\d{2}-\d{2})/);
    return m ? m[1] : null;
  }

  function applyDatesToRow(r) {
    const fields = fieldList(r);
    const startField = fields.find((f) => f.name === 'start_at');
    const endField = fields.find((f) => f.name === 'end_at');
    if (!startField && !endField) return false;
    const startISO = isoDate(startField?.value);
    const endISO = isoDate(endField?.value);
    if (startField) r.startISO = startISO;
    if (endField) r.endISO = endISO;
    r.periodText = startISO && endISO ? `${fmtShort(startISO)} – ${fmtShort(endISO)}` : '期間未設定';
    datesTouched.add(String(r.id));
    return true;
  }

  async function reloadOriginList() {
    if (ctx.demo) return;
    const snapshot = originRows.map((r) => ({ ...r }));
    try {
      const fresh = ctx.demo ? await demoReports({ refresh: true }) : await api.reports({ refresh: true });
      const next = (fresh.reports || []).map(normalizeOrigin);
      const prevById = new Map(snapshot.map((r) => [String(r.id), r]));
      originRows.splice(0, originRows.length, ...next.map((n) => {
        const prev = prevById.get(String(n.id));
        if (!prev) return n;
        const merged = { ...n };
        if (prev.detailLoaded) {
          merged.fields = prev.fields;
          merged.detailLoaded = true;
          merged.body = prev.body;
          merged.meta = prev.meta;
          merged.timeline = prev.timeline;
          merged.lockedBy = prev.lockedBy;
        }
        if (datesTouched.has(String(n.id))) {
          merged.startISO = prev.startISO;
          merged.endISO = prev.endISO;
          merged.periodText = prev.periodText;
        }
        return merged;
      }));
    } catch {
      // 直前に反映した行は残す
    }
    paintTab();
  }

  function paintSaveState(stateName, text) {
    const el = document.getElementById('save-state');
    if (!el) return;
    el.dataset.state = stateName;
    el.textContent = text;
  }

  function queueFieldSave(report, field) {
    dirtyFields.add(`${report.id}:${field.name}`);
    paintSaveState('saving', '保存中…');
    const key = `${report.id}:${field.name}`;
    clearTimeout(saveTimers.get(key));
    saveTimers.set(key, setTimeout(() => { flushField(report, field); }, 500));
  }

  async function flushField(report, field) {
    const key = `${report.id}:${field.name}`;
    if (ctx.demo) {
      dirtyFields.delete(key);
      paintSaveState('saved', '保存しました（デモ）');
      if (field.name === 'start_at' || field.name === 'end_at') {
        applyDatesToRow(report);
        paintTab();
      }
      return;
    }
    try {
      await api.saveReportField(report.id, field.name, field.value ?? '');
      dirtyFields.delete(key);
      const at = fmtTime(new Date().toISOString());
      paintSaveState('saved', `保存しました${at ? `（${at}）` : ''}`);
      if (field.name === 'start_at' || field.name === 'end_at') {
        applyDatesToRow(report);
        paintTab();
      }
    } catch (e) {
      paintSaveState('error', e?.message || '保存できませんでした');
    }
  }

  async function flushReport(report) {
    const pending = fieldList(report).filter((f) => dirtyFields.has(`${report.id}:${f.name}`));
    if (ctx.demo) {
      await new Promise((resolve) => setTimeout(resolve, 400));
      for (const field of pending) dirtyFields.delete(`${report.id}:${field.name}`);
      return;
    }
    for (const field of pending) {
      const key = `${report.id}:${field.name}`;
      clearTimeout(saveTimers.get(key));
      await api.saveReportField(report.id, field.name, field.value ?? '');
      dirtyFields.delete(key);
    }
  }

  function toDatetimeLocal(value) {
    if (!value) return '';
    const s = String(value).trim();
    if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(s)) return s.slice(0, 16);
    return '';
  }

  function buildDetailBody(r, { editable, loading = false, error = null } = {}) {
    const rest = dueRest(r.dueISO, today);
    const fields = fieldList(r);
    const lockedFields = fields.filter((f) => f.lockedBy);
    const isDatePair = fields.some((f) => f.name === 'start_at' || f.name === 'end_at');

    const saveState = h('span', {
      class: 'save-state', id: 'save-state', dataset: { state: 'idle' },
      text: editable ? '変更は自動で保存されます' : ''
    });

    const fallbackMeta = [
      ['期間', r.startISO && r.endISO
        ? `${fmtDate(r.startISO)} – ${fmtDate(r.endISO)}` : (r.periodText || '—')],
      ['ステータス', statusPill(r.status)],
      ['期限', rest && r.status !== '完了'
        ? `${r.dueText}（${rest.glyph ? `${rest.glyph} ` : ''}${rest.text}）`
        : (r.dueText || '—')],
      ['作成日', r.createdText || '—']
    ];
    const fromDetail = (r.meta || []).map((m) => [m.label, m.value]).filter((e) => e[0]);
    const seen = new Set(fromDetail.map((e) => e[0]));
    const metaEntries = fromDetail.length
      ? [...fromDetail, ...fallbackMeta.filter((e) => !seen.has(e[0])
        && !(e[0] === '期限' && seen.has('提出期限'))
        && !(e[0] === '期間' && seen.has('作業期間')))]
      : fallbackMeta;

    const dateFields = fields.filter((f) => f.name === 'start_at' || f.name === 'end_at');
    const textFields = fields.filter((f) => f.name !== 'start_at' && f.name !== 'end_at');

    const dateNode = dateFields.length ? h('div', { class: 'grid-2' }, dateFields.map((f) =>
      dateControl(r, f, editable))) : null;
    const textNodes = textFields.map((f, i) => {
      const fieldId = f.name === 'content' && textFields.length === 1
        ? 'panel-text' : `panel-field-${f.name}-${i}`;
      const hintId = `${fieldId}-hint`;
      const lockedField = Boolean(f.lockedBy) || !editable;
      const ta = h('textarea', {
        class: 'input textarea textarea--tall', id: fieldId, rows: 10,
        'aria-describedby': hintId,
        readonly: lockedField || null,
        placeholder: editable && !lockedField && !f.value ? 'この週にやったことを書く' : null,
        oninput: (e) => {
          f.value = e.target.value;
          if (f.name === 'content' || fields.length === 1) r.body = e.target.value;
          if (editable && !f.lockedBy) queueFieldSave(r, f);
        }
      });
      ta.value = f.value || '';
      return h('div', { class: 'field' },
        h('label', { class: 'field__label', for: fieldId, text: displayLabel(f) }),
        ta,
        h('p', { class: 'field__hint', id: hintId },
          f.lockedBy
            ? `${f.lockedBy} さんが編集中のため読み取り専用です`
            : (i === textFields.length - 1 ? saveState : null)));
    });

    const timeline = (r.timeline || []).filter((t) => t && (t.text || t.at));
    const history = timeline.length
      ? h('div', { class: 'field' },
        h('p', { class: 'field__label', text: '履歴' }),
        ...timeline.map((t) => h('p', {
          class: 'field__hint',
          text: [t.at, t.text].filter(Boolean).join(' · ')
        })))
      : null;

    return [
      metaList(metaEntries),
      loading && h('p', {
        class: 'field__hint', id: 'panel-detail-status',
        text: '詳細を読み込み中…'
      }),
      error && h('p', { class: 'form-error', id: 'panel-detail-error', text: error }),
      isDatePair ? h('div', { class: 'field' },
        h('p', { class: 'field__label', text: '作成期間' }), dateNode) : null,
      ...textNodes,
      history,
      lockedFields.length > 0 && h('p', { class: 'lock', id: 'panel-lock' },
        h('span', { 'aria-hidden': 'true', text: '●' }),
        h('span', {
          id: 'panel-lock-text',
          text: lockedFields.map((f) => `${displayLabel(f)}は ${f.lockedBy} さんが編集中です`).join('。')
        }))
    ];

    function dateControl(report, f, canEdit) {
      const fieldId = `panel-field-${f.name}`;
      const lockedField = Boolean(f.lockedBy) || !canEdit;
      return h('div', { class: 'field' },
        h('label', { class: 'field__label', for: fieldId, text: displayLabel(f) }),
        h('input', {
          class: 'input', type: 'datetime-local', id: fieldId,
          readonly: lockedField || null,
          value: toDatetimeLocal(f.value),
          oninput: (e) => {
            f.value = e.target.value;
            if (canEdit && !f.lockedBy) queueFieldSave(report, f);
          }
        }));
    }
  }

  function openDetail(id, { focus = true } = {}) {
    const r = originRows.find((x) => sameId(x.id, id));
    if (!r) return;

    o.selectedId = id;
    if (tab !== 'origin') tab = 'origin';
    paintTab();
    syncUrl();

    const editable = true;
    const needsFetch = !ctx.demo && !r.detailLoaded && r.id != null;

    const save = h('button', {
      class: 'btn btn--primary', type: 'button', id: 'panel-save',
      onclick: async () => {
        save.dataset.state = 'loading';
        const hadPending = fieldList(r).some((f) => dirtyFields.has(`${r.id}:${f.name}`));
        try {
          await flushReport(r);
          applyDatesToRow(r);
          panel.close();
          if (hadPending) toasts.push('保存しました');
          reloadOriginList();
        } catch (e) {
          delete save.dataset.state;
          paintSaveState('error', e?.message || '保存できませんでした');
          toasts.push(e?.message || '保存できませんでした');
        }
      }
    }, '保存して閉じる');

    panel.open({
      eyebrow: '提出用',
      title: r.title,
      body: buildDetailBody(r, { editable, loading: needsFetch }),
      actions: [
        save,
        h('button', {
          class: 'btn btn--secondary', type: 'button', id: 'panel-copy-local',
          onclick: () => copyOriginToLocal(r)
        }, '下書きにコピー'),
        h('button', {
          class: 'btn btn--secondary', type: 'button', id: 'panel-cancel',
          onclick: () => panel.close()
        }, '閉じる')
      ],
      onClose: () => {
        o.selectedId = null;
        paintTab();
        syncUrl();
        return tabHost.querySelector(`#report_${CSS.escape(String(id))} .row__open`);
      }
    });

    if (!focus) document.activeElement?.blur?.();

    if (needsFetch) {
      const loadDetail = ctx.demo ? demoReport(r.id) : api.report(r.id);
      Promise.resolve(loadDetail).then((detail) => {
        if (!sameId(o.selectedId, id)) return;
        applyDetail(r, detail);
        panel.update({
          title: r.title,
          body: buildDetailBody(r, { editable, loading: false })
        });
      }).catch((e) => {
        if (!sameId(o.selectedId, id)) return;
        panel.update({
          body: buildDetailBody(r, {
            editable,
            loading: false,
            error: e?.message || '詳細を読めませんでした'
          })
        });
      });
    }
  }

  // ══ 下書きタブ ══════════════════════════════════════
  function localSearchHay(r) {
    const m = r.meta || {};
    const weeks = (r.weeks || []).map((w) =>
      `${w.label} ${w.progress} ${w.issue} ${w.plan}`).join(' ');
    return `${r.title} ${m.teamName} ${m.teamNumber} ${m.overview} ${weeks}`.toLowerCase();
  }

  function localVisible() {
    const q = l.q.trim().toLowerCase();
    const [key, dirRaw] = l.sort.split(':');
    const dir = dirRaw === 'asc' ? 1 : -1;
    return localRows
      .filter((r) => {
        if (l.status !== 'all' && r.status !== l.status) return false;
        if (!q) return true;
        return localSearchHay(r).includes(q);
      })
      .sort((a, b) => {
        const x = a[key] || '';
        const y = b[key] || '';
        if (x === y) return String(a.id).localeCompare(String(b.id));
        return (String(x) > String(y) ? 1 : -1) * dir;
      });
  }

  function renderLocalTab() {
    const list = localVisible();
    const filtering = l.q.trim() !== '' || l.status !== 'all';
    const countEl = h('p', {
      class: 'toolbar__count', role: 'status', 'aria-live': 'polite',
      text: filtering ? `${list.length} / ${localRows.length} 件` : `${localRows.length} 件`
    });
    const host = h('div', { class: 'cards' });

    const wrap = h('div', {},
      h('div', { class: 'toolbar' },
        h('div', { class: 'field field--search' },
          h('label', { class: 'field__label', for: 'lq', text: '絞り込み' }),
          h('input', {
            class: 'input', type: 'search', id: 'lq', value: l.q,
            placeholder: 'チーム名・概要・週の内容',
            oninput: (e) => {
              l.q = e.target.value;
              paintTab();
              syncUrl();
            }
          })),
        h('fieldset', { class: 'field field--status' },
          h('legend', { class: 'field__label', text: 'ステータス' }),
          h('div', { class: 'segmented' },
            [['all', 'すべて'], ...LOCAL_STATUSES.map((s) => [s, s])]
              .map(([value, label]) => h('label', { class: 'segmented__option' },
                h('input', {
                  type: 'radio', name: 'lstatus', value,
                  checked: l.status === value,
                  onchange: () => {
                    l.status = value;
                    paintTab();
                    syncUrl();
                  }
                }),
                h('span', {}, label)))),
          h('p', { class: 'field__hint', 'aria-hidden': 'true' }, ' ')),
        h('div', { class: 'field field--sort' },
          h('label', { class: 'field__label', for: 'lsort', text: '並べ替え' }),
          h('span', { class: 'select-wrap' }, h('select', {
            class: 'input select', id: 'lsort',
            onchange: (e) => {
              l.sort = e.target.value;
              paintTab();
              syncUrl();
            }
          }, LOCAL_SORTS.map(([value, label]) => h('option', {
            value, selected: value === l.sort
          }, label)))),
          h('p', { class: 'field__hint', 'aria-hidden': 'true' }, ' ')),
        countEl),
      h('div', { class: 'local-actions' },
        h('button', {
          class: 'btn btn--secondary', type: 'button', id: 'local-import',
          onclick: () => fileInput.click()
        }, 'Excel取込'),
        h('button', {
          class: 'btn btn--secondary', type: 'button', id: 'local-blank',
          onclick: downloadBlankTemplate
        }, '空テンプレート'),
        h('button', {
          class: 'btn btn--secondary', type: 'button', id: 'local-from-origin',
          onclick: openCopyDialog
        }, '提出用からコピー')),
      host,
      h('p', {
        class: 'disclaimer',
        text: '下書きはこのブラウザだけに保存されます。Excel は公式テンプレート形式です。'
          + ' 提出用への同期は、選んだ週の進捗・問題点・予定の上書きです。'
      }));

    if (!list.length) {
      host.replaceChildren(localRows.length
        ? emptyBlock({
          title: '条件に合う下書きがありません',
          actionLabel: '絞り込みを解除',
          onAction: () => {
            l.q = '';
            l.status = 'all';
            paintTab();
            syncUrl();
          }
        })
        : emptyBlock({
          title: '下書きはまだありません',
          body: '「下書きを書く」か「Excel取込」「提出用からコピー」で追加できます。',
          actionLabel: '下書きを書く',
          onAction: () => {
            const created = createLocalReport({});
            refreshLocal();
            paintTab();
            openEditor(created.id);
          }
        }));
      return wrap;
    }

    host.replaceChildren(...list.map((r) => {
      const filled = filledWeeks(r).length;
      const total = (r.weeks || []).length;
      const synced = (r.weeks || []).filter((w) => w.originId).length;
      return h('article', {
        class: `card${sameId(r.id, l.selectedId) ? ' is-selected' : ''}`
      },
      h('button', {
        class: 'card__main', type: 'button',
        onclick: () => openEditor(r.id),
        ariaLabel: `${documentTitle(r)}を開く`
      },
      h('p', { class: 'card__title', text: documentTitle(r) }),
      r.meta?.overview
        ? h('p', { class: 'card__sub', text: String(r.meta.overview).slice(0, 80) })
        : null,
      h('div', { class: 'card__meta' },
        statusPill(r.status),
        h('span', { class: 'card__stat', text: `記入 ${filled}/${total}週` }),
        synced
          ? h('span', { class: 'card__stat card__stat--synced', text: `🔗 ${synced}週同期済` })
          : h('span', { class: 'card__stat card__stat--unsynced', text: '未同期' }),
        h('span', {
          class: 'card__stat',
          text: r.updatedAt
            ? `${fmtDate(String(r.updatedAt).slice(0, 10))} ${fmtTime(r.updatedAt)}`.trim()
            : ''
        }))),
      h('div', { class: 'card__actions' },
        h('button', {
          class: 'btn btn--secondary btn--small', type: 'button',
          onclick: (e) => {
            e.stopPropagation();
            exportOne(r);
          }
        }, 'Excel'),
        h('button', {
          class: 'btn btn--secondary btn--small', type: 'button',
          onclick: (e) => {
            e.stopPropagation();
            openSyncDialog(r);
          }
        }, '同期')));
    }));
    return wrap;
  }

  async function exportOne(doc) {
    try {
      const result = await exportReportsExcel(doc);
      toasts.push(`Excel を書き出しました（${result.filename}）`);
    } catch (e) {
      toasts.push(e.message || '書き出しに失敗しました');
    }
  }

  async function downloadBlankTemplate() {
    try {
      const url = new URL('../assets/weekly-report-template.xlsx', import.meta.url);
      const res = await fetch(url);
      if (!res.ok) throw new Error(`テンプレートを取得できません（${res.status}）`);
      const buf = await res.arrayBuffer();
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([buf], {
        type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
      }));
      a.download = '[チーム番号]-[チーム名]-週報.xlsx';
      a.rel = 'noopener';
      document.body.append(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    } catch (e) {
      toasts.push(e.message || 'テンプレートを取得できませんでした');
    }
  }

  async function onImportFile(e) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    try {
      const incoming = await importReportsExcel(file);
      if (!incoming.length) {
        toasts.push('取り込める週報がありませんでした');
        return;
      }
      const { created, updated } = mergeLocalReports(incoming);
      refreshLocal();
      paintTab();
      syncUrl();
      toasts.push(`取り込み完了：新規 ${created} 件・更新 ${updated} 件`);
      if (incoming[0]?.id) openEditor(incoming[0].id);
    } catch (err) {
      toasts.push(err.message || '取り込みに失敗しました');
    }
  }

  // ── 下書きエディタ ────────────────────────────────
  function openEditor(id, { focus = true } = {}) {
    const found = localRows.find((x) => sameId(x.id, id))
      || listLocalReports().find((x) => sameId(x.id, id));
    if (!found) return;
    if (!localRows.some((x) => sameId(x.id, found.id))) refreshLocal();
    const current = JSON.parse(JSON.stringify(
      localRows.find((x) => sameId(x.id, id)) || found));
    if (!current.meta) current.meta = {};
    if (!Array.isArray(current.weeks)) current.weeks = [];

    l.selectedId = String(current.id);
    if (tab !== 'local') tab = 'local';
    paintTab();
    syncUrl();

    const saveState = h('span', {
      class: 'save-state', id: 'save-state', dataset: { state: 'idle' },
      text: 'このブラウザに自動保存されます'
    });

    const statusSelect = h('select', {
      class: 'input select', id: 'local-status',
      onchange: (e) => {
        current.status = e.target.value;
        persist();
        paintTab();
      }
    }, LOCAL_STATUSES.map((s) => h('option', {
      value: s, selected: current.status === s || null, text: s
    })));

    const body = h('div', { class: 'local-doc' },
      metaList([
        ['保存先', 'このブラウザ（localStorage）'],
        ['形式', '公式週報テンプレート'],
        ['ローカルID', current.id]
      ]),
      h('div', { class: 'field' },
        h('label', { class: 'field__label', for: 'local-status', text: 'ステータス' }),
        h('span', { class: 'select-wrap' }, statusSelect)),
      h('section', { class: 'local-section' },
        h('h2', { class: 'local-section__title', text: 'ヘッダー' }),
        h('div', { class: 'grid-2' },
          fieldText('teamName', 'チーム名', current.meta.teamName, (v) => {
            current.meta.teamName = v;
          }),
          fieldText('teamNumber', 'チーム番号', current.meta.teamNumber, (v) => {
            current.meta.teamNumber = v;
          })),
        fieldArea('overview', '作品概要', current.meta.overview, (v) => {
          current.meta.overview = v;
        }, 4),
        h('div', { class: 'grid-2' },
          fieldText('meetingDay', '定例ミーティング曜日', current.meta.meetingDay, (v) => {
            current.meta.meetingDay = v;
          }),
          fieldText('meetingTime', '定例ミーティング時間', current.meta.meetingTime, (v) => {
            current.meta.meetingTime = v;
          }))),
      h('section', { class: 'local-section' },
        h('h2', { class: 'local-section__title', text: 'チームメンバー' }),
        h('div', { class: 'grid-2' },
          ...Array.from({ length: MEMBER_SLOTS }, (_, i) =>
            fieldText(`member-${i}`, `メンバー ${i + 1}`, current.meta.members?.[i] || '', (v) => {
              if (!current.meta.members) current.meta.members = [];
              current.meta.members[i] = v;
            })))),
      h('section', { class: 'local-section' },
        h('h2', { class: 'local-section__title', text: 'サポートメンバー' }),
        h('div', { class: 'grid-2' },
          ...Array.from({ length: SUPPORT_SLOTS }, (_, i) =>
            fieldText(`support-${i}`, `サポート ${i + 1}`, current.meta.support?.[i] || '', (v) => {
              if (!current.meta.support) current.meta.support = [];
              current.meta.support[i] = v;
            })))),
      h('section', { class: 'local-section' },
        h('h2', { class: 'local-section__title', text: '各週の記入' }),
        h('p', {
          class: 'field__hint',
          text: 'テンプレートの週ブロックです。週ごとの「同期」で提出用へ書き込めます。'
        }),
        h('div', { class: 'week-list' }, current.weeks.map((week, wi) =>
          weekEditor(week, wi)))),
      h('p', { class: 'field__hint' }, saveState));

    panel.open({
      eyebrow: '下書き',
      title: documentTitle(current),
      body,
      actions: [
        h('button', {
          class: 'btn btn--primary', type: 'button', id: 'local-sync',
          onclick: () => openSyncDialog(current)
        }, '提出用に同期'),
        h('button', {
          class: 'btn btn--secondary', type: 'button',
          onclick: async () => {
            persist();
            await exportOne(current);
          }
        }, 'Excel出力'),
        h('button', {
          class: 'btn btn--secondary', type: 'button',
          onclick: () => panel.close()
        }, '閉じる'),
        h('button', {
          class: 'btn btn--danger', type: 'button',
          onclick: () => removeLocal(current.id)
        }, '削除')
      ],
      onClose: () => {
        l.selectedId = null;
        refreshLocal();
        paintTab();
        syncUrl();
        return tabHost.querySelector('.card__main');
      }
    });

    if (!focus) document.activeElement?.blur?.();

    function fieldText(name, label, value, apply) {
      const id = `local-${name}`;
      return h('div', { class: 'field' },
        h('label', { class: 'field__label', for: id, text: label }),
        h('input', {
          class: 'input', type: 'text', id, value: value || '',
          oninput: (e) => { apply(e.target.value); persist(); }
        }));
    }

    function fieldArea(name, label, value, apply, rows = 4) {
      const id = `local-${name}`;
      const ta = h('textarea', {
        class: 'input textarea', id, rows,
        oninput: (e) => { apply(e.target.value); persist(); }
      });
      ta.value = value || '';
      return h('div', { class: 'field' },
        h('label', { class: 'field__label', for: id, text: label }),
        ta);
    }

    function weekEditor(week, wi) {
      const hasContent = Boolean(week.progress || week.issue || week.plan || week.workedAt);
      return h('details', {
        class: 'week-block',
        open: hasContent || null
      },
      h('summary', { class: 'week-block__summary' },
        h('span', {
          class: `week-block__dot${hasContent ? ' is-filled' : ''}`,
          'aria-hidden': 'true'
        }),
        h('span', { class: 'week-block__label', text: weekDisplayLabel(week) }),
        h('span', {
          class: 'week-block__hint',
          text: [
            hasContent ? '記入あり' : '未記入',
            week.originId ? '🔗同期済' : null
          ].filter(Boolean).join(' · ')
        })),
      h('div', { class: 'week-block__body' },
        h('div', { class: 'grid-2' },
          fieldText(`w${wi}-worked`, '集まって作業した日時', week.workedAt, (v) => {
            current.weeks[wi].workedAt = v;
          }),
          fieldText(`w${wi}-abs`, '欠席者', week.absentees, (v) => {
            current.weeks[wi].absentees = v;
          })),
        fieldArea(`w${wi}-progress`, '前回からの進捗', week.progress, (v) => {
          current.weeks[wi].progress = v;
        }, 3),
        fieldArea(`w${wi}-issue`, '問題点', week.issue, (v) => {
          current.weeks[wi].issue = v;
        }, 2),
        fieldArea(`w${wi}-plan`, '次回までの予定', week.plan, (v) => {
          current.weeks[wi].plan = v;
        }, 2),
        h('button', {
          class: 'btn btn--secondary btn--small', type: 'button',
          onclick: () => {
            persist();
            openSyncDialog(current, week.key);
          }
        }, 'この週を提出用に同期')));
    }

    function persist() {
      const saved = saveLocalReport(current);
      Object.assign(current, JSON.parse(JSON.stringify(saved)));
      if (saveState) {
        saveState.dataset.state = 'saved';
        const at = fmtTime(new Date().toISOString());
        saveState.textContent = `保存しました${at ? `（${at}）` : ''}`;
      }
      const titleEl = document.getElementById('panel-title');
      if (titleEl) titleEl.textContent = documentTitle(current);
    }
  }

  function removeLocal(id) {
    const removed = deleteLocalReport(id);
    l.selectedId = null;
    panel.close();
    refreshLocal();
    paintTab();
    syncUrl();
    if (!removed) return;
    toasts.push(`「${documentTitle(removed)}」を削除しました`, {
      label: '元に戻す',
      run: () => {
        saveLocalReport(removed);
        refreshLocal();
        paintTab();
      }
    });
  }

  // ── 提出用 ⇄ 下書きの行き来 ───────────────────────
  async function loadOriginList() {
    if (ctx.demo) return demoReports();
    return api.reports({ refresh: true });
  }

  function pickWeekKeyForOrigin(originRow, doc) {
    const title = String(originRow.title || originRow.period || '');
    const hit = (doc.weeks || []).find((w) => title.includes(w.label));
    if (hit) return hit.key;
    const empty = (doc.weeks || []).find((w) => !w.progress && !w.issue && !w.plan);
    return empty?.key || doc.weeks?.[0]?.key;
  }

  async function ensureOriginFields(originRow) {
    if (originRow.detailLoaded && Array.isArray(originRow.fields)) {
      return Object.fromEntries(originRow.fields.map((f) => [f.name, f.value ?? '']));
    }
    const detail = ctx.demo
      ? await demoReport(originRow.id)
      : await api.report(originRow.id, { refresh: true });
    const row = originRows.find((r) => sameId(r.id, originRow.id));
    if (row) applyDetail(row, detail);
    return Object.fromEntries(((detail.fields || []).map((f) => [f.name, f.value ?? ''])));
  }

  async function copyOriginToLocal(originRow) {
    try {
      const byName = await ensureOriginFields(originRow);
      const created = createLocalReport({
        status: '下書き',
        originId: originRow.id,
        originTitle: originRow.title || null,
        meta: { overview: byName.shortnote || byName.content || '' }
      });
      const weekKey = pickWeekKeyForOrigin(originRow, created);
      const weeks = created.weeks.map((w) => {
        if (w.key !== weekKey) return w;
        return {
          ...w,
          progress: byName.progress || '',
          issue: byName.issue || '',
          plan: byName.plan || '',
          workedAt: [byName.start_at, byName.end_at].filter(Boolean).join(' ～ '),
          originId: originRow.id,
          originTitle: originRow.title || null
        };
      });
      const saved = saveLocalReport({ ...created, weeks });
      panel.close();
      refreshLocal();
      setTab('local');
      toasts.push(`「${documentTitle(saved)}」に下書きコピーしました`);
      openEditor(saved.id);
    } catch (e) {
      toasts.push(e.message || 'コピーに失敗しました');
    }
  }

  async function openCopyDialog() {
    const bodyHost = h('div', {}, h('p', { class: 'loading', text: '提出用の週報を読み込み中…' }));
    panel.open({
      eyebrow: '提出用からコピー',
      title: '取り込む週報を選ぶ',
      body: bodyHost,
      actions: [
        h('button', {
          class: 'btn btn--secondary', type: 'button',
          onclick: () => {
            if (l.selectedId) openEditor(l.selectedId, { focus: false });
            else panel.close();
          }
        }, '戻る')
      ]
    });

    try {
      const data = await loadOriginList();
      const list = data.reports || [];
      if (!list.length) {
        bodyHost.replaceChildren(emptyBlock({
          title: '提出用に週報がありません',
          body: '締め切りが設定されるとここに表示されます。'
        }));
        return;
      }
      const search = h('input', {
        class: 'input', type: 'search', placeholder: 'タイトルで絞り込み',
        oninput: paintItems
      });
      const itemsHost = h('div', { class: 'itemlist' });
      bodyHost.replaceChildren(
        h('p', {
          class: 'field__hint',
          text: '選んだ週報を下書きテンプレートへコピーします（提出用は変わりません）。'
        }),
        h('div', { class: 'field' },
          h('label', { class: 'field__label', text: '絞り込み' }), search),
        itemsHost);

      function paintItems() {
        const q = search.value.trim().toLowerCase();
        const shown = list.filter((r) =>
          !q || String(r.title || '').toLowerCase().includes(q));
        itemsHost.replaceChildren(...shown.map((r) => h('button', {
          class: 'item item--button', type: 'button',
          onclick: () => copyOriginToLocal(r)
        },
        h('span', { class: 'item__title', text: r.title || `週報 ${r.id}` }),
        h('span', {
          class: 'item__meta',
          text: [r.status, r.period, r.due].filter(Boolean).join(' · ')
        }))));
        if (!shown.length) {
          itemsHost.replaceChildren(h('p', {
            class: 'field__hint', text: '条件に合う週報がありません'
          }));
        }
      }
      paintItems();
      search.focus();
    } catch (e) {
      bodyHost.replaceChildren(h('p', {
        class: 'form-error',
        text: e.message || '提出用の週報を読めませんでした'
      }));
    }
  }

  async function openSyncDialog(localDoc, preferredWeekKey = null) {
    const weeks = localDoc.weeks || [];
    let weekKey = preferredWeekKey
      || weeks.find((w) => w.progress || w.issue || w.plan)?.key
      || weeks[0]?.key;
    let originId = (weeks.find((w) => w.key === weekKey)?.originId)
      || localDoc.originId
      || null;

    const bodyHost = h('div', {}, h('p', { class: 'loading', text: '提出用の週報を読み込み中…' }));
    panel.open({
      eyebrow: '提出用に同期',
      title: documentTitle(localDoc),
      body: bodyHost,
      actions: [
        h('button', {
          class: 'btn btn--secondary', type: 'button',
          onclick: () => openEditor(localDoc.id, { focus: false })
        }, '戻る')
      ]
    });

    try {
      const data = await loadOriginList();
      const list = data.reports || [];
      if (!list.length) {
        bodyHost.replaceChildren(emptyBlock({
          title: '同期できる週報がありません',
          body: '提出用に週報が無いと同期できません。'
        }));
        return;
      }
      if (!originId && localDoc.originId) originId = localDoc.originId;
      if (!list.some((r) => sameId(r.id, originId))) originId = list[0]?.id ?? null;

      const weekSelect = h('select', {
        class: 'input select', id: 'sync-week',
        onchange: (e) => {
          weekKey = e.target.value;
          const w = weeks.find((x) => x.key === weekKey);
          if (w?.originId) {
            originId = w.originId;
            originSelect.value = String(originId ?? '');
          }
          paintPreview();
        }
      }, weeks.map((w) => h('option', {
        value: w.key, text: weekDisplayLabel(w)
      })));
      weekSelect.value = weekKey;

      const originSelect = h('select', {
        class: 'input select', id: 'sync-origin',
        onchange: (e) => {
          originId = e.target.value || null;
          paintPreview();
        }
      }, list.map((r) => h('option', {
        value: String(r.id),
        text: `${r.title || `週報 ${r.id}`}${sameId(r.id, localDoc.originId) ? '（前回の同期先）' : ''}`
      })));
      if (originId) originSelect.value = String(originId);

      const preview = h('pre', { class: 'sync-preview' });
      const goBtn = h('button', {
        class: 'btn btn--primary', type: 'button',
        onclick: () => {
          const week = weeks.find((w) => w.key === weekKey);
          const origin = list.find((r) => sameId(r.id, originId));
          if (!week || !origin) {
            toasts.push('週と提出先を選んでください');
            return;
          }
          runSync(localDoc, week, origin);
        }
      }, 'この内容で書き込む');

      bodyHost.replaceChildren(
        h('div', { class: 'field' },
          h('label', { class: 'field__label', for: 'sync-week', text: '同期する週' }),
          h('span', { class: 'select-wrap' }, weekSelect)),
        h('div', { class: 'field' },
          h('label', { class: 'field__label', for: 'sync-origin', text: '書き込み先の提出用' }),
          h('span', { class: 'select-wrap' }, originSelect)),
        h('p', {
          class: 'field__hint',
          text: '概要・進捗・課題・計画を上書きします。提出側の他項目は変わりません。'
        }),
        preview);

      panel.update({
        actions: [
          goBtn,
          h('button', {
            class: 'btn btn--secondary', type: 'button',
            onclick: () => openEditor(localDoc.id, { focus: false })
          }, '戻る')
        ]
      });

      paintPreview();

      function paintPreview() {
        const week = weeks.find((w) => w.key === weekKey);
        const origin = list.find((r) => sameId(r.id, originId));
        const fields = weekToFieldList(week, localDoc.meta?.overview);
        preview.textContent = [
          `書き込み先: ${origin?.title || '（未選択）'}`,
          ...fields.map((f) => `${f.label}: ${(f.value || '（空）').slice(0, 80)}`)
        ].join('\n');
      }
    } catch (e) {
      bodyHost.replaceChildren(h('p', {
        class: 'form-error',
        text: e.message || '提出用の週報を読めませんでした'
      }));
    }
  }

  async function runSync(localDoc, week, originRow) {
    const ok = window.confirm(
      `「${originRow.title || originRow.id}」へ\n`
      + `下書き「${weekDisplayLabel(week)}」を書き込みます。\n`
      + '提出用の該当項目は上書きされます。よろしいですか？'
    );
    if (!ok) return;

    const fields = weekToFieldList(week, localDoc.meta?.overview);
    const statusEl = h('p', { class: 'field__hint', text: '同期中…' });
    panel.update({ body: h('div', {}, statusEl), actions: [] });

    try {
      if (ctx.demo) {
        await new Promise((r) => setTimeout(r, 400));
      } else {
        for (const f of fields) {
          statusEl.textContent = `同期中…（${f.label}）`;
          await api.saveReportField(originRow.id, f.name, f.value ?? '');
        }
      }
      const weeks = localDoc.weeks.map((w) => {
        if (w.key !== week.key) return w;
        return { ...w, originId: originRow.id, originTitle: originRow.title || null };
      });
      const linked = saveLocalReport({
        ...localDoc,
        weeks,
        originId: originRow.id,
        originTitle: originRow.title || null,
        status: '準備完了'
      });
      ctx.invalidate?.(['/reports']);
      toasts.push(`「${originRow.title || originRow.id}」へ同期しました`);
      panel.close();
      refreshLocal();
      paintTab();
      syncUrl();
      openEditor(linked.id, { focus: false });
    } catch (e) {
      toasts.push(e.message || '同期に失敗しました');
      openSyncDialog(localDoc, week.key);
    }
  }
}

/** `/` で検索欄へ。タブに応じて対象を変える。 */
document.addEventListener('keydown', (e) => {
  if (e.key !== '/') return;
  const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName || '');
  if (typing) return;
  if (!location.pathname.startsWith('/reports')) return;
  const search = document.getElementById('lq') || document.getElementById('q');
  if (!search) return;
  e.preventDefault();
  search.focus();
  search.select();
});
