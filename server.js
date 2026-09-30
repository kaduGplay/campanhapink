const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { createPayments, PaymentError } = require('./lib/payments');
const { createWebhooks, WebhookError, publicOrigin } = require('./lib/voidpay-webhooks');
const { configuredStore, StorageError } = require('./lib/storage');
const { createMeta } = require('./lib/meta');
const CONFIG = require('./shop-config');
if (!process.env.VERCEL) {
  try { process.loadEnvFile(path.join(__dirname, '.env')); }
  catch (e) { if (e.code !== 'ENOENT') throw e; }
}
const root = __dirname;
const types = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.webp': 'image/webp', '.woff2': 'font/woff2', '.ttf': 'font/ttf' };
const webhookStore = configuredStore({ directory: path.join(root, '.data/webhooks'), collection: 'webhooks' });
const orderStore = configuredStore({ directory: path.join(root, '.data/orders'), collection: 'orders' });
const webhooks = createWebhooks({ store: webhookStore, token: process.env.GATEWAY_WEBHOOK_TOKEN, publicBaseUrl: process.env.PUBLIC_BASE_URL });
const webhookRoutes = {
  '/api/webhooks/voidpay/created': 'TRANSACTION_CREATED',
  '/api/webhooks/voidpay/paid': 'TRANSACTION_PAID'
};
const siteOrigin = publicOrigin(process.env.PUBLIC_BASE_URL);
const meta = createMeta({ token: process.env.META_ACCESS_TOKEN, testEventCode: process.env.META_TEST_EVENT_CODE, origin: siteOrigin });
const payments = createPayments({
  webhooks, store: orderStore, publicKey: process.env.VOIDPAY_PUBLIC_KEY, secretKey: process.env.VOIDPAY_SECRET_KEY,
  callbackUrl: siteOrigin ? siteOrigin + '/api/webhooks/voidpay' : '', confirmWithGateway: true, onPaid: record => meta.purchase(record)
});
function json(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(data));
}
async function body(req, limit = 16384) {
  if (!req.headers['content-type']?.startsWith('application/json')) throw new PaymentError(415, 'Envie os dados em JSON.');
  // A Vercel pode entregar o JSON já interpretado em request.body.
  let parsed;
  try { parsed = req.body; } catch { throw new PaymentError(400, 'JSON inválido.'); }
  if (parsed !== undefined) {
    const raw = Buffer.isBuffer(parsed) ? parsed.toString('utf8') : typeof parsed === 'string' ? parsed : JSON.stringify(parsed);
    if (Buffer.byteLength(raw) > limit) throw new PaymentError(413, 'Pedido muito grande.');
    try { return JSON.parse(raw); } catch { throw new PaymentError(400, 'JSON inválido.'); }
  }
  let size = 0; const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new PaymentError(413, 'Pedido muito grande.');
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new PaymentError(400, 'JSON inválido.'); }
}
function sameOrigin(req) {
  const origin = req.headers.origin;
  if ((origin && new URL(origin).host !== req.headers.host) || req.headers['sec-fetch-site'] === 'cross-site') throw new PaymentError(403, 'Origem não permitida.');
}
function createHandler({ paymentService = payments, webhookService = webhooks, metaService = meta, apiOnly = false } = {}) {
  return async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'same-origin');
    let url, pathname;
    try { url = new URL(req.url, 'http://localhost'); pathname = decodeURIComponent(url.pathname); }
    catch { return json(res, 400, { message: 'Endereço inválido.' }); }
    if (pathname.startsWith('/api/')) {
      try {
        if (Object.hasOwn(webhookRoutes, pathname)) {
          if (req.method !== 'POST') return json(res, 405, { message: 'Método não permitido.' });
          const result = await webhookService.receive(await body(req, 131072), webhookRoutes[pathname]);
          console.info(JSON.stringify({ scope: 'voidpay-webhook', event: webhookRoutes[pathname], outcome: result.duplicate ? 'duplicate' : 'accepted' }));
          return json(res, 200, result);
        }
        if (pathname === '/api/webhooks/voidpay') {
          if (req.method !== 'POST') return json(res, 405, { message: 'Método não permitido.' });
          const result = await paymentService.notify(await body(req, 131072));
          console.info(JSON.stringify({ scope: 'voidpay-callback', outcome: result.status }));
          return json(res, 200, result);
        }
        if (pathname === '/api/cpf' && req.method === 'GET') return json(res, 200, { nome: null });
        if (pathname === '/api/pix' && req.method === 'POST') {
          sameOrigin(req);
          return json(res, 200, await paymentService.generate(await body(req), req.headers['idempotency-key'], { attribution: metaService.attribution(req) }));
        }
        if (pathname === '/api/meta/event' && req.method === 'POST') {
          sameOrigin(req);
          const data = await body(req, 2048);
          if (data?.event !== 'AddToCart' || !Object.hasOwn(CONFIG.kits, data.kit) || !/^atc:[a-zA-Z0-9-]{16,80}$/.test(data.eventId || '')) throw new PaymentError(400, 'Evento inválido.');
          return json(res, 200, { sent: await metaService.addToCart(data.kit, data.eventId, metaService.attribution(req)) });
        }
        if (pathname === '/api/status' && req.method === 'GET') {
          return json(res, 200, await paymentService.status(url.searchParams.get('order'), url.searchParams.get('id'), req.headers.authorization?.replace(/^Bearer /, '')));
        }
        return json(res, 404, { message: 'Rota não encontrada.' });
      } catch (e) {
        const known = e instanceof PaymentError || e instanceof WebhookError || e instanceof StorageError;
        if (Object.hasOwn(webhookRoutes, pathname)) console.warn(JSON.stringify({ scope: 'voidpay-webhook', event: webhookRoutes[pathname], outcome: 'rejected', status: known ? e.status : 500 }));
        if (pathname === '/api/webhooks/voidpay') console.warn(JSON.stringify({ scope: 'voidpay-callback', outcome: 'rejected', status: known ? e.status : 500 }));
        return json(res, known ? e.status : 500, { message: known ? e.message : 'Não foi possível processar o pedido.', ...(e instanceof PaymentError && e.code ? { code: e.code } : {}) });
      }
    }
    if (apiOnly) return json(res, 404, { message: 'Rota não encontrada.' });
    if (!['GET', 'HEAD'].includes(req.method)) return json(res, 405, { message: 'Método não permitido.' });
    if (pathname === '/loja' || pathname === '/loja/') {
      res.writeHead(302, { Location: '/parte%201/index.html' }); return res.end();
    }
    if (pathname.endsWith('/')) pathname += 'index.html';
    // Somente arquivos públicos. Chaves, pedidos e código do servidor não são servidos.
    const allowed = ['/index.html', '/checkout.html', '/shop-config.js', '/parte 1/index.html'].includes(pathname)
      || /^\/(?:images|fonts|js|odb|banners checkout|parte 1\/(?:images|css))\/[a-zA-Z0-9_. /-]+$/.test(pathname);
    const file = path.resolve(root, '.' + pathname);
    if (!allowed || !types[path.extname(file)] || !file.startsWith(root + path.sep) || pathname.split('/').some(p => p.startsWith('.'))) return json(res, 404, { message: 'Arquivo não encontrado.' });
    fs.readFile(file, (err, data) => {
      if (err) return json(res, 404, { message: 'Arquivo não encontrado.' });
      res.setHeader('Content-Type', types[path.extname(file)]);
      if (pathname === '/checkout.html') {
        data = Buffer.from(data.toString('utf8').replace('<head>', '<head><meta name="pink-runtime" content="node">'));
        res.setHeader('Cache-Control', 'no-store');
      }
      res.end(req.method === 'HEAD' ? undefined : data);
    });
  };
}
function createServer(options) { return http.createServer(createHandler(options)); }
const server = createServer();
if (require.main === module) {
  const port = Number(process.env.PORT || 58327), host = process.env.HOST || '127.0.0.1';
  server.listen(port, host, () => console.log(`Campanha PINK: http://${host}:${port}`));
}
module.exports = server;

module.exports.createServer = createServer;

module.exports.createHandler = createHandler;
