const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
class StorageError extends Error {
  constructor(message = 'O armazenamento de pedidos está indisponível. Tente novamente mais tarde.') {
    super(message); this.status = 503;
  }
}
async function syncDirectory(directory) {
  const handle = await fs.open(directory, 'r');
  try { await handle.sync(); } finally { await handle.close(); }
}
function createFileStore(directory) {
  if (!directory) throw new Error('Diretório de armazenamento obrigatório.');
  function fileFor(key) {
    if (!/^[a-zA-Z0-9-]{1,200}$/.test(key)) throw new StorageError();
    return path.join(directory, key + '.json');
  }
  async function init() {
    const first = await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    if (first) {
      const stop = path.dirname(path.resolve(first));
      for (let current = path.resolve(directory); ; current = path.dirname(current)) {
        await syncDirectory(current);
        if (current === stop) break;
      }
    }
  }
  async function read(key) {
    try { return JSON.parse(await fs.readFile(fileFor(key), 'utf8')); }
    catch (e) { if (e.code === 'ENOENT') return null; throw e; }
  }
  async function write(key, value, onlyIfAbsent) {
    await init();
    const file = fileFor(key), temp = file + '.' + randomUUID() + '.tmp';
    try {
      const handle = await fs.open(temp, 'wx', 0o600);
      try { await handle.writeFile(JSON.stringify(value)); await handle.sync(); }
      finally { await handle.close(); }
      if (onlyIfAbsent) {
        try { await fs.link(temp, file); }
        catch (e) {
          if (e.code !== 'EEXIST') throw e;
          await syncDirectory(directory);
          return false;
        }
      } else await fs.rename(temp, file);
      await syncDirectory(directory);
      return true;
    } finally { await fs.unlink(temp).catch(e => { if (e.code !== 'ENOENT') throw e; }); }
  }
  return { init, read, create: (key, value) => write(key, value, true), save: (key, value) => write(key, value, false) };
}
function createRedisStore({ url, token, prefix, fetchImpl = fetch }) {
  let endpoint;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.search || parsed.hash || parsed.pathname !== '/') throw new Error();
    endpoint = parsed.origin;
    if (!token || !/^[a-zA-Z0-9:_-]{1,150}$/.test(prefix)) throw new Error();
  } catch { throw new StorageError('Configure o armazenamento Redis do projeto.'); }
  function keyFor(key) {
    if (!/^[a-zA-Z0-9-]{1,200}$/.test(key)) throw new StorageError();
    return prefix + ':' + key;
  }
  async function command(args) {
    try {
      const response = await fetchImpl(endpoint, {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(8000),
        headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
        body: JSON.stringify(args), cache: 'no-store'
      });
      const data = await response.json();
      if (!response.ok || !data || data.error || !Object.hasOwn(data, 'result')) throw new Error();
      return data.result;
    } catch { throw new StorageError(); }
  }
  return {
    async init() {},
    async read(key) {
      const result = await command(['GET', keyFor(key)]);
      if (result === null) return null;
      try {
        if (typeof result !== 'string') throw new Error();
        return JSON.parse(result);
      } catch { throw new StorageError(); }
    },
    async create(key, value) {
      // SET NX é atômico no banco, inclusive entre funções Vercel diferentes.
      const result = await command(['SET', keyFor(key), JSON.stringify(value), 'NX']);
      if (result === null) return false;
      if (result !== 'OK') throw new StorageError();
      return true;
    },
    async save(key, value) {
      if (await command(['SET', keyFor(key), JSON.stringify(value)]) !== 'OK') throw new StorageError();
    }
  };
}
function unavailableStore() {
  const fail = async () => { throw new StorageError('O armazenamento de pedidos ainda não foi configurado.'); };
  return { init: fail, read: fail, create: fail, save: fail };
}
function configuredStore({ directory, collection, env = process.env, fetchImpl = fetch }) {
  const url = env.UPSTASH_REDIS_REST_URL || env.KV_REST_API_URL;
  const token = env.UPSTASH_REDIS_REST_TOKEN || env.KV_REST_API_TOKEN;
  if (url || token) {
    if (!url || !token) return unavailableStore();
    const prefix = env.PINK_STORAGE_PREFIX || `campanha-pink:${env.VERCEL_ENV || 'local'}`;
    try { return createRedisStore({ url, token, prefix: `${prefix}:${collection}`, fetchImpl }); }
    catch { return unavailableStore(); }
  }
  // Nunca usar filesystem efêmero ou /tmp para cobranças na Vercel.
  if (env.VERCEL) return unavailableStore();
  return createFileStore(directory);
}
module.exports = { StorageError, createFileStore, createRedisStore, configuredStore };
