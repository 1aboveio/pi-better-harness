'use strict';
const { syncBuiltinESMExports } = require('node:module');
const attempts = [];
const deny = (name) => function () {
  attempts.push(name);
  throw new Error(`Offline benchmark blocked network: ${name}`);
};
for (const name of ['http', 'https']) {
  const module = require(`node:${name}`);
  module.request = deny(`${name}.request`);
  module.get = deny(`${name}.get`);
}
require('node:net').Socket.prototype.connect = deny('net.Socket.connect');
require('node:tls').connect = deny('tls.connect');
require('node:dgram').Socket.prototype.send = deny('dgram.send');
const dns = require('node:dns');
for (const name of Object.keys(dns)) {
  if (/^(lookup|resolve|reverse)/.test(name) && typeof dns[name] === 'function') dns[name] = deny(`dns.${name}`);
}
for (const name of Object.keys(dns.promises)) {
  if (/^(lookup|resolve|reverse)/.test(name)) dns.promises[name] = deny(`dns.promises.${name}`);
}
globalThis.fetch = deny('fetch');
globalThis.__startupNetworkAttempts = attempts;
syncBuiltinESMExports();
process.on('exit', () => {
  process.stderr.write(`${JSON.stringify({ type: 'benchmark_network_audit', attempts })}\n`);
  if (attempts.length) process.exitCode = 1;
});
