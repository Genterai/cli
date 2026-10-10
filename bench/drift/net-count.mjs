// Preloaded into the `genter` processes that bench/drift/takes.mjs times (node --import): counts every network
// connection, name lookup and listening server the process starts, and writes the counts to GENTER_NET_COUNT on exit.
// A model call, a hosted index or any service would show up here; local files do not.
import dgram from "node:dgram";
import dns from "node:dns";
import { writeFileSync } from "node:fs";
import net from "node:net";

const counts = { connections: [], lookups: 0, servers: 0, udp: 0 };
const connect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) {
  const o = args[0] && typeof args[0] === "object" ? args[0] : { port: args[0], host: args[1] };
  counts.connections.push(o.path ? `ipc:${o.path}` : `${o.host ?? "localhost"}:${o.port}`);
  return connect.apply(this, args);
};
const listen = net.Server.prototype.listen;
net.Server.prototype.listen = function (...args) {
  counts.servers++;
  return listen.apply(this, args);
};
const lookup = dns.lookup;
dns.lookup = function (...args) {
  counts.lookups++;
  return lookup.apply(this, args);
};
const createSocket = dgram.createSocket;
dgram.createSocket = function (...args) {
  counts.udp++;
  return createSocket.apply(this, args);
};
process.on("exit", () => {
  if (process.env.GENTER_NET_COUNT) writeFileSync(process.env.GENTER_NET_COUNT, JSON.stringify(counts));
});
