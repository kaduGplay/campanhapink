const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { randomUUID, createHash } = require('node:crypto');
const { createMeta, attribution, purchaseEvent } = require('../lib/meta');
const { createPayments, buildOrder } = require('../lib/payments');
const { createServer } = require('../server');
const sha = v => createHash('sha256').update(v).digest('hex');
const ORIGIN = 'https://loja.example.com';
const input = () => ({ kit: '1', frete: 'sedex', bumps: { feive: 2 }, cliente: { email: ' Teste@Example.com ', telefone: '(11) 99999-9999', cpf: '52998224725' }, endereco: { cep: '01310-100', rua: 'Rua Teste', numero: '100', bairro: 'Centro', cidade: 'São Paulo', uf: 'sp' } });
const AMOUNT = 34.9 + 14.82 * 2 + 19.9;
function gateway({ status = 'PENDING', amount = AMOUNT, lookupError = false, extra = {} } = {}) {
  const calls = { create: [], lookup: 0 };
  const fetchImpl = async (url, options) => {
    if (url.endsWith('/pix/receive')) {
      calls.create.push(JSON.parse(options.body));
      return new Response(JSON.stringify({ transactionId: 'tx-test-1', status: 'OK', pix: { code: 'pix-code' }, webhookToken: 'per-transaction-token' }));
    }
    calls.lookup++;
    assert.equal(url, 'https://dash.voidpayments.com/api/v1/gateway/transactions?id=tx-test-1');
    assert.equal(options.headers['x-secret-key'], 'secret-test');
    if (lookupError) throw new Error('offline');
    const identifier = calls.create[0]?.identifier;
    return new Response(JSON.stringify({ id: 'tx-test-1', clientIdentifier: identifier, currency: 'BRL', amount, status: typeof status === 'function' ? status() : status, paymentMethod: 'PIX', payedAt: '2026-09-30T21:01:00.000Z', ...extra }));
  };
  return { calls, fetchImpl };
}
async function service(t, options = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'pink-meta-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const paidEvents = [];
  const onPaid = options.onPaid || (async record => { paidEvents.push(record); return true; });
  const api = createPayments({ directory, publicKey: 'public-test', secretKey: 'secret-test', confirmWithGateway: true, callbackUrl: ORIGIN + '/api/webhooks/voidpay', ...options, onPaid });
  return { api, directory, paidEvents };
}
test('atribuição usa cookies da Meta válidos, IP da plataforma e user agent', () => {
  const req = { headers: { cookie: '_fbp=fb.1.1700000000000.123456; _fbc=fb.1.1700000000000.AbC-_1.2; outro=x', 'x-vercel-forwarded-for': '200.160.2.3, 10.0.0.1', 'x-forwarded-for': '1.1.1.1', 'user-agent': 'Mozilla/5.0' } };
  assert.deepEqual(attribution(req), { fbp: 'fb.1.1700000000000.123456', fbc: 'fb.1.1700000000000.AbC-_1.2', client_ip_address: '200.160.2.3', client_user_agent: 'Mozilla/5.0' });
  assert.deepEqual(attribution({ headers: { cookie: '_fbp=<script>; _fbc=fb.x', 'x-forwarded-for': 'não-é-ip' } }), {});
});
test('Purchase envia dados pessoais só em SHA-256 normalizado e itens físicos do pedido', () => {
  const record = { identifier: 'pedido-teste-0001', paidAt: '2026-09-30T21:01:00.000Z', attribution: { fbp: 'fb.1.1.1' }, order: buildOrder(input()) };
  const event = purchaseEvent(record, ORIGIN);
  assert.equal(event.event_id, 'purchase:pedido-teste-0001');
  assert.equal(event.event_time, Math.floor(Date.parse('2026-09-30T21:01:00.000Z') / 1000));
  assert.equal(event.event_source_url, ORIGIN + '/checkout.html');
  assert.deepEqual(event.user_data.em, [sha('teste@example.com')]);
  assert.deepEqual(event.user_data.ph, [sha('5511999999999')]);
  assert.deepEqual(event.user_data.zp, [sha('01310100')]);
  assert.deepEqual(event.user_data.ct, [sha('saopaulo')]);
  assert.deepEqual(event.user_data.st, [sha('sp')]);
  assert.deepEqual(event.user_data.country, [sha('br')]);
  assert.equal(event.user_data.fbp, 'fb.1.1.1');
  assert.equal(event.custom_data.value, record.order.amount);
  assert.deepEqual(event.custom_data.content_ids, ['kit5-body-splash-1', 'feive']);
  assert.equal(event.custom_data.num_items, 3);
  const text = JSON.stringify(event);
  for (const secret of ['teste@example.com', '99999', '52998224725', 'Rua Teste']) assert.equal(text.includes(secret), false, secret);
});
test('envio à API de Conversões: desligado sem token/origem, confirma events_received e nunca lança', async () => {
  let calls = 0;
  const never = async () => { calls++; throw new Error('Não deveria chamar'); };
  assert.equal(await createMeta({ token: '', origin: ORIGIN, fetchImpl: never }).addToCart('1', 'atc:' + randomUUID(), {}), false);
  assert.equal(await createMeta({ token: 'token', origin: null, fetchImpl: never }).addToCart('1', 'atc:' + randomUUID(), {}), false);
  assert.equal(calls, 0);
  let sent;
  const ok = createMeta({ pixelId: '123', token: 'token-test', testEventCode: 'TEST1', origin: ORIGIN, fetchImpl: async (url, options) => {
    sent = { url, options, body: JSON.parse(options.body) };
    return new Response(JSON.stringify({ events_received: 1 }));
  } });
  const eventId = 'atc:' + randomUUID();
  assert.equal(await ok.addToCart('2', eventId, { client_ip_address: '200.160.2.3' }), true);
  assert.equal(sent.url, 'https://graph.facebook.com/v26.0/123/events');
  assert.equal(sent.options.headers.Authorization, 'Bearer token-test');
  assert.equal(sent.body.test_event_code, 'TEST1');
  assert.equal(sent.body.data[0].event_name, 'AddToCart');
  assert.equal(sent.body.data[0].event_id, eventId);
  assert.equal(sent.body.data[0].custom_data.value, 58.8);
  assert.equal(sent.body.data[0].event_source_url, ORIGIN + '/checkout.html?kit=2');
  const failing = createMeta({ token: 'token', origin: ORIGIN, fetchImpl: async () => new Response(JSON.stringify({ error: { code: 190 } }), { status: 400 }) });
  assert.equal(await failing.addToCart('1', eventId, {}), false);
  const offline = createMeta({ token: 'token', origin: ORIGIN, fetchImpl: async () => { throw new Error('offline'); } });
  assert.equal(await offline.addToCart('1', eventId, {}), false);
});
test('cobrança registra callbackUrl e atribuição sem expor token por transação ao navegador', async t => {
  const g = gateway();
  const { api, directory } = await service(t, { fetchImpl: g.fetchImpl });
  const key = randomUUID();
  const result = await api.generate(input(), key, { attribution: { fbp: 'fb.1.1.1' } });
  assert.equal(g.calls.create[0].callbackUrl, ORIGIN + '/api/webhooks/voidpay');
  assert.equal(result.statusVerificationAvailable, true);
  assert.equal(JSON.stringify(result).includes('per-transaction-token'), false);
  assert.equal(result.attribution, undefined);
  const record = JSON.parse(await fs.readFile(path.join(directory, key + '.json'), 'utf8'));
  assert.deepEqual(record.attribution, { fbp: 'fb.1.1.1' });
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(directory, 'tx-tx-test-1.json'), 'utf8')), { identifier: key });
  const plain = gateway();
  await createPayments({ directory, publicKey: 'p', secretKey: 's', fetchImpl: plain.fetchImpl }).generate(input(), randomUUID());
  assert.equal(plain.calls.create[0].callbackUrl, undefined);
});
test('status confirma pela consulta autenticada, com intervalo mínimo, e envia Purchase uma vez', async t => {
  let status = 'PENDING';
  const g = gateway({ status: () => status });
  const { api, directory, paidEvents } = await service(t, { fetchImpl: g.fetchImpl });
  const key = randomUUID(), result = await api.generate(input(), key);
  assert.equal((await api.status(key, result.transactionId, result.orderToken)).status, 'pending');
  assert.equal(g.calls.lookup, 1);
  status = 'COMPLETED';
  assert.equal((await api.status(key, result.transactionId, result.orderToken)).status, 'pending');
  assert.equal(g.calls.lookup, 1, 'respeita o intervalo entre consultas');
  const fresh = createPayments({ directory, publicKey: 'public-test', secretKey: 'secret-test', confirmWithGateway: true, fetchImpl: g.fetchImpl, onPaid: async r => { paidEvents.push(r); return true; } });
  assert.deepEqual(await fresh.status(key, result.transactionId, result.orderToken), { status: 'paid', verificationAvailable: true });
  assert.equal(paidEvents.length, 1);
  assert.equal(paidEvents[0].paidAt, '2026-09-30T21:01:00.000Z');
  const record = JSON.parse(await fs.readFile(path.join(directory, key + '.json'), 'utf8'));
  assert.equal(record.paid, true); assert.ok(record.purchaseNotifiedAt);
  assert.equal((await fresh.status(key, result.transactionId, result.orderToken)).status, 'paid');
  assert.equal(paidEvents.length, 1); assert.equal(g.calls.lookup, 2);
});
test('valor, moeda, método ou pedido divergentes na consulta nunca aprovam', async t => {
  for (const extra of [{ amount: 1 }, { currency: 'USD' }, { paymentMethod: 'BOLETO' }, { clientIdentifier: 'outro-pedido-0000000' }, { status: 'PAID_OUT' }]) {
    const g = gateway({ status: 'COMPLETED', extra });
    const { api, paidEvents } = await service(t, { fetchImpl: g.fetchImpl });
    const key = randomUUID(), result = await api.generate(input(), key);
    assert.equal((await api.status(key, result.transactionId, result.orderToken)).status, 'pending', JSON.stringify(extra));
    assert.equal(paidEvents.length, 0);
  }
});
test('aviso do callback localiza o pedido, confere na VoidPay e pede reenvio quando não confirma', async t => {
  let status = 'PENDING';
  const g = gateway({ status: () => status });
  let fail = true;
  const { api, paidEvents } = await service(t, { fetchImpl: g.fetchImpl, onPaid: async r => { if (fail) return false; paidEvents.push(r); return true; } });
  await assert.rejects(api.notify({ transaction: { id: 'desconhecida' } }), e => e.status === 404);
  await assert.rejects(api.notify([]), e => e.status === 400);
  const key = randomUUID(), result = await api.generate(input(), key);
  // O corpo declara pago, mas a VoidPay ainda não confirma: pede reenvio sem aprovar.
  await assert.rejects(api.notify({ event: 'TRANSACTION_PAID', transaction: { id: 'tx-test-1', status: 'COMPLETED', identifier: key } }), e => e.status === 503);
  await new Promise(r => setTimeout(r, 2100));
  assert.deepEqual(await api.notify({ event: 'TRANSACTION_CREATED', transaction: { id: 'tx-test-1', status: 'PENDING' } }), { status: 'pending' });
  await new Promise(r => setTimeout(r, 2100));
  status = 'COMPLETED';
  assert.deepEqual(await api.notify({ data: { id: 'tx-test-1', status: 'COMPLETED' } }), { status: 'paid' });
  assert.equal(paidEvents.length, 0, 'falha da Meta não impede a confirmação');
  fail = false;
  assert.equal((await api.status(key, result.transactionId, result.orderToken)).status, 'paid');
  assert.equal(paidEvents.length, 1, 'Purchase pendente é reenviado na próxima conferência');
});
test('aviso do callback responde 503 quando a consulta à VoidPay falha', async t => {
  const g = gateway({ lookupError: true });
  const { api } = await service(t, { fetchImpl: g.fetchImpl });
  const key = randomUUID();
  await api.generate(input(), key);
  await assert.rejects(api.notify({ transaction: { identifier: key } }), e => e.status === 503);
});
test('HTTP: rota do callback, evento AddToCart validado e atribuição repassada ao Pix', async t => {
  const g = gateway({ status: 'COMPLETED' });
  const { api } = await service(t, { fetchImpl: g.fetchImpl });
  const added = [];
  let captured;
  const metaService = { attribution: () => ({ client_ip_address: '200.160.2.3' }), addToCart: async (...args) => { added.push(args); return true; } };
  const paymentService = { ...api, generate: (data, key, context) => { captured = context; return api.generate(data, key, context); } };
  const server = createServer({ paymentService, metaService });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  t.after(() => new Promise(r => server.close(r)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (route, data, headers = {}) => fetch(base + route, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(data) });
  const key = randomUUID();
  assert.equal((await post('/api/pix', input(), { 'Idempotency-Key': key })).status, 200);
  assert.deepEqual(captured, { attribution: { client_ip_address: '200.160.2.3' } });
  assert.equal((await fetch(base + '/api/webhooks/voidpay')).status, 405);
  const callback = await post('/api/webhooks/voidpay', { transaction: { id: 'tx-test-1' } });
  assert.equal(callback.status, 200); assert.deepEqual(await callback.json(), { status: 'paid' });
  const eventId = 'atc:' + randomUUID();
  for (const bad of [{ event: 'Purchase', kit: '1', eventId }, { event: 'AddToCart', kit: '9', eventId }, { event: 'AddToCart', kit: '1', eventId: 'x' }]) assert.equal((await post('/api/meta/event', bad)).status, 400);
  assert.equal((await post('/api/meta/event', { event: 'AddToCart', kit: '1', eventId }, { Origin: 'https://externo.invalid' })).status, 403);
  const ok = await post('/api/meta/event', { event: 'AddToCart', kit: '2', eventId });
  assert.equal(ok.status, 200); assert.deepEqual(await ok.json(), { sent: true });
  assert.deepEqual(added, [['2', eventId, { client_ip_address: '200.160.2.3' }]]);
});
