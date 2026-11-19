import { createServer } from 'node:http';

const counts = new Map();
const sink = createServer(async (request, response) => {
  if (request.method === 'POST' && request.url === '/logs') {
    try {
      let body = '';
      for await (const chunk of request) {
        body += chunk;
        if (body.length > 512 * 1024) throw new Error('Batch too large');
      }
      const lines = JSON.parse(body);
      for (const { message } of lines) {
        const id = /^n06-(warm|load-[0-9]+)$/.exec(message)?.[1];
        if (id) counts.set(id, (counts.get(id) ?? 0) + 1);
      }
      response.writeHead(204).end();
    } catch {
      response.writeHead(400).end();
    }
    return;
  }
  response.writeHead(404).end();
});
const open = () => new Promise(resolve => sink.listen(8080, '0.0.0.0', resolve));
const close = () => new Promise(resolve => {
  sink.close(resolve);
  sink.closeAllConnections();
});
await open();

createServer(async (request, response) => {
  if (request.method === 'GET' && request.url === '/receipt') {
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify(Object.fromEntries(counts)));
  } else if (request.method === 'POST' && request.url === '/offline') {
    if (sink.listening) await close();
    response.writeHead(204).end();
  } else if (request.method === 'POST' && request.url === '/online') {
    if (!sink.listening) await open();
    response.writeHead(204).end();
  } else {
    response.writeHead(404).end();
  }
}).listen(8081, '127.0.0.1');
