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
 * Output (stdout JSON):
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
 * Write error to stderr and exit with code.
 */
function exitWithError(code, message) {
    console.error(JSON.stringify({ error: message }));
    process.exit(code);
}

/**
 * Main ingestion function.
 */
async function main() {
    let browser = null;
    
    try {
        // Read and parse input
        const inputJson = await readStdin();
        let input;
        try {
            input = JSON.parse(inputJson);
        } catch (e) {
            exitWithError(EXIT_FETCH_FAILED, `Invalid JSON input: ${e.message}`);
        }

        const { url, timeout_ms = 30000 } = input;
        
        if (!url) {
            exitWithError(EXIT_FETCH_FAILED, 'Missing required field: url');
        }

        // Launch browser
        browser = await chromium.launch({
            headless: true,
        });

        const context = await browser.newContext({
            userAgent: 'NexusBot/1.0 (+https://nexus.example.com/bot)',
            // Ignore HTTPS errors for development/testing
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
                timeout: timeout_ms,
                waitUntil: 'domcontentloaded',
            });
        } catch (e) {
            if (e.name === 'TimeoutError' || e.message.includes('timeout')) {
                exitWithError(EXIT_TIMEOUT, `Page load timeout: ${e.message}`);
            }
            exitWithError(EXIT_FETCH_FAILED, `Navigation failed: ${e.message}`);
        }

        // Check response
        if (!response) {
            exitWithError(EXIT_FETCH_FAILED, 'No response received');
        }

        const status = response.status();
        if (status >= 400) {
            exitWithError(EXIT_FETCH_FAILED, `HTTP error: ${status}`);
        }

        // Get final URL after redirects
        const finalUrl = page.url();

        // Get full page HTML
        const fullHtml = await page.content();

        // Close browser early to free resources
        await browser.close();
        browser = null;

        // Parse with jsdom (with URL context for relative URL resolution)
        const dom = new JSDOM(fullHtml, { url: finalUrl });
        const document = dom.window.document;

        // Run Mozilla Readability
        const reader = new Readability(document, {
            // Keep some attributes for better extraction
            keepClasses: false,
        });
        
        const article = reader.parse();

        if (!article || !article.content) {
            exitWithError(EXIT_READABILITY_FAILED, 'Readability could not extract article content');
        }

        // Output result
        const result = {
            final_url: finalUrl,
            base_url: finalUrl,
            title: article.title || '',
            content_html: article.content,
        };

        console.log(JSON.stringify(result));
        process.exit(EXIT_SUCCESS);

    } catch (e) {
        // Cleanup browser if still open
        if (browser) {
            try {
                await browser.close();
            } catch (_) {}
        }

        // Determine exit code based on error type
        if (e.message && e.message.includes('timeout')) {
            exitWithError(EXIT_TIMEOUT, `Timeout: ${e.message}`);
        }
        exitWithError(EXIT_FETCH_FAILED, `Unexpected error: ${e.message}`);
    }
}

// Run main
main();
