/* 旧 /local-reports のリダイレクト。
 *
 * 下書きは /reports?tab=local に統合した。ブックマーク・共有リンクのため
 * このルートは残し、クエリを引き継いで転送する。
 */

import { LOCAL_STATUSES } from '../report-local.js';
import { h } from '../ui.js';

export const meta = {
  route: '/local-reports',
  nav: '週報',
  title: '週報'
};

export async function load() {
  return { source: 'local', fetchedAt: new Date().toISOString() };
}

export function render(_data, ctx) {
  const from = new URLSearchParams(location.search);
  const to = new URLSearchParams();
  to.set('tab', 'local');
  // 旧パラメータを引き継ぐ（新形式 lq/lstatus/lsort へ）
  const q = from.get('q');
  if (q) to.set('lq', q);
  const st = from.get('status');
  if (LOCAL_STATUSES.includes(st)) to.set('lstatus', st);
  const sortBy = from.get('sort_by');
  const sortDir = from.get('sort_direction') === 'asc' ? 'asc' : 'desc';
  if (sortBy === 'updatedAt' || sortBy === 'title') to.set('lsort', `${sortBy}:${sortDir}`);
  const id = from.get('local_id');
  if (id) to.set('local_id', id);
  if (ctx.demo) to.set('demo', '1');
  queueMicrotask(() => ctx.navigate(`/reports?${to}`, { replace: true }));
  return h('p', { class: 'loading', text: '週報へ移動中…' });
}
