import { createServer as httpServer } from 'node:http';
import { connect, createServer as tcpServer } from 'node:net';
import { Transform } from 'node:stream';
import { setTimeout as pause } from 'node:timers/promises';

const delayMs = Number(process.argv[2]);
let slow = false;
let delayedChunks = 0;
let forwardedBytes = 0;

httpServer((request, response) => {
  if (request.method === 'POST' && request.url === '/slow') slow = true;
  else if (request.method === 'POST' && request.url === '/normal') slow = false;
  else if (request.method !== 'GET' || request.url !== '/receipt') {
    response.writeHead(404).end();
    return;
  }
  response.setHeader('content-type', 'application/json');
  response.end(JSON.stringify({ slow, delayMs, delayedChunks, forwardedBytes }));
}).listen(4602, '127.0.0.1');

tcpServer(client => {
  const agent = connect(4600, '127.0.0.1');
  const traffic = new Transform({
    transform(chunk, _encoding, done) {
      const forward = () => {
        forwardedBytes += chunk.length;
        done(null, chunk);
      };
      if (!slow) forward();
      else {
        delayedChunks++;
        void pause(delayMs).then(forward);
      }
    },
  });
  const close = () => {
    traffic.destroy();
    agent.destroy();
    client.destroy();
  };
  client.once('error', close);
  agent.once('error', close);
  traffic.once('error', close);
  client.once('close', close);
  agent.once('close', close);
  client.pipe(traffic).pipe(agent);
  agent.pipe(client);
}).listen(4601, '0.0.0.0');
