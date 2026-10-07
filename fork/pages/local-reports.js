/* ローカル週報（公式テンプレート形式）。
 *
 * - データは localStorage のみ（サーバー／Worker に保存しない）
 * - 公式 Excel テンプレートのエクスポート／インポート
 * - 新規作成・編集・削除
 * - 週ブロックを選んで元アプリ週報へ同期（PUSH）
 */

import { api } from '../api.js';
import { demoReports, demoReport } from '../demo.js';
import { fmtDate, fmtTime } from '../format.js';
import {
  clearLocalReports, createLocalReport, deleteLocalReport, documentTitle,
  filledWeeks, listLocalReports, LOCAL_STATUSES, MEMBER_SLOTS, mergeLocalReports,
  saveLocalReport, SUPPORT_SLOTS, weekDisplayLabel, weekToFieldList
} from '../report-local.js';
import { exportReportsExcel, importReportsExcel } from '../report-excel.js';
import { dataTable, emptyBlock, h, metaList, panel, statusPill, toasts } from '../ui.js';

export const meta = {
  route: '/local-reports',
  nav: 'ローカル週報',
  title: 'ローカル週報'
};

const SORT_KEYS = ['updatedAt', 'title', 'status'];
const state = {
  q: '', status: 'all', sortKey: 'updatedAt', sortDir: 'desc', selectedId: null
};

function sameId(a, b) {
  if (a == null || b == null) return false;
  return String(a) === String(b);
}

function loadRows() {
  return listLocalReports();
}

export async function load(_ctx, _opts = {}) {
  return {
    source: 'local',
    fetchedAt: new Date().toISOString(),
    reports: loadRows()
  };
}

export function render(data, ctx) {
  let rows = [...(data.reports || loadRows())];

  readUrl();

  const listHost = h('div', { class: 'list' });
  const countEl = h('p', {
    class: 'toolbar__count', id: 'result-count', role: 'status', 'aria-live': 'polite'
  });
  const fileInput = h('input', {
    type: 'file', accept: '.xlsx,.xls,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    hidden: true,
    onchange: onImportFile
  });

  const page = h('div', {},
    h('header', { class: 'page-head' },
      h('div', {},
        h('h1', { class: 'page-head__title', text: meta.title }),
        h('p', {
          class: 'page-head__lede',
          text: '公式週報テンプレートと同じ形式で、このブラウザにだけ保存します。'
        })),
      h('div', { class: 'page-head__actions' },
        h('button', {
          class: 'btn btn--primary', type: 'button', id: 'local-new',
          onclick: () => openEditor(createLocalReport({}).id)
        }, '新規作成'),
        h('button', {
          class: 'btn btn--secondary', type: 'button', id: 'local-export',
          onclick: onExport
        }, 'Excel出力'),
        h('button', {
          class: 'btn btn--secondary', type: 'button', id: 'local-import',
          onclick: () => fileInput.click()
        }, 'Excel取込'),
        h('button', {
          class: 'btn btn--secondary', type: 'button', id: 'local-from-origin',
          onclick: openCopyFromOrigin
        }, '元アプリからコピー'))),
    buildToolbar(),
    listHost,
    fileInput,
    h('p', {
      class: 'disclaimer',
      text: 'Excel は公式テンプレート（シート「テンプレート」）を使います。'
        + ' 同期は選んだ週の進捗・問題点・予定を、元アプリの週報へ上書きします。'
    }));

  paint();
  if (state.selectedId) openEditor(state.selectedId, { focus: false });
  return page;

  function readUrl() {
    const p = new URLSearchParams(location.search);
    state.q = p.get('q') || '';
    const st = p.get('status');
    state.status = LOCAL_STATUSES.includes(st) ? st : 'all';
    const key = p.get('sort_by');
    if (SORT_KEYS.includes(key)) state.sortKey = key;
    state.sortDir = p.get('sort_direction') === 'asc' ? 'asc' : 'desc';
    state.selectedId = p.get('local_id') || null;
  }

  function syncUrl() {
    const p = new URLSearchParams();
    if (state.q.trim()) p.set('q', state.q.trim());
    if (state.status !== 'all') p.set('status', state.status);
    p.set('sort_by', state.sortKey);
    p.set('sort_direction', state.sortDir);
    if (state.selectedId) p.set('local_id', state.selectedId);
    if (ctx.demo) p.set('demo', '1');
    history.replaceState(null, '', `${location.pathname}?${p}`);
  }

  function refreshRows() {
    rows = loadRows();
    paint();
  }

  function searchHay(r) {
    const m = r.meta || {};
    const weeks = (r.weeks || []).map((w) =>
      `${w.label} ${w.progress} ${w.issue} ${w.plan}`).join(' ');
    return `${r.title} ${m.teamName} ${m.teamNumber} ${m.overview} ${weeks}`.toLowerCase();
  }

  function visible() {
    const q = state.q.trim().toLowerCase();
    const dir = state.sortDir === 'asc' ? 1 : -1;
    return rows
      .filter((r) => {
        if (state.status !== 'all' && r.status !== state.status) return false;
        if (!q) return true;
        return searchHay(r).includes(q);
      })
      .sort((a, b) => {
        const x = a[state.sortKey] || '';
        const y = b[state.sortKey] || '';
        if (x === y) return String(a.id).localeCompare(String(b.id));
        return (String(x) > String(y) ? 1 : -1) * dir;
      });
  }

  function buildToolbar() {
    return h('div', { class: 'toolbar' },
      h('div', { class: 'field field--search' },
        h('label', { class: 'field__label', for: 'q', text: '絞り込み' }),
        h('input', {
          class: 'input', type: 'search', id: 'q', value: state.q,
          placeholder: 'チーム名・概要・週の内容',
          oninput: (e) => { state.q = e.target.value; paint(); syncUrl(); }
        })),
      h('div', { class: 'field field--status' },
        h('label', { class: 'field__label', for: 'status', text: 'ステータス' }),
        h('span', { class: 'select-wrap' }, h('select', {
          class: 'input select', id: 'status',
          onchange: (e) => {
            state.status = e.target.value || 'all';
            paint();
            syncUrl();
          }
        },
        h('option', { value: 'all', selected: state.status === 'all' || null, text: 'すべて' }),
        LOCAL_STATUSES.map((s) => h('option', {
          value: s, selected: state.status === s || null, text: s
        }))))),
      h('div', { class: 'field field--sort' },
        h('label', { class: 'field__label', for: 'sort', text: '並べ替え' }),
        h('span', { class: 'select-wrap' }, h('select', {
          class: 'input select', id: 'sort',
          onchange: (e) => {
            const [key, dir] = e.target.value.split(':');
            state.sortKey = key;
            state.sortDir = dir;
            paint();
            syncUrl();
          }
        }, [
          ['updatedAt:desc', '更新が新しい順'],
          ['updatedAt:asc', '更新が古い順'],
          ['title:asc', 'タイトル順']
        ].map(([value, label]) => h('option', {
          value, selected: value === `${state.sortKey}:${state.sortDir}`
        }, label))))),
      countEl);
  }

  function paint() {
    const list = visible();
    countEl.textContent = state.q || state.status !== 'all'
      ? `${list.length} / ${rows.length} 件（ローカル）`
      : `${rows.length} 件（ローカル）`;

    if (!list.length) {
      listHost.replaceChildren(rows.length
        ? emptyBlock({
          title: '条件に合うローカル週報がありません',
          actionLabel: '絞り込みを解除',
          onAction: () => {
            state.q = '';
            state.status = 'all';
            paint();
            syncUrl();
          }
        })
        : emptyBlock({
          title: 'ローカル週報はまだありません',
          body: '「新規作成」か「Excel取込」「元アプリからコピー」で追加できます。',
          actionLabel: '新規作成',
          onAction: () => openEditor(createLocalReport({}).id)
        }));
      return;
    }

    listHost.replaceChildren(dataTable({
      caption: 'ローカル週報一覧',
      columns: [
        { key: 'title', label: '週報', className: 'table__th--title' },
        { key: 'status', label: 'ステータス', className: 'table__th--status' },
        { key: 'filled', label: '記入週', className: 'table__th--created' },
        { key: 'updatedAt', label: '更新', className: 'table__th--created' }
      ],
      sort: { key: state.sortKey, dir: state.sortDir },
      onSort: (key) => {
        if (key === 'filled') return;
        state.sortDir = state.sortKey === key && state.sortDir === 'asc' ? 'desc' : 'asc';
        state.sortKey = key;
        paint();
        syncUrl();
      },
      rows: list.map((r) => ({
        id: r.id,
        idPrefix: 'local',
        selected: sameId(r.id, state.selectedId),
        onOpen: (id) => openEditor(id),
        cells: [
          {
            label: '週報',
            value: h('span', {},
              h('span', { class: 'cell__title', text: documentTitle(r) }),
              r.meta?.overview
                ? h('span', {
                  class: 'cell__sub',
                  text: String(r.meta.overview).slice(0, 60)
                })
                : null)
          },
          { label: 'ステータス', value: statusPill(r.status) },
          {
            label: '記入週',
            value: `${filledWeeks(r).length} / ${(r.weeks || []).length}`
          },
          {
            label: '更新',
            value: r.updatedAt
              ? [fmtDate(String(r.updatedAt).slice(0, 10)), fmtTime(r.updatedAt)]
                .filter(Boolean).join(' ')
              : '—',
            className: 'cell--num'
          }
        ]
      }))
    }));
  }

  async function onExport() {
    const target = state.selectedId
      ? rows.find((r) => sameId(r.id, state.selectedId))
      : null;
    const doc = target || (visible()[0] || rows[0]);
    if (!doc) {
      toasts.push('書き出す週報がありません');
      return;
    }
    if (!target && rows.length > 1) {
      const ok = window.confirm(
        `一覧の先頭「${documentTitle(doc)}」を Excel 出力します。\n`
        + '別の週報を出す場合は、先に一覧から開いてください。'
      );
      if (!ok) return;
    }
    try {
      const result = await exportReportsExcel(doc);
      toasts.push(`Excel を書き出しました（${result.filename}）`);
    } catch (e) {
      toasts.push(e.message || '書き出しに失敗しました');
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
      refreshRows();
      toasts.push(`取り込み完了：新規 ${created} 件・更新 ${updated} 件`);
      if (incoming[0]?.id) openEditor(incoming[0].id);
    } catch (err) {
      toasts.push(err.message || '取り込みに失敗しました');
    }
  }

  function openEditor(id, { focus = true } = {}) {
    const r = rows.find((x) => sameId(x.id, id)) || listLocalReports()
      .find((x) => sameId(x.id, id));
    if (!r) return;
    if (!rows.some((x) => sameId(x.id, r.id))) rows = loadRows();
    const current = JSON.parse(JSON.stringify(rows.find((x) => sameId(x.id, id)) || r));
    if (!current.meta) current.meta = {};
    if (!Array.isArray(current.weeks)) current.weeks = [];

    state.selectedId = String(current.id);
    paint();
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
        fieldText('teamName', 'チーム名', current.meta.teamName, (v) => {
          current.meta.teamName = v;
        }),
        fieldText('teamNumber', 'チーム番号', current.meta.teamNumber, (v) => {
          current.meta.teamNumber = v;
        }),
        fieldArea('overview', '作品概要', current.meta.overview, (v) => {
          current.meta.overview = v;
        }, 4),
        fieldText('meetingDay', '定例ミーティング曜日', current.meta.meetingDay, (v) => {
          current.meta.meetingDay = v;
        }),
        fieldText('meetingTime', '定例ミーティング時間', current.meta.meetingTime, (v) => {
          current.meta.meetingTime = v;
        })),
      h('section', { class: 'local-section' },
        h('h2', { class: 'local-section__title', text: 'チームメンバー' }),
        ...Array.from({ length: MEMBER_SLOTS }, (_, i) =>
          fieldText(`member-${i}`, `メンバー ${i + 1}`, current.meta.members?.[i] || '', (v) => {
            if (!current.meta.members) current.meta.members = [];
            current.meta.members[i] = v;
          }))),
      h('section', { class: 'local-section' },
        h('h2', { class: 'local-section__title', text: 'サポートメンバー' }),
        ...Array.from({ length: SUPPORT_SLOTS }, (_, i) =>
          fieldText(`support-${i}`, `サポート ${i + 1}`, current.meta.support?.[i] || '', (v) => {
            if (!current.meta.support) current.meta.support = [];
            current.meta.support[i] = v;
          }))),
      h('section', { class: 'local-section' },
        h('h2', { class: 'local-section__title', text: '各週の記入' }),
        h('p', {
          class: 'field__hint',
          text: 'テンプレートの週ブロックです。同期するときは週を選んで元アプリへ書き込みます。'
        }),
        h('div', { class: 'week-list' }, current.weeks.map((week, wi) =>
          weekEditor(week, wi)))),
      h('p', { class: 'field__hint' }, saveState));

    panel.open({
      eyebrow: 'ローカル週報',
      title: documentTitle(current),
      body,
      actions: [
        h('button', {
          class: 'btn btn--primary', type: 'button', id: 'local-sync',
          onclick: () => openSyncPicker(current)
        }, '元アプリに同期'),
        h('button', {
          class: 'btn btn--secondary', type: 'button',
          onclick: async () => {
            try {
              const result = await exportReportsExcel(current);
              toasts.push(`Excel を書き出しました（${result.filename}）`);
            } catch (e) {
              toasts.push(e.message || '書き出しに失敗しました');
            }
          }
        }, 'この週報をExcel出力'),
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
        state.selectedId = null;
        refreshRows();
        syncUrl();
        return listHost.querySelector(`#local_${CSS.escape(String(current.id))} .row__open`);
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

    function fieldArea(name, label, value, apply, rows = 5) {
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
      const open = h('details', {
        class: 'week-block',
        open: Boolean(week.progress || week.issue || week.plan || week.workedAt) || null
      },
      h('summary', { class: 'week-block__summary' },
        h('span', { class: 'week-block__label', text: weekDisplayLabel(week) }),
        h('span', {
          class: 'week-block__hint',
          text: (week.progress || week.issue || week.plan) ? '記入あり' : '未記入'
        })),
      h('div', { class: 'week-block__body' },
        fieldText(`w${wi}-worked`, '集まって作業した日時', week.workedAt, (v) => {
          current.weeks[wi].workedAt = v;
        }),
        fieldText(`w${wi}-abs`, '欠席者', week.absentees, (v) => {
          current.weeks[wi].absentees = v;
        }),
        fieldArea(`w${wi}-progress`, '前回からの進捗', week.progress, (v) => {
          current.weeks[wi].progress = v;
        }, 4),
        fieldArea(`w${wi}-issue`, '問題点', week.issue, (v) => {
          current.weeks[wi].issue = v;
        }, 3),
        fieldArea(`w${wi}-plan`, '次回までの予定', week.plan, (v) => {
          current.weeks[wi].plan = v;
        }, 3),
        h('button', {
          class: 'btn btn--secondary btn--small', type: 'button',
          onclick: () => openSyncPicker(current, week.key)
        }, 'この週を元アプリに同期')));
      return open;
    }

    function persist() {
      const saved = saveLocalReport(current);
      Object.assign(current, saved);
      if (saveState) {
        saveState.dataset.state = 'saved';
        saveState.textContent = '保存しました';
      }
      const titleEl = document.getElementById('panel-title');
      if (titleEl) titleEl.textContent = documentTitle(current);
    }
  }

  function removeLocal(id) {
    const removed = deleteLocalReport(id);
    state.selectedId = null;
    panel.close();
    refreshRows();
    syncUrl();
    if (!removed) return;
    toasts.push(`「${documentTitle(removed)}」を削除しました`, {
      label: '元に戻す',
      run: () => { saveLocalReport(removed); refreshRows(); }
    });
  }

  async function loadOriginReports() {
    if (ctx.demo) return demoReports();
    return api.reports({ refresh: true });
  }

  async function openCopyFromOrigin() {
    const bodyHost = h('div', {}, h('p', { class: 'loading', text: '元アプリの週報を読み込み中…' }));
    panel.open({
      eyebrow: '元アプリからコピー',
      title: '取り込む週報を選ぶ',
      body: bodyHost,
      actions: [
        h('button', {
          class: 'btn btn--secondary', type: 'button',
          onclick: () => panel.close()
        }, '閉じる')
      ]
    });

    try {
      const data = await loadOriginReports();
      const list = data.reports || [];
      if (!list.length) {
        bodyHost.replaceChildren(emptyBlock({
          title: '元アプリに週報がありません',
          body: '締め切りが設定されるとここに表示されます。'
        }));
        return;
      }
      bodyHost.replaceChildren(
        h('p', {
          class: 'field__hint',
          text: '選んだ週報の内容をローカルテンプレートの該当週（または先頭の空週）へコピーします。'
        }),
        h('div', { class: 'itemlist' }, list.map((r) => h('button', {
          class: 'item item--button', type: 'button',
          onclick: () => copyOriginToLocal(r)
        },
        h('span', { class: 'item__title', text: r.title || `週報 ${r.id}` }),
        h('span', {
          class: 'item__meta',
          text: [r.status, r.period, r.due].filter(Boolean).join(' · ')
        })))));
    } catch (e) {
      bodyHost.replaceChildren(h('p', {
        class: 'form-error',
        text: e.message || '元アプリの週報を読めませんでした'
      }));
    }
  }

  function pickWeekKeyForOrigin(originRow, doc) {
    const title = String(originRow.title || originRow.period || '');
    const hit = (doc.weeks || []).find((w) =>
      title.includes(w.label.replace(/第/, '第')) || title.includes(w.label));
    if (hit) return hit.key;
    const empty = (doc.weeks || []).find((w) =>
      !w.progress && !w.issue && !w.plan);
    return empty?.key || doc.weeks?.[0]?.key;
  }

  async function copyOriginToLocal(originRow) {
    try {
      let fields = [];
      if (ctx.demo) {
        const detail = await demoReport(originRow.id);
        fields = detail.fields || [];
      } else {
        const detail = await api.report(originRow.id, { refresh: true });
        fields = detail.fields || [];
      }
      const byName = Object.fromEntries(
        (fields || []).map((f) => [f.name, f.value ?? ''])
      );
      const created = createLocalReport({
        status: '下書き',
        originId: originRow.id,
        originTitle: originRow.title || null,
        meta: {
          overview: byName.shortnote || byName.content || ''
        }
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
      refreshRows();
      toasts.push(`「${documentTitle(saved)}」をローカルにコピーしました`);
      openEditor(saved.id);
    } catch (e) {
      toasts.push(e.message || 'コピーに失敗しました');
    }
  }

  async function openSyncPicker(localReport, preferredWeekKey = null) {
    const weeks = localReport.weeks || [];
    const preferred = preferredWeekKey
      || weeks.find((w) => w.progress || w.issue || w.plan)?.key
      || weeks[0]?.key;

    let selectedWeekKey = preferred;

    const bodyHost = h('div', {}, h('p', { class: 'loading', text: '元アプリの週報を読み込み中…' }));
    panel.open({
      eyebrow: '元アプリに同期',
      title: documentTitle(localReport),
      body: bodyHost,
      actions: [
        h('button', {
          class: 'btn btn--secondary', type: 'button',
          onclick: () => openEditor(localReport.id, { focus: false })
        }, '戻る')
      ]
    });

    try {
      const data = await loadOriginReports();
      const list = data.reports || [];

      function paintSync() {
        const week = weeks.find((w) => w.key === selectedWeekKey) || weeks[0];
        const linkedId = week?.originId || localReport.originId;
        const preferredOrigins = linkedId
          ? list.filter((r) => sameId(r.id, linkedId))
          : [];
        const rest = list.filter((r) => !sameId(r.id, linkedId));
        const ordered = [...preferredOrigins, ...rest];

        if (!ordered.length) {
          bodyHost.replaceChildren(emptyBlock({
            title: '同期できる週報がありません',
            body: '元アプリ側に週報が無いと同期できません。'
          }));
          return;
        }

        const fields = weekToFieldList(week, localReport.meta?.overview);
        const preview = fields
          .map((f) => `${f.label}: ${(f.value || '（空）').slice(0, 80)}`)
          .join('\n');

        bodyHost.replaceChildren(
          h('div', { class: 'field' },
            h('label', { class: 'field__label', for: 'sync-week', text: '同期する週' }),
            h('span', { class: 'select-wrap' }, h('select', {
              class: 'input select', id: 'sync-week',
              onchange: (e) => {
                selectedWeekKey = e.target.value;
                paintSync();
              }
            }, weeks.map((w) => h('option', {
              value: w.key,
              selected: w.key === selectedWeekKey || null,
              text: weekDisplayLabel(w)
            }))))),
          h('p', {
            class: 'field__hint',
            text: '選んだ元アプリの週報へ、概要・進捗・課題・計画を書き込みます。'
          }),
          h('pre', { class: 'sync-preview', text: preview }),
          h('div', { class: 'itemlist' }, ordered.map((r) => h('button', {
            class: `item item--button${sameId(r.id, linkedId) ? ' is-selected' : ''}`,
            type: 'button',
            onclick: () => runSync(localReport, week, r)
          },
          h('span', { class: 'item__title', text: r.title || `週報 ${r.id}` }),
          h('span', {
            class: 'item__meta',
            text: [
              sameId(r.id, linkedId) ? '前回の同期先' : null,
              r.status,
              r.period
            ].filter(Boolean).join(' · ')
          })))));
      }

      paintSync();
    } catch (e) {
      bodyHost.replaceChildren(h('p', {
        class: 'form-error',
        text: e.message || '元アプリの週報を読めませんでした'
      }));
    }
  }

  async function runSync(localReport, week, originRow) {
    const ok = window.confirm(
      `「${originRow.title || originRow.id}」へ\n`
      + `ローカル「${weekDisplayLabel(week)}」を書き込みます。\n`
      + '元アプリの該当項目は上書きされます。よろしいですか？'
    );
    if (!ok) return;

    const fields = weekToFieldList(week, localReport.meta?.overview);
    const statusEl = h('p', { class: 'field__hint', text: '同期中…' });
    panel.update({
      body: h('div', {}, statusEl),
      actions: []
    });

    try {
      if (ctx.demo) {
        await new Promise((r) => setTimeout(r, 400));
      } else {
        for (const f of fields) {
          statusEl.textContent = `同期中…（${f.label}）`;
          await api.saveReportField(originRow.id, f.name, f.value ?? '');
        }
      }
      const weeks = localReport.weeks.map((w) => {
        if (w.key !== week.key) return w;
        return {
          ...w,
          originId: originRow.id,
          originTitle: originRow.title || null
        };
      });
      const linked = saveLocalReport({
        ...localReport,
        weeks,
        originId: originRow.id,
        originTitle: originRow.title || null,
        status: '準備完了'
      });
      ctx.invalidate?.(['/reports']);
      toasts.push(`「${originRow.title || originRow.id}」へ同期しました`);
      panel.close();
      refreshRows();
      openEditor(linked.id, { focus: false });
    } catch (e) {
      toasts.push(e.message || '同期に失敗しました');
      openSyncPicker(localReport, week.key);
    }
  }
}

/** 開発・テスト用にストレージを空にする入口（通常 UI には出さない）。 */
export function __dangerouslyClearLocalReports() {
  clearLocalReports();
}
