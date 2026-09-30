const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { createHandler } = require('../server');
const vercelHandler = require('../api/index');
const { build } = require('../scripts/build');
function response() {
  return { headers: {}, statusCode: 200, setHeader(k, v) { this.headers[k.toLowerCase()] = v; }, writeHead(status, headers) { this.statusCode = status; for (const [k, v] of Object.entries(headers || {})) this.setHeader(k, v); }, end(body) { this.payload = body; } };
}
test('Vercel: corpo pré-interpretado chega ao serviço de pagamento', async () => {
  let input;
  const handler = createHandler({ apiOnly: true, paymentService: { generate: async data => { input = data; return { pix: { code: 'test' } }; } } });
  const req = { url: '/api/pix', method: 'POST', headers: { 'content-type': 'application/json', host: 'example.vercel.app', origin: 'https://example.vercel.app', 'idempotency-key': 'test-key' }, body: { kit: '1' } };
  const res = response(); await handler(req, res);
  assert.equal(res.statusCode, 200); assert.deepEqual(input, { kit: '1' });
});
test('Vercel: corpo inválido ou grande é recusado mesmo com parser da plataforma', async () => {
  const handler = createHandler({ apiOnly: true, paymentService: { generate: async () => { throw Error('Unexpected payment call'); } } });
  for (const [body, status] of [['{invalid', 400], [' '.repeat(17000), 413]]) {
    const res = response(); await handler({ url: '/api/pix', method: 'POST', headers: { 'content-type': 'application/json' }, body }, res); assert.equal(res.statusCode, status);
  }
  const req = { url: '/api/pix', method: 'POST', headers: { 'content-type': 'application/json' }, get body() { throw Error('JSON parser error'); } };
  const res = response(); await handler(req, res); assert.equal(res.statusCode, 400);
});
test('Vercel: wrapper encaminha rotas mantendo query de status, sem servir backend como estático', async () => {
  const res = response();
  await vercelHandler({ url: '/api/index?__pink_route=cpf', method: 'GET', headers: {} }, res);
  assert.equal(res.statusCode, 200); assert.deepEqual(JSON.parse(res.payload), { nome: null });
  const req = { url: '/api/index?__pink_route=status&id=tx&order=invalid', method: 'GET', headers: {} };
  const invalid = response(); await vercelHandler(req, invalid);
  assert.equal(req.url, '/api/status?id=tx&order=invalid'); assert.equal(invalid.statusCode, 404);
  for (const url of ['/server.js', '/.env', '/api/index?__pink_route=../server.js']) {
    const r = response(); await vercelHandler({ url, method: 'GET', headers: {} }, r); assert.ok([400, 404].includes(r.statusCode));
  }
});
test('build publica somente recursos permitidos, preserva URLs e não inclui dados privados', async () => {
  await build();
  const root = path.resolve(__dirname, '../dist');
  const files = await fs.readdir(root, { recursive: true });
  for (const file of files) assert.equal(/(^|\/)(\.env|\.data|lib|tests|server\.js|package\.json|api)(\/|$|\.)/.test(file), false, file);
  for (const file of ['index.html', 'checkout.html', 'parte 1/index.html', 'shop-config.js', 'js/qrcode.min.js', 'parte 1/images/kit.jpg']) assert.ok(files.includes(file));
  const html = await fs.readFile(path.join(root, 'checkout.html'), 'utf8');
  assert.ok(html.indexOf('<meta name="pink-runtime" content="node">') < html.indexOf('location.replace('));
  assert.equal(/utmify|fbevents|fbq\(/i.test(html), false);
  const config = JSON.parse(await fs.readFile(path.resolve(__dirname, '../vercel.json'), 'utf8'));
  assert.equal(config.outputDirectory, 'dist'); assert.equal(config.functions['api/index.js'].maxDuration, 60);
});
