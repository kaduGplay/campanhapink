const { randomBytes, createHash, timingSafeEqual } = require('node:crypto');
const { createFileStore } = require('./storage');
const CONFIG = require('../shop-config');
const { gatewayFailure } = require('./gateway-errors');
const ENDPOINT = 'https://dash.voidpayments.com/api/v1/gateway/pix/receive';
const TRANSACTIONS = 'https://dash.voidpayments.com/api/v1/gateway/transactions';
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
const field = (object, ...keys) => { for (const k of keys) if (typeof object?.[k] === 'string' && object[k]) return object[k]; };
function createPayments({ directory, publicKey, secretKey, fetchImpl = fetch, webhooks = null, store = createFileStore(directory), callbackUrl = '', confirmWithGateway = false, onPaid = null }) {
  const lookupEnabled = Boolean(confirmWithGateway && publicKey && secretKey);
  async function paymentState(record) {
    const state = webhooks ? await webhooks.stateFor(record) : { paid: record.paid === true, verificationAvailable: record.paid === true };
    return lookupEnabled ? { ...state, verificationAvailable: true } : state;
  }
  const lastLookup = new Map();
  function lookupDue(identifier, interval) {
    const now = Date.now();
    if (now - (lastLookup.get(identifier) || 0) < interval) return false;
    if (lastLookup.size > 5000) lastLookup.clear();
    lastLookup.set(identifier, now);
    return true;
  }
  // Consulta autenticada: só COMPLETED com transação, pedido, valor, moeda e método conferidos confirma o pagamento.
  async function lookup(record) {
    const response = await fetchImpl(`${TRANSACTIONS}?id=${encodeURIComponent(record.result.transactionId)}`, {
      redirect: 'error', signal: AbortSignal.timeout(8000), cache: 'no-store',
      headers: { 'x-public-key': publicKey, 'x-secret-key': secretKey }
    });
    const tx = await response.json().catch(() => null);
    if (!response.ok || tx?.id !== record.result.transactionId) throw new Error('Consulta indisponível.');
    const matches = (!tx.clientIdentifier || tx.clientIdentifier === record.identifier) && tx.paymentMethod === 'PIX' && tx.currency === 'BRL'
      && typeof tx.amount === 'number' && Math.round(tx.amount * 100) === Math.round(record.order.amount * 100);
    if (!matches || tx.status !== 'COMPLETED') return { paid: false };
    return { paid: true, paidAt: typeof tx.payedAt === 'string' && Number.isFinite(Date.parse(tx.payedAt)) ? tx.payedAt : new Date().toISOString() };
  }
  async function sync(record, { interval = 15000, strict = false } = {}) {
    let state = await paymentState(record);
    if (!state.paid && lookupEnabled && lookupDue(record.identifier, interval)) {
      try {
        const found = await lookup(record);
        if (found.paid) { state = { paid: true, verificationAvailable: true }; record.paidAt = found.paidAt; }
      } catch { if (strict) throw new PaymentError(503, 'Não foi possível consultar o pagamento. Reenvie o aviso.'); }
    }
    if (state.paid) {
      let changed = false;
      if (!record.paid) { record.paid = true; record.state = 'paid'; record.paidAt = record.paidAt || new Date().toISOString(); changed = true; }
      // Purchase é enviado uma vez por pedido; o ID do evento também deduplica na Meta.
      if (onPaid && !record.purchaseNotifiedAt && await onPaid(record)) { record.purchaseNotifiedAt = new Date().toISOString(); changed = true; }
      if (changed) await store.save(record.identifier, record);
    }
    return state;
  }
  async function publicResult(record) {
    const state = await paymentState(record);
    return { ...record.result, identifier: record.identifier, total: record.order.amount, orderToken: record.orderToken, statusVerificationAvailable: state.verificationAvailable };
  }
  const inflight = new Map();
  async function generate(input, key, context = {}) {
    if (typeof key !== 'string' || !/^[a-zA-Z0-9-]{16,80}$/.test(key)) invalid('Identificador da tentativa inválido.');
    const order = buildOrder(input);
    const hash = createHash('sha256').update(JSON.stringify(order)).digest('hex');
    if (inflight.has(key)) {
      const current = inflight.get(key);
      if (current.hash !== hash) throw new PaymentError(409, 'Esta tentativa já pertence a outro pedido.');
      return current.promise;
    }
    const promise = run(order, key, hash, context.attribution);
    inflight.set(key, { hash, promise });
    try { return await promise; } finally { inflight.delete(key); }
  }
  async function run(order, key, hash, attribution) {
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
    const record = { identifier: key, hash, order, orderToken: randomBytes(32).toString('hex'), createdAt: new Date().toISOString(), state: 'processing', ...(attribution ? { attribution } : {}) };
    // Reserva durável antes de enviar: uma falha de rede não autoriza outra cobrança.
    if (!await store.create(key, record)) throw new PaymentError(409, 'Pedido já em processamento.');
    try {
      const response = await fetchImpl(ENDPOINT, {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(25000),
        headers: { 'Content-Type': 'application/json', 'x-public-key': publicKey, 'x-secret-key': secretKey },
        // callbackUrl registra na VoidPay o aviso desta cobrança (gerada e paga), sem cadastro manual no painel.
        body: JSON.stringify({ identifier: key, amount: order.amount, client: order.client, products: order.products, metadata: { provider: 'Campanha PINK', orderId: key }, ...(callbackUrl ? { callbackUrl } : {}) })
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
      // Índice opcional para avisos que tragam só o ID da transação.
      if (/^[a-zA-Z0-9-]{1,190}$/.test(data.transactionId)) await store.save('tx-' + data.transactionId, { identifier: key }).catch(() => {});
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
    const state = await sync(record);
    return { status: state.paid ? 'paid' : 'pending', verificationAvailable: state.verificationAvailable };
  }
  // Aviso do callbackUrl: o corpo só indica qual pedido conferir; o status vem da consulta autenticada.
  async function notify(payload) {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) invalid('Notificação inválida.');
    const nested = [payload.data?.transaction, payload.transaction, payload.data].find(v => v && typeof v === 'object' && !Array.isArray(v)) || {};
    const transactionId = field(nested, 'id', 'transactionId') || field(payload, 'transactionId');
    const identifier = field(nested, 'identifier', 'clientIdentifier') || field(payload, 'identifier', 'clientIdentifier');
    let record = /^[a-zA-Z0-9-]{16,80}$/.test(identifier || '') ? await store.read(identifier) : null;
    if (!record?.order && /^[a-zA-Z0-9-]{1,190}$/.test(transactionId || '')) {
      const index = await store.read('tx-' + transactionId);
      if (typeof index?.identifier === 'string') record = await store.read(index.identifier);
    }
    if (!record?.order) throw new PaymentError(404, 'Pedido não encontrado.');
    if (!record.result) throw new PaymentError(503, 'Cobrança ainda sendo registrada. Reenvie o aviso.');
    const state = await sync(record, { interval: 2000, strict: true });
    const declared = [payload.event, payload.status, nested.status].filter(v => typeof v === 'string').join(' ');
    if (!state.paid && /PAID|COMPLETED|APPROVED/i.test(declared)) throw new PaymentError(503, 'Pagamento ainda não confirmado pela VoidPay. Reenvie o aviso.');
    return { status: state.paid ? 'paid' : 'pending' };
  }
  return { generate, status, notify };
}
module.exports = { buildOrder, createPayments, PaymentError };
