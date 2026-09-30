const { createHash } = require('node:crypto');
const { isIP } = require('node:net');
const CONFIG = require('../shop-config');
const GRAPH = 'https://graph.facebook.com/v26.0';
const sha = value => createHash('sha256').update(value).digest('hex');
const plain = value => String(value || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]/g, '');
// Atribuição capturada na requisição do próprio cliente, nunca na notificação da VoidPay.
function attribution(req) {
  const cookies = new Map(String(req.headers.cookie || '').split(';').map(part => {
    const i = part.indexOf('=');
    return [part.slice(0, i).trim(), part.slice(i + 1).trim()];
  }));
  const result = {};
  for (const key of ['fbp', 'fbc']) {
    const value = cookies.get('_' + key);
    if (value && value.length <= 500 && /^fb\.\d+\.\d+\.[A-Za-z0-9_.-]+$/.test(value)) result[key] = value;
  }
  const ip = String(req.headers['x-vercel-forwarded-for'] || req.headers['x-forwarded-for'] || req.socket?.remoteAddress || '').split(',')[0].trim();
  if (isIP(ip)) result.client_ip_address = ip;
  const agent = req.headers['user-agent'];
  if (typeof agent === 'string' && agent) result.client_user_agent = agent.slice(0, 1000);
  return result;
}
// Dados pessoais seguem para a Meta somente em SHA-256, normalizados conforme a API de Conversões.
function userData(order, attr = {}) {
  const client = order.client || {}, address = order.endereco || {};
  const data = { ...attr, country: [sha('br')] };
  if (client.email) data.em = [sha(client.email.trim().toLowerCase())];
  if (client.phone) data.ph = [sha('55' + client.phone.replace(/\D/g, ''))];
  if (address.cep) data.zp = [sha(address.cep.replace(/\D/g, ''))];
  if (address.cidade) data.ct = [sha(plain(address.cidade))];
  if (address.uf) data.st = [sha(address.uf.toLowerCase())];
  return data;
}
function purchaseEvent(record, origin) {
  const items = record.order.products.filter(p => p.physical);
  const paidAt = Date.parse(record.paidAt);
  return {
    event_name: 'Purchase',
    event_id: 'purchase:' + record.identifier,
    event_time: Math.floor(Math.min(Date.now(), Number.isFinite(paidAt) ? paidAt : Date.now()) / 1000),
    action_source: 'website',
    event_source_url: origin + '/checkout.html',
    user_data: userData(record.order, record.attribution),
    custom_data: {
      value: record.order.amount, currency: 'BRL', content_type: 'product',
      content_ids: items.map(p => p.id),
      contents: items.map(p => ({ id: p.id, quantity: p.quantity, item_price: p.price })),
      num_items: items.reduce((sum, p) => sum + p.quantity, 0),
      order_id: record.identifier
    }
  };
}
function addToCartEvent(kitId, eventId, attr, origin) {
  const kit = CONFIG.kits[kitId], id = `${CONFIG.produtoId}-${kitId}`;
  return {
    event_name: 'AddToCart',
    event_id: eventId,
    event_time: Math.floor(Date.now() / 1000),
    action_source: 'website',
    event_source_url: `${origin}/checkout.html?kit=${kitId}`,
    user_data: attr,
    custom_data: { value: kit.total, currency: 'BRL', content_type: 'product', content_ids: [id], contents: [{ id, quantity: 1, item_price: kit.total }], num_items: 1 }
  };
}
function createMeta({ pixelId = CONFIG.metaPixelId, token = '', testEventCode = '', origin = '', fetchImpl = fetch } = {}) {
  const enabled = Boolean(pixelId && token && origin);
  // A indisponibilidade da Meta nunca bloqueia checkout nem confirmação de pagamento.
  async function send(events) {
    if (!enabled) return false;
    try {
      const response = await fetchImpl(`${GRAPH}/${pixelId}/events`, {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(8000), cache: 'no-store',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
        body: JSON.stringify({ data: events, ...(testEventCode ? { test_event_code: testEventCode } : {}) })
      });
      const result = await response.json().catch(() => null);
      if (response.ok && result?.events_received === events.length) return true;
      console.warn(JSON.stringify({ scope: 'meta-capi', events: events.map(e => e.event_name), status: response.status, code: typeof result?.error?.code === 'number' ? result.error.code : null }));
    } catch {
      console.warn(JSON.stringify({ scope: 'meta-capi', events: events.map(e => e.event_name), status: 'network_error' }));
    }
    return false;
  }
  return {
    enabled,
    attribution,
    purchase: record => send([purchaseEvent(record, origin)]),
    addToCart: (kitId, eventId, attr) => send([addToCartEvent(kitId, eventId, attr, origin)])
  };
}
module.exports = { createMeta, attribution, userData, purchaseEvent, addToCartEvent };
