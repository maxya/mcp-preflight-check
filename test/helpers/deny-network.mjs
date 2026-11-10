// Loaded with `node --import ./test/helpers/deny-network.mjs`. Any outbound connection attempt
// prints a marker to stderr and throws, so a test can assert "zero sockets" and get a positive control.
import net from 'node:net';
import dns from 'node:dns';
const MARK = 'NETWORK-ATTEMPT-BLOCKED';
const deny = (what) => { process.stderr.write(`${MARK} ${what}\n`); throw new Error(`${MARK}: ${what}`); };
const origConnect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) {
  const o = args[0];
  // allow IPC/pipe sockets (no host/port), e.g. used by test runners
  if (o && typeof o === 'object' && 'path' in o && !('port' in o)) return origConnect.apply(this, args);
  deny(`socket.connect ${JSON.stringify(typeof o === 'object' ? { host: o.host, port: o.port } : o)}`);
};
for (const fn of ['lookup', 'resolve', 'resolve4', 'resolve6']) {
  dns[fn] = (...a) => deny(`dns.${fn} ${a[0]}`);
  if (dns.promises[fn]) dns.promises[fn] = async (...a) => deny(`dns.promises.${fn} ${a[0]}`);
}
