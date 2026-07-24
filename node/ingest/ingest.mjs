#!/usr/bin/env node
/**
 * Web Article Ingestion Script
 *
 * Fetches a URL using native fetch() (Node 20+), follows redirects,
 * detects character encoding, and extracts readable content using
 * Mozilla Readability via jsdom.
 *
 * LIMITATION: No JavaScript execution. Client-rendered SPA pages that
 * rely on runtime hydration may return shell HTML and fail extraction.
 *
 * Input (stdin JSON):
 *   { "url": "https://example.com/article", "timeout_ms": 30000 }
 *
 * Output (stdout JSON for every modeled result):
 *   { "version": 1, "tag": "Success",
 *     "final_url": "https://example.com/actual-article",
 *     "base_url": "https://example.com/actual-article",
 *     "title": "Article Title",
 *     "content_html": "<div>...</div>",
 *     "byline": "Author Name",
 *     "excerpt": "Short description",
 *     "site_name": "Example.com",
 *     "published_time": "2023-01-15T00:00:00Z"
 *   }
 *   { "version": 1, "tag": "Failure",
 *     "failure": { "tag": "Http", "status": 403 },
 *     "message": "HTTP error: 403"
 *   }
 *
 * IMPORTANT: Never call process.exit() directly — it kills the process
 * before stdio buffers flush, truncating piped output. Instead, throw
 * an IngestFailure or set process.exitCode and return.
 */

import { JSDOM } from 'jsdom';
import { Readability } from '@mozilla/readability';

const USER_AGENT = 'NexusBot/1.0 (+https://nexus.example.com/bot)';
const MAX_BODY_BYTES = 10 * 1024 * 1024; // 10 MiB safety limit
const MAX_TIMEOUT_MS = 120000; // hard cap to avoid unbounded hangs
const PROTOCOL_VERSION = 1;

/**
 * Structured modeled failure for the ingestion pipeline.
 * Thrown instead of calling process.exit() to allow proper cleanup
 * and stdio flushing.
 */
class IngestFailure extends Error {
    constructor(failure, message) {
        super(message);
        this.failure = failure;
    }
}

/**
 * Read all stdin data as a string.
 */
async function readStdin() {
    const chunks = [];
    for await (const chunk of process.stdin) {
        chunks.push(chunk);
    }
    return Buffer.concat(chunks).toString('utf-8');
}

/**
 * Parse charset from Content-Type header value.
 * Returns the charset name or null if not specified.
 *
 * Examples:
 *   "text/html; charset=utf-8"       → "utf-8"
 *   "text/html; charset=ISO-8859-1"  → "iso-8859-1"
 *   "text/html"                       → null
 */
function parseCharsetFromContentType(contentType) {
    if (!contentType) return null;
    const match = contentType.match(/charset\s*=\s*"?([^";,\s]+)"?/i);
    return match ? normalizeCharset(match[1]) : null;
}

/**
 * Normalize charset names and common aliases to decoder-friendly values.
 */
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

/**
 * Sniff charset from a <meta> tag in the first ~2048 bytes of HTML.
 * Scans raw bytes decoded as ASCII (safe — we only look for ASCII tag names).
 *
 * Handles:
 *   <meta charset="iso-8859-1">
 *   <meta http-equiv="Content-Type" content="text/html; charset=iso-8859-1">
 */
function sniffMetaCharset(bytes) {
    // Decode first 2048 bytes as ASCII to find meta tags
    const head = new TextDecoder('ascii', { fatal: false }).decode(bytes.slice(0, 2048));

    const metaTags = head.match(/<meta\b[^>]*>/gi) || [];

    for (const tag of metaTags) {
        // <meta charset="..."> (attribute can appear in any position)
        const charsetMatch = tag.match(/charset\s*=\s*["']?\s*([^"'>\s/;]+)/i);
        if (charsetMatch) {
            const normalized = normalizeCharset(charsetMatch[1]);
            if (normalized) return normalized;
        }

        // <meta http-equiv="Content-Type" content="text/html; charset=...">
        const isContentTypeMeta = /http-equiv\s*=\s*["']?\s*content-type\s*["']?/i.test(tag);
        if (!isContentTypeMeta) continue;

        const contentMatch = tag.match(/content\s*=\s*["']([^"']*)["']/i)
            || tag.match(/content\s*=\s*([^>\s]+)/i);
        if (!contentMatch) continue;

        const charset = parseCharsetFromContentType(contentMatch[1]);
        if (charset) return charset;
    }

    return null;
}

/**
 * Decode response body bytes into a string using the correct charset.
 *
 * Resolution order:
 * 1. charset from Content-Type header
 * 2. charset from <meta> tag in first 2048 bytes
 * 3. Default to UTF-8
 */
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
        } catch (_) {
            // Unsupported charset label: try next candidate.
        }
    }

    return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
}

function extractWikisourceArticle(document) {
    const contentRoot = document.querySelector('.mw-parser-output');
    if (!contentRoot) return null;

    const body = contentRoot.querySelector(':scope > .prp-pages-output:not(.reflist)')
        || contentRoot.querySelector(':scope > .prp-pages-output');
    if (!body) return null;

    const clone = body.cloneNode(true);
    for (const selector of [
        '.reference',
        '.references',
        '.reflist',
        '.ws-noexport',
        '.noprint',
        '.pagenum',
        'style',
        'script',
    ]) {
        for (const element of clone.querySelectorAll(selector)) {
            element.remove();
        }
    }

    const text = (clone.textContent || '').replace(/\s+/g, ' ').trim();
    if (text.length < 200) return null;

    const title = document.querySelector('#firstHeading')?.textContent?.trim()
        || document.title
        || '';
    return {
        title,
        content: `<article>${clone.innerHTML}</article>`,
        byline: '',
        excerpt: '',
        siteName: 'Wikisource',
        publishedTime: '',
    };
}

function extractArticle(document) {
    const wikisourceArticle = extractWikisourceArticle(document);
    if (wikisourceArticle) return wikisourceArticle;

    const reader = new Readability(document, { keepClasses: true });
    return reader.parse();
}

/**
 * Read response body with a bounded in-memory budget.
 */
async function readResponseBytes(response) {
    const contentLengthHeader = response.headers.get('content-length');
    if (contentLengthHeader) {
        const contentLength = Number.parseInt(contentLengthHeader, 10);
        if (Number.isFinite(contentLength) && contentLength > MAX_BODY_BYTES) {
            throw new IngestFailure(
                { tag: 'TooLarge' },
                `Response too large: ${contentLength} bytes (max ${MAX_BODY_BYTES})`
            );
        }
    }

    if (!response.body) {
        const arrayBuffer = await response.arrayBuffer();
        if (arrayBuffer.byteLength > MAX_BODY_BYTES) {
            throw new IngestFailure(
                { tag: 'TooLarge' },
                `Response too large: ${arrayBuffer.byteLength} bytes (max ${MAX_BODY_BYTES})`
            );
        }
        return new Uint8Array(arrayBuffer);
    }

    const reader = response.body.getReader();
    const chunks = [];
    let total = 0;

    while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value) continue;

        total += value.byteLength;
        if (total > MAX_BODY_BYTES) {
            try {
                await reader.cancel();
            } catch (_) {
                // Best-effort cancel only.
            }
            throw new IngestFailure(
                { tag: 'TooLarge' },
                `Response too large: exceeded ${MAX_BODY_BYTES} bytes`
            );
        }
        chunks.push(value);
    }

    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
    }
    return bytes;
}

/**
 * Core ingestion: fetch URL with native fetch(), extract with Readability.
 * Returns the result object on success, throws IngestFailure on modeled failure.
 */
async function ingest(url, timeoutMs) {
    // Fetch with timeout and redirect following
    let response;
    try {
        response = await fetch(url, {
            signal: AbortSignal.timeout(timeoutMs),
            headers: {
                'User-Agent': USER_AGENT,
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                'Accept-Language': 'en-US,en;q=0.5',
            },
            redirect: 'follow',
        });
    } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        if (e.name === 'TimeoutError' || e.name === 'AbortError') {
            throw new IngestFailure({ tag: 'Timeout' }, `Fetch timeout: ${message}`);
        }
        throw new IngestFailure({ tag: 'Network' }, `Fetch failed: ${message}`);
    }

    if (!response.ok) {
        throw new IngestFailure(
            { tag: 'Http', status: response.status },
            `HTTP error: ${response.status}`
        );
    }

    const finalUrl = response.url;
    const contentType = response.headers.get('content-type') || '';

    // Read response as raw bytes for proper encoding detection
    const bytes = await readResponseBytes(response);
    const fullHtml = decodeBody(bytes, contentType);

    // Extract article with jsdom + Readability, plus source-aware handling for
    // Wikisource proofread pages whose poem/body text can score below notes.
    const dom = new JSDOM(fullHtml, { url: finalUrl });
    const article = extractArticle(dom.window.document);

    if (!article || !article.content) {
        throw new IngestFailure(
            { tag: 'Readability' },
            'Readability could not extract article content'
        );
    }

    return {
        final_url: finalUrl,
        base_url: finalUrl,
        title: article.title || '',
        content_html: article.content,
        source_html: fullHtml,
        byline: article.byline || '',
        excerpt: article.excerpt || '',
        site_name: article.siteName || '',
        published_time: article.publishedTime || '',
    };
}

/**
 * Entry point: parse stdin, run ingestion, write result to stdout.
 *
 * Uses process.exitCode (not process.exit) so Node flushes stdio
 * before terminating — critical when stdout is a pipe.
 */
async function main() {
    try {
        const input = JSON.parse(await readStdin());
        if (
            !input
            || typeof input !== 'object'
            || Array.isArray(input)
            || Object.keys(input).length !== 2
            || !Object.hasOwn(input, 'url')
            || !Object.hasOwn(input, 'timeout_ms')
        ) {
            throw new Error('Input must contain exactly url and timeout_ms');
        }
        const { url, timeout_ms: timeoutMs = 30000 } = input;
        if (!url || typeof url !== 'string') {
            throw new Error('Missing required field: url');
        }
        const parsedUrl = new URL(url);
        if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
            throw new Error(`Unsupported URL scheme: ${parsedUrl.protocol}`);
        }
        if (
            typeof timeoutMs !== 'number'
            || !Number.isInteger(timeoutMs)
            || timeoutMs <= 0
            || timeoutMs > MAX_TIMEOUT_MS
        ) {
            throw new Error(
                `Invalid timeout_ms: ${timeoutMs}. Expected integer in range 1-${MAX_TIMEOUT_MS}`
            );
        }
        const result = await ingest(parsedUrl.toString(), timeoutMs);
        process.stdout.write(JSON.stringify({
            version: PROTOCOL_VERSION,
            tag: 'Success',
            ...result,
        }) + '\n');
    } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        if (e instanceof IngestFailure) {
            process.stdout.write(JSON.stringify({
                version: PROTOCOL_VERSION,
                tag: 'Failure',
                failure: e.failure,
                message,
            }) + '\n');
            return;
        }
        process.stderr.write(JSON.stringify({ error: message }) + '\n');
        process.exitCode = 1;
    }
}

main();
