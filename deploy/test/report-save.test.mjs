/* 週報の項目保存。元アプリはモックする。 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { saveReportField } from '../src/meister.js';

const ID = '8b293839-a910-4bd6-b468-4915b9cefd19';

const EDIT_HTML = `<!DOCTYPE html><html><head>
<meta name="csrf-token" content="meta-token" />
</head><body>
<form action="/users/sign_out" method="post">
<input type="hidden" name="authenticity_token" value="logout-token" />
</form>
<form action="/reports/${ID}" method="post">
<input type="hidden" name="authenticity_token" value="form-token" />
<input type="datetime-local" name="report[start_at]" id="report_start_at" value="2026-10-01T09:00" />
<input type="datetime-local" name="report[end_at]" id="report_end_at" />
<textarea data-field-name="shortnote" name="report[shortnote]" id="report_shortnote">既存の概要</textarea>
<textarea data-field-name="progress" name="report[progress]" id="report_progress">進捗</textarea>
<textarea data-field-name="issue" name="report[issue]" id="report_issue"></textarea>
<textarea data-field-name="plan" name="report[plan]" id="report_plan"></textarea>
</form>
</body></html>`;

async function withFetch(handler, fn) {
  const original = globalThis.fetch;
  globalThis.fetch = handler;
  try {
    return await fn();
  } finally {
    globalThis.fetch = original;
  }
}

test('知らない項目は元アプリを呼ばずに拒む', async () => {
  let called = false;
  await withFetch(async () => {
    called = true;
    throw new Error('fetch should not run');
  }, async () => {
    await assert.rejects(
      () => saveReportField('c=1', ID, 'title', 'x'),
      (e) => e.status === 400 && /保存できません/.test(e.message)
    );
  });
  assert.equal(called, false);
});

test('本文は auto_save に PATCH し、CSRF は meta のトークン', async () => {
  const calls = [];
  await withFetch(async (url, init) => {
    calls.push({ url: String(url), init });
    if (String(url).endsWith('/edit')) {
      return new Response(EDIT_HTML, { status: 200 });
    }
    return new Response(JSON.stringify({ success: true }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
  }, async () => {
    const result = await saveReportField('c=1', ID, 'shortnote', '書き直した概要');
    assert.equal(result.ok, true);
    assert.equal(result.fieldName, 'shortnote');
  });

  const save = calls.find((c) => c.url.includes('/auto_save'));
  assert.ok(save, 'auto_save が呼ばれていない');
  assert.equal(save.init.method, 'PATCH');
  assert.equal(save.init.headers['X-CSRF-Token'], 'meta-token');
  assert.equal(save.init.headers.Cookie, 'c=1');
  assert.deepEqual(JSON.parse(save.init.body), {
    field_name: 'shortnote',
    content: '書き直した概要'
  });
  assert.equal(calls.some((c) => c.init?.method === 'POST'), false);
});

test('開始日は他の項目を残したままフォームを PATCH する', async () => {
  const calls = [];
  await withFetch(async (url, init) => {
    calls.push({ url: String(url), init });
    if (String(url).endsWith('/edit')) {
      return new Response(EDIT_HTML, { status: 200 });
    }
    return new Response('', {
      status: 302,
      headers: { Location: `/reports/${ID}` }
    });
  }, async () => {
    const result = await saveReportField('c=1', ID, 'start_at', '2026-10-02T10:00');
    assert.equal(result.ok, true);
  });

  assert.equal(calls.some((c) => c.url.includes('/auto_save')), false);
  const post = calls.find((c) => c.init?.method === 'POST');
  assert.ok(post);
  const params = new URLSearchParams(post.init.body);
  assert.equal(params.get('_method'), 'patch');
  assert.equal(params.get('authenticity_token'), 'form-token');
  assert.equal(params.get('report[start_at]'), '2026-10-02T10:00');
  assert.equal(params.get('report[shortnote]'), '既存の概要');
  assert.equal(params.get('report[progress]'), '進捗');
});
