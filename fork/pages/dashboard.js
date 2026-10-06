/* ダッシュボード（フォーク独自）。
 *
 * Hallmark · pre-emit critique: P4 H4 E4 S4 R4 V4
 *
 * 元アプリの `/dashboard` は見出し・チーム名・「調整中」だけで中身が無い。
 * 数字を作ると嘘になるので、他画面から既に取れている件数と行だけを組む。
 * 取れなかった面は出さない（0 件と「不明」を混同しない）。
 *
 * レイアウトは左右非対称。左に「いま出すもの」（期限の近い未完了の週報）、
 * 右に件数の縦列。入口の一覧は末尾に下げ、ここをショートカット集にしない。
 */

import { api } from '../api.js';
import {
  DEMO_TODAY, demoDashboard, demoLoans, demoOrders, demoReports, demoUnreadCount
} from '../demo.js';
import { dueRest, fmtDate } from '../format.js';
import { h, statusPill } from '../ui.js';

export const meta = { route: '/dashboard', nav: 'ダッシュボード', title: 'ダッシュボード' };

const LINKS = [
  ['/reports', '週報'],
  ['/orders', '注文'],
  ['/equipments', '機材'],
  ['/loans', '貸出'],
  ['/notifications', '通知']
];

/** 進行中の注文。元アプリの現行語彙 + 旧「未完了」。 */
const OPEN_ORDER_STATUSES = new Set(['保留中', '注文済み', '受取可能', '未完了']);

function isOpenOrder(status) {
  return OPEN_ORDER_STATUSES.has(status);
}

async function settle(promise) {
  try {
    return await promise;
  } catch {
    return null;
  }
}

export async function load(ctx, opts = {}) {
  const dashP = ctx.demo ? demoDashboard(opts) : api.dashboard(opts);
  const restP = Promise.all([
    settle(ctx.demo ? demoReports(opts) : api.reports(opts)),
    settle(ctx.demo ? demoOrders(opts) : api.orders(opts)),
    settle(ctx.demo ? demoLoans(opts) : api.loans(opts)),
    settle(ctx.demo ? demoUnreadCount() : api.unreadCount())
  ]);
  const dash = await dashP;
  const [reports, orders, loans, unread] = await restP;
  return { ...dash, reports, orders, loans, unread };
}

export function render(data, ctx) {
  const today = ctx.demo ? new Date(`${DEMO_TODAY}T00:00:00`) : ctx.today;
  const team = data.team || '';
  const notice = data.notice || '';
  const reports = data.reports && Array.isArray(data.reports.reports)
    ? data.reports.reports : null;
  const orders = data.orders && Array.isArray(data.orders.orders)
    ? data.orders.orders : null;
  const loanSections = data.loans && Array.isArray(data.loans.sections)
    ? data.loans.sections : null;
  const unread = typeof data.unread?.count === 'number' ? data.unread.count : null;

  const openReports = (reports || [])
    .filter((r) => r && r.status === '未完了')
    .slice()
    .sort((a, b) => String(a.dueISO || a.due || '').localeCompare(String(b.dueISO || b.due || '')));
  const focus = openReports[0] || null;
  const rest = openReports.slice(1, 6);

  return h('div', { class: 'board' },
    h('header', { class: 'page-head' },
      h('div', {},
        h('h1', { class: 'page-head__title', text: data.heading || 'ダッシュボード' }),
        team ? h('p', { class: 'page-head__lede', text: team }) : null)),
    h('div', { class: 'board__layout' },
      h('div', { class: 'board__main' },
        reports ? focusBlock(focus, rest, today, ctx) : null,
        ordersList(orders, ctx),
        loanList(loanSections, ctx)),
      tallyColumn({
        reports: data.reports,
        openCount: reports ? openReports.length : null,
        orderOpen: orders
          ? orders.filter((o) => isOpenOrder(o.status)).length : null,
        orderTotal: orders ? orders.length : null,
        loanSections,
        unread,
        ctx
      })),
    notice ? h('p', { class: 'notice', id: 'origin-notice' },
      h('span', { class: 'notice__glyph', 'aria-hidden': 'true', text: '…' }),
      `${notice} · 元アプリのダッシュボードはこの 1 行だけなので、`
        + '週報・注文・貸出・通知からこの画面を組んでいます') : null,
    h('nav', { class: 'board__index', 'aria-label': '他の画面' },
      LINKS.map(([route, label]) => h('button', {
        class: 'board__index-link', type: 'button',
        onclick: () => ctx.navigate(route)
      }, label))),
    h('p', {
      class: 'disclaimer',
      text: ctx.demo
        ? 'これは UI 改善の検証用のフォークです。表示しているデータはダミーです。'
          + 'ダッシュボード本体に集計は無く、他画面のデモデータから件数と行を載せています。'
        : 'これは UI 改善の検証用のフォークです。元アプリのダッシュボードに'
          + '集計は無いので、数字は週報・注文・貸出・通知から読んだものだけを出しています。'
    }));
}

function go(ctx, path) {
  ctx.navigate(path);
}

function focusBlock(focus, rest, today, ctx) {
  if (!focus) {
    return h('section', { class: 'board__focus', 'aria-label': '週報' },
      h('p', { class: 'board__kicker', text: '週報' }),
      h('p', { class: 'board__empty', text: '未完了の週報はありません' }),
      h('button', {
        class: 'btn btn--secondary', type: 'button',
        onclick: () => go(ctx, '/reports')
      }, '週報一覧'));
  }

  const restInfo = dueRest(focus.dueISO, today);
  const dueLine = [
    focus.due || fmtDate(focus.dueISO) || null,
    restInfo ? `${restInfo.glyph ? `${restInfo.glyph} ` : ''}${restInfo.text}` : null
  ].filter(Boolean).join(' · ');

  return h('section', { class: 'board__focus', 'aria-label': '提出が近い週報' },
    h('p', { class: 'board__kicker', text: '提出が近い週報' }),
    h('h2', { class: 'board__title', text: focus.title || '週報' }),
    h('p', {
      class: `board__due${restInfo?.tone === 'over' ? ' board__due--over' : ''}`,
      text: dueLine || '期限なし'
    }),
    h('div', { class: 'board__actions' },
      h('button', {
        class: 'btn btn--primary', type: 'button',
        onclick: () => go(ctx, reportPath(focus.id))
      }, 'この週報を開く'),
      h('button', {
        class: 'btn btn--secondary', type: 'button',
        onclick: () => go(ctx, '/reports')
      }, '一覧')),
    rest.length
      ? h('div', { class: 'itemlist board__queue' }, rest.map((r) => {
        const info = dueRest(r.dueISO, today);
        return h('button', {
          class: 'item item--button', type: 'button',
          onclick: () => go(ctx, reportPath(r.id))
        },
        h('span', { class: 'item__title', text: r.title || '週報' }),
        h('span', { class: 'item__meta' },
          info
            ? `${info.glyph ? `${info.glyph} ` : ''}${info.text}`
            : (r.due || fmtDate(r.dueISO) || '')));
      }))
      : null);
}

function reportPath(id) {
  if (id == null || id === '') return '/reports';
  return `/reports?report_id=${encodeURIComponent(id)}`;
}

function ordersList(orders, ctx) {
  if (!orders) return null;
  const open = orders.filter((o) => isOpenOrder(o.status)).slice(0, 4);
  if (!open.length) return null;
  return h('section', { class: 'board__section' },
    h('div', { class: 'section__head' },
      h('h2', { class: 'section__title', text: '進行中の注文' }),
      h('p', { class: 'section__count', text: `${open.length} 件` })),
    h('div', { class: 'itemlist' }, open.map((o) => h('button', {
      class: 'item item--button', type: 'button',
      onclick: () => go(ctx, '/orders')
    },
    h('span', { class: 'item__title', text: o.product || '注文' }),
    h('span', { class: 'item__meta' }, statusPill(o.status))))));
}

function loanList(sections, ctx) {
  if (!sections) return null;
  const withItems = sections.filter((s) => Array.isArray(s.items) && s.items.length);
  if (!withItems.length) return null;
  return h('div', { class: 'board__loans' }, withItems.map((s) =>
    h('section', { class: 'board__section' },
      h('div', { class: 'section__head' },
        h('h2', { class: 'section__title', text: s.title || '貸出' }),
        h('p', { class: 'section__count', text: `${s.items.length} 件` })),
      h('div', { class: 'itemlist' }, s.items.slice(0, 4).map((item) => h('button', {
        class: 'item item--button', type: 'button',
        onclick: () => go(ctx, '/loans')
      },
      h('span', { class: 'item__title', text: item.name || '—' }),
      item.meta ? h('span', { class: 'item__meta', text: item.meta }) : null))))));
}

function tallyColumn({ reports, openCount, orderOpen, orderTotal, loanSections, unread, ctx }) {
  const rows = [];
  const counts = reports?.counts;
  if (counts && typeof counts.未完了 === 'number') {
    rows.push(tally('週報 未完了', counts.未完了, () => go(ctx, '/reports')));
  } else if (openCount != null) {
    rows.push(tally('週報 未完了', openCount, () => go(ctx, '/reports')));
  }
  if (typeof unread === 'number') {
    rows.push(tally('未読の通知', unread, () => go(ctx, '/notifications')));
  }
  if (orderOpen != null) {
    rows.push(tally('注文 進行中', orderOpen, () => go(ctx, '/orders')));
  } else if (orderTotal != null) {
    rows.push(tally('注文', orderTotal, () => go(ctx, '/orders')));
  }
  if (loanSections) {
    for (const s of loanSections) {
      const n = Array.isArray(s.items) ? s.items.length : 0;
      rows.push(tally(s.title || '貸出', n, () => go(ctx, '/loans')));
    }
  }
  if (!rows.length) return null;
  return h('aside', { class: 'board__tally', 'aria-label': '件数' }, rows);
}

function tally(label, value, onOpen) {
  return h('button', {
    class: 'board__tally-item', type: 'button', onclick: onOpen
  },
  h('span', { class: 'board__tally-label', text: label }),
  h('span', { class: 'board__tally-value', text: String(value) }));
}
