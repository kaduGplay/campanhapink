const { test } = require('node:test');
const assert = require('node:assert/strict');
const server = require('../server');
test('HTTP: entrega páginas e bloqueia segredos, pedidos, backend e solicitações inválidas', async t => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  for (const route of ['/', '/checkout.html', '/parte%201/index.html', '/shop-config.js']) assert.equal((await fetch(base + route)).status, 200);
  const checkout = await fetch(base + '/checkout.html');
  const html = await checkout.text();
  assert.ok(html.indexOf('<meta name="pink-runtime" content="node">') < html.indexOf("location.replace("));
  assert.equal(checkout.headers.get('cache-control'), 'no-store');
  for (const route of ['/.env', '/.data/orders/test.json', '/server.js', '/lib/payments.js', '/package.json', '/images/../server.js']) assert.equal((await fetch(base + route)).status, 404);
  assert.equal((await fetch(base + '/api/pix', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://external.invalid' }, body: '{}' })).status, 403);
  assert.equal((await fetch(base + '/api/pix', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{' })).status, 400);
  assert.equal((await fetch(base + '/api/pix', { method: 'POST', body: '{}' })).status, 415);
  assert.equal((await fetch(base + '/api/pix', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: ' '.repeat(17000) })).status, 413);
  assert.equal((await fetch(base + '/api/status?order=invalid')).status, 404);
});
