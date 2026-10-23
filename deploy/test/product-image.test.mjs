import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  directImageUrl, productImageFromHtml, publicProductUrl
} from '../src/product-image.js';
import { parseTaProductUrl } from '../src/parse-pages.js';

test('私設アドレスの商品URLは画像取得に使わない', () => {
  assert.equal(publicProductUrl('http://127.0.0.1/latest'), null);
  assert.equal(publicProductUrl('http://169.254.169.254/'), null);
  assert.equal(publicProductUrl('http://10.0.0.4/a'), null);
  assert.equal(publicProductUrl('http://192.168.0.2/a'), null);
  assert.equal(publicProductUrl('file:///etc/passwd'), null);
  assert.equal(publicProductUrl('https://user:pass@example.test/a'), null);
  assert.ok(publicProductUrl('https://akizukidenshi.com/catalog/g/g113371/'));
});

test('秋月の商品URLは画像パスに変換できる', () => {
  assert.equal(
    directImageUrl('https://akizukidenshi.com/catalog/g/g113371/'),
    'https://akizukidenshi.com/img/goods/L/113371.jpg'
  );
  assert.equal(directImageUrl('https://www.monotaro.com/g/00174701/'), null);
});

test('og:image と Amazon のメイン画像を取る', () => {
  const og = '<meta content="https://cdn.example.test/item.jpg" property="og:image">';
  assert.equal(
    productImageFromHtml(og, 'https://shop.example.test/p/1'),
    'https://cdn.example.test/item.jpg'
  );

  const amazon = `<img id="landingImage" data-a-dynamic-image="{&quot;https://m.media-amazon.com/images/I/51GiFp77acL._AC_SY355_.jpg&quot;:[355,355]}" data-old-hires="https://m.media-amazon.com/images/I/51GiFp77acL._AC_SL1500_.jpg">
    <img src="https://m.media-amazon.com/images/G/09/social_share/amazon_logo.png">`;
  assert.equal(
    productImageFromHtml(amazon, 'https://www.amazon.co.jp/dp/B0F43NCQ25'),
    'https://m.media-amazon.com/images/I/51GiFp77acL._AC_SY355_.jpg'
  );
});

test('相対 og:image は商品ページを基準に絶対 URL にする', () => {
  const html = '<meta property="og:image" content="/images/item.png">';
  assert.equal(
    productImageFromHtml(html, 'https://shop.example.test/p/1'),
    'https://shop.example.test/images/item.png'
  );
});

test('詳細 HTML の商品URLを取る', () => {
  const html = `<label>商品URL</label>
    <a href="https://www.monotaro.com/g/00174701/?t.q=%E5%8D%98%E4%B8%89&amp;x=1">link</a>`;
  assert.equal(
    parseTaProductUrl(html),
    'https://www.monotaro.com/g/00174701/?t.q=%E5%8D%98%E4%B8%89&x=1'
  );
  assert.equal(parseTaProductUrl('<p>ショップ</p>'), null);
});
