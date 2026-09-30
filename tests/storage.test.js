const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { createRedisStore, configuredStore } = require('../lib/storage');
const { createPayments } = require('../lib/payments');
const { createWebhooks } = require('../lib/voidpay-webhooks');
function redisFixture() {
  const data = new Map(), commands = [];
  const fetchImpl = async (url, options) => {
    assert.equal(url, 'https://redis.example.com');
    assert.equal(options.headers.Authorization, 'Bearer test-redis-token');
    const command = JSON.parse(options.body); commands.push(command);
    const [op, key, value, flag] = command;
    let result;
    if (op === 'GET') result = data.get(key) ?? null;
    else if (op === 'SET') {
      if (flag === 'NX' && data.has(key)) result = null;
      else { data.set(key, value); result = 'OK'; }
    } else throw Error('Unexpected command');
    return new Response(JSON.stringify({ result }));
  };
  const store = collection => createRedisStore({ url: 'https://redis.example.com', token: 'test-redis-token', prefix: 'test:' + collection, fetchImpl });
  return { store, data, commands };
}
function input() {
  return { kit: '1', frete: 'gratis', bumps: {}, cliente: { email: 'test@example.com', telefone: '11999999999', cpf: '52998224725' }, endereco: { cep: '01310100', rua: 'Rua Teste', numero: '100', bairro: 'Centro', cidade: 'São Paulo', uf: 'SP' } };
}
function paid(key) {
  return { event: 'TRANSACTION_PAID', token: 'test-webhook', offerCode: '', checkoutUrl: '', client: { id: 'test', name: 'Cliente', email: 'test@example.com', phone: '11999999999', cpf: '52998224725', cnpj: null, address: null }, transaction: { id: 'tx-test', identifier: key, status: 'COMPLETED', paymentMethod: 'PIX', amount: 34.9, originalAmount: 34.9, currency: 'BRL', originalCurrency: 'BRL', installments: 1, createdAt: '2026-09-30T22:00:00Z', payedAt: '2026-09-30T22:01:00Z' }, subscription: null, orderItems: [], trackProps: {} };
}
test('Redis REST: serializa, persiste entre instâncias e usa reserva atômica sem expiração', async () => {
  const { store, commands } = redisFixture();
  const a = store('orders'), b = store('orders');
  assert.equal(await a.read('test'), null);
  const outcomes = await Promise.all([a.create('test', { n: 1 }), b.create('test', { n: 2 })]);
  assert.deepEqual(outcomes.sort(), [false, true]);
  assert.deepEqual(await b.read('test'), { n: 1 });
  await b.save('test', { n: 3 });
  assert.deepEqual(await store('orders').read('test'), { n: 3 });
  assert.ok(commands.filter(c => c[0] === 'SET').every(c => c.length <= 4));
});
test('duas funções concorrentes não duplicam cobrança e outra função reconhece o webhook pago', async () => {
  const { store } = redisFixture(); let gatewayCalls = 0;
  const hooks = () => createWebhooks({ store: store('webhooks'), token: 'test-webhook', publicBaseUrl: 'https://example.com' });
  const gateway = async () => { gatewayCalls++; return new Response(JSON.stringify({ status: 'OK', transactionId: 'tx-test', pix: { code: 'test-code' } })); };
  const instance = () => createPayments({ store: store('orders'), publicKey: 'test', secretKey: 'test', webhooks: hooks(), fetchImpl: gateway });
  const key = randomUUID();
  const results = await Promise.allSettled([instance().generate(input(), key), instance().generate(input(), key)]);
  assert.ok(results.some(r => r.status === 'fulfilled'));
  for (const r of results) if (r.status === 'rejected') assert.equal(r.reason.status, 409);
  assert.equal(gatewayCalls, 1);
  const result = await instance().generate(input(), key);
  assert.equal(gatewayCalls, 1);
  assert.equal((await instance().status(key, result.transactionId, result.orderToken)).status, 'pending');
  await hooks().receive(paid(key), 'TRANSACTION_PAID');
  assert.equal((await hooks().receive(paid(key), 'TRANSACTION_PAID')).duplicate, true);
  assert.equal((await instance().status(key, result.transactionId, result.orderToken)).status, 'paid');
});
test('timeout após SET NX não permite nova cobrança em outra função', async () => {
  const fixture = redisFixture(); let fail = true, calls = 0;
  const options = { url: 'https://redis.example.com', token: 'test', prefix: 'test:orders', fetchImpl: async (_url, req) => {
    const [op, key, value, flag] = JSON.parse(req.body);
    if (op === 'GET') return new Response(JSON.stringify({ result: fixture.data.get(key) ?? null }));
    if (flag === 'NX' && !fixture.data.has(key)) {
      fixture.data.set(key, value);
      if (fail) { fail = false; throw Error('connection lost after write'); }
      return new Response(JSON.stringify({ result: 'OK' }));
    }
    return new Response(JSON.stringify({ result: null }));
  } };
  const instance = () => createPayments({ store: createRedisStore(options), publicKey: 'test', secretKey: 'test', fetchImpl: async () => { calls++; throw Error('Must not call'); } });
  const key = randomUUID();
  await assert.rejects(instance().generate(input(), key), e => e.status === 503);
  await assert.rejects(instance().generate(input(), key), e => e.status === 409);
  assert.equal(calls, 0);
});
test('Vercel sem Redis ou com configuração incompleta bloqueia operações antes de cobrar', async () => {
  for (const env of [{ VERCEL: '1' }, { VERCEL: '1', UPSTASH_REDIS_REST_URL: 'https://example.com' }, { VERCEL: '1', UPSTASH_REDIS_REST_URL: 'http://example.com', UPSTASH_REDIS_REST_TOKEN: 'test' }]) {
    const store = configuredStore({ collection: 'orders', env });
    let calls = 0;
    const api = createPayments({ store, publicKey: 'test', secretKey: 'test', fetchImpl: async () => { calls++; } });
    await assert.rejects(api.generate(input(), randomUUID()), e => e.status === 503);
    assert.equal(calls, 0);
  }
});
test('Redis com falha de autenticação ou JSON inválido não expõe credenciais', async () => {
  for (const fetchImpl of [async () => new Response(JSON.stringify({ error: 'test-secret-token' }), { status: 401 }), async () => new Response(JSON.stringify({ result: '{invalid-json' }))]) {
    const store = createRedisStore({ url: 'https://redis.example.com', token: 'test-secret-token', prefix: 'test', fetchImpl });
    await assert.rejects(store.read('key'), e => e.status === 503 && !e.message.includes('test-secret-token'));
  }
});
