/* 週報一覧。
 *
 * 他の画面もこの形に合わせている。
 *   meta   … ルートとナビ表示名と <title>
 *   load   … デモなら demo.js、実データなら api.js
 *   render … ノードを 1 つ返す。画面内の再描画は自分で持つ
 *
 * 元 UI との違いで意図的なものは 4 つ。
 *  1. 絞り込み・並べ替えでページを再読み込みしない。状態は URL に同期する。
 *  2. 詳細パネルは Escape と背景クリックで閉じ、フォーカスを呼び出した行へ返す。
 *  3. パネルを閉じても中身を捨てない。開き直しで再取得しない。
 *  4. 削除は確認ダイアログではなく、実行してから「元に戻す」を出す。
 */

import { api } from '../api.js';
import { DEMO_TODAY, demoReports } from '../demo.js';
import { dueRest, fmtDate, fmtShort } from '../format.js';
import { dataTable, dueCell, emptyBlock, h, metaList, panel, statusPill, toasts } from '../ui.js';

export const meta = { route: '/reports', nav: '週報', title: '週報一覧' };

const SORT_KEYS = ['title', 'periodStart', 'status', 'due', 'createdAt'];
const state = { q: '', status: 'all', sortKey: 'due', sortDir: 'asc', selectedId: null };

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
  return ctx.demo ? demoReports(opts) : api.reports(opts);
}

export function render(data, ctx) {
  const today = ctx.demo ? new Date(`${DEMO_TODAY}T00:00:00`) : ctx.today;

  let rows = (data.reports || []).map(normalize);
  const serverCounts = data.counts?.合計 != null ? data.counts : null;
  const emptyText = data.empty || { title: '週報がありません', body: '' };

  readUrl();

  const listHost = h('div', { class: 'list' });
  const countEl = h('p', {
    class: 'toolbar__count', id: 'result-count', role: 'status', 'aria-live': 'polite'
  });
  const summary = h('dl', { class: 'summary' });
  const disclaimer = h('p', { class: 'disclaimer', id: 'disclaimer' });

  const page = h('div', {},
    h('header', { class: 'page-head' },
      h('h1', { class: 'page-head__title', text: meta.title }),
      summary),
    buildToolbar(),
    listHost,
    disclaimer);

  const saveTimers = new Map();
  const dirtyFields = new Set();
  const datesTouched = new Set();

  paint();
  if (state.selectedId != null) openDetail(state.selectedId, { focus: false });
  return page;

  // ── 状態 ────────────────────────────────────────
  function normalize(r) {
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

  function sortValue(r) {
    switch (state.sortKey) {
      case 'title': return r.title;
      case 'periodStart': return r.startISO || r.periodText;
      case 'status': return r.status;
      case 'createdAt': return r.createdISO || r.createdText;
      default: return r.dueISO || r.dueText;
    }
  }

  function filtering() {
    return state.q.trim() !== '' || state.status !== 'all';
  }

  function visible() {
    const q = state.q.trim().toLowerCase();
    const dir = state.sortDir === 'asc' ? 1 : -1;
    return rows
      .filter((r) => {
        if (state.status !== 'all' && r.status !== state.status) return false;
        if (q && !r.title.toLowerCase().includes(q)) return false;
        return true;
      })
      .sort((a, b) => {
        const x = sortValue(a) ?? '';
        const y = sortValue(b) ?? '';
        if (x === y) return String(a.id ?? '').localeCompare(String(b.id ?? ''), 'en');
        return (x > y ? 1 : -1) * dir;
      });
  }

  // ── URL 同期。リンクを共有できる状態を保つ ─────────
  function readUrl() {
    const p = new URLSearchParams(location.search);
    state.q = p.get('q') || '';
    const status = p.get('status');
    state.status = status === '未完了' || status === '完了' ? status : 'all';
    const key = p.get('sort_by');
    if (SORT_KEYS.includes(key)) state.sortKey = key;
    state.sortDir = p.get('sort_direction') === 'desc' ? 'desc' : 'asc';
    const id = parseReportQueryId(p.get('report_id'));
    state.selectedId = id;
  }

  function syncUrl() {
    const p = new URLSearchParams();
    if (state.q.trim()) p.set('q', state.q.trim());
    if (state.status !== 'all') p.set('status', state.status);
    p.set('sort_by', state.sortKey);
    p.set('sort_direction', state.sortDir);
    if (state.selectedId) p.set('report_id', state.selectedId);
    if (ctx.demo) p.set('demo', '1');
    history.replaceState(null, '', `${location.pathname}?${p}`);
  }

  // ── ツールバー ──────────────────────────────────
  function buildToolbar() {
    const search = h('input', {
      class: 'input', type: 'search', id: 'q', name: 'q',
      placeholder: '第 3 週', autocomplete: 'off', 'aria-describedby': 'q-hint',
      value: state.q,
      oninput: (e) => { state.q = e.target.value; paint(); syncUrl(); }
    });

    const segments = [['all', 'すべて'], ['未完了', '未完了'], ['完了', '完了']]
      .map(([value, label]) => h('label', { class: 'segmented__option' },
        h('input', {
          type: 'radio', name: 'status', value,
          checked: state.status === value,
          onchange: (e) => {
            if (!e.target.checked) return;
            state.status = value;
            paint();
            syncUrl();
          }
        }),
        h('span', {}, label)));

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
      ['due:asc', '期限が近い順'], ['due:desc', '期限が遠い順'],
      ['createdAt:desc', '作成が新しい順'], ['createdAt:asc', '作成が古い順'],
      ['title:asc', 'タイトル順']
    ].map(([value, label]) => h('option', {
      value, selected: value === `${state.sortKey}:${state.sortDir}`
    }, label)));

    return h('div', { class: 'toolbar' },
      h('div', { class: 'field field--search' },
        h('label', { class: 'field__label', for: 'q', text: 'タイトルで絞り込み' }),
        search,
        h('p', { class: 'field__hint', id: 'q-hint' }, h('kbd', { text: '/' }), ' で移動')),
      h('fieldset', { class: 'field field--status' },
        h('legend', { class: 'field__label', text: 'ステータス' }),
        h('div', { class: 'segmented' }, segments),
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
        caption: '週報の一覧。列見出しのボタンで並べ替えできます。行を開くと右に詳細が出ます。',
        columns: [
          { key: 'title', label: 'タイトル', className: 'table__th--title' },
          { key: 'periodStart', label: '期間', className: 'table__th--period' },
          { key: 'status', label: 'ステータス', className: 'table__th--status' },
          { key: 'due', label: '期限', className: 'table__th--due' },
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
        rows: list.map((r) => {
          const due = dueCell(r.dueISO, r.dueText, { done: r.status === '完了', today });
          return {
            id: r.id,
            idPrefix: 'report',       // 元 UI の行 ID 規約を保つ
            selected: sameId(r.id, state.selectedId),
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
      wireKeyboard();
    } else {
      // 絞り込みで 0 件になったのか、そもそも 0 件なのかを言い分ける
      listHost.replaceChildren(filtering()
        ? emptyBlock({
          title: '条件に合う週報がありません',
          body: '検索語やステータスを変えてみてください。',
          actionLabel: '絞り込みを解除',
          onAction: resetFilters
        })
        : emptyBlock(emptyText));
    }

    countEl.textContent = filtering()
      ? `${list.length} / ${rows.length} 件`
      : `${rows.length} 件`;

    const counts = serverCounts || {
      未完了: rows.filter((r) => r.status === '未完了').length,
      完了: rows.filter((r) => r.status === '完了').length,
      合計: rows.length
    };
    summary.replaceChildren(...[
      ['未完了', counts.未完了 ?? 0, ''],
      ['完了', counts.完了 ?? 0, ''],
      ['合計', counts.合計 ?? rows.length, 'summary__item--total']
    ].map(([label, value, extra]) => h('div', { class: `summary__item ${extra}`.trim() },
      h('dt', { class: 'summary__label', text: label }),
      h('dd', { class: 'summary__value', text: String(value) }))));

    // 注記は出どころに合わせて書き分ける。実データを「ダミー」と書くと嘘になる。
    disclaimer.textContent = ctx.demo
      ? 'これは UI 改善の検証用のフォークです。表示しているデータはダミーで、'
        + 'ステータスは元アプリで確認できた「未完了 / 完了」の 2 値だけを使っています。'
      : 'これは UI 改善の検証用のフォークです。一覧は元アプリの週報一覧をそのまま読んで'
        + '表示しています。行を開くと `/reports/:id/edit` の詳細項目を取り、項目名は元アプリの'
        + 'ラベルをそのまま使います。本文の変更は元アプリの自動保存へ送ります。'
        + 'ステータスは元アプリで確認できた「未完了 / 完了」の 2 値だけを使います。';
  }

  function resetFilters() {
    state.q = '';
    state.status = 'all';
    const input = listHost.parentElement?.querySelector('#q');
    if (input) input.value = '';
    listHost.parentElement?.querySelectorAll('input[name="status"]')
      .forEach((r) => { r.checked = r.value === 'all'; });
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

  // ── 詳細パネル ──────────────────────────────────
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
      if (!r.body) {
        r.body = r.fields.map((f) => f.value).filter(Boolean).join('\n\n');
      }
    }
    if (Array.isArray(detail.meta)) r.meta = detail.meta;
    if (Array.isArray(detail.timeline)) r.timeline = detail.timeline;
    r.detailLoaded = true;
  }

  function fieldList(r) {
    if (Array.isArray(r.fields) && r.fields.length) return r.fields;
    return [{
      name: 'content',
      label: '本文',
      value: r.body || '',
      lockedBy: r.lockedBy || null
    }];
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

  /** 編集した開始・終了を一覧の「期間」へ反映する。両方揃うまで期間未設定。 */
  function applyDatesToRow(r) {
    const fields = fieldList(r);
    const startField = fields.find((f) => f.name === 'start_at');
    const endField = fields.find((f) => f.name === 'end_at');
    if (!startField && !endField) return false;
    const startISO = isoDate(startField?.value);
    const endISO = isoDate(endField?.value);
    if (startField) r.startISO = startISO;
    if (endField) r.endISO = endISO;
    r.periodText = startISO && endISO
      ? `${fmtShort(startISO)} – ${fmtShort(endISO)}`
      : '期間未設定';
    datesTouched.add(String(r.id));
    return true;
  }

  async function reloadList() {
    if (ctx.demo) return;
    const snapshot = rows.map((r) => ({ ...r }));
    try {
      const data = await api.reports({ refresh: true });
      const next = (data.reports || []).map(normalize);
      const prevById = new Map(snapshot.map((r) => [String(r.id), r]));
      rows.splice(0, rows.length, ...next.map((n) => {
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
      // 一覧の取り直しに失敗しても、直前に反映した行は残す
    }
    paint();
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
      paintSaveState('saved', '保存しました');
      if (field.name === 'start_at' || field.name === 'end_at') {
        applyDatesToRow(report);
        paint();
      }
      return;
    }
    try {
      await api.saveReportField(report.id, field.name, field.value ?? '');
      dirtyFields.delete(key);
      paintSaveState('saved', '保存しました');
      if (field.name === 'start_at' || field.name === 'end_at') {
        applyDatesToRow(report);
        paint();
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

    const fieldNodes = fields.map((f, i) => {
      const fieldId = f.name === 'content' || i === 0 ? 'panel-text' : `panel-field-${f.name}`;
      const hintId = `${fieldId}-hint`;
      const lockedField = Boolean(f.lockedBy) || !editable;
      const isDate = f.name === 'start_at' || f.name === 'end_at';
      const oninput = (e) => {
        f.value = e.target.value;
        if (!isDate && (f.name === 'content' || fields.length === 1)) r.body = e.target.value;
        if (editable && !f.lockedBy) queueFieldSave(r, f);
      };
      const control = isDate
        ? h('input', {
          class: 'input', type: 'datetime-local', id: fieldId,
          'aria-describedby': hintId,
          readonly: lockedField || null,
          value: toDatetimeLocal(f.value),
          oninput
        })
        : h('textarea', {
          class: 'input textarea', id: fieldId, rows: 8,
          'aria-describedby': hintId,
          readonly: lockedField || null,
          placeholder: editable && !lockedField && !f.value ? 'この週にやったことを書く' : null,
          oninput
        });
      if (!isDate) control.value = f.value || '';
      return h('div', { class: 'field' },
        h('label', { class: 'field__label', for: fieldId, text: displayLabel(f) }),
        control,
        h('p', { class: 'field__hint', id: hintId },
          f.lockedBy
            ? `${f.lockedBy} さんが編集中のため読み取り専用です`
            : (i === fields.length - 1 ? saveState : null)));
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
      error && h('p', {
        class: 'form-error', id: 'panel-detail-error',
        text: error
      }),
      ...fieldNodes,
      history,
      lockedFields.length > 0 && h('p', { class: 'lock', id: 'panel-lock' },
        h('span', { 'aria-hidden': 'true', text: '●' }),
        h('span', {
          id: 'panel-lock-text',
          text: lockedFields.map((f) => `${displayLabel(f)}は ${f.lockedBy} さんが編集中です`).join('。')
        }))
    ];
  }

  function openDetail(id, { focus = true } = {}) {
    const r = rows.find((x) => sameId(x.id, id));
    if (!r) return;

    state.selectedId = id;
    paint();
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
          reloadList();
        } catch (e) {
          delete save.dataset.state;
          paintSaveState('error', e?.message || '保存できませんでした');
          toasts.push(e?.message || '保存できませんでした');
        }
      }
    }, '保存');

    const actions = [
      editable ? save : null,
      h('button', {
        class: 'btn btn--secondary', type: 'button', id: 'panel-cancel',
        onclick: () => panel.close()
      }, '閉じる'),
      h('button', {
        class: 'btn btn--danger', type: 'button', id: 'panel-delete',
        onclick: () => removeReport(id)
      }, '削除')
    ].filter(Boolean);

    panel.open({
      eyebrow: '週報',
      title: r.title,
      body: buildDetailBody(r, { editable, loading: needsFetch }),
      actions,
      onClose: () => {
        state.selectedId = null;
        paint();
        syncUrl();
        return listHost.querySelector(`#report_${id} .row__open`);
      }
    });

    if (!focus) document.activeElement?.blur?.();

    if (needsFetch) {
      const loadDetail = ctx.demo ? demoReport(r.id) : api.report(r.id);
      Promise.resolve(loadDetail).then((detail) => {
        if (state.selectedId !== id) return;
        applyDetail(r, detail);
        panel.update({
          title: r.title,
          body: buildDetailBody(r, { editable, loading: false })
        });
      }).catch((e) => {
        if (state.selectedId !== id) return;
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

  // 削除は確認せず実行して、元に戻せるようにする
  function removeReport(id) {
    const index = rows.findIndex((x) => sameId(x.id, id));
    if (index < 0) return;
    const [removed] = rows.splice(index, 1);

    state.selectedId = null;
    panel.close();
    paint();
    syncUrl();

    toasts.push(`「${removed.title}」を削除しました`, {
      label: '元に戻す',
      run: () => { rows.splice(index, 0, removed); paint(); }
    });
  }
}

/** `/` で検索欄へ。画面をまたいで同じ挙動にするため入口はここ 1 箇所。 */
document.addEventListener('keydown', (e) => {
  if (e.key !== '/') return;
  const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName || '');
  if (typing) return;
  const search = document.getElementById('q');
  if (!search) return;
  e.preventDefault();
  search.focus();
  search.select();
});
