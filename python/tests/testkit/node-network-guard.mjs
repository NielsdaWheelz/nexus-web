import dns from "node:dns";
import http from "node:http";
import https from "node:https";
import { syncBuiltinESMExports } from "node:module";
import net from "node:net";
import tls from "node:tls";

const ALLOWED_HOSTS = new Set(["127.0.0.1", "::1", "127.0.1.1"]);

function requireLocal(host) {
  const normalized = String(host ?? "");
  if (!ALLOWED_HOSTS.has(normalized)) {
    throw new Error(`test process denied external network host: ${normalized}`);
  }
}

function requestHost(input, options) {
  if (input instanceof URL || (typeof input === "string" && !input.startsWith("/"))) {
    return new URL(input).hostname;
  }
  return input?.hostname ?? input?.host ?? options?.hostname ?? options?.host ?? "127.0.0.1";
}

function socketHost(args) {
  const first = args[0];
  if (first !== null && typeof first === "object") {
    return first.hostname ?? first.host ?? "127.0.0.1";
  }
  if (typeof first === "number") {
    const second = args[1];
    if (typeof second === "string") {
      return second;
    }
    if (second !== null && typeof second === "object") {
      return second.hostname ?? second.host ?? "127.0.0.1";
    }
  }
  return "127.0.0.1";
}

function guardedModuleConnect(owner, original) {
  return (...args) => {
    requireLocal(socketHost(args));
    return Reflect.apply(original, owner, args);
  };
}

function guardedSocketConnect(original) {
  return function (...args) {
    requireLocal(socketHost(args));
    return Reflect.apply(original, this, args);
  };
}

const originalFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  requireLocal(new URL(input instanceof Request ? input.url : input).hostname);
  return originalFetch(input, init);
};

for (const module of [http, https]) {
  const originalRequest = module.request.bind(module);
  module.request = (...args) => {
    requireLocal(requestHost(args[0], args[1]));
    return originalRequest(...args);
  };
}

const originalNetConnect = net.connect;
const originalSocketConnect = net.Socket.prototype.connect;
const originalTlsConnect = tls.connect;
const originalTlsSocketConnect = tls.TLSSocket.prototype.connect;
net.connect = guardedModuleConnect(net, originalNetConnect);
net.createConnection = net.connect;
net.Socket.prototype.connect = guardedSocketConnect(originalSocketConnect);
tls.connect = guardedModuleConnect(tls, originalTlsConnect);
tls.TLSSocket.prototype.connect = guardedSocketConnect(originalTlsSocketConnect);

const originalLookup = dns.lookup.bind(dns);
dns.lookup = (hostname, options, callback) => {
  requireLocal(hostname);
  return originalLookup(hostname, options, callback);
};
const originalPromisesLookup = dns.promises.lookup.bind(dns.promises);
dns.promises.lookup = async (hostname, options) => {
  requireLocal(hostname);
  return originalPromisesLookup(hostname, options);
};

syncBuiltinESMExports();
