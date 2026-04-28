import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import { fileURLToPath, URL } from 'node:url';

function parseEnv(path) {
  try {
    const src = fs.readFileSync(path, 'utf8');
    return src.split(/\r?\n/).reduce((acc, line) => {
      line = line.trim();
      if (!line || line.startsWith('#')) return acc;
      const eq = line.indexOf('=');
      if (eq === -1) return acc;
      const k = line.slice(0, eq).trim();
      const v = line.slice(eq + 1).trim();
      acc[k] = v;
      return acc;
    }, {});
  } catch {
    return {};
  }
}

function gatherEnvRpcUrls() {
  const candidates = ['./.env', './control-plane/.env'];
  const urls = new Map();
  for (const p of candidates) {
    const env = parseEnv(p);
    for (const [k, v] of Object.entries(env)) {
      if (!v) continue;
      if (/RPC_URL|RPC|WS_RPC_URL|FORK_RPC_URL/i.test(k) && /^https?:\/\//i.test(v)) {
        urls.set(v, { key: k, file: p });
      }
    }
  }
  return urls;
}

function gatherCliRpcUrls(argv) {
  const urls = new Map();
  for (const value of argv) {
    if (/^https?:\/\//i.test(value)) {
      urls.set(value, { key: 'CLI_ARG', file: 'argv' });
    }
  }
  return urls;
}

function displayUrl(urlString) {
  try {
    const url = new URL(urlString);
    const parts = url.pathname.split('/').filter(Boolean);
    if (!parts.length) return url.origin;
    parts[parts.length - 1] = '***';
    return `${url.origin}/${parts.join('/')}`;
  } catch {
    return urlString;
  }
}

function requestJsonRpc(urlString, timeout = 8000) {
  return new Promise((resolve) => {
    const url = new URL(urlString);
    const payload = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_blockNumber', params: [] });
    const opts = {
      method: 'POST',
      hostname: url.hostname,
      path: url.pathname + url.search,
      port: url.port || (url.protocol === 'https:' ? 443 : 80),
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
      },
    };

    const lib = url.protocol === 'https:' ? https : http;
    const start = Date.now();
    const req = lib.request(opts, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        body += chunk;
      });
      res.on('end', () => {
        const ms = Date.now() - start;
        let ok = false;
        try {
          const j = JSON.parse(body);
          ok = Boolean(j.result) || j.error === undefined;
        } catch {
          ok = false;
        }
        resolve({ url: urlString, ok, ms, statusCode: res.statusCode });
      });
    });

    req.on('error', (err) => {
      const ms = Date.now() - start;
      resolve({ url: urlString, ok: false, ms, error: String(err) });
    });

    req.setTimeout(timeout, () => {
      req.destroy();
      const ms = Date.now() - start;
      resolve({ url: urlString, ok: false, ms, error: 'timeout' });
    });

    req.write(payload);
    req.end();
  });
}

async function main() {
  const urls = gatherCliRpcUrls(process.argv.slice(2));
  for (const [url, meta] of gatherEnvRpcUrls()) {
    if (!urls.has(url)) urls.set(url, meta);
  }

  if (!urls.size) {
    console.error('No HTTP RPC URLs found in CLI args or .env files.');
    process.exitCode = 2;
    return;
  }

  console.log('Found RPC endpoints:');
  for (const [u, meta] of urls) {
    console.log('-', meta.key, 'in', meta.file, '->', displayUrl(u));
  }

  const results = await Promise.all([...urls.keys()].map((u) => requestJsonRpc(u)));

  console.log('\nResults:');
  results.sort((a, b) => (a.ms || 0) - (b.ms || 0));
  for (const [index, r] of results.entries()) {
    const rank = `#${index + 1}`;
    if (r.ok) {
      console.log(`${rank} ${displayUrl(r.url)} - ${r.ms} ms (HTTP ${r.statusCode || ''})`);
    } else {
      console.log(`${rank} ${displayUrl(r.url)} - failed ${r.ms} ms ${r.error ? '- ' + r.error : ''}`);
    }
  }
}

const isMainModule = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];

if (isMainModule) main();
