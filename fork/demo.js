/* デモ用のダミーデータ。
 *
 * 通常は Worker の `/api/*` から元アプリの実データを取る。これはログインせずに
 * 画面の作りを見るとき（`?demo=1`）と、`/api/*` が無い静的配信のときの代わり。
 *
 * 形は API の応答に合わせる。画面側が 1 本の描画経路で済むようにするため。
 * 語彙は元アプリで確認できた範囲だけを使う（`../clone/NOTES.md`）。
 *
 * キャッシュ戦略（SWR・裏更新・先読み）もデモで触れるよう、短い遅延と
 * 鮮度帯で Worker 側と同じ `source` / `revalidating` を返す。
 */

export const DEMO_TODAY = '2026-08-05';
export const DEMO_USER = {
  name: '三谷 慧介',
  badge: 'U',
  mode: 'student',
  canSwitch: true,
  canTa: true
};
export const DEMO_TA_USER = {
  name: '三谷 慧介',
  badge: 'TAモード',
  mode: 'ta',
  canSwitch: true,
  canTa: true
};

/** デモ用。本番（45s）より短くし、キャッシュ→裏更新をすぐ確認できるようにする。 */
export const DEMO_FRESH_MS = 8_000;
/** 初回ミス / refresh 時の「元アプリが遅い」感。 */
export const DEMO_ORIGIN_MS = 700;

const YEAR = '2026';
const iso = (s) => s;
const md = (v) => v.replace('-', '/');

const entries = new Map();
const generations = new Map();

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function resetDemoCache() {
  entries.clear();
  generations.clear();
}

function nextGeneration(key) {
  const n = (generations.get(key) || 0) + 1;
  generations.set(key, n);
  return n;
}

/**
 * Worker の page-cache と同じ見え方にする。
 * - 未取得: 古いキャッシュを即返し + revalidating（裏更新デモ）
 * - 新しい: source=cache
 * - 鮮度切れ: revalidating
 * - refresh: 遅延のあと live（世代を進めて差分を見えるようにする）
 */
async function cached(key, build, opts = {}) {
  if (opts.refresh) {
    await sleep(DEMO_ORIGIN_MS);
    const generation = nextGeneration(key);
    const payload = build({ generation });
    const fetchedAt = new Date().toISOString();
    entries.set(key, { payload, at: Date.now(), fetchedAt, generation });
    return { source: 'live', fetchedAt, ...payload };
  }

  let entry = entries.get(key);
  if (!entry) {
    const generation = nextGeneration(key);
    const payload = build({ generation });
    const fetchedAt = new Date(Date.now() - 60_000).toISOString();
    entry = { payload, at: Date.now() - DEMO_FRESH_MS - 1_000, fetchedAt, generation };
    entries.set(key, entry);
    return { source: 'cache', fetchedAt, revalidating: true, ...payload };
  }

  const age = Date.now() - entry.at;
  if (age < DEMO_FRESH_MS) {
    return { source: 'cache', fetchedAt: entry.fetchedAt, ...entry.payload };
  }

  return {
    source: 'cache',
    fetchedAt: entry.fetchedAt,
    revalidating: true,
    ...entry.payload
  };
}

// ── 週報 ───────────────────────────────────────────
const REPORT_SEED = [
  [102, '第2週 週報', '05-04', '05-10', '05-13', '05-06', '完了',
    '旋盤の基本操作を確認。端面削りと外径削りを一通り試し、切削条件をノートにまとめた。\n来週は突切りに入る。'],
  [103, '第3週 週報', '05-11', '05-17', '05-20', '05-12', '完了',
    '突切りで刃物が食い込む症状が出たので、送り速度を落として再試行。\n刃物台の剛性不足が原因と判断し、締結を見直した。'],
  [104, '第4週 週報', '05-18', '05-24', '05-27', '05-20', '完了',
    'フライス盤の段取りを担当。バイスの平行出しに時間がかかったので、手順を書き出して次回に備える。'],
  [105, '第5週 週報', '05-25', '05-31', '06-03', '05-27', '完了',
    '図面のはめあい公差を読み違えて再加工が発生した。指示記号の一覧を手元に置くことにした。'],
  [106, '第6週 週報', '06-01', '06-07', '06-10', '06-02', '完了',
    '治具の設計を開始。位置決めをピン 2 本で行う方針にして、担当と方式をすり合わせた。'],
  [107, '第7週 週報', '06-08', '06-14', '06-17', '06-10', '完了',
    '治具の部品を発注。納期が読めない部品があり、代替品の候補も併せて出した。'],
  [108, '第8週 週報', '06-15', '06-21', '06-24', '06-16', '完了',
    '溶接の練習。ビードが蛇行するので、運棒の速度を一定に保つ練習に時間を割いた。'],
  [109, '第9週 週報', '06-22', '06-28', '07-01', '06-24', '完了',
    '治具の仮組み。ピン穴の位置がわずかにずれていたため、リーマで修正した。'],
  [110, '第10週 週報', '06-29', '07-05', '07-08', '06-30', '完了',
    '治具を使って本加工。段取り替えの時間が短くなり、狙いどおりの効果を確認できた。'],
  [111, '第11週 週報', '07-06', '07-12', '07-15', '07-08', '完了',
    '検査工程を担当。マイクロメータの読み取りを 3 回平均に統一し、記録用紙を作り直した。'],
  [112, '第12週 週報', '07-13', '07-19', '07-22', '07-14', '未完了',
    '中間発表の資料づくりに入った。加工手順の写真がまだ足りない。'],
  [113, '第13週 週報', '07-20', '07-26', '07-29', '07-21', '未完了',
    '中間発表。質疑で治具の位置決め精度を聞かれ、根拠となる測定データが手元に無かった。', '岸 洋輔'],
  [114, '第14週 週報', '07-27', '08-02', '08-05', '07-28', '未完了',
    '位置決め精度の測定をやり直し中。'],
  [115, '第15週 週報', '08-03', '08-09', '08-12', '08-03', '未完了', '']
];

function buildReports() {
  const reports = REPORT_SEED.map(([id, title, from, to, due, created, status, body, lockedBy]) => ({
    id,
    title,
    period: `${md(from)} – ${md(to)}`,
    status,
    due: `${YEAR}/${md(due)}`,
    createdAt: `${YEAR}/${md(created)}`,
    dueISO: iso(`${YEAR}-${due}`),
    createdAtISO: iso(`${YEAR}-${created}`),
    periodStartISO: iso(`${YEAR}-${from}`),
    periodEndISO: iso(`${YEAR}-${to}`),
    body,
    lockedBy: lockedBy || null,
    fields: [{
      name: 'content',
      label: '本文',
      value: body || '',
      lockedBy: lockedBy || null
    }],
    meta: [
      { label: '期間', value: `${md(from)} – ${md(to)}` },
      { label: 'ステータス', value: status },
      { label: '期限', value: `${YEAR}/${md(due)}` },
      { label: '作成日', value: `${YEAR}/${md(created)}` }
    ],
    timeline: []
  }));

  return {
    columns: [
      { label: 'タイトル' }, { label: '期間' }, { label: 'ステータス' },
      { label: '期限' }, { label: '作成日' }
    ],
    counts: {
      未完了: reports.filter((r) => r.status === '未完了').length,
      完了: reports.filter((r) => r.status === '完了').length,
      合計: reports.length
    },
    empty: {
      title: '週報がありません',
      body: '管理者によって新しいレポートの締め切りが設定されると、ここにレポートが表示されます。'
    },
    reports
  };
}

export function demoReports(opts = {}) {
  return cached('reports', buildReports, opts);
}

export async function demoReport(id, opts = {}) {
  const data = await demoReports(opts);
  const r = (data.reports || []).find((x) => String(x.id) === String(id));
  if (!r) throw new Error('週報が見つかりません');
  return {
    source: data.source,
    fetchedAt: data.fetchedAt,
    origin: `/reports/${r.id}`,
    id: r.id,
    title: r.title,
    meta: r.meta || [],
    fields: r.fields || [],
    timeline: r.timeline || [],
    body: r.body || '',
    lockedBy: r.lockedBy || null
  };
}

// ── ダッシュボード ──────────────────────────────────
function buildDashboard({ generation = 1 } = {}) {
  return {
    heading: 'ダッシュボード',
    team: 'チーム: 10(未定)',
    // 再取得のたびに文言が変わり、ライブ更新が見える
    notice: generation <= 1 ? '調整中' : `調整中 · デモ再取得 #${generation}`
  };
}

export function demoDashboard(opts = {}) {
  return cached('dashboard', buildDashboard, opts);
}

// ── 注文 ───────────────────────────────────────────
// 元アプリの現行ステータス: 保留中 / 注文済み / 受取可能 / 受取済み / キャンセル済み
const ORDER_SEED = [
  [21, 'アルミ丸棒 φ20 1m', 1480, 4, '08-01', '受取済み'],
  [22, '超硬バイト 12mm', 3280, 2, '07-28', '受取済み'],
  [23, 'ノギス 150mm', 5600, 1, '07-24', '注文済み'],
  [24, 'M4 六角穴付ボルト 100本', 980, 3, '07-20', '保留中'],
  [25, '位置決めピン φ6 h7', 220, 12, '07-16', '受取可能'],
  [26, '切削油 1L', 1750, 2, '07-10', 'キャンセル済み']
];

function buildOrders({ generation = 1 } = {}) {
  const orders = ORDER_SEED.map(([id, product, unitPrice, quantity, created, status]) => ({
    id,
    product,
    unitPrice: `¥${unitPrice.toLocaleString('ja-JP')}`,
    quantity: String(quantity),
    total: `¥${(unitPrice * quantity).toLocaleString('ja-JP')}`,
    status,
    createdAt: `${YEAR}/${md(created)}`,
    createdAtISO: iso(`${YEAR}-${created}`),
    unitPriceValue: unitPrice,
    quantityValue: quantity,
    totalValue: unitPrice * quantity
  }));

  return {
    columns: [
      { label: '商品' }, { label: '単価' }, { label: '数量' },
      { label: '合計' }, { label: 'ステータス' }, { label: '作成日' }
    ],
    empty: {
      title: '注文がありません',
      body: generation <= 1
        ? '新しい注文を作成して始めましょう。'
        : `新しい注文を作成して始めましょう。（デモ再取得 #${generation}）`
    },
    orders
  };
}

export function demoOrders(opts = {}) {
  return cached('orders', buildOrders, opts);
}

export async function demoOrder(id, opts = {}) {
  const data = await demoOrders(opts);
  const o = (data.orders || []).find((x) => String(x.id) === String(id));
  if (!o) throw new Error('注文が見つかりません');
  return {
    source: data.source,
    fetchedAt: data.fetchedAt,
    id: o.id,
    product: o.product,
    status: o.status,
    unitPrice: o.unitPrice,
    quantity: o.quantity,
    total: o.total,
    createdAt: o.createdAt,
    history: [
      { title: '注文作成', detail: o.createdAt || null }
    ]
  };
}

// ── 機材 ───────────────────────────────────────────
function buildEquipments({ generation = 1 } = {}) {
  return {
    heading: '利用可能な機材',
    lede: generation <= 1
      ? '貸出申請可能な機材一覧'
      : `貸出申請可能な機材一覧（デモ再取得 #${generation}）`,
    empty: { text: '現在利用可能な機材はありません。' },
    equipments: [
      { id: 3, name: 'デジタルノギス 150mm', meta: '計測 · 在庫 2', action: null },
      { id: 5, name: 'トルクレンチ 5–25N·m', meta: '工具 · 在庫 1', action: null },
      { id: 8, name: '卓上ボール盤', meta: '加工 · 在庫 1', action: null },
      { id: 11, name: '熱電対データロガー', meta: '計測 · 在庫 3', action: null }
    ]
  };
}

export function demoEquipments(opts = {}) {
  return cached('equipments', buildEquipments, opts);
}

// ── 貸出 ───────────────────────────────────────────
function buildLoans({ generation = 1 } = {}) {
  return {
    heading: '機材貸出',
    lede: generation <= 1
      ? 'チームの現在と過去の機材貸出を確認できます'
      : `チームの現在と過去の機材貸出を確認できます（デモ再取得 #${generation}）`,
    sections: [
      {
        key: 'pending',
        title: '申請中',
        empty: '申請中の貸出はありません。',
        items: [{ id: 41, name: 'トルクレンチ 5–25N·m', meta: '08/04 申請 · 承認待ち' }]
      },
      {
        key: 'active',
        title: '貸出中',
        empty: 'アクティブな貸出はありません。',
        items: [
          { id: 38, name: 'デジタルノギス 150mm', meta: '07/29 から · 返却予定 08/12' },
          { id: 36, name: '熱電対データロガー', meta: '07/22 から · 返却予定 08/19' }
        ]
      }
    ]
  };
}

export function demoLoans(opts = {}) {
  return cached('loans', buildLoans, opts);
}

// ── 通知 ───────────────────────────────────────────
function buildNotifications({ generation = 1 } = {}) {
  return {
    heading: '通知',
    unreadText: generation <= 1 ? '未読 2 件' : `未読 2 件 · デモ再取得 #${generation}`,
    empty: { title: '通知はありません', body: '新しい通知が届くとここに表示されます。' },
    notifications: [
      {
        id: 91, title: '第14週 週報の期限が近づいています',
        body: '期限は 2026/08/05 です。', at: `${YEAR}/08/04`,
        atISO: `${YEAR}-08-04`, read: false
      },
      {
        id: 90, title: '「トルクレンチ 5–25N·m」の貸出申請を受け付けました',
        body: '担当者の承認をお待ちください。', at: `${YEAR}/08/04`,
        atISO: `${YEAR}-08-04`, read: false
      },
      {
        id: 88, title: '注文「ノギス 150mm」が完了しました',
        body: '受け取り場所は実習棟 2F です。', at: `${YEAR}/07/26`,
        atISO: `${YEAR}-07-26`, read: true
      }
    ]
  };
}

export function demoNotifications(opts = {}) {
  return cached('notifications', buildNotifications, opts);
}

/** バッジ用。キャッシュを通さず件数だけ返す。 */
export function demoUnreadCount() {
  return {
    count: buildNotifications().notifications.filter((n) => n.read === false).length
  };
}

// ── TA ─────────────────────────────────────────────
const TA_ORDER_SEED = [
  ['a1111111-1111-4111-8111-111111111111', 'SN74LVC1G04DCKR', '02: うめおにぎり', 20, 2, '08-01', '注文済み'],
  ['a2222222-2222-4222-8222-222222222222', 'アルミ丸棒 φ20', '01: RYKT', 1480, 4, '07-28', '受取可能'],
  ['a3333333-3333-4333-8333-333333333333', 'ノギス 150mm', '03: (未定)', 5600, 1, '07-24', '保留中'],
  ['a4444444-4444-4444-8444-444444444444', '切削油 1L', '02: うめおにぎり', 1750, 2, '07-10', '受取済み'],
  ['a5555555-5555-4555-8555-555555555555', 'M4 ボルト 100本', '01: RYKT', 980, 3, '07-20', 'キャンセル済み']
];

function buildTaOrders({ generation = 1 } = {}) {
  const orders = TA_ORDER_SEED.map(([id, product, team, unitPrice, quantity, created, status]) => ({
    id,
    product,
    team,
    unitPrice: `¥${unitPrice.toLocaleString('ja-JP')}`,
    quantity: `${quantity}個`,
    total: `¥${(unitPrice * quantity).toLocaleString('ja-JP')}`,
    status,
    createdAt: `${YEAR}/${md(created)}`,
    createdAtISO: iso(`${YEAR}-${created}`),
    unitPriceValue: unitPrice,
    quantityValue: quantity,
    totalValue: unitPrice * quantity
  }));
  return {
    heading: '注文管理',
    columns: [
      { label: '商品' }, { label: 'チーム' }, { label: '単価' }, { label: '数量' },
      { label: '合計' }, { label: 'ステータス' }, { label: '作成日時' }, { label: '操作' }
    ],
    empty: {
      title: '注文がありません',
      body: generation <= 1 ? '' : `（デモ再取得 #${generation}）`
    },
    filters: {
      status: [
        { value: '', label: 'すべて' },
        { value: 'pending', label: '保留中' },
        { value: 'ordered', label: '注文済み' },
        { value: 'available', label: '受取可能' },
        { value: 'received', label: '受取済み' },
        { value: 'cancelled', label: 'キャンセル済み' }
      ],
      team: [
        { value: '', label: 'すべて' },
        { value: 't1', label: '01: RYKT' },
        { value: 't2', label: '02: うめおにぎり' },
        { value: 't3', label: '03: (未定)' }
      ],
      quantity: []
    },
    orders
  };
}

export function demoTaOrders(opts = {}) {
  return cached('ta-orders', buildTaOrders, opts);
}

export async function demoTaOrder(id, opts = {}) {
  const data = await demoTaOrders(opts);
  const o = (data.orders || []).find((x) => String(x.id) === String(id));
  if (!o) throw new Error('注文が見つかりません');
  return {
    source: data.source,
    fetchedAt: data.fetchedAt,
    id: o.id,
    product: o.product,
    status: o.status,
    team: o.team,
    total: o.total,
    totalValue: o.totalValue,
    teamBudget: '¥12,400',
    fields: {
      単価: o.unitPrice,
      数量: o.quantity,
      ショップ名: 'デモショップ',
      型番: o.product,
      商品URL: ''
    },
    history: [
      { title: '注文作成', detail: o.createdAt || null }
    ],
    editHref: `/ta/orders/${o.id}/edit`
  };
}

function buildTaDashboard({ generation = 1 } = {}) {
  return {
    heading: 'TAダッシュボード',
    team: null,
    notice: generation <= 1 ? '調整中' : `調整中 · デモ再取得 #${generation}`
  };
}

export function demoTaDashboard(opts = {}) {
  return cached('ta-dashboard', buildTaDashboard, opts);
}

const TA_SUB_ID = 'b1111111-1111-4111-8111-111111111111';

function buildTaReports({ generation = 1 } = {}) {
  return {
    heading: '週報一覧',
    columns: [
      { label: 'チーム' }, { label: 'タイトル' }, { label: '期間' },
      { label: 'ステータス' }, { label: '期限' }
    ],
    empty: null,
    filters: {
      team: [
        { value: '', label: 'すべてのチーム' },
        { value: 't1', label: '01: RYKT' },
        { value: 't2', label: '02: うめおにぎり' }
      ]
    },
    submissions: [
      {
        id: TA_SUB_ID,
        label: '08/05 17:00 · 12/39 完了',
        when: '08/05 17:00',
        progress: '12/39 完了',
        overdue: false,
        selected: true
      }
    ],
    reports: [
      {
        id: 'c1111111-1111-4111-8111-111111111111',
        team: '01: RYKT',
        title: '第15週 週報',
        period: '08/03 – 08/09',
        status: '未完了',
        due: `${YEAR}/08/05`,
        dueISO: `${YEAR}-08-05`
      },
      {
        id: 'c2222222-2222-4222-8222-222222222222',
        team: '02: うめおにぎり',
        title: '第15週 週報',
        period: '08/03 – 08/09',
        status: '完了',
        due: `${YEAR}/08/05`,
        dueISO: `${YEAR}-08-05`
      },
      {
        id: 'c3333333-3333-4333-8333-333333333333',
        team: '03: (未定)',
        title: '第14週 週報',
        period: '07/27 – 08/02',
        status: '期限切れ',
        due: `${YEAR}/08/01`,
        dueISO: `${YEAR}-08-01`
      }
    ].map((r) => (generation > 1 ? { ...r, title: `${r.title} · #${generation}` } : r))
  };
}

export function demoTaReports(opts = {}) {
  return cached(`ta-reports:${opts.submissionId || 'all'}`, buildTaReports, opts);
}

/** デモの TA 週報詳細。本文は一覧の行に足すだけの見本。 */
export async function demoTaReport(id, opts = {}) {
  const data = await demoTaReports(opts);
  const r = (data.reports || []).find((x) => String(x.id) === String(id));
  if (!r) throw new Error('週報が見つかりません');
  return {
    source: data.source,
    fetchedAt: data.fetchedAt,
    id: r.id,
    title: r.title,
    status: r.status,
    team: r.team,
    due: r.due,
    period: r.period,
    overdue: r.status === '期限切れ',
    fields: {
      提出期限: r.due || '—',
      作業期間: r.period || '—',
      概要: `${r.title}の概要（デモ）`,
      進捗: 'デモの進捗',
      課題: 'デモの課題',
      計画: 'デモの計画'
    },
    updatedAt: r.due || null
  };
}

function buildTaTeams() {
  return {
    heading: 'チーム管理',
    empty: null,
    teams: [
      {
        id: 'd1111111-1111-4111-8111-111111111111',
        name: '01: RYKT', members: '5 人', spend: '¥838',
        pendingInvites: 'なし', spendValue: 838
      },
      {
        id: 'd2222222-2222-4222-8222-222222222222',
        name: '02: うめおにぎり', members: '4 人', spend: '¥74,507',
        pendingInvites: 'なし', spendValue: 74507
      },
      {
        id: 'd3333333-3333-4333-8333-333333333333',
        name: '03: (未定)', members: '2 人', spend: '¥0',
        pendingInvites: '1', spendValue: 0
      }
    ]
  };
}

export function demoTaTeams(opts = {}) {
  return cached('ta-teams', buildTaTeams, opts);
}

function buildTaUsers() {
  return {
    heading: 'ユーザー一覧 (TA)',
    empty: null,
    filters: {
      status: [
        { value: '', label: 'すべて' },
        { value: 'active', label: '有効' },
        { value: 'inactive', label: '無効' }
      ]
    },
    users: [
      {
        id: 'e1111111-1111-4111-8111-111111111111',
        name: '山田 太郎', email: 's25001@tokyo.kosen-ac.jp',
        team: '01: RYKT', status: '有効'
      },
      {
        id: 'e2222222-2222-4222-8222-222222222222',
        name: '佐藤 花子', email: 's25002@tokyo.kosen-ac.jp',
        team: '02: うめおにぎり', status: '有効'
      },
      {
        id: 'e3333333-3333-4333-8333-333333333333',
        name: '鈴木 次郎', email: 's25003@tokyo.kosen-ac.jp',
        team: '未割当', status: '無効'
      }
    ]
  };
}

export function demoTaUsers(opts = {}) {
  return cached('ta-users', buildTaUsers, opts);
}
