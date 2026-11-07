// Imported before official runtime libraries, only in scrubbed test children.
import { appendFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import net from 'node:net';
import tls from 'node:tls';
import http from 'node:http';
import https from 'node:https';
import dgram from 'node:dgram';
const refuse = () => {
  if (process.env.PROBE_EVENTS) appendFileSync(process.env.PROBE_EVENTS, JSON.stringify({ kind: 'network-refused', pid: process.pid }) + '\n');
  throw new Error('runtime network is forbidden');
};
net.Socket.prototype.connect = refuse;
net.Server.prototype.listen = refuse;
tls.connect = refuse;
http.request = http.get = https.request = https.get = refuse;
dgram.createSocket = refuse;
globalThis.fetch = refuse;
syncBuiltinESMExports();
