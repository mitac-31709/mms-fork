/* 通知。
 *
 * 元アプリは 1 列のリストで、未読数の表示枠は空のこともある。
 * 既読・未読が判別できるのは値が真偽値のときだけで、
 * null は「わからない」なので、未読の印も状態の文字も断定しない。
 *
 * 既読にする口は元アプリの
 * `PATCH /notifications/:id/mark_as_read` と
 * `PATCH /notifications/mark_all_as_read`。Worker が中継する。
 *
 * 画面上部に届け先（ブラウザ / Discord）の入口を置く。初回だけ開いて
 * 機能を見せ、閉じる／保存後は折りたたむ（どちらもオフのままでも可）。
 */

import { api } from '../api.js';
import { demoNotifications } from '../demo.js';
import { fmtDate } from '../format.js';
import { renderNotifySettings } from '../notify-settings.js';
import { emptyBlock, h, metaList, panel, toasts } from '../ui.js';

export const meta = { route: '/notifications', nav: '通知', title: '通知' };

export async function load(ctx, opts = {}) {
  return ctx.demo ? demoNotifications(opts) : api.notifications(opts);
}

export function render(data, ctx) {
  const items = (data.notifications || []).map(normalize);
  const unread = typeof data.unreadText === 'string' ? data.unreadText.trim() : '';
  const empty = data.empty || {};
  // 既読かどうか不明でも id があれば既読化を試せる（元が no-op でも害は無い）。
  const canMarkAny = items.some((n) => n.id != null && n.read !== true);

  const listHost = h('div', {});

  const page = h('div', {},
    h('header', { class: 'page-head' },
      h('div', {},
        h('h1', { class: 'page-head__title', text: data.heading || meta.title }),
        unread ? h('p', { class: 'page-head__lede', text: unread }) : null),
      canMarkAny
        ? h('button', {
          class: 'btn btn--secondary', type: 'button', id: 'mark-all-read',
          onclick: () => markAll()
        }, 'すべて既読')
        : null),
    ctx?.watcher
      ? renderNotifySettings({ watcher: ctx.watcher, isDemo: ctx.demo })
      : null,
    listHost);

  paint();
  return page;

  function paint() {
    listHost.replaceChildren(
      h('section', { class: 'notify-list', 'aria-label': '通知一覧' },
        items.length
          ? h('div', { class: 'itemlist' }, items.map(row))
          : emptyBlock({
            title: empty.title || '通知はありません',
            body: empty.body || '新しい通知が届くとここに表示されます。'
          }))
    );
    const markAllBtn = page.querySelector('#mark-all-read');
    if (markAllBtn) {
      const still = items.some((n) => n.id != null && n.read !== true);
      markAllBtn.hidden = !still;
    }
  }

  function normalize(n) {
    return {
      id: n.id,
      title: n.title || '',
      body: n.body || '',
      atText: n.at || fmtDate(n.atISO),
      // 真偽値のときだけ既読・未読を語る。null は元 HTML から読み取れなかった印。
      read: typeof n.read === 'boolean' ? n.read : null
    };
  }

  function row(n) {
    return h('button', {
      class: `item item--button${n.read === false ? ' item--unread' : ''}`,
      type: 'button',
      id: n.id != null ? `notification_${n.id}` : null,
      onclick: () => openDetail(n)
    },
    h('span', { class: 'item__title', text: n.title }),
    n.atText ? h('span', { class: 'item__meta', text: n.atText }) : null,
    n.body ? h('span', { class: 'item__body', text: n.body }) : null);
  }

  function openDetail(n) {
    const actions = [];
    if (n.id != null && n.read !== true) {
      actions.push(h('button', {
        class: 'btn btn--primary', type: 'button', id: 'panel-mark-read',
        onclick: () => markOne(n)
      }, '既読にする'));
    }
    actions.push(h('button', {
      class: 'btn btn--secondary', type: 'button', id: 'panel-cancel',
      onclick: () => panel.close()
    }, '閉じる'));

    panel.open({
      eyebrow: '通知',
      title: n.title,
      body: [
        metaList([
          ['日時', n.atText || '—'],
          ['状態', n.read == null ? '—' : (n.read ? '既読' : '未読')]
        ]),
        n.body ? h('p', { class: 'item__body', text: n.body }) : null
      ],
      actions
    });
  }

  async function markOne(n) {
    const btn = document.getElementById('panel-mark-read');
    if (btn) {
      btn.disabled = true;
      btn.dataset.state = 'loading';
      btn.textContent = '既読にしています…';
    }
    try {
      if (ctx.demo) {
        n.read = true;
        panel.close();
        paint();
        toasts.push('既読にしました（デモ）');
        return;
      }
      await api.markNotificationRead(n.id);
      n.read = true;
      panel.close();
      paint();
      toasts.push('既読にしました');
      ctx.invalidate?.(['/notifications']);
      // 未読バッジ用。一覧はローカルで既に更新済み。
      ctx.watcher?.tick?.();
    } catch (e) {
      toasts.push(e.message || '既読にできませんでした');
      if (btn) {
        btn.disabled = false;
        delete btn.dataset.state;
        btn.textContent = '既読にする';
      }
    }
  }

  async function markAll() {
    const btn = page.querySelector('#mark-all-read');
    if (btn) {
      btn.disabled = true;
      btn.dataset.state = 'loading';
      btn.textContent = '既読にしています…';
    }
    try {
      if (ctx.demo) {
        for (const n of items) n.read = true;
        paint();
        toasts.push('すべて既読にしました（デモ）');
        return;
      }
      await api.markAllNotificationsRead();
      for (const n of items) {
        if (n.read !== true) n.read = true;
      }
      paint();
      toasts.push('すべて既読にしました');
      ctx.invalidate?.(['/notifications']);
      ctx.watcher?.tick?.();
    } catch (e) {
      toasts.push(e.message || '一括既読にできませんでした');
    } finally {
      if (btn) {
        btn.disabled = false;
        delete btn.dataset.state;
        btn.textContent = 'すべて既読';
      }
    }
  }
}
