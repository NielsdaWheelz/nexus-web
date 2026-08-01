import dns from "node:dns";
import http from "node:http";
import https from "node:https";
import net from "node:net";

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

const originalConnect = net.connect.bind(net);
net.connect = (...args) => {
  const first = args[0];
  const host = typeof first === "object" ? first.host ?? "127.0.0.1" : args[1] ?? "127.0.0.1";
  requireLocal(host);
  return originalConnect(...args);
};
net.createConnection = net.connect;

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
