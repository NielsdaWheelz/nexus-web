import dns from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';
import net, { BlockList } from 'node:net';
import { Readable } from 'node:stream';
import tls from 'node:tls';
import {
    createBrotliDecompress,
    createGunzip,
    createInflate,
} from 'node:zlib';

export const MAX_ACCEPTED_URL_TIMEOUT_MS = 120_000;
export const MAX_ACCEPTED_URL_BYTES = 2048;
export const DEFAULT_ACCEPTED_URL_LIMITS = Object.freeze({
    maxRedirects: 5,
    maxWireBytes: 10 * 1024 * 1024,
    maxDecompressedBytes: 10 * 1024 * 1024,
    maxDecodedCodePoints: 10 * 1024 * 1024,
    maxSourceBytes: 10 * 1024 * 1024,
});

const REQUEST_HEADERS = Object.freeze({
    Accept: 'text/html,application/xhtml+xml',
    'Accept-Encoding': 'gzip, deflate, br',
    'Accept-Language': 'en-US,en;q=0.5',
    'User-Agent': 'NexusBot/1.0 (+https://nexus.example.com/bot)',
});
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const HTML_MEDIA_TYPES = new Set(['text/html', 'application/xhtml+xml']);
const URL_CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/u;

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
    constructor(failure) {
        super(failure.tag);
        this.failure = Object.freeze(failure);
    }
}

class SystemResolver {
    async resolve(hostname, { signal } = {}) {
        const literal = unbracket(hostname);
        const literalFamily = net.isIP(literal);
        if (literalFamily !== 0) {
            return [{ address: literal, family: literalFamily }];
        }
        const records = await abortable(
            dns.lookup(literal, { all: true, verbatim: true }),
            signal,
        );
        return records.map(({ address, family }) => ({ address, family }));
    }
}

export class DirectConnector {
    constructor({
        dial = directDial,
        requestOnSocket: requestPort = requestOnSocket,
    } = {}) {
        this.dial = dial;
        this.requestPort = requestPort;
    }

    async connect({ url, resolvedAddress, signal }) {
        const parsed = new URL(url);
        const port = parsed.port === ''
            ? (parsed.protocol === 'https:' ? 443 : 80)
            : Number(parsed.port);
        const socket = await this.dial({
            protocol: parsed.protocol,
            address: resolvedAddress.address,
            family: resolvedAddress.family,
            hostname: unbracket(parsed.hostname),
            port,
            signal,
        });
        const peerAddress = {
            address: socket.remoteAddress ?? '',
            family: socket.remoteFamily === 'IPv6' ? 6 : 4,
        };
        let requested = false;

        return {
            peerAddress,
            close: async () => socket.destroy(),
            request: async ({ headers }) => {
                if (requested) {
                    throw new Error('accepted URL connection may issue only one request');
                }
                requested = true;
                return this.requestPort({ parsed, socket, headers, signal });
            },
        };
    }
}

const SYSTEM_RESOLVER = new SystemResolver();
const DIRECT_CONNECTOR = new DirectConnector();

export async function fetchAcceptedHtml({
    url,
    timeoutMs,
    limits = DEFAULT_ACCEPTED_URL_LIMITS,
    resolver = SYSTEM_RESOLVER,
    connector = DIRECT_CONNECTOR,
}) {
    validateInvocation({ url, timeoutMs, limits, resolver, connector });
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    timeout.unref?.();
    try {
        return await fetchWithRedirects({
            initialUrl: normalizeAcceptedUrl(url),
            limits,
            resolver,
            connector,
            signal: controller.signal,
        });
    } catch (error) {
        if (controller.signal.aborted) {
            return failureResult({ tag: 'Timeout' });
        }
        if (error instanceof AcceptedUrlFailure) {
            return failureResult(error.failure);
        }
        throw error;
    } finally {
        clearTimeout(timeout);
    }
}

async function fetchWithRedirects({
    initialUrl,
    limits,
    resolver,
    connector,
    signal,
}) {
    let current = initialUrl;
    let followedRedirects = 0;

    while (true) {
        throwIfTimedOut(signal);
        const addresses = await networkCall(
            () => resolver.resolve(unbracket(current.hostname), { signal }),
            signal,
        );
        const admittedAddresses = validateResolvedAddresses(addresses);
        const resolvedAddress = admittedAddresses[0];
        const connection = await networkCall(
            () => connector.connect({
                url: current.toString(),
                resolvedAddress,
                signal,
            }),
            signal,
        );
        if (
            !validAddressRecord(connection.peerAddress)
            || !isPublicAddress(connection.peerAddress.address)
            || !sameAddress(connection.peerAddress.address, resolvedAddress.address)
        ) {
            await closeQuietly(connection);
            throw new AcceptedUrlFailure({ tag: 'UnsafeDestination' });
        }

        let response;
        try {
            response = await networkCall(
                () => connection.request({ headers: REQUEST_HEADERS }),
                signal,
            );
        } catch (error) {
            await closeQuietly(connection);
            throw error;
        }

        const statusCode = response.statusCode;
        if (!Number.isInteger(statusCode) || statusCode < 100 || statusCode > 599) {
            await closeResponseAndConnection(response, connection);
            throw new Error('accepted URL connector returned an invalid HTTP status');
        }
        if (REDIRECT_STATUSES.has(statusCode)) {
            const location = headerValue(response.headers, 'location');
            await closeResponseAndConnection(response, connection);
            if (followedRedirects >= limits.maxRedirects) {
                throw new AcceptedUrlFailure({ tag: 'TooManyRedirects' });
            }
            if (location === null) {
                throw new AcceptedUrlFailure({ tag: 'Network' });
            }
            current = resolveAcceptedRedirect(location, current);
            followedRedirects += 1;
            continue;
        }
        if (statusCode < 200 || statusCode > 299) {
            await closeResponseAndConnection(response, connection);
            throw new AcceptedUrlFailure({ tag: 'Http', status: statusCode });
        }

        const contentType = headerValue(response.headers, 'content-type') ?? '';
        const mediaType = contentType.split(';', 1)[0].trim().toLowerCase();
        if (!HTML_MEDIA_TYPES.has(mediaType)) {
            await closeResponseAndConnection(response, connection);
            throw new AcceptedUrlFailure({ tag: 'UnsupportedMediaType' });
        }

        try {
            const sourceHtml = await readSourceHtml({
                response,
                contentType,
                limits,
                signal,
            });
            return {
                tag: 'Success',
                final_url: current.toString(),
                source_html: sourceHtml,
            };
        } finally {
            await closeResponseAndConnection(response, connection);
        }
    }
}

async function readSourceHtml({ response, contentType, limits, signal }) {
    const contentLength = headerValue(response.headers, 'content-length');
    if (contentLength !== null && /^\d+$/.test(contentLength)) {
        const declaredLength = Number(contentLength);
        if (Number.isSafeInteger(declaredLength) && declaredLength > limits.maxWireBytes) {
            throw new AcceptedUrlFailure({ tag: 'TooLarge', limit: 'wire' });
        }
    }
    const contentEncoding = (headerValue(response.headers, 'content-encoding') ?? 'identity')
        .trim()
        .toLowerCase();
    const wire = Readable.from(boundedWireBody(response.body, limits.maxWireBytes, signal));
    let decodedBody;
    switch (contentEncoding) {
        case '':
        case 'identity':
            decodedBody = wire;
            break;
        case 'gzip':
        case 'x-gzip':
            decodedBody = wire.pipe(createGunzip());
            break;
        case 'deflate':
            decodedBody = wire.pipe(createInflate());
            break;
        case 'br':
            decodedBody = wire.pipe(createBrotliDecompress());
            break;
        default:
            throw new AcceptedUrlFailure({ tag: 'UnsupportedContentEncoding' });
    }
    if (decodedBody !== wire) {
        wire.on('error', (error) => decodedBody.destroy(error));
    }

    const chunks = [];
    let decompressedBytes = 0;
    try {
        for await (const rawChunk of decodedBody) {
            throwIfTimedOut(signal);
            const chunk = Buffer.from(rawChunk);
            decompressedBytes += chunk.byteLength;
            if (decompressedBytes > limits.maxDecompressedBytes) {
                decodedBody.destroy();
                throw new AcceptedUrlFailure({ tag: 'TooLarge', limit: 'decompressed' });
            }
            chunks.push(chunk);
        }
    } catch (error) {
        if (error instanceof AcceptedUrlFailure || signal.aborted) {
            throw error;
        }
        throw new AcceptedUrlFailure({ tag: 'Network' });
    }

    const sourceBytes = Buffer.concat(chunks, decompressedBytes);
    const sourceHtml = decodeBody(sourceBytes, contentType);
    if (exceedsCodePointLimit(sourceHtml, limits.maxDecodedCodePoints)) {
        throw new AcceptedUrlFailure({ tag: 'TooLarge', limit: 'decoded' });
    }
    if (Buffer.byteLength(sourceHtml, 'utf8') > limits.maxSourceBytes) {
        throw new AcceptedUrlFailure({ tag: 'TooLarge', limit: 'source' });
    }
    return sourceHtml;
}

async function* boundedWireBody(body, maxBytes, signal) {
    if (body === null || body === undefined || body[Symbol.asyncIterator] === undefined) {
        throw new Error('accepted URL connector returned an invalid body');
    }
    let wireBytes = 0;
    try {
        for await (const rawChunk of body) {
            throwIfTimedOut(signal);
            const chunk = Buffer.from(rawChunk);
            wireBytes += chunk.byteLength;
            if (wireBytes > maxBytes) {
                throw new AcceptedUrlFailure({ tag: 'TooLarge', limit: 'wire' });
            }
            yield chunk;
        }
    } catch (error) {
        if (error instanceof AcceptedUrlFailure || signal.aborted) {
            throw error;
        }
        throw new AcceptedUrlFailure({ tag: 'Network' });
    }
}

function validateResolvedAddresses(addresses) {
    if (!Array.isArray(addresses) || addresses.length === 0) {
        throw new AcceptedUrlFailure({ tag: 'Network' });
    }
    if (!addresses.every(validAddressRecord)) {
        throw new Error('accepted URL resolver returned an invalid address record');
    }
    if (addresses.some(({ address }) => !isPublicAddress(address))) {
        throw new AcceptedUrlFailure({ tag: 'UnsafeDestination' });
    }
    return addresses;
}

function validAddressRecord(value) {
    return value !== null
        && typeof value === 'object'
        && typeof value.address === 'string'
        && (value.family === 4 || value.family === 6)
        && net.isIP(unbracket(value.address)) === value.family;
}

function isPublicAddress(rawAddress) {
    const address = unbracket(rawAddress).split('%', 1)[0].toLowerCase();
    const family = net.isIP(address);
    if (family === 4) {
        return !DENIED_IPV4.check(address, 'ipv4');
    }
    if (family === 6) {
        return GLOBAL_IPV6.check(address, 'ipv6') && !DENIED_IPV6.check(address, 'ipv6');
    }
    return false;
}

function sameAddress(left, right) {
    return comparableAddress(left) === comparableAddress(right);
}

function comparableAddress(rawAddress) {
    const address = unbracket(rawAddress).split('%', 1)[0].toLowerCase();
    const dottedMapped = address.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    return dottedMapped ? dottedMapped[1] : address;
}

function normalizeAcceptedUrl(value) {
    if (
        typeof value !== 'string'
        || value.length === 0
        || Buffer.byteLength(value, 'utf8') > MAX_ACCEPTED_URL_BYTES
        || URL_CONTROL_CHARACTERS.test(value)
    ) {
        throw new AcceptedUrlFailure({ tag: 'UnsafeDestination' });
    }
    let parsed;
    try {
        parsed = new URL(value);
    } catch {
        throw new AcceptedUrlFailure({ tag: 'UnsafeDestination' });
    }
    if (
        !['http:', 'https:'].includes(parsed.protocol)
        || parsed.username !== ''
        || parsed.password !== ''
        || parsed.hostname === ''
    ) {
        throw new AcceptedUrlFailure({ tag: 'UnsafeDestination' });
    }
    parsed.hash = '';
    if (
        Buffer.byteLength(parsed.toString(), 'utf8') > MAX_ACCEPTED_URL_BYTES
        || URL_CONTROL_CHARACTERS.test(parsed.toString())
    ) {
        throw new AcceptedUrlFailure({ tag: 'UnsafeDestination' });
    }
    return parsed;
}

function resolveAcceptedRedirect(location, current) {
    if (
        typeof location !== 'string'
        || Buffer.byteLength(location, 'utf8') > MAX_ACCEPTED_URL_BYTES
        || URL_CONTROL_CHARACTERS.test(location)
    ) {
        throw new AcceptedUrlFailure({ tag: 'UnsafeDestination' });
    }
    try {
        return normalizeAcceptedUrl(new URL(location, current).toString());
    } catch (error) {
        if (error instanceof AcceptedUrlFailure) {
            throw error;
        }
        throw new AcceptedUrlFailure({ tag: 'Network' });
    }
}

function validateInvocation({ url, timeoutMs, limits, resolver, connector }) {
    if (typeof url !== 'string' || url.length === 0) {
        throw new TypeError('url must be a non-empty string');
    }
    if (
        !Number.isInteger(timeoutMs)
        || timeoutMs <= 0
        || timeoutMs > MAX_ACCEPTED_URL_TIMEOUT_MS
    ) {
        throw new TypeError('timeoutMs is outside the accepted URL deadline range');
    }
    const limitNames = [
        'maxRedirects',
        'maxWireBytes',
        'maxDecompressedBytes',
        'maxDecodedCodePoints',
        'maxSourceBytes',
    ];
    if (
        limits === null
        || typeof limits !== 'object'
        || limitNames.some((name) => !Number.isInteger(limits[name]) || limits[name] < 0)
        || limits.maxWireBytes === 0
        || limits.maxDecompressedBytes === 0
        || limits.maxDecodedCodePoints === 0
        || limits.maxSourceBytes === 0
    ) {
        throw new TypeError('accepted URL limits are invalid');
    }
    if (typeof resolver?.resolve !== 'function' || typeof connector?.connect !== 'function') {
        throw new TypeError('accepted URL ports are invalid');
    }
}

async function networkCall(operation, signal) {
    try {
        return await operation();
    } catch (error) {
        if (signal.aborted) {
            throw new AcceptedUrlFailure({ tag: 'Timeout' });
        }
        if (error instanceof AcceptedUrlFailure) {
            throw error;
        }
        throw new AcceptedUrlFailure({ tag: 'Network' });
    }
}

function failureResult(failure) {
    return { tag: 'Failure', failure };
}

function headerValue(headers, name) {
    if (headers?.get instanceof Function) {
        const value = headers.get(name);
        return typeof value === 'string' ? value : null;
    }
    if (headers === null || typeof headers !== 'object') {
        return null;
    }
    const value = headers[name] ?? headers[name.toLowerCase()];
    if (Array.isArray(value)) {
        return typeof value[0] === 'string' ? value[0] : null;
    }
    return typeof value === 'string' ? value : null;
}

async function closeResponseAndConnection(response, connection) {
    await closeQuietly(response);
    await closeQuietly(connection);
}

async function closeQuietly(value) {
    try {
        await value?.close?.();
    } catch {
        // Closing after a terminal result is best effort; no further request can be issued.
    }
}

function throwIfTimedOut(signal) {
    if (signal.aborted) {
        throw new AcceptedUrlFailure({ tag: 'Timeout' });
    }
}

function abortable(promise, signal) {
    if (signal === undefined) {
        return promise;
    }
    if (signal.aborted) {
        return Promise.reject(new AcceptedUrlFailure({ tag: 'Timeout' }));
    }
    return new Promise((resolve, reject) => {
        const aborted = () => reject(new AcceptedUrlFailure({ tag: 'Timeout' }));
        signal.addEventListener('abort', aborted, { once: true });
        promise.then(
            (value) => {
                signal.removeEventListener('abort', aborted);
                resolve(value);
            },
            (error) => {
                signal.removeEventListener('abort', aborted);
                reject(error);
            },
        );
    });
}

function directDial({ protocol, address, family, hostname, port, signal }) {
    if (protocol === 'https:') {
        return connectTls({ address, family, hostname, port, signal });
    }
    return connectTcp({ address, family, port, signal });
}

function connectTcp({ address, family, port, signal }) {
    return connectSocket(
        () => net.connect({ host: address, family, port }),
        'connect',
        signal,
    );
}

function connectTls({ address, family, hostname, port, signal }) {
    return connectSocket(
        () => tls.connect({
            host: address,
            family,
            port,
            servername: net.isIP(hostname) === 0 ? hostname : undefined,
            rejectUnauthorized: true,
            checkServerIdentity: (_serverName, certificate) => (
                tls.checkServerIdentity(hostname, certificate)
            ),
            ALPNProtocols: ['http/1.1'],
        }),
        'secureConnect',
        signal,
    );
}

function connectSocket(createSocket, readyEvent, signal) {
    return new Promise((resolve, reject) => {
        const socket = createSocket();
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
        const aborted = () => {
            cleanup();
            socket.destroy();
            reject(new AcceptedUrlFailure({ tag: 'Timeout' }));
        };
        socket.once(readyEvent, ready);
        socket.once('error', failed);
        signal.addEventListener('abort', aborted, { once: true });
        if (signal.aborted) {
            aborted();
        }
    });
}

function requestOnSocket({ parsed, socket, headers, signal }) {
    const client = parsed.protocol === 'https:' ? https : http;
    const agent = new client.Agent({ keepAlive: false });
    agent.createConnection = (_options, callback) => {
        callback?.(null, socket);
        return socket;
    };
    return new Promise((resolve, reject) => {
        const request = client.request(
            {
                protocol: parsed.protocol,
                hostname: unbracket(parsed.hostname),
                port: parsed.port || undefined,
                method: 'GET',
                path: `${parsed.pathname}${parsed.search}`,
                headers,
                agent,
                signal,
            },
            (response) => {
                resolve({
                    statusCode: response.statusCode,
                    headers: response.headers,
                    body: response,
                    close: async () => {
                        response.destroy();
                        agent.destroy();
                    },
                });
            },
        );
        request.once('error', (error) => {
            agent.destroy();
            reject(error);
        });
        request.end();
    });
}

function parseCharsetFromContentType(contentType) {
    if (!contentType) return null;
    const match = contentType.match(/charset\s*=\s*"?([^";,\s]+)"?/i);
    return match ? normalizeCharset(match[1]) : null;
}

function normalizeCharset(charset) {
    if (!charset) return null;
    const cleaned = charset.trim().toLowerCase().replace(/^["']|["']$/g, '');
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

function sniffMetaCharset(bytes) {
    const head = new TextDecoder('ascii', { fatal: false }).decode(bytes.subarray(0, 2048));
    const metaTags = head.match(/<meta\b[^>]*>/gi) || [];
    for (const tag of metaTags) {
        const charsetMatch = tag.match(/charset\s*=\s*["']?\s*([^"'>\s/;]+)/i);
        if (charsetMatch) {
            const normalized = normalizeCharset(charsetMatch[1]);
            if (normalized) return normalized;
        }
        if (!/http-equiv\s*=\s*["']?\s*content-type\s*["']?/i.test(tag)) continue;
        const contentMatch = tag.match(/content\s*=\s*["']([^"']*)["']/i)
            || tag.match(/content\s*=\s*([^>\s]+)/i);
        if (!contentMatch) continue;
        const charset = parseCharsetFromContentType(contentMatch[1]);
        if (charset) return charset;
    }
    return null;
}

function decodeBody(bytes, contentType) {
    const candidates = [
        parseCharsetFromContentType(contentType),
        sniffMetaCharset(bytes),
        'utf-8',
    ];
    const tried = new Set();
    for (const candidate of candidates) {
        const charset = normalizeCharset(candidate);
        if (!charset || tried.has(charset)) continue;
        tried.add(charset);
        try {
            return new TextDecoder(charset, { fatal: false }).decode(bytes);
        } catch {
            // An unsupported declared charset falls through to the UTF-8 baseline.
        }
    }
    return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
}

function exceedsCodePointLimit(value, limit) {
    let codePoints = 0;
    for (const _codePoint of value) {
        codePoints += 1;
        if (codePoints > limit) return true;
    }
    return false;
}

function unbracket(value) {
    return value.startsWith('[') && value.endsWith(']') ? value.slice(1, -1) : value;
}
