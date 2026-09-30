const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { buildOrder, createPayments } = require('../lib/payments');
function order() {
  return { kit: '2', frete: 'sedex', bumps: { bodysplash: 2 }, cliente: { email: 'teste@example.com', telefone: '11999999999', cpf: '52998224725' }, endereco: { cep: '01310100', rua: 'Avenida Teste', numero: '100', bairro: 'Centro', cidade: 'São Paulo', uf: 'SP' } };
}
const success = (extra = {}) => ({ transactionId: 'tx_test', status: 'OK', pix: { code: 'test-code', expiresAt: '2026-12-01T12:00:00Z' }, ...extra });
async function service(t, fetchImpl, overrides = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'pink-payments-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const config = { directory, publicKey: 'public-test', secretKey: 'secret-test', fetchImpl, ...overrides };
  return { api: createPayments(config), config, directory };
}
test('recalcula kit, adicionais e frete em centavos e ignora total informado', () => {
  const input = { ...order(), total: 0.01, amount: 0.01 };
  const result = buildOrder(input);
  assert.equal(result.amount, 90);
  assert.equal(result.client.name, 'Cliente');
  assert.equal(buildOrder({ ...order(), cliente: { ...order().cliente, nome: 'Nome enviado' } }).client.name, 'Cliente');
  assert.equal(result.products.reduce((s, p) => s + Math.round(p.price * 100) * p.quantity, 0), 9000);
  assert.equal(buildOrder({ ...order(), kit: '1', frete: 'gratis', bumps: {} }).amount, 34.9);
});
test('recusa catálogo adulterado, quantidades e dados inválidos', () => {
  for (const change of [{ kit: '__proto__' }, { frete: 'inexistente' }, { bumps: { bodysplash: -1 } }, { bumps: { bodysplash: 1.5 } }, { bumps: { feive: 11 } }, { bumps: { inventado: 1 } }, { cliente: { ...order().cliente, cpf: '11111111111' } }]) assert.throws(() => buildOrder({ ...order(), ...change }), e => e.status === 400);
});
test('envia contrato VoidPay e preserva a mesma cobrança em tentativas simultâneas e após reinício', async t => {
  let calls = 0;
  const { api, config } = await service(t, async (url, options) => {
    calls++;
    assert.equal(url, 'https://dash.voidpayments.com/api/v1/gateway/pix/receive');
    assert.equal(options.headers['x-secret-key'], 'secret-test');
    const sent = JSON.parse(options.body);
    assert.equal(sent.amount, 90); assert.equal(sent.client.name, 'Cliente');
    assert.equal(sent.metadata.orderId, sent.identifier);
    assert.equal(sent.shippingFee, undefined);
    return new Response(JSON.stringify(success()));
  });
  const key = randomUUID();
  const [a, b] = await Promise.all([api.generate(order(), key), api.generate(order(), key)]);
  assert.deepEqual(a, b); assert.equal(calls, 1);
  assert.equal(a.statusVerificationAvailable, false); assert.equal(a.total, 90);
  assert.equal(a.secretKey, undefined);
  assert.deepEqual(await createPayments(config).generate(order(), key), a); assert.equal(calls, 1);
  await assert.rejects(api.generate({ ...order(), kit: '1' }, key), e => e.status === 409);
  await assert.rejects(api.status(key, a.transactionId, 'invalid-token'), e => e.status === 404);
  assert.deepEqual(await api.status(key, a.transactionId, a.orderToken), { status: 'pending', verificationAvailable: false });
});
test('status OK da criação não equivale a pagamento; só COMPLETED é confirmado', async t => {
  const { api } = await service(t, async () => new Response(JSON.stringify(success({ transactionStatus: 'COMPLETED' }))));
  const key = randomUUID(), result = await api.generate(order(), key);
  assert.deepEqual(await api.status(key, result.transactionId, result.orderToken), { status: 'paid', verificationAvailable: true });
});
test('timeout ou erro de rede não gera segunda cobrança nem após reinício', async t => {
  let calls = 0;
  const { api, config } = await service(t, async () => { calls++; throw new Error('Timeout with secret-test'); });
  const key = randomUUID();
  await assert.rejects(api.generate(order(), key), e => e.status === 502 && !e.message.includes('secret-test'));
  await assert.rejects(createPayments(config).generate(order(), key), e => e.status === 409);
  assert.equal(calls, 1);
});
test('erros do gateway, respostas inválidas e rejeições não expõem dados nem aprovam pedido', async t => {
  for (const [data, status] of [[{ message: 'secret-test' }, 400], [success({ status: 'REJECTED' }), 200], [{ status: 'OK' }, 200], [success({ transactionStatus: 'FAILED' }), 200]]) {
    const { api } = await service(t, async () => new Response(JSON.stringify(data), { status }));
    await assert.rejects(api.generate(order(), randomUUID()), e => e.status === 502 && !e.message.includes('secret-test'));
  }
});
test('sem credenciais não chama gateway e permite configurar depois', async t => {
  const { api, directory } = await service(t, async () => { throw new Error('Não deveria chamar'); }, { secretKey: '' });
  await assert.rejects(api.generate(order(), randomUUID()), e => e.status === 503);
  assert.deepEqual(await fs.readdir(directory), []);
});
test('persiste diagnóstico seguro e retorna o mesmo erro sem reenviar cobrança', async t => {
  let calls = 0;
  const { api, directory, config } = await service(t, async () => {
    calls++;
    return new Response(JSON.stringify({ errorCode: 'GATEWAY_INVALID_DATA', message: 'secret-test', details: [{ path: ['client', 'email'], message: 'cliente@example.com' }] }), { status: 400 });
  });
  const key = randomUUID();
  for (const instance of [api, createPayments(config)]) await assert.rejects(instance.generate(order(), key), e => e.status === 502 && e.code === 'GATEWAY_INVALID_DATA' && e.message.includes('e-mail'));
  assert.equal(calls, 1);
  const record = JSON.parse(await fs.readFile(path.join(directory, key + '.json'), 'utf8'));
  assert.equal(record.gatewayError.code, 'GATEWAY_INVALID_DATA');
  assert.equal(JSON.stringify(record.gatewayError).includes('secret-test'), false);
  assert.equal(JSON.stringify(record.gatewayError).includes('cliente@example.com'), false);
});
test('retorno não JSON do gateway registra HTTP sem descartar a informação de erro', async t => {
  const { api, directory } = await service(t, async () => new Response('<html>erro interno</html>', { status: 502 }));
  const key = randomUUID();
  await assert.rejects(api.generate(order(), key), e => e.message.includes('HTTP 502'));
  const record = JSON.parse(await fs.readFile(path.join(directory, key + '.json'), 'utf8'));
  assert.equal(record.gatewayHttpStatus, 502);
  assert.equal(record.gatewayError.code, 'GATEWAY_ERROR');
});
