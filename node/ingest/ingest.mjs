#!/usr/bin/env node
/**
 * Web Article Ingestion Script
 *
 * Fetches a URL using Playwright (with JS enabled), follows redirects,
 * extracts readable content using Mozilla Readability, and outputs JSON.
 *
 * Input (stdin JSON):
 *   { "url": "https://example.com/article", "timeout_ms": 30000 }
 *
 * Output (stdout JSON on success, stderr JSON on failure):
 *   {
 *     "final_url": "https://example.com/actual-article",
 *     "base_url": "https://example.com/actual-article",
 *     "title": "Article Title",
 *     "content_html": "<div>...</div>"
 *   }
 *
 * Exit Codes:
 *   0  - Success
 *   10 - Timeout
 *   11 - Fetch failed (network error, HTTP error, etc.)
 *   12 - Readability extraction failed
 *
 * IMPORTANT: Never call process.exit() directly — it kills the process
 * before stdio buffers flush, truncating piped output. Instead, throw
 * an IngestError or set process.exitCode and return.
 */

import { chromium } from 'playwright';
import { JSDOM } from 'jsdom';
import { Readability } from '@mozilla/readability';

// Exit codes per spec
const EXIT_SUCCESS = 0;
const EXIT_TIMEOUT = 10;
const EXIT_FETCH_FAILED = 11;
const EXIT_READABILITY_FAILED = 12;

/**
 * Structured error with exit code for the ingestion pipeline.
 * Thrown instead of calling process.exit() to allow proper cleanup
 * and stdio flushing.
 */
class IngestError extends Error {
    constructor(code, message) {
        super(message);
        this.code = code;
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
 * Core ingestion: fetch URL with Playwright, extract with Readability.
 * Returns the result object on success, throws IngestError on failure.
 */
async function ingest(url, timeoutMs) {
    let browser = null;

    try {
        browser = await chromium.launch({ headless: true });

        const context = await browser.newContext({
            userAgent: 'NexusBot/1.0 (+https://nexus.example.com/bot)',
            ignoreHTTPSErrors: true,
        });

        const page = await context.newPage();

        // Block heavy resources for speed and stability
        await page.route('**/*', (route) => {
            const type = route.request().resourceType();
            if (['media', 'font', 'image'].includes(type)) {
                route.abort();
            } else {
                route.continue();
            }
        });

        // Navigate to URL with timeout
        let response;
        try {
            response = await page.goto(url, {
                timeout: timeoutMs,
                waitUntil: 'domcontentloaded',
            });
        } catch (e) {
            if (e.name === 'TimeoutError' || e.message.includes('timeout')) {
                throw new IngestError(EXIT_TIMEOUT, `Page load timeout: ${e.message}`);
            }
            throw new IngestError(EXIT_FETCH_FAILED, `Navigation failed: ${e.message}`);
        }

        if (!response) {
            throw new IngestError(EXIT_FETCH_FAILED, 'No response received');
        }

        const status = response.status();
        if (status >= 400) {
            throw new IngestError(EXIT_FETCH_FAILED, `HTTP error: ${status}`);
        }

        const finalUrl = page.url();
        const fullHtml = await page.content();

        // Close browser before CPU-bound extraction to free resources
        await browser.close();
        browser = null;

        // Extract article with jsdom + Readability
        const dom = new JSDOM(fullHtml, { url: finalUrl });
        const reader = new Readability(dom.window.document, { keepClasses: false });
        const article = reader.parse();

        if (!article || !article.content) {
            throw new IngestError(EXIT_READABILITY_FAILED, 'Readability could not extract article content');
        }

        return {
            final_url: finalUrl,
            base_url: finalUrl,
            title: article.title || '',
            content_html: article.content,
        };
    } finally {
        if (browser) {
            try { await browser.close(); } catch (_) { /* best-effort cleanup */ }
        }
    }
}

/**
 * Entry point: parse stdin, run ingestion, write result to stdout.
 *
 * Uses process.exitCode (not process.exit) so Node flushes stdio
 * before terminating — critical when stdout is a pipe.
 */
async function main() {
    let input;
    try {
        input = JSON.parse(await readStdin());
    } catch (e) {
        process.stderr.write(JSON.stringify({ error: `Invalid JSON input: ${e.message}` }) + '\n');
        process.exitCode = EXIT_FETCH_FAILED;
        return;
    }

    const { url, timeout_ms: timeoutMs = 30000 } = input;
    if (!url) {
        process.stderr.write(JSON.stringify({ error: 'Missing required field: url' }) + '\n');
        process.exitCode = EXIT_FETCH_FAILED;
        return;
    }

    try {
        const result = await ingest(url, timeoutMs);
        process.stdout.write(JSON.stringify(result) + '\n');
        process.exitCode = EXIT_SUCCESS;
    } catch (e) {
        const code = e instanceof IngestError ? e.code
            : e.message?.includes('timeout') ? EXIT_TIMEOUT
            : EXIT_FETCH_FAILED;
        process.stderr.write(JSON.stringify({ error: e.message }) + '\n');
        process.exitCode = code;
    }
}

main();
