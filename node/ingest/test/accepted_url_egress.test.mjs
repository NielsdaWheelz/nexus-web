import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { gzipSync } from 'node:zlib';

const INGEST_CLI = fileURLToPath(new URL('../ingest.mjs', import.meta.url));
const ACCEPTED_URL_EGRESS = new URL('../accepted_url_egress.mjs', import.meta.url);
const PUBLIC_ADDRESS = '8.8.8.8';
const OTHER_PUBLIC_ADDRESS = '1.1.1.1';
const TEST_LIMITS = Object.freeze({
    maxRedirects: 2,
    maxWireBytes: 512,
    maxDecompressedBytes: 2048,
    maxDecodedCodePoints: 1000,
    maxSourceBytes: 1200,
});
const SMALL_HTML = `<!doctype html>
<html lang="en">
  <head><title>Accepted source</title></head>
  <body><article><h1>Accepted source</h1><p>Small public article.</p></article></body>
</html>`;
const ARTICLE_HTML = `<!doctype html>
<html lang="en">
  <head><title>Private destination proof</title></head>
  <body>
    <article>
      <h1>Private destination proof</h1>
      <p>${'The production ingestion CLI must reject private destinations before sending an HTTP request. '.repeat(20)}</p>
    </article>
  </body>
</html>`;

async function listen(handler) {
    const server = http.createServer(handler);
    await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address();
    assert(address && typeof address === 'object');
    return {
        server,
        url: `http://127.0.0.1:${address.port}`,
    };
}

async function close(server) {
    await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
            server.closeAllConnections?.();
            reject(new Error('loopback test server did not close within 1 second'));
        }, 1_000);
        server.close((error) => {
            clearTimeout(timeout);
            if (error) {
                reject(error);
                return;
            }
            resolve();
        });
        server.closeAllConnections?.();
    });
}

function addressRecord(address) {
    return {
        address,
        family: address.includes(':') ? 6 : 4,
    };
}

class StaticResolver {
    constructor(records) {
        this.records = new Map(Object.entries(records));
        this.calls = [];
    }

    async resolve(hostname, { signal } = {}) {
        if (signal?.aborted) {
            throw signal.reason;
        }
        this.calls.push({ hostname, signal });
        const addresses = this.records.get(hostname);
        assert(addresses, `no test DNS record for ${hostname}`);
        return addresses.map(addressRecord);
    }
}

class MappedConnector {
    constructor(origins, { peerAddresses = {} } = {}) {
        this.origins = new Map(Object.entries(origins));
        this.peerAddresses = new Map(Object.entries(peerAddresses));
        this.connectCalls = [];
        this.requestCalls = [];
    }

    async connect({ url, resolvedAddress, signal }) {
        if (signal?.aborted) {
            throw signal.reason;
        }
        const parsed = new URL(url);
        const mappedOrigin = this.origins.get(parsed.hostname);
        assert(mappedOrigin, `no test connector route for ${parsed.hostname}`);
        const call = {
            url: parsed.toString(),
            resolvedAddress,
            signal,
            closed: false,
        };
        this.connectCalls.push(call);
        const peerAddress = addressRecord(
            this.peerAddresses.get(parsed.hostname) ?? resolvedAddress.address,
        );

        return {
            peerAddress,
            close: async () => {
                call.closed = true;
            },
            request: async ({ headers }) => {
                const normalizedHeaders = Object.fromEntries(
                    Object.entries(headers).map(([name, value]) => [name.toLowerCase(), value]),
                );
                const requestCall = {
                    url: parsed.toString(),
                    resolvedAddress,
                    signal,
                    headers: normalizedHeaders,
                    bodyBytesRead: 0,
                };
                this.requestCalls.push(requestCall);
                const target = new URL(`${parsed.pathname}${parsed.search}`, mappedOrigin);
                const response = await new Promise((resolve, reject) => {
                    const request = http.request(
                        {
                            method: 'GET',
                            hostname: target.hostname,
                            port: target.port,
                            path: `${target.pathname}${target.search}`,
                            headers: {
                                ...normalizedHeaders,
                                host: parsed.host,
                            },
                            signal,
                        },
                        resolve,
                    );
                    request.once('error', reject);
                    request.end();
                });
                const body = (async function* trackBody() {
                    for await (const chunk of response) {
                        requestCall.bodyBytesRead += chunk.byteLength;
                        yield chunk;
                    }
                }());
                return {
                    statusCode: response.statusCode,
                    headers: response.headers,
                    body,
                    close: async () => response.destroy(),
                };
            },
        };
    }
}

async function fetchAcceptedHtml({
    url,
    resolver,
    connector,
    timeoutMs = 1000,
    limits = TEST_LIMITS,
}) {
    const production = await import(ACCEPTED_URL_EGRESS);
    assert.equal(
        typeof production.fetchAcceptedHtml,
        'function',
        'accepted_url_egress.mjs must export fetchAcceptedHtml',
    );
    return production.fetchAcceptedHtml({
        url,
        timeoutMs,
        limits,
        resolver,
        connector,
    });
}

function assertFailure(result, failure, message) {
    assert.equal(result.tag, 'Failure', message);
    assert.deepEqual(result.failure, failure, message);
}

function assertSuccess(result, finalUrl) {
    assert.equal(result.tag, 'Success');
    assert.equal(result.final_url, finalUrl);
    assert.equal(typeof result.source_html, 'string');
}

function htmlWithText(text) {
    return `<!doctype html><html><head><title>Limit</title></head><body><article><p>${text}</p></article></body></html>`;
}

function respondHtml(response, body, extraHeaders = {}) {
    response.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        ...extraHeaders,
    });
    response.end(body);
}

async function invokeIngest(url) {
    const { stdout, stderr } = await new Promise((resolve, reject) => {
        const child = execFile(
            process.execPath,
            [INGEST_CLI],
            { timeout: 10_000 },
            (error, childStdout, childStderr) => {
                if (error) {
                    reject(error);
                    return;
                }
                resolve({ stdout: childStdout, stderr: childStderr });
            },
        );
        child.stdin.end(JSON.stringify({ url, timeout_ms: 5_000 }));
    });
    assert.equal(stderr, '');
    return JSON.parse(stdout.trim());
}

function assertUnsafeBeforeRequest(result, requestCount) {
    assert.equal(
        result.tag,
        'Failure',
        `private loopback destination crossed accepted URL egress before rejection; CLI returned ${result.tag}, server_requests=${requestCount}`,
    );
    assert.deepEqual(result.failure, { tag: 'UnsafeDestination' });
    assert.equal(requestCount, 0);
}

test('production CLI rejects an initial private loopback destination before HTTP', async () => {
    let requests = 0;
    const origin = await listen((_request, response) => {
        requests += 1;
        response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        response.end(ARTICLE_HTML);
    });

    try {
        const result = await invokeIngest(`${origin.url}/article`);
        assertUnsafeBeforeRequest(result, requests);
    } finally {
        await close(origin.server);
    }
});

test('public redirect to a private destination sends zero private requests', async () => {
    let publicRequests = 0;
    let privateRequests = 0;
    const privateOrigin = await listen((_request, response) => {
        privateRequests += 1;
        respondHtml(response, SMALL_HTML);
    });
    const publicOrigin = await listen((_request, response) => {
        publicRequests += 1;
        response.writeHead(302, { location: 'http://private.test/secret' });
        response.end();
    });
    const resolver = new StaticResolver({
        'public.test': [PUBLIC_ADDRESS],
        'private.test': ['127.0.0.1'],
    });
    const connector = new MappedConnector({
        'public.test': publicOrigin.url,
        'private.test': privateOrigin.url,
    });

    try {
        const result = await fetchAcceptedHtml({
            url: 'http://public.test/start',
            resolver,
            connector,
        });
        assertFailure(
            result,
            { tag: 'UnsafeDestination' },
            'private loopback destination crossed accepted URL egress before rejection',
        );
        assert.equal(publicRequests, 1);
        assert.equal(privateRequests, 0);
        assert.equal(connector.requestCalls.length, 1);
        assert.deepEqual(
            resolver.calls.map(({ hostname }) => hostname),
            ['public.test', 'private.test'],
        );
    } finally {
        await Promise.all([close(publicOrigin.server), close(privateOrigin.server)]);
    }
});

test('one private or special DNS answer rejects the entire answer set before connect', async (t) => {
    const unsafeAddresses = [
        '10.0.0.1',
        '127.0.0.1',
        '169.254.169.254',
        '::1',
        '::ffff:127.0.0.1',
    ];

    for (const unsafeAddress of unsafeAddresses) {
        await t.test(unsafeAddress, async () => {
            const resolver = new StaticResolver({
                'mixed.test': [PUBLIC_ADDRESS, unsafeAddress],
            });
            const connector = new MappedConnector({ 'mixed.test': 'http://127.0.0.1:1' });
            const result = await fetchAcceptedHtml({
                url: 'http://mixed.test/article',
                resolver,
                connector,
            });
            assertFailure(
                result,
                { tag: 'UnsafeDestination' },
                unsafeAddress === '127.0.0.1'
                    ? 'private loopback destination crossed accepted URL egress before rejection'
                    : undefined,
            );
            assert.equal(connector.connectCalls.length, 0);
            assert.equal(connector.requestCalls.length, 0);
        });
    }
});

test('known platform and non-global address literals are rejected before connect', async (t) => {
    const specialAddresses = [
        ['Azure WireServer', '168.63.129.16'],
        ['IANA non-global IETF assignment space', '2001:100::1'],
        ['IANA documentation space', '3fff::1'],
    ];

    for (const [label, address] of specialAddresses) {
        await t.test(label, async () => {
            const resolver = new StaticResolver({ [address]: [address] });
            const connector = {
                calls: [],
                async connect(options) {
                    this.calls.push(options);
                    throw new Error('special destination reached the connector');
                },
            };
            const literal = address.includes(':') ? `[${address}]` : address;
            const result = await fetchAcceptedHtml({
                url: `http://${literal}/article`,
                resolver,
                connector,
            });

            assertFailure(result, { tag: 'UnsafeDestination' });
            assert.equal(connector.calls.length, 0);
        });
    }
});

test('connected peer must equal the selected public DNS address before request bytes', async () => {
    let requests = 0;
    const origin = await listen((_request, response) => {
        requests += 1;
        respondHtml(response, SMALL_HTML);
    });
    const resolver = new StaticResolver({ 'rebind.test': [PUBLIC_ADDRESS] });
    const connector = new MappedConnector(
        { 'rebind.test': origin.url },
        { peerAddresses: { 'rebind.test': '127.0.0.1' } },
    );

    try {
        const result = await fetchAcceptedHtml({
            url: 'http://rebind.test/article',
            resolver,
            connector,
        });
        assertFailure(result, { tag: 'UnsafeDestination' });
        assert.equal(connector.connectCalls.length, 1);
        assert.equal(connector.connectCalls[0].closed, true);
        assert.equal(connector.requestCalls.length, 0);
        assert.equal(requests, 0);
    } finally {
        await close(origin.server);
    }
});

test('production DirectConnector pins the selected address and original TLS identity before one request', async () => {
    const production = await import(ACCEPTED_URL_EGRESS);
    assert.equal(
        typeof production.DirectConnector,
        'function',
        'accepted_url_egress.mjs must export the production DirectConnector test seam',
    );

    const dialCalls = [];
    const requestCalls = [];
    const closedSockets = [];
    const connector = new production.DirectConnector({
        dial: async (options) => {
            dialCalls.push(options);
            return {
                remoteAddress: PUBLIC_ADDRESS,
                remoteFamily: 'IPv4',
                destroy: () => closedSockets.push(PUBLIC_ADDRESS),
            };
        },
        requestOnSocket: async (options) => {
            requestCalls.push(options);
            return {
                statusCode: 200,
                headers: { 'content-type': 'text/html; charset=utf-8' },
                body: (async function* body() {
                    yield Buffer.from(SMALL_HTML);
                }()),
                close: async () => {},
            };
        },
    });
    const resolver = new StaticResolver({ 'connector.test': [PUBLIC_ADDRESS] });

    const result = await fetchAcceptedHtml({
        url: 'https://connector.test:8443/article?proof=pin',
        resolver,
        connector,
    });

    assertSuccess(result, 'https://connector.test:8443/article?proof=pin');
    assert.equal(dialCalls.length, 1);
    assert.equal(dialCalls[0].protocol, 'https:');
    assert.equal(dialCalls[0].address, PUBLIC_ADDRESS);
    assert.equal(dialCalls[0].family, 4);
    assert.equal(dialCalls[0].hostname, 'connector.test');
    assert.equal(dialCalls[0].port, 8443);
    assert.equal(requestCalls.length, 1);
    assert.equal(requestCalls[0].parsed.hostname, 'connector.test');
    assert.equal(requestCalls[0].parsed.pathname, '/article');
    assert.equal(requestCalls[0].parsed.search, '?proof=pin');
    assert.equal(closedSockets.length, 1);

    let mismatchedRequests = 0;
    const mismatchedConnector = new production.DirectConnector({
        dial: async () => ({
            remoteAddress: '127.0.0.1',
            remoteFamily: 'IPv4',
            destroy: () => {},
        }),
        requestOnSocket: async () => {
            mismatchedRequests += 1;
            throw new Error('request issued before peer admission');
        },
    });
    const mismatched = await fetchAcceptedHtml({
        url: 'https://connector.test/article',
        resolver,
        connector: mismatchedConnector,
    });
    assertFailure(mismatched, { tag: 'UnsafeDestination' });
    assert.equal(mismatchedRequests, 0);
});

test('only HTML and XHTML MIME types are admitted before body consumption', async (t) => {
    await t.test('forbidden MIME', async () => {
        const origin = await listen((_request, response) => {
            response.writeHead(200, { 'content-type': 'application/json' });
            response.end(JSON.stringify({ secret: 'not article content' }));
        });
        const resolver = new StaticResolver({ 'mime.test': [PUBLIC_ADDRESS] });
        const connector = new MappedConnector({ 'mime.test': origin.url });
        try {
            const result = await fetchAcceptedHtml({
                url: 'http://mime.test/data',
                resolver,
                connector,
            });
            assertFailure(result, { tag: 'UnsupportedMediaType' });
            assert.equal(connector.requestCalls.length, 1);
            assert.equal(connector.requestCalls[0].bodyBytesRead, 0);
        } finally {
            await close(origin.server);
        }
    });

    for (const mediaType of ['text/html; charset=utf-8', 'application/xhtml+xml']) {
        await t.test(mediaType, async () => {
            const origin = await listen((_request, response) => {
                response.writeHead(200, { 'content-type': mediaType });
                response.end(SMALL_HTML);
            });
            const resolver = new StaticResolver({ 'html.test': [PUBLIC_ADDRESS] });
            const connector = new MappedConnector({ 'html.test': origin.url });
            try {
                const result = await fetchAcceptedHtml({
                    url: 'http://html.test/article',
                    resolver,
                    connector,
                });
                assertSuccess(result, 'http://html.test/article');
            } finally {
                await close(origin.server);
            }
        });
    }
});

test('redirects are manual, bounded, and revalidated at every hop', async () => {
    let requests = 0;
    const origin = await listen((request, response) => {
        requests += 1;
        const step = Number.parseInt(request.url.slice(1), 10);
        if (step < 3) {
            response.writeHead(302, { location: `/${step + 1}` });
            response.end();
            return;
        }
        respondHtml(response, SMALL_HTML);
    });
    const resolver = new StaticResolver({ 'redirect.test': [PUBLIC_ADDRESS] });
    const connector = new MappedConnector({ 'redirect.test': origin.url });

    try {
        const result = await fetchAcceptedHtml({
            url: 'http://redirect.test/0',
            resolver,
            connector,
        });
        assertFailure(result, { tag: 'TooManyRedirects' });
        assert.equal(requests, TEST_LIMITS.maxRedirects + 1);
        assert.equal(connector.requestCalls.length, TEST_LIMITS.maxRedirects + 1);
        assert.equal(resolver.calls.length, TEST_LIMITS.maxRedirects + 1);
    } finally {
        await close(origin.server);
    }
});

test('wire bytes are bounded while streaming', async () => {
    const origin = await listen((_request, response) => {
        respondHtml(response, htmlWithText('w'.repeat(TEST_LIMITS.maxWireBytes)));
    });
    const resolver = new StaticResolver({ 'wire.test': [PUBLIC_ADDRESS] });
    const connector = new MappedConnector({ 'wire.test': origin.url });
    try {
        const result = await fetchAcceptedHtml({
            url: 'http://wire.test/article',
            resolver,
            connector,
        });
        assertFailure(result, { tag: 'TooLarge', limit: 'wire' });
        assert(connector.requestCalls[0].bodyBytesRead <= TEST_LIMITS.maxWireBytes + 65536);
    } finally {
        await close(origin.server);
    }
});

test('compressed wire overflow returns the modeled wire limit instead of terminating', async () => {
    const compressed = gzipSync(SMALL_HTML);
    const maxWireBytes = compressed.byteLength - 1;
    assert(maxWireBytes > 0);
    const origin = await listen((_request, response) => {
        response.writeHead(200, {
            'content-type': 'text/html; charset=utf-8',
            'content-encoding': 'gzip',
            'transfer-encoding': 'chunked',
        });
        response.end(compressed);
    });
    const resolver = new StaticResolver({ 'compressed-wire.test': [PUBLIC_ADDRESS] });
    const connector = new MappedConnector({ 'compressed-wire.test': origin.url });
    try {
        const result = await fetchAcceptedHtml({
            url: 'http://compressed-wire.test/article',
            resolver,
            connector,
            limits: { ...TEST_LIMITS, maxWireBytes },
        });
        assertFailure(result, { tag: 'TooLarge', limit: 'wire' });
        assert(connector.requestCalls[0].bodyBytesRead <= maxWireBytes + 65536);
    } finally {
        await close(origin.server);
    }
});

test('decompressed bytes are bounded independently of compressed wire bytes', async () => {
    const compressed = gzipSync(htmlWithText('d'.repeat(TEST_LIMITS.maxDecompressedBytes)));
    assert(compressed.byteLength < TEST_LIMITS.maxWireBytes);
    const origin = await listen((_request, response) => {
        respondHtml(response, compressed, {
            'content-encoding': 'gzip',
            'content-length': compressed.byteLength,
        });
    });
    const resolver = new StaticResolver({ 'decompressed.test': [PUBLIC_ADDRESS] });
    const connector = new MappedConnector({ 'decompressed.test': origin.url });
    try {
        const result = await fetchAcceptedHtml({
            url: 'http://decompressed.test/article',
            resolver,
            connector,
        });
        assertFailure(result, { tag: 'TooLarge', limit: 'decompressed' });
    } finally {
        await close(origin.server);
    }
});

test('decoded code points are bounded independently of decoded byte size', async () => {
    const compressed = gzipSync(htmlWithText('c'.repeat(TEST_LIMITS.maxDecodedCodePoints)));
    assert(compressed.byteLength < TEST_LIMITS.maxWireBytes);
    const origin = await listen((_request, response) => {
        respondHtml(response, compressed, { 'content-encoding': 'gzip' });
    });
    const resolver = new StaticResolver({ 'decoded.test': [PUBLIC_ADDRESS] });
    const connector = new MappedConnector({ 'decoded.test': origin.url });
    try {
        const result = await fetchAcceptedHtml({
            url: 'http://decoded.test/article',
            resolver,
            connector,
        });
        assertFailure(result, { tag: 'TooLarge', limit: 'decoded' });
    } finally {
        await close(origin.server);
    }
});

test('UTF-8 source bytes are bounded independently of Unicode code points', async () => {
    const source = htmlWithText('🜁'.repeat(320));
    assert([...source].length < TEST_LIMITS.maxDecodedCodePoints);
    assert(Buffer.byteLength(source) > TEST_LIMITS.maxSourceBytes);
    assert(Buffer.byteLength(source) < TEST_LIMITS.maxDecompressedBytes);
    const compressed = gzipSync(source);
    assert(compressed.byteLength < TEST_LIMITS.maxWireBytes);
    const origin = await listen((_request, response) => {
        respondHtml(response, compressed, { 'content-encoding': 'gzip' });
    });
    const resolver = new StaticResolver({ 'source.test': [PUBLIC_ADDRESS] });
    const connector = new MappedConnector({ 'source.test': origin.url });
    try {
        const result = await fetchAcceptedHtml({
            url: 'http://source.test/article',
            resolver,
            connector,
        });
        assertFailure(result, { tag: 'TooLarge', limit: 'source' });
    } finally {
        await close(origin.server);
    }
});

test('one total timeout signal spans resolution, redirects, and body streaming', async () => {
    const origin = await listen((request, response) => {
        if (request.url === '/0') {
            response.writeHead(302, { location: '/1' });
            response.end();
            return;
        }
        if (request.url === '/1') {
            response.writeHead(302, { location: '/slow' });
            response.end();
            return;
        }
        setTimeout(() => respondHtml(response, SMALL_HTML), 200);
    });
    const resolver = new StaticResolver({ 'timeout.test': [PUBLIC_ADDRESS] });
    const connector = new MappedConnector({ 'timeout.test': origin.url });
    const startedAt = Date.now();
    try {
        const result = await fetchAcceptedHtml({
            url: 'http://timeout.test/0',
            resolver,
            connector,
            timeoutMs: 40,
        });
        assertFailure(result, { tag: 'Timeout' });
        assert(Date.now() - startedAt < 500);
        assert.equal(connector.requestCalls.length, 3);
        const signals = [
            ...resolver.calls.map(({ signal }) => signal),
            ...connector.connectCalls.map(({ signal }) => signal),
        ];
        assert.equal(new Set(signals).size, 1, 'every hop must share one total-deadline signal');
    } finally {
        await close(origin.server);
    }
});

test('URL credentials are rejected and ambient proxy or credential state is never forwarded', async () => {
    const firstOrigin = await listen((_request, response) => {
        response.writeHead(302, { location: 'http://other-public.test/article' });
        response.end();
    });
    const finalOrigin = await listen((_request, response) => {
        respondHtml(response, SMALL_HTML);
    });
    const resolver = new StaticResolver({
        'public.test': [PUBLIC_ADDRESS],
        'other-public.test': [OTHER_PUBLIC_ADDRESS],
    });
    const connector = new MappedConnector({
        'public.test': firstOrigin.url,
        'other-public.test': finalOrigin.url,
    });
    const previousProxyEnvironment = Object.fromEntries(
        ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY'].map((name) => [name, process.env[name]]),
    );
    Object.assign(process.env, {
        HTTP_PROXY: 'http://user:secret@127.0.0.1:1',
        HTTPS_PROXY: 'http://user:secret@127.0.0.1:1',
        ALL_PROXY: 'socks5://user:secret@127.0.0.1:1',
        NO_PROXY: '',
    });

    try {
        const credentialed = await fetchAcceptedHtml({
            url: 'http://user:secret@public.test/article',
            resolver,
            connector,
        });
        assertFailure(credentialed, { tag: 'UnsafeDestination' });
        assert.equal(resolver.calls.length, 0);
        assert.equal(connector.connectCalls.length, 0);

        const result = await fetchAcceptedHtml({
            url: 'http://public.test/start',
            resolver,
            connector,
        });
        assertSuccess(result, 'http://other-public.test/article');
        assert.equal(connector.requestCalls.length, 2);
        for (const call of connector.connectCalls) {
            assert.equal(Object.hasOwn(call, 'proxy'), false);
        }
        for (const { headers } of connector.requestCalls) {
            for (const forbidden of ['authorization', 'cookie', 'proxy-authorization']) {
                assert.equal(headers[forbidden], undefined);
            }
        }
    } finally {
        for (const [name, value] of Object.entries(previousProxyEnvironment)) {
            if (value === undefined) {
                delete process.env[name];
            } else {
                process.env[name] = value;
            }
        }
        await Promise.all([close(firstOrigin.server), close(finalOrigin.server)]);
    }
});
