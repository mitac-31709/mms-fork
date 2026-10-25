/* 一覧の検索クエリ。
 *
 * 空白（または AND）でつないだ語はすべて含む。OR または | は、その両側の
 * まとまりのどれかが含まれればよい。OR の片側に語が複数あれば、その側は AND。
 * "…" と 「…」 は空白を含む語句。大文字小文字は区別しない。
 *
 * 演算子の無い 1 語は、これまでどおりその文字列の部分一致。
 * 演算子だけの入力（`or` や `|` だけ）も、その文字列の部分一致に戻す。
 * 空のクエリはすべて一致。
 *
 *   アルミ 板           … 両方を含む
 *   アルミ OR 鉄        … どちらかを含む
 *   アルミ|鉄           … 同上
 *   アルミ AND 板       … 空白と同じ
 *   "アルミ 板" OR 鉄   … 語句「アルミ 板」、または「鉄」
 */

/** 検索欄の下に出す短い説明。 */
export const SEARCH_HINT = '空白か AND はすべて含む。OR か | はいずれか。"…" は語句';

const OR_WORD = /^or$/i;
const AND_WORD = /^and$/i;

function isSpace(ch) {
  return /\s/.test(ch);
}

function tokenize(query) {
  const tokens = [];
  const s = String(query ?? '');
  let i = 0;
  while (i < s.length) {
    const ch = s[i];
    if (isSpace(ch)) {
      i += 1;
      continue;
    }
    if (ch === '|') {
      tokens.push({ kind: 'or' });
      i += 1;
      continue;
    }
    const close = ch === '"' ? '"' : ch === '「' ? '」' : null;
    if (close) {
      i += 1;
      let phrase = '';
      while (i < s.length && s[i] !== close) {
        if (s[i] === '\\' && i + 1 < s.length) {
          phrase += s[i + 1];
          i += 2;
          continue;
        }
        phrase += s[i];
        i += 1;
      }
      if (i < s.length && s[i] === close) i += 1;
      if (phrase) tokens.push({ kind: 'term', value: phrase });
      continue;
    }
    let word = '';
    while (i < s.length && !isSpace(s[i]) && s[i] !== '|' && s[i] !== '"' && s[i] !== '「') {
      word += s[i];
      i += 1;
    }
    if (OR_WORD.test(word)) tokens.push({ kind: 'or' });
    else if (AND_WORD.test(word)) tokens.push({ kind: 'and' });
    else if (word) tokens.push({ kind: 'term', value: word });
  }
  return tokens;
}

/**
 * haystack が query に合うか。
 * 対象フィールドの連結は呼び出し側が決める（これまでと同じ範囲）。
 */
export function matchesSearch(haystack, query) {
  const raw = String(query ?? '').trim();
  if (!raw) return true;
  const tokens = tokenize(raw);
  const groups = [];
  let current = [];
  let sawTerm = false;
  for (const token of tokens) {
    if (token.kind === 'or') {
      if (current.length) groups.push(current);
      current = [];
      continue;
    }
    if (token.kind === 'and') continue;
    current.push(token.value.toLowerCase());
    sawTerm = true;
  }
  if (current.length) groups.push(current);
  const hay = String(haystack ?? '').toLowerCase();
  // `or` や `|` だけの 1 語は演算子にせず、今までどおり部分一致にする。
  if (!sawTerm) return hay.includes(raw.toLowerCase());
  return groups.some((terms) => terms.every((term) => hay.includes(term)));
}
