const { createFileStore } = require('./storage');
const { createHash, timingSafeEqual } = require('node:crypto');
class WebhookError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const fail = () => { throw new WebhookError(400, 'Notificação inválida.'); };
const obj = v => { if (!v || typeof v !== 'object' || Array.isArray(v)) fail(); return v; };
const str = (v, empty = false) => { if (typeof v !== 'string' || (!empty && !v.trim()) || v.length > 12000) fail(); };
const nullableString = v => { if (v !== null) str(v, true); };
const num = (v, min = 0) => { if (typeof v !== 'number' || !Number.isFinite(v) || v < min) fail(); };
const integer = (v, min = 1) => { num(v, min); if (!Number.isSafeInteger(v)) fail(); };
const oneOf = (v, values) => { if (!values.includes(v)) fail(); };
const date = v => { str(v); if (!/^\d{4}-\d{2}-\d{2}T/.test(v) || !Number.isFinite(Date.parse(v))) fail(); };
function subscription(v) {
  if (v === null) return;
  obj(v); str(v.id); str(v.identifier); integer(v.cycle); date(v.startAt);
  oneOf(v.intervalType, ['DAYS', 'WEEKS', 'MONTHS', 'YEARS']); integer(v.intervalCount);
  oneOf(v.status, ['ACTIVE', 'INACTIVE', 'CANCELED']);
}
function items(v) {
  if (!Array.isArray(v) || v.length > 100) fail();
  for (const item of v) {
    obj(item); str(item.id); num(item.price); obj(item.product);
    for (const k of ['id', 'name', 'externalId']) str(item.product[k], true);
  }
}
function tracking(v) {
  obj(v);
  for (const k of ['utm_id', 'utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term', 'fbc', 'fbp', 'ip', 'country', 'user_agent', 'zip_code', 'city', 'state']) {
    if (v[k] !== undefined) str(v[k], true);
  }
  if (v.isUpsell !== undefined && typeof v.isUpsell !== 'boolean') fail();
}
function validate(payload, event) {
  obj(payload);
  if (payload.event !== event || !['TRANSACTION_CREATED', 'TRANSACTION_PAID'].includes(event)) fail();
  str(payload.offerCode, true); str(payload.checkoutUrl, true);
  const c = obj(payload.client);
  for (const k of ['id', 'name', 'email', 'phone']) str(c[k], true);
  nullableString(c.cpf); nullableString(c.cnpj);
  if (c.address !== null) {
    obj(c.address);
    for (const k of ['country', 'zipCode', 'state', 'city', 'neighborhood', 'street', 'number']) str(c.address[k], true);
    if (c.address.complement !== undefined) nullableString(c.address.complement);
  }
  const tx = obj(payload.transaction);
  str(tx.id); if (tx.id.length > 200) fail();
  if (tx.identifier !== undefined) nullableString(tx.identifier);
  oneOf(tx.status, ['COMPLETED', 'FAILED', 'PENDING', 'REFUNDED', 'CHARGED_BACK']);
  oneOf(tx.paymentMethod, ['CREDIT_CARD', 'PIX', 'BOLETO', 'CRYPTO']);
  num(tx.amount, 0.01); num(tx.originalAmount, 0.01);
  if (!Number.isSafeInteger(Math.round(tx.amount * 100)) || Math.abs(tx.amount * 100 - Math.round(tx.amount * 100)) > 0.000001) fail();
  str(tx.currency); str(tx.originalCurrency);
  if (!/^[A-Z]{3}$/.test(tx.currency) || !/^[A-Z]{3}$/.test(tx.originalCurrency)) fail();
  integer(tx.installments); date(tx.createdAt);
  if (tx.payedAt !== null) date(tx.payedAt);
  if (tx.exchangeRate !== undefined) num(tx.exchangeRate, Number.MIN_VALUE);
  if (tx.commissionAmount !== undefined) num(tx.commissionAmount);
  if (event === 'TRANSACTION_PAID' && (tx.status !== 'COMPLETED' || tx.payedAt === null)) fail();
  if (tx.pixInformation != null) {
    const pix = obj(tx.pixInformation);
    if (pix.id !== undefined) str(pix.id);
    str(pix.qrCode, true); nullableString(pix.endToEndId);
  }
  if (tx.boletoInformation != null) {
    const boleto = obj(tx.boletoInformation);
    for (const k of ['transactionId', 'id', 'barcode', 'digitableLine', 'pdfUrl', 'instructions']) str(boleto[k], true);
    date(boleto.createdAt); date(boleto.updatedAt);
  }
  // A documentação mostra estes campos tanto na raiz quanto dentro de transaction.
  for (const parent of [payload, tx]) {
    if (parent.subscription !== undefined) subscription(parent.subscription);
    if (parent.orderItems !== undefined) items(parent.orderItems);
    if (parent.trackProps !== undefined) tracking(parent.trackProps);
  }
  return tx;
}
function createWebhooks({ directory, token = '', publicBaseUrl = '', store = createFileStore(directory) }) {
  let publicUrlValid = false;
  try {
    const url = new URL(publicBaseUrl);
    publicUrlValid = url.protocol === 'https:' && !url.username && !url.password && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  } catch {}
  const enabled = Boolean(token && publicUrlValid);
  function keyFor(event, id) {
    return createHash('sha256').update(event + ':' + id).digest('hex');
  }
  async function receive(payload, expectedEvent) {
    // Autenticação precede validação de negócio, persistência e efeitos.
    if (!token) throw new WebhookError(503, 'Receptor de notificações não configurado.');
    const supplied = typeof payload?.token === 'string' ? payload.token : '';
    const a = Buffer.from(supplied), b = Buffer.from(token);
    if (!supplied || a.length !== b.length || !timingSafeEqual(a, b)) throw new WebhookError(401, 'Notificação não autorizada.');
    const tx = validate(payload, expectedEvent);
    /** @type {import('./voidpay-webhooks').Receipt} */
    const receipt = {
      event: expectedEvent, transactionId: tx.id, identifier: tx.identifier || null,
      status: tx.status, paymentMethod: tx.paymentMethod,
      amountCents: Math.round(tx.amount * 100), currency: tx.currency,
      createdAt: tx.createdAt, paidAt: tx.payedAt, receivedAt: new Date().toISOString()
    };
    const key = keyFor(expectedEvent, tx.id);
    const duplicate = !await store.create(key, receipt);
    if (duplicate) {
      const old = await store.read(key);
      for (const k of ['event', 'transactionId', 'identifier', 'status', 'paymentMethod', 'amountCents', 'currency']) {
        if (old?.[k] !== receipt[k]) throw new WebhookError(409, 'Notificação conflitante para esta transação.');
      }
    }
    return { accepted: true, duplicate };
  }
  async function stateFor(record) {
    let paid = record.paid === true;
    if (!paid && record.result?.transactionId) {
      const receipt = await store.read(keyFor('TRANSACTION_PAID', record.result.transactionId));
      paid = Boolean(receipt && receipt.event === 'TRANSACTION_PAID' && receipt.status === 'COMPLETED'
        && receipt.transactionId === record.result.transactionId
        && (!receipt.identifier || receipt.identifier === record.identifier)
        && receipt.paymentMethod === 'PIX' && receipt.currency === 'BRL'
        && receipt.amountCents === Math.round(record.order.amount * 100));
    }
    return { paid, verificationAvailable: paid || enabled };
  }
  return { enabled, receive, stateFor };
}
module.exports = { createWebhooks, WebhookError };
