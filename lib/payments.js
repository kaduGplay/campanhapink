const { randomBytes, createHash, timingSafeEqual } = require('node:crypto');
const { createFileStore } = require('./storage');
const CONFIG = require('../shop-config');
const { gatewayFailure } = require('./gateway-errors');
const ENDPOINT = 'https://dash.voidpayments.com/api/v1/gateway/pix/receive';
class PaymentError extends Error {
  constructor(status, message, code) { super(message); this.status = status; this.code = code; }
}
const invalid = message => { throw new PaymentError(400, message); };
const cents = n => Math.round(n * 100);
function text(value, label, max = 150) {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > max) invalid(`Informe ${label}.`);
  return value.trim();
}
function cpfValid(value) {
  if (!/^\d{11}$/.test(value) || /^(\d)\1+$/.test(value)) return false;
  for (let t = 9; t < 11; t++) {
    let sum = 0;
    for (let i = 0; i < t; i++) sum += Number(value[i]) * (t + 1 - i);
    if (((sum * 10) % 11) % 10 !== Number(value[t])) return false;
  }
  return true;
}
function buildOrder(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) invalid('Dados do pedido inválidos.');
  if (!Object.hasOwn(CONFIG.kits, input.kit) || !Object.hasOwn(CONFIG.fretes, input.frete)) invalid('Kit ou frete inválido.');
  const kit = CONFIG.kits[input.kit], shipping = CONFIG.fretes[input.frete];
  const c = input.cliente || {}, address = input.endereco || {};
  const client = {
    name: 'Cliente',
    email: text(c.email, 'um e-mail válido', 254),
    phone: text(c.telefone, 'um telefone válido', 30).replace(/\D/g, ''),
    document: text(c.cpf, 'um CPF válido', 20).replace(/\D/g, '')
  };
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(client.email)) invalid('Informe um e-mail válido.');
  if (!/^\d{10,11}$/.test(client.phone)) invalid('Informe um telefone válido.');
  if (!cpfValid(client.document)) invalid('Informe um CPF válido.');
  const endereco = {};
  for (const k of ['cep', 'rua', 'numero', 'bairro', 'cidade', 'uf']) endereco[k] = text(address[k], `o campo ${k}`, 180);
  endereco.cep = endereco.cep.replace(/\D/g, '');
  endereco.uf = endereco.uf.toUpperCase();
  if (!/^\d{8}$/.test(endereco.cep) || !/^[A-Z]{2}$/.test(endereco.uf)) invalid('CEP ou estado inválido.');
  endereco.complemento = typeof address.complemento === 'string' ? address.complemento.trim().slice(0, 180) : '';
  const products = [{ id: `${CONFIG.produtoId}-${input.kit}`, name: kit.nome, quantity: 1, price: kit.total, physical: true }];
  let total = cents(kit.total);
  const bumps = input.bumps ?? {};
  if (!bumps || typeof bumps !== 'object' || Array.isArray(bumps)) invalid('Adicionais inválidos.');
  for (const id of Object.keys(bumps).sort()) {
    const quantity = bumps[id];
    if (!Object.hasOwn(CONFIG.orderBumps, id) || !Number.isInteger(quantity) || quantity < 1 || quantity > 10) invalid('Adicional ou quantidade inválida.');
    const product = CONFIG.orderBumps[id];
    products.push({ id, name: product.nome, quantity, price: product.preco, physical: true });
    total += cents(product.preco) * quantity;
  }
  // Frete como item: amount corresponde exatamente à soma dos itens.
  // Não usamos shippingFee sem a documentação da fórmula desse campo.
  if (shipping.valor) products.push({ id: `frete-${input.frete}`, name: shipping.nome, quantity: 1, price: shipping.valor, physical: false });
  total += cents(shipping.valor);
  return { client, products, amount: total / 100, endereco, frete: input.frete };
}
function createPayments({ directory, publicKey, secretKey, fetchImpl = fetch, webhooks = null, store = createFileStore(directory) }) {
  async function paymentState(record) {
    return webhooks ? webhooks.stateFor(record) : { paid: record.paid === true, verificationAvailable: record.paid === true };
  }
  async function publicResult(record) {
    const state = await paymentState(record);
    return { ...record.result, identifier: record.identifier, total: record.order.amount, orderToken: record.orderToken, statusVerificationAvailable: state.verificationAvailable };
  }
  const inflight = new Map();
  async function generate(input, key) {
    if (typeof key !== 'string' || !/^[a-zA-Z0-9-]{16,80}$/.test(key)) invalid('Identificador da tentativa inválido.');
    const order = buildOrder(input);
    const hash = createHash('sha256').update(JSON.stringify(order)).digest('hex');
    if (inflight.has(key)) {
      const current = inflight.get(key);
      if (current.hash !== hash) throw new PaymentError(409, 'Esta tentativa já pertence a outro pedido.');
      return current.promise;
    }
    const promise = run(order, key, hash);
    inflight.set(key, { hash, promise });
    try { return await promise; } finally { inflight.delete(key); }
  }
  async function run(order, key, hash) {
    await store.init();
    const existing = await store.read(key);
    if (existing) {
      if (existing.hash !== hash) throw new PaymentError(409, 'Esta tentativa já pertence a outro pedido.');
      if (existing.result) return publicResult(existing);
      if (existing.gatewayError) throw new PaymentError(502, existing.gatewayError.message, existing.gatewayError.code);
      if (existing.gatewayHttpStatus) throw new PaymentError(409, `A tentativa anterior foi recusada pela VoidPay (HTTP ${existing.gatewayHttpStatus}), mas o motivo detalhado não foi registrado. A loja precisa conferir esta tentativa antes de gerar outra cobrança.`, 'PREVIOUS_GATEWAY_ERROR');
      throw new PaymentError(409, 'A solicitação anterior precisa ser conferida no painel da loja antes de gerar outra cobrança.');
    }
    if (!publicKey || !secretKey) throw new PaymentError(503, 'O pagamento está temporariamente indisponível.');
    const record = { identifier: key, hash, order, orderToken: randomBytes(32).toString('hex'), createdAt: new Date().toISOString(), state: 'processing' };
    // Reserva durável antes de enviar: uma falha de rede não autoriza outra cobrança.
    if (!await store.create(key, record)) throw new PaymentError(409, 'Pedido já em processamento.');
    try {
      const response = await fetchImpl(ENDPOINT, {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(25000),
        headers: { 'Content-Type': 'application/json', 'x-public-key': publicKey, 'x-secret-key': secretKey },
        body: JSON.stringify({ identifier: key, amount: order.amount, client: order.client, products: order.products, metadata: { provider: 'Campanha PINK', orderId: key } })
      });
      const data = await response.json().catch(() => null);
      if (!response.ok || ['FAILED', 'REJECTED', 'CANCELED'].includes(data?.status) || ['FAILED', 'EXPIRED', 'REFUNDED', 'CHARGED_BACK'].includes(data?.transactionStatus) || typeof data?.transactionId !== 'string' || typeof data?.pix?.code !== 'string' || !data.pix.code) {
        record.state = 'review'; record.gatewayHttpStatus = response.status;
        record.gatewayError = gatewayFailure(response.status, data, [publicKey, secretKey]);
        await store.save(key, record);
        throw new PaymentError(502, record.gatewayError.message, record.gatewayError.code);
      }
      record.paid = data.transactionStatus === 'COMPLETED';
      record.result = { transactionId: data.transactionId, pix: { code: data.pix.code } };
      if (typeof data.pix.expiresAt === 'string' && Number.isFinite(Date.parse(data.pix.expiresAt))) record.result.pix.expiresAt = data.pix.expiresAt;
      record.state = record.paid ? 'paid' : 'pending';
      await store.save(key, record);
      return publicResult(record);
    } catch (e) {
      if (e instanceof PaymentError) throw e;
      throw new PaymentError(502, 'Não foi possível confirmar a geração do Pix. Confira esta tentativa com a loja antes de repetir.');
    }
  }
  async function status(identifier, transactionId, token) {
    if (!/^[a-zA-Z0-9-]{16,80}$/.test(identifier || '')) throw new PaymentError(404, 'Pedido não encontrado.');
    const record = await store.read(identifier);
    const a = Buffer.from(token || ''), b = Buffer.from(record?.orderToken || '');
    if (!record?.result || record.result.transactionId !== transactionId || a.length !== b.length || !timingSafeEqual(a, b)) throw new PaymentError(404, 'Pedido não encontrado.');
    const state = await paymentState(record);
    return { status: state.paid ? 'paid' : 'pending', verificationAvailable: state.verificationAvailable };
  }
  return { generate, status };
}
module.exports = { buildOrder, createPayments, PaymentError };
