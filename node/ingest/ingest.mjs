#!/usr/bin/env node
/**
 * Web Article Ingestion Script
 *
 * Fetches a URL through the accepted-source egress boundary, detects character
 * encoding, and extracts readable content using Mozilla Readability via jsdom.
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
 *     "failure": { "tag": "Http", "status": 403 }
 *   }
 *
 * IMPORTANT: Never call process.exit() directly — it kills the process
 * before stdio buffers flush, truncating piped output. Instead, throw
 * an IngestFailure or set process.exitCode and return.
 */

import { JSDOM } from 'jsdom';
import { Readability } from '@mozilla/readability';
import {
    DEFAULT_ACCEPTED_URL_LIMITS,
    fetchAcceptedHtml,
    MAX_ACCEPTED_URL_TIMEOUT_MS,
} from './accepted_url_egress.mjs';

const PROTOCOL_VERSION = 1;
const MAX_SUCCESS_URL_BYTES = 4096;
const MAX_SUCCESS_CONTENT_BYTES = DEFAULT_ACCEPTED_URL_LIMITS.maxSourceBytes;
const SUCCESS_TEXT_LIMITS = Object.freeze({
    title: 1000,
    byline: 1000,
    excerpt: 2000,
    siteName: 255,
    publishedTime: 64,
});

/**
 * Structured modeled failure for the ingestion pipeline.
 * Thrown instead of calling process.exit() to allow proper cleanup
 * and stdio flushing.
 */
class IngestFailure extends Error {
    constructor(failure) {
        super(failure.tag);
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
 * Core ingestion: acquire admitted HTML, then extract with Readability.
 * Returns the result object on success, throws IngestFailure on modeled failure.
 */
async function ingest(url, timeoutMs) {
    const fetched = await fetchAcceptedHtml({ url, timeoutMs });
    if (fetched.tag === 'Failure') {
        throw new IngestFailure(fetched.failure);
    }
    const finalUrl = acceptedSuccessUrl(fetched.final_url);
    const fullHtml = fetched.source_html;

    // Extract article with jsdom + Readability, plus source-aware handling for
    // Wikisource proofread pages whose poem/body text can score below notes.
    const dom = new JSDOM(fullHtml, { url: finalUrl });
    const article = extractArticle(dom.window.document);

    if (!article || typeof article.content !== 'string' || article.content.length === 0) {
        throw new IngestFailure({ tag: 'Readability' });
    }
    if (
        Buffer.byteLength(article.content, 'utf8') > MAX_SUCCESS_CONTENT_BYTES
        || Buffer.byteLength(fullHtml, 'utf8') > MAX_SUCCESS_CONTENT_BYTES
    ) {
        throw new IngestFailure({ tag: 'TooLarge', limit: 'source' });
    }

    return {
        final_url: finalUrl,
        base_url: finalUrl,
        title: boundedText(article.title, SUCCESS_TEXT_LIMITS.title),
        content_html: article.content,
        source_html: fullHtml,
        byline: boundedText(article.byline, SUCCESS_TEXT_LIMITS.byline),
        excerpt: boundedText(article.excerpt, SUCCESS_TEXT_LIMITS.excerpt),
        site_name: boundedText(article.siteName, SUCCESS_TEXT_LIMITS.siteName),
        published_time: boundedText(
            article.publishedTime,
            SUCCESS_TEXT_LIMITS.publishedTime,
        ),
    };
}

function acceptedSuccessUrl(value) {
    if (typeof value !== 'string' || Buffer.byteLength(value, 'utf8') > MAX_SUCCESS_URL_BYTES) {
        throw new IngestFailure({ tag: 'UnsafeDestination' });
    }
    let parsed;
    try {
        parsed = new URL(value);
    } catch {
        throw new IngestFailure({ tag: 'UnsafeDestination' });
    }
    if (
        !['http:', 'https:'].includes(parsed.protocol)
        || parsed.username !== ''
        || parsed.password !== ''
        || parsed.hash !== ''
        || parsed.hostname === ''
    ) {
        throw new IngestFailure({ tag: 'UnsafeDestination' });
    }
    return value;
}

function boundedText(value, maxCodePoints) {
    if (value === null || value === undefined) {
        return '';
    }
    if (typeof value !== 'string') {
        throw new IngestFailure({ tag: 'Readability' });
    }
    let bounded = '';
    let codePoints = 0;
    for (const codePoint of value) {
        if (codePoints === maxCodePoints) {
            break;
        }
        bounded += codePoint;
        codePoints += 1;
    }
    return bounded;
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
        if (
            typeof timeoutMs !== 'number'
            || !Number.isInteger(timeoutMs)
            || timeoutMs <= 0
            || timeoutMs > MAX_ACCEPTED_URL_TIMEOUT_MS
        ) {
            throw new Error(
                `Invalid timeout_ms: ${timeoutMs}. `
                + `Expected integer in range 1-${MAX_ACCEPTED_URL_TIMEOUT_MS}`
            );
        }
        const result = await ingest(url, timeoutMs);
        process.stdout.write(JSON.stringify({
            version: PROTOCOL_VERSION,
            tag: 'Success',
            ...result,
        }) + '\n');
    } catch (e) {
        if (e instanceof IngestFailure) {
            process.stdout.write(JSON.stringify({
                version: PROTOCOL_VERSION,
                tag: 'Failure',
                failure: e.failure,
            }) + '\n');
            return;
        }
        const message = e instanceof Error ? e.message : String(e);
        process.stderr.write(JSON.stringify({ error: message }) + '\n');
        process.exitCode = 1;
    }
}

main();
