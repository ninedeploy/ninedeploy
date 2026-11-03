import assert from 'node:assert/strict';
import dgram from 'node:dgram';
import http from 'node:http';
import net from 'node:net';
import { existsSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';

const mode = process.argv[2];
const address = '10.6.6.9';
const timeout = (promise, ms = 4000) => {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('socket deadline')), ms); })]).finally(() => clearTimeout(timer));
};
const stun = packet => packet.length === 20 && packet.readUInt32BE(4) === 0x2112a442;
const web = () => new Promise((resolve, reject) => {
  // Node 26 fetch ignores a custom Host header; use http so Traefik sees pbx.test.
  const request = http.get({ hostname: address, port: 8080, headers: { host: 'pbx.test' } }, response => {
    let body = '';
    response.setEncoding('utf8'); response.on('data', chunk => { body += chunk; if (body.length > 1024) request.destroy(new Error('Oversized web fixture response')); });
    response.once('error', reject); response.once('end', () => resolve({ status: response.statusCode, body }));
  });
  request.setTimeout(4000, () => request.destroy(new Error('Web deadline'))); request.once('error', reject);
});
if (mode === 'server') {
  const version = process.argv[3];
  for (const port of [5060, 3478, ...Array.from({ length: 101 }, (_, i) => i + 10000)]) {
    const socket = dgram.createSocket('udp4');
    socket.on('message', (packet, peer) => {
      if (stun(packet)) {
        const reply = Buffer.alloc(32);
        reply.writeUInt16BE(0x0101); reply.writeUInt16BE(12, 2); packet.copy(reply, 4, 4, 20);
        reply.writeUInt16BE(0x0020, 20); reply.writeUInt16BE(8, 22); reply[25] = 1;
        reply.writeUInt16BE(peer.port ^ 0x2112, 26);
        peer.address.split('.').forEach((part, i) => { reply[28 + i] = Number(part) ^ packet[4 + i]; });
        socket.send(reply, peer.port, peer.address);
      } else {
        socket.send(JSON.stringify({ version, port, sourceIp: peer.address, sourcePort: peer.port, payload: packet.toString('hex') }), peer.port, peer.address);
      }
    });
    socket.bind(port, '0.0.0.0');
  }
  net.createServer(socket => {
    socket.on('data', packet => socket.write(JSON.stringify({ version, sourceIp: socket.remoteAddress, sourcePort: socket.remotePort, payload: packet.toString() }) + '\n'));
  }).listen(5060, '0.0.0.0');
  http.createServer((req, res) => {
    if (req.url === '/ready' && version === 'new' && !existsSync('/tmp/ready')) res.statusCode = 503;
    res.end(version);
  }).listen(3000, '0.0.0.0');
} else if (mode === 'keeper') {
  for (const port of [5060, 3478, ...Array.from({ length: 101 }, (_, i) => i + 10000)]) dgram.createSocket('udp4').bind(port, address);
  net.createServer(socket => socket.destroy()).listen(5060, address);
} else if (mode === 'probe' || mode === 'hold') {
  const expected = process.argv[3];
  const localIp = process.argv[4];
  const sockets = [];
  const udp = async port => {
    const socket = dgram.createSocket('udp4'); sockets.push(socket);
    await new Promise(resolve => socket.bind(0, '0.0.0.0', resolve));
    socket.connect(port, address);
    await new Promise(resolve => socket.once('connect', resolve));
    return socket;
  };
  const exchange = async (socket, packet) => {
    let message, error;
    const pending = new Promise((resolve, reject) => { message = resolve; error = reject; socket.once('message', message); socket.once('error', error); });
    try { socket.send(packet); return await timeout(pending); }
    catch (error) { throw new Error(`UDP ${socket.remoteAddress().port}: ${error.message}`, { cause: error }); }
    finally { socket.off('message', message); socket.off('error', error); }
  };
  const sip = await udp(5060);
  const rtp = await Promise.all([10000, 10050, 10100].map(udp));
  const st = await udp(3478);
  const tcp = net.connect(5060, address); sockets.push(tcp);
  await timeout(new Promise((resolve, reject) => { tcp.once('connect', resolve); tcp.once('error', reject); })).catch(error => { throw new Error(`TCP connect: ${error.message}`); });
  async function probe() {
    const packet = Buffer.from('OPTIONS sip:pbx.test SIP/2.0\r\nCall-ID: ' + randomBytes(8).toString('hex') + '\r\n\r\n');
    for (const [socket, data] of [[sip, packet], ...rtp.map((socket, i) => [socket, Buffer.from([0x80, 0, 0, i, ...randomBytes(8)])])]) {
      const reply = JSON.parse((await exchange(socket, data)).toString());
      assert.equal(reply.version, expected); assert.equal(reply.sourceIp, localIp); assert.equal(reply.sourcePort, socket.address().port); assert.equal(reply.payload, data.toString('hex'));
    }
    const request = Buffer.alloc(20); request.writeUInt16BE(1); request.writeUInt32BE(0x2112a442, 4); randomBytes(12).copy(request, 8);
    const reply = await exchange(st, request);
    assert.equal(reply.readUInt16BE(0), 0x0101); assert.deepEqual(reply.subarray(8, 20), request.subarray(8, 20));
    assert.equal(reply.readUInt16BE(26) ^ 0x2112, st.address().port);
    assert.equal([...reply.subarray(28, 32)].map((part, i) => part ^ request[4 + i]).join('.'), localIp);
    let data, error;
    const pending = new Promise((resolve, reject) => { data = resolve; error = reject; tcp.once('data', data); tcp.once('error', error); });
    try {
      tcp.write(packet);
      const answer = JSON.parse((await timeout(pending)).toString());
      assert.equal(answer.version, expected); assert.equal(answer.sourceIp, localIp); assert.equal(answer.sourcePort, tcp.localPort); assert.equal(answer.payload, packet.toString());
    } finally { tcp.off('data', data); tcp.off('error', error); }
  }
  try {
    await probe();
    if (mode === 'hold') {
      const label = process.argv[5] ?? '';
      assert.ok(['', 'candidate'].includes(label));
      const prefix = label ? `/proof/${label}-` : '/proof/';
      writeFileSync(prefix + 'hold-ready', 'ready');
      let count = 1;
      const deadline = Date.now() + 120000;
      while (!existsSync('/proof/finish') && Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 150)); await probe(); count++;
      }
      assert.ok(existsSync('/proof/finish'), 'hold completion deadline');
      writeFileSync(prefix + 'hold-result.json', JSON.stringify({ count, expected, sourcePreserved: true }));
    } else console.log(JSON.stringify({ expected, sourcePreserved: true, tcp: 1, udp: 5, stun: 1 }));
  } finally { for (const socket of sockets) { if (socket instanceof net.Socket) socket.destroy(); else socket.close(); } }
} else if (mode === 'web-probe') {
  const response = await web(); console.log(JSON.stringify(response));
  assert.equal(response.status, 200); assert.equal(response.body, process.argv[3]);
} else if (mode === 'sample') {
  let count = 0;
  const deadline = Date.now() + 120000;
  while (!existsSync('/proof/finish') && Date.now() < deadline) {
    const response = await web();
    assert.equal(response.status, 200); assert.ok(['old', 'new'].includes(response.body)); count++;
    await new Promise(resolve => setTimeout(resolve, 30));
  }
  assert.ok(existsSync('/proof/finish'), 'sample completion deadline');
  writeFileSync('/proof/web-result.json', JSON.stringify({ count, badGateway: 0 }));
} else throw new Error('Unknown fixture mode');
