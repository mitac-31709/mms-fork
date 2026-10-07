/* 画面をまたいで使う DOM の部品。
 *
 * 元 UI はデスクトップ用とモバイル用でマークアップを二重に持っていたが、
 * ここでは 1 つだけ作り、見た目の切り替えは CSS に任せる。
 */

import { dueRest, fmtDate } from './format.js';

/** 要素を組む。attrs の値が null / undefined の属性は付けない。 */
export function h(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else if (k === 'dataset') Object.assign(node.dataset, v);
    else if (k.startsWith('on') && typeof v === 'function') {
      node.addEventListener(k.slice(2).toLowerCase(), v);
    } else node.setAttribute(k, v === true ? '' : String(v));
  }
  for (const child of children.flat()) {
    // `条件 && ノード` の書き方で空文字が残らないように '' も飛ばす
    if (child == null || child === false || child === '') continue;
    node.append(typeof child === 'string' || typeof child === 'number'
      ? document.createTextNode(String(child)) : child);
  }
  return node;
}

/** ステータス。色だけに意味を持たせず、必ずグリフを添える。
 *  注文の語彙（保留中〜キャンセル済み）と週報の未完了/完了の両方に対応。 */
const STATUS_TONES = {
  完了: { tone: 'done', glyph: '✓' },
  返却済み: { tone: 'done', glyph: '✓' },
  既読: { tone: 'done', glyph: '✓' },
  有効: { tone: 'done', glyph: '✓' },
  準備完了: { tone: 'done', glyph: '✓' },
  受取済み: { tone: 'received', glyph: '✓' },
  保留中: { tone: 'pending', glyph: '●' },
  注文済み: { tone: 'ordered', glyph: '▣' },
  受取可能: { tone: 'available', glyph: '◇' },
  キャンセル済み: { tone: 'cancelled', glyph: '×' },
  無効: { tone: 'cancelled', glyph: '×' },
  期限切れ: { tone: 'cancelled', glyph: '×' },
  下書き: { tone: 'open', glyph: '○' },
  未完了: { tone: 'open', glyph: '○' }
};

export function statusPill(value, { doneWhen = ['完了', '返却済み', '既読'] } = {}) {
  const label = value || '—';
  const known = STATUS_TONES[label];
  let tone;
  let glyph;
  if (known) {
    tone = known.tone;
    glyph = known.glyph;
  } else if (doneWhen.includes(label)) {
    tone = 'done';
    glyph = '✓';
  } else {
    tone = 'open';
    glyph = '○';
  }
  return h('span', { class: `status status--${tone}` },
    h('span', { class: 'status__glyph', 'aria-hidden': 'true', text: glyph }),
    label);
}

/** 期限のセル。日付の下に残り日数を出す。完了済みでも枠は残して行高を揃える。 */
export function dueCell(dueISO, dueText, { done = false, today = new Date() } = {}) {
  const rest = dueRest(dueISO, today);
  const cell = h('span', {}, dueText || fmtDate(dueISO) || '—');
  const restEl = h('span', { class: 'due__rest' });
  if (rest && !done) {
    restEl.textContent = rest.glyph ? `${rest.glyph} ${rest.text}` : rest.text;
  }
  return { nodes: [cell, restEl], tone: rest ? rest.tone : null };
}

/** 空状態。文言はここ 1 箇所だけで、複製しない。 */
export function emptyBlock({ title, body, actionLabel, onAction }) {
  return h('div', { class: 'empty' },
    title && h('p', { class: 'empty__title', text: title }),
    body && h('p', { class: 'empty__body', text: body }),
    actionLabel && h('button', {
      class: 'btn btn--secondary empty__reset', type: 'button', onclick: onAction
    }, actionLabel));
}

/** データ表。列見出しは押せば並べ替わる。
 *  columns: [{ key, label, className }]
 *  rows:    [{ id, selected, onOpen, cells: [{ label, value, className, tone }] }]
 */
export function dataTable({ columns, rows, sort, onSort, caption }) {
  const headCells = columns.map((c) => {
    const th = h('th', {
      scope: 'col',
      class: `table__th${c.className ? ` ${c.className}` : ''}`
    });
    if (sort && sort.key === c.key) {
      th.setAttribute('aria-sort', sort.dir === 'asc' ? 'ascending' : 'descending');
    }
    th.append(h('button', {
      class: 'sort-btn', type: 'button', dataset: { sort: c.key },
      onclick: () => onSort?.(c.key)
    }, c.label, h('span', { class: 'sort-btn__mark', 'aria-hidden': 'true' })));
    return th;
  });

  const body = h('tbody', { id: 'rows' }, rows.map((r) => {
    const tr = h('tr', {
      class: `row${r.selected ? ' is-selected' : ''}`,
      id: r.id != null ? `${r.idPrefix || 'row'}_${r.id}` : null,
      dataset: { id: r.id ?? '' }
    });
    r.cells.forEach((c, i) => {
      const td = h('td', {
        class: ['cell', i === 0 ? 'cell--title' : null, c.className,
          c.tone ? `due--${c.tone}` : null].filter(Boolean).join(' '),
        dataset: { label: c.label }
      });
      if (i === 0 && r.onOpen) {
        td.append(h('button', {
          class: 'row__open', type: 'button', dataset: { open: r.id ?? '' },
          onclick: () => r.onOpen(r.id)
        }, c.value));
      } else if (Array.isArray(c.value)) {
        td.append(...c.value);
      } else if (c.value instanceof Node) {
        td.append(c.value);
      } else {
        td.textContent = c.value ?? '';
      }
      tr.append(td);
    });
    return tr;
  }));

  return h('table', { class: 'table', id: 'table' },
    caption && h('caption', { class: 'sr-only', text: caption }),
    h('thead', {}, h('tr', {}, headCells)),
    body);
}

/** ラベルと値を縦に並べる定義リスト。詳細パネルとダッシュボードで使う。 */
export function metaList(entries) {
  return h('dl', { class: 'meta' }, entries.map(([key, value]) => h('div', { class: 'meta__row' },
    h('dt', { class: 'meta__key', text: key }),
    h('dd', { class: 'meta__val' }, value instanceof Node ? value : String(value ?? '—')))));
}

// ── トースト ────────────────────────────────────────
/* ビューポートの角に固定する。新しいのが来ても既存は動かさない。
   成功は祝わない。失敗と取り消せる操作にだけ出す。 */
export const toasts = {
  push(message, action) {
    const host = document.getElementById('toasts');
    if (!host) return;
    const box = h('div', { class: 'toast' },
      h('span', { class: 'toast__text', text: message }));
    if (action) {
      box.append(h('button', {
        class: 'toast__action', type: 'button',
        onclick: () => { action.run(); box.remove(); }
      }, action.label));
    }
    host.append(box);
    setTimeout(() => box.remove(), 10000);   // 取り消しの猶予は 10 秒
  }
};

// ── 詳細スライドオーバー ──────────────────────────────
/* Escape と背景クリックで閉じ、開いたら中へフォーカスし、
   閉じたら呼び出した要素へフォーカスを返す。裏側は inert にする。 */
export const panel = {
  _lastFocused: null,
  _onClose: null,

  get el() { return document.getElementById('panel'); },
  get scrim() { return document.getElementById('scrim'); },

  isOpen() { return this.el && !this.el.hidden; },

  open({ eyebrow, title, body, actions, onClose }) {
    this._lastFocused = document.activeElement;
    this._onClose = onClose || null;

    document.getElementById('panel-eyebrow').textContent = eyebrow || '';
    document.getElementById('panel-title').textContent = title || '';
    document.getElementById('panel-body').replaceChildren(...[body].flat().filter(Boolean));
    document.getElementById('panel-foot').replaceChildren(...(actions || []));

    this.el.hidden = false;
    this.scrim.hidden = false;
    document.getElementById('app').inert = true;

    const first = this.el.querySelector(
      '.panel__body textarea:not([readonly]), .panel__body input:not([readonly]),'
      + ' .panel__foot a, .panel__foot button');
    (first || document.getElementById('panel-close')).focus();
  },

  /** 開いたまま中身だけ差し替える（詳細の遅延読み込み用）。 */
  update({ title, body, actions } = {}) {
    if (!this.isOpen()) return;
    if (title != null) document.getElementById('panel-title').textContent = title;
    if (body != null) {
      document.getElementById('panel-body').replaceChildren(...[body].flat().filter(Boolean));
    }
    if (actions != null) {
      document.getElementById('panel-foot').replaceChildren(...(actions || []));
    }
  },

  /** 画面遷移で閉じるときは silent。開いていた画面の onClose が
   *  遷移後の URL に古いクエリを書き戻してしまうため。 */
  close({ silent = false } = {}) {
    if (!this.isOpen()) return;
    this.el.hidden = true;
    this.scrim.hidden = true;
    document.getElementById('app').inert = false;

    const onClose = this._onClose;
    this._onClose = null;
    if (silent) return;

    const back = onClose?.();
    (back || this._lastFocused)?.focus?.();
  }
};

/** パネルの閉じる操作をひとまとめに束ねる。呼び出しは 1 回で足りる。 */
export function wirePanel() {
  document.getElementById('panel-close').addEventListener('click', () => panel.close());
  document.getElementById('scrim').addEventListener('click', () => panel.close());
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') panel.close();
  });
}
