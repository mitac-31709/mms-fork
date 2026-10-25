/* 一覧検索の AND / OR。
 *
 *   node --test test_search.mjs
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SEARCH_HINT, matchesSearch } from './search.js';

const hay = 'アルミ丸棒 φ20 1m';

test('空のクエリはすべて一致する', () => {
  assert.equal(matchesSearch(hay, ''), true);
  assert.equal(matchesSearch(hay, '   '), true);
  assert.equal(matchesSearch(null, ''), true);
  assert.equal(matchesSearch(undefined, null), true);
});

test('演算子の無い 1 語は大文字小文字を無視した部分一致', () => {
  assert.equal(matchesSearch(hay, 'アルミ'), true);
  assert.equal(matchesSearch(hay, 'φ20'), true);
  assert.equal(matchesSearch('Hello World', 'hello'), true);
  assert.equal(matchesSearch('Hello World', 'WORLD'), true);
  assert.equal(matchesSearch(hay, '鉄'), false);
  assert.equal(matchesSearch('第10週 週報', '第1'), true);
  assert.equal(matchesSearch('第2週 週報', '第1'), false);
});

test('記号は正規表現にせず、そのまま探す', () => {
  assert.equal(matchesSearch('a.b', 'a.b'), true);
  assert.equal(matchesSearch('axb', 'a.b'), false);
});

test('空白と AND はすべての語を含む', () => {
  assert.equal(matchesSearch(hay, 'アルミ 丸棒'), true);
  assert.equal(matchesSearch(hay, 'アルミ　φ20'), true);
  assert.equal(matchesSearch(hay, 'アルミ AND 1m'), true);
  assert.equal(matchesSearch(hay, 'アルミ and φ20'), true);
  assert.equal(matchesSearch(hay, 'アルミ 鉄'), false);
  assert.equal(matchesSearch(hay, 'アルミ AND 鉄'), false);
  assert.equal(matchesSearch('foo bar baz', 'foo baz'), true);
});

test('OR と | はいずれかのまとまりで一致する', () => {
  assert.equal(matchesSearch(hay, '鉄 OR アルミ'), true);
  assert.equal(matchesSearch(hay, '鉄 or 丸棒'), true);
  assert.equal(matchesSearch(hay, '鉄 | 丸棒'), true);
  assert.equal(matchesSearch(hay, '鉄|丸棒'), true);
  assert.equal(matchesSearch(hay, '銅 OR 鉄'), false);
  assert.equal(matchesSearch(hay, '銅|鉄'), false);
});

test('OR の両側はそれぞれ AND になる', () => {
  assert.equal(matchesSearch('アルミの板', 'アルミ 板 OR 鉄 棒'), true);
  assert.equal(matchesSearch('鉄の棒', 'アルミ 板 OR 鉄 棒'), true);
  assert.equal(matchesSearch('アルミの棒', 'アルミ 板 OR 鉄 棒'), false);
  assert.equal(matchesSearch(hay, 'ノギス AND 150 OR 丸棒'), true);
  assert.equal(matchesSearch('ノギス 150mm', 'ノギス AND 150 OR ボルト'), true);
  assert.equal(matchesSearch('ボルト', 'ノギス AND 150 OR ボルト'), true);
  assert.equal(matchesSearch('ノギス', 'ノギス AND 150 OR ボルト'), false);
});

test('引用符は空白を含む語句', () => {
  assert.equal(matchesSearch(hay, '"丸棒 φ20"'), true);
  assert.equal(matchesSearch(hay, '"φ20 丸棒"'), false);
  assert.equal(matchesSearch(hay, '「丸棒 φ20」 OR 鉄'), true);
  assert.equal(matchesSearch('say OR please', '"OR"'), true);
  assert.equal(matchesSearch('please', '"OR"'), false);
  assert.equal(matchesSearch('アルミ 丸棒', '"アルミ 丸棒'), true);
  assert.equal(matchesSearch(hay, '"アルミ 丸棒'), false);
});

test('演算子だけの入力は、その文字列の部分一致に戻す', () => {
  assert.equal(matchesSearch('flavor', 'or'), true);
  assert.equal(matchesSearch('plant', 'or'), false);
  assert.equal(matchesSearch('random', 'AND'), true);
  assert.equal(matchesSearch('銅', 'AND'), false);
  assert.equal(matchesSearch('a|b', '|'), true);
  assert.equal(matchesSearch('ab', '|'), false);
});

test('端の演算子は無視し、途中の語は残す', () => {
  assert.equal(matchesSearch(hay, 'アルミ OR'), true);
  assert.equal(matchesSearch(hay, 'OR アルミ'), true);
  assert.equal(matchesSearch(hay, 'AND アルミ'), true);
  assert.equal(matchesSearch('鉄', 'アルミ OR'), false);
  assert.equal(matchesSearch(hay, '|||'), false);
});

test('一致しない対象と null は落とす', () => {
  assert.equal(matchesSearch(null, 'アルミ'), false);
  assert.equal(matchesSearch('', 'アルミ'), false);
});

test('説明文に AND と OR の書き方がある', () => {
  assert.match(SEARCH_HINT, /AND/);
  assert.match(SEARCH_HINT, /OR/);
  assert.match(SEARCH_HINT, /\|/);
});
