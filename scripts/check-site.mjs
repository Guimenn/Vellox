import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

const root = process.cwd();
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const localAssets = [...html.matchAll(/(?:src|href)="(public\/[^"]+)"/g)].map(match => match[1]);
const missing = [...new Set(localAssets)].filter(asset => !fs.existsSync(path.join(root, asset)));
if (missing.length) throw new Error('Missing landing assets: ' + missing.join(', '));

const server = http.createServer((request, response) => {
  const relative = request.url === '/' ? 'index.html' : decodeURIComponent(request.url || '/').replace(/^\/+/, '');
  const file = path.resolve(root, relative);
  if (!file.startsWith(root + path.sep) || !fs.existsSync(file)) {
    response.writeHead(404).end();
    return;
  }
  response.writeHead(200, { 'content-type': file.endsWith('.png') ? 'image/png' : 'text/html; charset=utf-8' });
  fs.createReadStream(file).pipe(response);
});

await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
try {
  const address = server.address();
  const base = 'http://127.0.0.1:' + address.port;
  const rootResponse = await fetch(base + '/');
  if (!rootResponse.ok || !(await rootResponse.text()).includes('<title>Vellox')) throw new Error('Landing root smoke test failed.');
  await Promise.all([...new Set(localAssets)].map(async asset => {
    const response = await fetch(base + '/' + asset);
    if (!response.ok) throw new Error('Asset smoke test failed: ' + asset);
  }));
  console.log('Landing root and ' + new Set(localAssets).size + ' local assets passed.');
} finally {
  await new Promise(resolve => server.close(resolve));
}
