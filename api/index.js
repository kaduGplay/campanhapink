const { createHandler } = require('../server');
const handler = createHandler({ apiOnly: true });
module.exports = async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const route = url.searchParams.get('__pink_route');
  if (route !== null) {
    if (!/^[a-zA-Z0-9/-]+$/.test(route)) {
      res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify({ message: 'Rota inválida.' }));
    }
    url.searchParams.delete('__pink_route');
    req.url = '/api/' + route + (url.searchParams.size ? '?' + url.searchParams : '');
  }
  return handler(req, res);
};
