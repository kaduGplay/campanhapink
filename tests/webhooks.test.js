const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { createWebhooks } = require('../lib/voidpay-webhooks');
const { createPayments } = require('../lib/payments');
const { createServer } = require('../server');
const TOKEN = 'webhook-test-token-not-a-real-secret';
const CREATED = 'TRANSACTION_CREATED', PAID = 'TRANSACTION_PAID';
function payload(event = PAID, changes = {}) {
  return { event, token: TOKEN, offerCode: '', checkoutUrl: '',
    client: { id: 'client-test', name: 'Cliente', email: 'test@example.com', phone: '11999999999', cpf: '52998224725', cnpj: null, address: null },
    transaction: { id: 'tx_test', status: event === PAID ? 'COMPLETED' : 'PENDING', paymentMethod: 'PIX', amount: 34.90, originalAmount: 34.90, originalCurrency: 'BRL', currency: 'BRL', installments: 1, createdAt: '2026-09-30T21:00:00.000Z', payedAt: event === PAID ? '2026-09-30T21:01:00.000Z' : null, pixInformation: { qrCode: 'test-code', endToEndId: event === PAID ? 'test-end-to-end' : null }, ...changes },
    subscription: null, orderItems: [{ id: 'item-test', price: 34.9, product: { id: 'product-test', name: 'Kit', externalId: 'kit-test' } }], trackProps: { isUpsell: false }
  };
}
const record = (extra = {}) => ({ paid: false, identifier: randomUUID(), result: { transactionId: 'tx_test' }, order: { amount: 34.9 }, ...extra });
const input = () => ({ kit: '1', frete: 'gratis', bumps: {}, cliente: { email: 'teste@example.com', telefone: '11999999999', cpf: '52998224725' }, endereco: { cep: '01310100', rua: 'Rua Teste', numero: '100', bairro: 'Centro', cidade: 'São Paulo', uf: 'SP' } });
async function setup(t, options = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pink-hooks-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const config = { directory: path.join(root, 'private/webhooks'), token: TOKEN, publicBaseUrl: 'https://checkout.example.com', ...options };
  return { root, config, hooks: createWebhooks(config) };
}
test('token é validado antes de persistir e eventos são restritos à rota correta', async t => {
  const { hooks, config } = await setup(t);
  for (const token of ['', 'incorrect', undefined, 123]) await assert.rejects(hooks.receive({ ...payload(), token }, PAID), e => e.status === 401);
  await assert.rejects(hooks.receive(payload(CREATED), PAID), e => e.status === 400);
  await assert.rejects(hooks.receive(payload(), CREATED), e => e.status === 400);
  await assert.rejects(fs.stat(config.directory), e => e.code === 'ENOENT');
  await assert.rejects(createWebhooks({ ...config, token: '' }).receive(payload(), PAID), e => e.status === 503);
});
test('valida corpo, status pago, datas, valores, itens e estruturas opcionais', async t => {
  const { hooks } = await setup(t);
  for (const change of [{ status: 'PENDING' }, { amount: -1 }, { amount: '34.9' }, { amount: 34.901 }, { currency: 'real' }, { payedAt: null }, { payedAt: 'not-a-date' }, { installments: 1.5 }, { pixInformation: 'invalid' }]) {
    await assert.rejects(hooks.receive(payload(PAID, change), PAID), e => e.status === 400);
  }
  for (const change of [{ client: null }, { subscription: { cycle: 'bad' } }, { orderItems: 'invalid' }, { trackProps: { isUpsell: 'yes' } }]) {
    await assert.rejects(hooks.receive({ ...payload(), ...change }, PAID), e => e.status === 400);
  }
});
test('criação é registrada sem aprovar; pagamento e repetições concorrentes são duráveis e não regridem', async t => {
  const { hooks, config } = await setup(t);
  const r = record();
  const created = payload(CREATED, { status: 'COMPLETED' });
  assert.equal((await hooks.receive(created, CREATED)).accepted, true);
  assert.deepEqual(await hooks.stateFor(r), { paid: false, verificationAvailable: true });
  const deliveries = await Promise.all(Array.from({ length: 8 }, () => hooks.receive(payload(), PAID)));
  assert.equal(deliveries.filter(x => !x.duplicate).length, 1);
  assert.equal((await createWebhooks(config).stateFor(r)).paid, true);
  await hooks.receive(created, CREATED);
  assert.equal((await hooks.stateFor(r)).paid, true);
  const files = await fs.readdir(config.directory); assert.equal(files.length, 2);
  const contents = (await Promise.all(files.map(f => fs.readFile(path.join(config.directory, f), 'utf8')))).join('');
  for (const sensitive of [TOKEN, 'test@example.com', '52998224725', '11999999999']) assert.equal(contents.includes(sensitive), false);
});
test('paid antes de created não regride e formatos aninhados do exemplo são aceitos', async t => {
  const { hooks } = await setup(t);
  await hooks.receive(payload(), PAID);
  const p = payload(CREATED);
  for (const k of ['subscription', 'orderItems', 'trackProps']) { p.transaction[k] = p[k]; delete p[k]; }
  await hooks.receive(p, CREATED);
  assert.equal((await hooks.stateFor(record())).paid, true);
});
test('repetição conflitante é recusada sem sobrescrever o evento original', async t => {
  const { hooks } = await setup(t);
  await hooks.receive(payload(), PAID);
  await assert.rejects(hooks.receive(payload(PAID, { amount: 0.01 }), PAID), e => e.status === 409);
  assert.equal((await hooks.stateFor(record())).paid, true);
});
test('valor, moeda, método, identificador ou transação divergentes nunca aprovam o pedido', async t => {
  for (const change of [{ amount: 1 }, { currency: 'USD' }, { paymentMethod: 'CREDIT_CARD' }, { identifier: randomUUID() }, { id: 'another-transaction' }]) {
    const { hooks } = await setup(t);
    await hooks.receive(payload(PAID, change), PAID);
    assert.equal((await hooks.stateFor(record())).paid, false);
  }
});
test('eventos recebidos antes da resposta de criação são reconciliados sem chamadas de saída adicionais', async t => {
  const { hooks, root, config } = await setup(t);
  let calls = 0;
  const key = randomUUID();
  const options = { directory: path.join(root, 'orders'), publicKey: 'test', secretKey: 'test', webhooks: hooks, fetchImpl: async () => {
    calls++;
    await hooks.receive(payload(PAID, { identifier: key }), PAID);
    await hooks.receive(payload(CREATED, { identifier: key }), CREATED);
    return new Response(JSON.stringify({ status: 'OK', transactionId: 'tx_test', pix: { code: 'test-code' } }));
  } };
  const api = createPayments(options), result = await api.generate(input(), key);
  assert.equal(result.statusVerificationAvailable, true);
  assert.deepEqual(await api.status(key, result.transactionId, result.orderToken), { status: 'paid', verificationAvailable: true });
  const restarted = createPayments({ ...options, webhooks: createWebhooks(config) });
  assert.equal((await restarted.status(key, result.transactionId, result.orderToken)).status, 'paid');
  assert.equal(calls, 1);
});
test('habilitação requer token e endereço público HTTPS; pagamento registrado continua válido sem configuração', async t => {
  const { hooks, config } = await setup(t);
  for (const publicBaseUrl of ['', 'http://example.com', 'https://localhost', 'https://127.0.0.1']) assert.equal(createWebhooks({ ...config, publicBaseUrl }).enabled, false);
  assert.equal(createWebhooks({ ...config, token: '' }).enabled, false);
  await hooks.receive(payload(), PAID);
  assert.equal((await createWebhooks({ ...config, token: '', publicBaseUrl: '' }).stateFor(record())).paid, true);
});
test('HTTP: recebe apenas POST, autentica, confirma pagamento via status e não consulta API no webhook', async t => {
  const { hooks, root } = await setup(t);
  let calls = 0;
  const api = createPayments({ directory: path.join(root, 'orders'), publicKey: 'test', secretKey: 'test', webhooks: hooks, fetchImpl: async () => {
    calls++;
    return new Response(JSON.stringify({ status: 'OK', transactionId: 'tx_test', pix: { code: 'test-code' } }));
  } });
  const server = createServer({ paymentService: api, webhookService: hooks });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  t.after(() => new Promise(r => server.close(r)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (route, data) => fetch(base + route, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
  const key = randomUUID();
  const response = await fetch(base + '/api/pix', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': key }, body: JSON.stringify(input()) });
  const generated = await response.json(); assert.equal(response.status, 200);
  const status = () => fetch(base + `/api/status?id=tx_test&order=${key}`, { headers: { Authorization: `Bearer ${generated.orderToken}` } }).then(r => r.json());
  assert.equal((await status()).status, 'pending');
  assert.equal((await fetch(base + '/api/webhooks/voidpay/paid')).status, 405);
  assert.equal((await post('/api/webhooks/voidpay/paid', { ...payload(), token: 'wrong' })).status, 401);
  assert.equal((await post('/api/webhooks/voidpay/created', payload())).status, 400);
  assert.equal((await post('/api/webhooks/voidpay/created', payload(CREATED, { identifier: key }))).status, 200);
  assert.equal((await status()).status, 'pending');
  assert.equal((await post('/api/webhooks/voidpay/paid', payload(PAID, { identifier: key }))).status, 200);
  assert.equal((await status()).status, 'paid');
  assert.equal((await post('/api/webhooks/voidpay/paid', payload(PAID, { identifier: key }))).status, 200);
  assert.equal((await fetch(base + `/.data/webhooks/test.json`)).status, 404);
  assert.equal(calls, 1);
});
test('falha de persistência responde erro em vez de confirmar aceitação', async t => {
  const { root, config } = await setup(t);
  const blockingFile = path.join(root, 'not-a-directory'); await fs.writeFile(blockingFile, 'test');
  const hooks = createWebhooks({ ...config, directory: path.join(blockingFile, 'webhooks') });
  const server = createServer({ webhookService: hooks });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  t.after(() => new Promise(r => server.close(r)));
  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/webhooks/voidpay/paid`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload()) });
  assert.equal(response.status, 500);
  assert.equal(JSON.stringify(await response.json()).includes(root), false);
});
