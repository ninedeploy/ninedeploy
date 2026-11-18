import { createServer } from 'node:http';

const counts = new Map();
createServer(async (request, response) => {
  if (request.method === 'GET' && request.url === '/receipt') {
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify(Object.fromEntries(counts)));
    return;
  }
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
}).listen(8080, '0.0.0.0');
