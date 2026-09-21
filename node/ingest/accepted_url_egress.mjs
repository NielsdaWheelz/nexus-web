import dns from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';
import net, { BlockList } from 'node:net';
import { Readable } from 'node:stream';
import tls from 'node:tls';
import { createBrotliDecompress, createGunzip, createInflate } from 'node:zlib';

export const MAX_ACCEPTED_URL_TIMEOUT_MS = 120_000;
export const MAX_HTML_BYTES = 10 * 1024 * 1024;
const MAX_URL_BYTES = 2048;
const URL_CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/u;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const REQUEST_HEADERS = {
    Accept: 'text/html,application/xhtml+xml',
    'Accept-Encoding': 'gzip, deflate, br',
    'Accept-Language': 'en-US,en;q=0.5',
    'User-Agent': 'NexusBot/1.0 (+https://nexus.example.com/bot)',
};

const DENIED_IPV4 = new BlockList();
for (const [network, prefix] of [
    ['0.0.0.0', 8],
    ['10.0.0.0', 8],
    ['100.64.0.0', 10],
    ['127.0.0.0', 8],
    ['169.254.0.0', 16],
    ['172.16.0.0', 12],
    ['168.63.129.16', 32],
    ['192.0.0.0', 24],
    ['192.0.2.0', 24],
    ['192.88.99.0', 24],
    ['192.168.0.0', 16],
    ['198.18.0.0', 15],
    ['198.51.100.0', 24],
    ['203.0.113.0', 24],
    ['224.0.0.0', 4],
    ['240.0.0.0', 4],
]) {
    DENIED_IPV4.addSubnet(network, prefix, 'ipv4');
}

const GLOBAL_IPV6 = new BlockList();
GLOBAL_IPV6.addSubnet('2000::', 3, 'ipv6');
const DENIED_IPV6 = new BlockList();
for (const [network, prefix] of [
    ['::', 128],
    ['::1', 128],
    ['::ffff:0:0', 96],
    ['64:ff9b::', 96],
    ['64:ff9b:1::', 48],
    ['100::', 64],
    ['2001::', 23],
    ['2001:db8::', 32],
    ['2002::', 16],
    ['3fff::', 20],
    ['fc00::', 7],
    ['fe80::', 10],
    ['ff00::', 8],
]) {
    DENIED_IPV6.addSubnet(network, prefix, 'ipv6');
}

class AcceptedUrlFailure extends Error {
    constructor(tag, details = {}) {
        super(tag);
        this.failure = { tag, ...details };
    }
}

// The entrypoint validates url/timeout. This owner fixes all network policy.
export async function fetchAcceptedHtml({ url, timeoutMs }) {
    const controller = new AbortController();
    const signal = controller.signal;
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    timeout.unref();
    try {
        let current = normalizeUrl(url);
        for (let redirects = 0; ; redirects += 1) {
            signal.throwIfAborted();
            const hostname = unbracket(current.hostname);
            const family = net.isIP(hostname);
            const addresses = family
                ? [{ address: hostname, family }]
                : await networkCall(() => resolveHostname(hostname, signal), signal);
            if (addresses.length === 0) throw new AcceptedUrlFailure('Network');
            if (addresses.some(({ address }) => !isPublicAddress(address))) {
                throw new AcceptedUrlFailure('UnsafeDestination');
            }

            const socket = await networkCall(() => connectSocket(current, addresses[0], signal), signal);
            let agent;
            let response;
            try {
                if (!isPublicAddress(socket.remoteAddress ?? '')
                    || comparableAddress(socket.remoteAddress) !== comparableAddress(addresses[0].address)) {
                    throw new AcceptedUrlFailure('UnsafeDestination');
                }
                const client = current.protocol === 'https:' ? https : http;
                agent = new client.Agent({ keepAlive: false });
                // Reuse only the admitted socket; the HTTP client must never resolve again.
                agent.createConnection = (_options, callback) => {
                    callback?.(null, socket);
                    return socket;
                };
                response = await networkCall(() => request(current, client, agent, signal), signal);
                const status = response.statusCode;
                if (!Number.isInteger(status) || status < 100 || status > 599) {
                    throw new Error('accepted URL returned an invalid HTTP status');
                }
                if (REDIRECT_STATUSES.has(status)) {
                    if (redirects >= 5) throw new AcceptedUrlFailure('TooManyRedirects');
                    const location = response.headers.location;
                    if (location === undefined) throw new AcceptedUrlFailure('Network');
                    if (Buffer.byteLength(location, 'utf8') > MAX_URL_BYTES
                        || URL_CONTROL_CHARACTERS.test(location)) {
                        throw new AcceptedUrlFailure('UnsafeDestination');
                    }
                    let redirected;
                    try {
                        redirected = new URL(location, current);
                    } catch {
                        throw new AcceptedUrlFailure('Network');
                    }
                    current = normalizeUrl(redirected.toString());
                    continue;
                }
                if (status < 200 || status > 299) throw new AcceptedUrlFailure('Http', { status });
                const contentType = response.headers['content-type'] ?? '';
                const mediaType = contentType.split(';', 1)[0].trim().toLowerCase();
                if (mediaType !== 'text/html' && mediaType !== 'application/xhtml+xml') {
                    throw new AcceptedUrlFailure('UnsupportedMediaType');
                }
                const sourceHtml = await readHtml(response, contentType, signal);
                return { tag: 'Success', final_url: current.toString(), source_html: sourceHtml };
            } finally {
                response?.destroy();
                agent?.destroy();
                socket.destroy();
            }
        }
    } catch (error) {
        if (signal.aborted) return { tag: 'Failure', failure: { tag: 'Timeout' } };
        if (error instanceof AcceptedUrlFailure) return { tag: 'Failure', failure: error.failure };
        throw error;
    } finally {
        clearTimeout(timeout);
    }
}

async function networkCall(operation, signal) {
    try {
        return await operation();
    } catch (error) {
        if (signal.aborted) throw new AcceptedUrlFailure('Timeout');
        if (error instanceof AcceptedUrlFailure) throw error;
        throw new AcceptedUrlFailure('Network');
    }
}

function normalizeUrl(value) {
    if (Buffer.byteLength(value, 'utf8') > MAX_URL_BYTES || URL_CONTROL_CHARACTERS.test(value)) {
        throw new AcceptedUrlFailure('UnsafeDestination');
    }
    let parsed;
    try {
        parsed = new URL(value);
    } catch {
        throw new AcceptedUrlFailure('UnsafeDestination');
    }
    if (!['http:', 'https:'].includes(parsed.protocol)
        || parsed.username !== '' || parsed.password !== '' || parsed.hostname === '') {
        throw new AcceptedUrlFailure('UnsafeDestination');
    }
    parsed.hash = '';
    if (Buffer.byteLength(parsed.toString(), 'utf8') > MAX_URL_BYTES
        || URL_CONTROL_CHARACTERS.test(parsed.toString())) {
        throw new AcceptedUrlFailure('UnsafeDestination');
    }
    return parsed;
}

function isPublicAddress(rawAddress) {
    const address = unbracket(rawAddress).split('%', 1)[0].toLowerCase();
    const family = net.isIP(address);
    if (family === 4) return !DENIED_IPV4.check(address, 'ipv4');
    return family === 6 && GLOBAL_IPV6.check(address, 'ipv6') && !DENIED_IPV6.check(address, 'ipv6');
}

function comparableAddress(rawAddress) {
    const address = unbracket(rawAddress).split('%', 1)[0].toLowerCase();
    return address.replace(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/, '$1');
}

function unbracket(value) {
    return value.startsWith('[') && value.endsWith(']') ? value.slice(1, -1) : value;
}

function resolveHostname(hostname, signal) {
    return new Promise((resolve, reject) => {
        const aborted = () => reject(new AcceptedUrlFailure('Timeout'));
        signal.addEventListener('abort', aborted, { once: true });
        dns.lookup(hostname, { all: true, verbatim: true }).then(
            (addresses) => {
                signal.removeEventListener('abort', aborted);
                resolve(addresses);
            },
            (error) => {
                signal.removeEventListener('abort', aborted);
                reject(error);
            },
        );
        if (signal.aborted) aborted();
    });
}

function connectSocket(url, { address, family }, signal) {
    const secure = url.protocol === 'https:';
    const hostname = unbracket(url.hostname);
    const options = { host: address, family, port: Number(url.port || (secure ? 443 : 80)) };
    return new Promise((resolve, reject) => {
        const socket = secure ? tls.connect({
            ...options,
            servername: net.isIP(hostname) === 0 ? hostname : undefined,
            rejectUnauthorized: true,
            checkServerIdentity: (_serverName, certificate) => tls.checkServerIdentity(hostname, certificate),
            ALPNProtocols: ['http/1.1'],
        }) : net.connect(options);
        const readyEvent = secure ? 'secureConnect' : 'connect';
        const cleanup = () => {
            socket.removeListener(readyEvent, ready);
            socket.removeListener('error', failed);
            signal.removeEventListener('abort', aborted);
        };
        const ready = () => {
            cleanup();
            resolve(socket);
        };
        const failed = (error) => {
            cleanup();
            socket.destroy();
            reject(error);
        };
        const aborted = () => failed(new AcceptedUrlFailure('Timeout'));
        socket.once(readyEvent, ready);
        socket.once('error', failed);
        signal.addEventListener('abort', aborted, { once: true });
        if (signal.aborted) aborted();
    });
}

function request(url, client, agent, signal) {
    return new Promise((resolve, reject) => {
        const request = client.request({
            protocol: url.protocol,
            hostname: unbracket(url.hostname),
            port: url.port || undefined,
            method: 'GET',
            path: `${url.pathname}${url.search}`,
            headers: REQUEST_HEADERS,
            agent,
            signal,
        }, resolve);
        request.once('error', reject);
        request.end();
    });
}

async function readHtml(response, contentType, signal) {
    const length = response.headers['content-length'];
    if (length !== undefined && /^\d+$/.test(length)
        && Number.isSafeInteger(Number(length)) && Number(length) > MAX_HTML_BYTES) {
        throw new AcceptedUrlFailure('TooLarge', { limit: 'wire' });
    }
    const encoding = (response.headers['content-encoding'] ?? 'identity').trim().toLowerCase();
    let decoder;
    switch (encoding) {
        case '':
        case 'identity': break;
        case 'gzip':
        case 'x-gzip': decoder = createGunzip(); break;
        case 'deflate': decoder = createInflate(); break;
        case 'br': decoder = createBrotliDecompress(); break;
        default: throw new AcceptedUrlFailure('UnsupportedContentEncoding');
    }
    const wire = Readable.from(boundedWireBody(response, signal));
    const body = decoder ? wire.pipe(decoder) : wire;
    if (decoder) wire.on('error', (error) => decoder.destroy(error));
    const chunks = [];
    let bytes = 0;
    try {
        for await (const chunk of body) {
            signal.throwIfAborted();
            bytes += chunk.byteLength;
            if (bytes > MAX_HTML_BYTES) throw new AcceptedUrlFailure('TooLarge', { limit: 'decompressed' });
            chunks.push(chunk);
        }
    } catch (error) {
        if (error instanceof AcceptedUrlFailure || signal.aborted) throw error;
        throw new AcceptedUrlFailure('Network');
    } finally {
        body.destroy();
        wire.destroy();
    }
    const html = decodeBody(Buffer.concat(chunks, bytes), contentType);
    let codePoints = 0;
    for (const _codePoint of html) {
        if (++codePoints > MAX_HTML_BYTES) throw new AcceptedUrlFailure('TooLarge', { limit: 'decoded' });
    }
    if (Buffer.byteLength(html, 'utf8') > MAX_HTML_BYTES) {
        throw new AcceptedUrlFailure('TooLarge', { limit: 'source' });
    }
    return html;
}

async function* boundedWireBody(response, signal) {
    let bytes = 0;
    for await (const chunk of response) {
        signal.throwIfAborted();
        bytes += chunk.byteLength;
        if (bytes > MAX_HTML_BYTES) throw new AcceptedUrlFailure('TooLarge', { limit: 'wire' });
        yield chunk;
    }
}

function normalizeCharset(charset) {
    const cleaned = charset?.trim().toLowerCase().replace(/^["']|["']$/g, '');
    if (!cleaned) return null;
    const aliases = {
        latin1: 'iso-8859-1',
        'latin-1': 'iso-8859-1',
        iso8859_1: 'iso-8859-1',
        'iso8859-1': 'iso-8859-1',
        cp1252: 'windows-1252',
        win1252: 'windows-1252',
        'win-1252': 'windows-1252',
    };
    return aliases[cleaned] || cleaned;
}

function contentTypeCharset(contentType) {
    return normalizeCharset(contentType.match(/charset\s*=\s*"?([^";,\s]+)"?/i)?.[1]);
}

function metaCharset(bytes) {
    const head = new TextDecoder('ascii').decode(bytes.subarray(0, 2048));
    for (const tag of head.match(/<meta\b[^>]*>/gi) || []) {
        const charset = normalizeCharset(tag.match(/charset\s*=\s*["']?\s*([^"'>\s/;]+)/i)?.[1]);
        if (charset) return charset;
        if (!/http-equiv\s*=\s*["']?\s*content-type\s*["']?/i.test(tag)) continue;
        const content = tag.match(/content\s*=\s*["']([^"']*)["']/i) || tag.match(/content\s*=\s*([^>\s]+)/i);
        const declared = content && contentTypeCharset(content[1]);
        if (declared) return declared;
    }
    return null;
}

function decodeBody(bytes, contentType) {
    for (const charset of [contentTypeCharset(contentType), metaCharset(bytes)]) {
        if (!charset) continue;
        try {
            return new TextDecoder(charset).decode(bytes);
        } catch {
            // Unsupported declarations leave the next source declaration or UTF-8.
        }
    }
    return new TextDecoder('utf-8').decode(bytes);
}
