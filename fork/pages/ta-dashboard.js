/* TA ダッシュボード。
 *
 * 元アプリの `/ta` は「調整中」だけ。学生ダッシュボードと同様、
 * 他の TA 画面から取れる件数だけを並べる（無い数字は作らない）。
 */

import { api } from '../api.js';
import {
  demoTaDashboard, demoTaOrders, demoTaReports, demoTaTeams, demoTaUsers
} from '../demo.js';
import { h, statusPill } from '../ui.js';

export const meta = {
  route: '/ta',
  nav: 'TAホーム',
  title: 'TAダッシュボード',
  mode: 'ta'
};

const LINKS = [
  ['/ta/orders', '注文'],
  ['/ta/reports', '週報'],
  ['/ta/teams', 'チーム'],
  ['/ta/users', 'ユーザー']
];

const OPEN = new Set(['保留中', '注文済み', '受取可能', '未完了', '期限切れ']);

async function settle(promise) {
  try {
    return await promise;
  } catch {
    return null;
  }
}

export async function load(ctx, opts = {}) {
  const dashP = ctx.demo ? demoTaDashboard(opts) : api.taDashboard(opts);
  const restP = Promise.all([
    settle(ctx.demo ? demoTaOrders(opts) : api.taOrders(opts)),
    settle(ctx.demo ? demoTaReports(opts) : api.taReports(opts)),
    settle(ctx.demo ? demoTaTeams(opts) : api.taTeams(opts)),
    settle(ctx.demo ? demoTaUsers(opts) : api.taUsers(opts))
  ]);
  const dash = await dashP;
  const [orders, reports, teams, users] = await restP;
  return { ...dash, orders, reports, teams, users };
}

export function render(data, ctx) {
  const notice = data.notice || '';
  const orders = Array.isArray(data.orders?.orders) ? data.orders.orders : null;
  const reports = Array.isArray(data.reports?.reports) ? data.reports.reports : null;
  const teams = Array.isArray(data.teams?.teams) ? data.teams.teams : null;
  const users = Array.isArray(data.users?.users) ? data.users.users : null;

  const openOrders = (orders || []).filter((o) => OPEN.has(o.status));
  const openReports = (reports || []).filter((r) => OPEN.has(r.status));

  return h('div', { class: 'board' },
    h('header', { class: 'page-head' },
      h('div', {},
        h('h1', { class: 'page-head__title', text: data.heading || meta.title }))),
    h('div', { class: 'board__layout' },
      h('div', { class: 'board__main' },
        openOrders.length
          ? h('section', { class: 'board__focus', 'aria-label': '進行中の注文' },
            h('p', { class: 'board__kicker', text: '進行中の注文' }),
            h('div', { class: 'itemlist' }, openOrders.slice(0, 6).map((o) => h('button', {
              class: 'item item--button', type: 'button',
              onclick: () => ctx.navigate(
                `/ta/orders?order_id=${encodeURIComponent(o.id)}`
              )
            },
            h('span', { class: 'item__title', text: o.product || '注文' }),
            h('span', { class: 'item__meta' },
              [o.team, o.status].filter(Boolean).join(' · ') || statusPill(o.status))))))
          : h('section', { class: 'board__focus', 'aria-label': '進行中の注文' },
            h('p', { class: 'board__kicker', text: '進行中の注文' }),
            h('p', {
              class: 'board__empty',
              text: orders ? '進行中の注文はありません' : '注文を読み込めませんでした'
            }),
            h('button', {
              class: 'btn btn--secondary', type: 'button',
              onclick: () => ctx.navigate('/ta/orders')
            }, '注文一覧')),
        openReports.length
          ? h('section', { class: 'board__section' },
            h('div', { class: 'section__head' },
              h('h2', { class: 'section__title', text: '未完了の週報' }),
              h('p', { class: 'section__count', text: `${openReports.length} 件` })),
            h('div', { class: 'itemlist' }, openReports.slice(0, 4).map((r) => h('button', {
              class: 'item item--button', type: 'button',
              onclick: () => ctx.navigate('/ta/reports')
            },
            h('span', { class: 'item__title', text: r.title || '週報' }),
            h('span', {
              class: 'item__meta',
              text: [r.team, r.status].filter(Boolean).join(' · ')
            })))))
          : null),
      h('aside', { class: 'board__tally', 'aria-label': '件数' },
        [
          orders ? ['注文（進行中）', openOrders.length, '/ta/orders'] : null,
          orders ? ['注文（全件）', orders.length, '/ta/orders'] : null,
          reports ? ['週報（未完了）', openReports.length, '/ta/reports'] : null,
          teams ? ['チーム', teams.length, '/ta/teams'] : null,
          users ? ['ユーザー', users.length, '/ta/users'] : null
        ].filter(Boolean).map(([label, value, route]) => h('button', {
          class: 'board__tally-item', type: 'button',
          onclick: () => ctx.navigate(route)
        },
        h('span', { class: 'board__tally-label', text: label }),
        h('span', { class: 'board__tally-value', text: String(value) }))))),
    notice ? h('p', { class: 'notice', id: 'origin-notice' },
      h('span', { class: 'notice__glyph', 'aria-hidden': 'true', text: '…' }),
      `${notice} · 元アプリの TA ダッシュボードはこの 1 行だけなので、`
        + '注文・週報・チーム・ユーザーからこの画面を組んでいます') : null,
    h('nav', { class: 'board__index', 'aria-label': 'TAの他の画面' },
      LINKS.map(([route, label]) => h('button', {
        class: 'board__index-link', type: 'button',
        onclick: () => ctx.navigate(route)
      }, label))),
    h('p', {
      class: 'disclaimer',
      text: ctx.demo
        ? 'これは UI 改善の検証用のフォークです。表示しているデータはダミーです。'
        : 'これは UI 改善の検証用のフォークです。元アプリの TA ダッシュボードに'
          + '集計は無いので、数字は他の TA 画面から読んだものだけを出しています。'
    }));
}
