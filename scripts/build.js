const fs = require('node:fs/promises');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const output = path.join(root, 'dist');
const publicFiles = ['index.html', 'checkout.html', 'shop-config.js', 'parte 1/index.html'];
const publicDirectories = ['images', 'fonts', 'js', 'odb', 'banners checkout', 'parte 1/images', 'parte 1/css'];
const extensions = new Set(['.png', '.jpg', '.jpeg', '.svg', '.webp', '.woff', '.woff2', '.ttf', '.css', '.js']);
async function copy(relative) {
  const source = path.join(root, relative), destination = path.join(output, relative);
  const info = await fs.lstat(source);
  if (info.isSymbolicLink()) throw new Error('Links simbólicos não são permitidos no build público.');
  if (info.isDirectory()) {
    for (const name of await fs.readdir(source)) {
      if (!name.startsWith('.')) await copy(path.join(relative, name));
    }
    return;
  }
  if (!publicFiles.includes(relative) && !extensions.has(path.extname(relative))) return;
  await fs.mkdir(path.dirname(destination), { recursive: true });
  let content = await fs.readFile(source);
  if (relative === 'checkout.html') content = Buffer.from(content.toString('utf8').replace('<head>', '<head><meta name="pink-runtime" content="node">'));
  await fs.writeFile(destination, content);
}
async function build() {
  await fs.rm(output, { recursive: true, force: true });
  await fs.mkdir(output, { recursive: true });
  for (const entry of [...publicFiles, ...publicDirectories]) await copy(entry);
  console.log('Build concluído em dist/: somente páginas e recursos públicos.');
}
if (require.main === module) build().catch(() => { console.error('Não foi possível gerar o build público.'); process.exit(1); });
module.exports = { build };
