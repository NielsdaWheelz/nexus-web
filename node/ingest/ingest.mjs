#!/usr/bin/env node
// One JSON request on stdin; one versioned result on stdout. Source failures
// are modeled results; invocation errors and defects use stderr and exit 1.
import { JSDOM } from 'jsdom';
import { fetchAcceptedHtml, MAX_ACCEPTED_URL_TIMEOUT_MS, MAX_HTML_BYTES } from './accepted_url_egress.mjs';
import { extractArticle } from './article_extraction.mjs';

async function ingest(url, timeoutMs) {
    const fetched = await fetchAcceptedHtml({ url, timeoutMs });
    if (fetched.tag === 'Failure') return fetched;
    const dom = new JSDOM(fetched.source_html, { url: fetched.final_url });
    const article = extractArticle(dom.window.document);
    if (!article || typeof article.content !== 'string' || article.content.length === 0) {
        return { tag: 'Failure', failure: { tag: 'Readability' } };
    }
    if (Buffer.byteLength(article.content, 'utf8') > MAX_HTML_BYTES) {
        return { tag: 'Failure', failure: { tag: 'TooLarge', limit: 'source' } };
    }
    const metadata = [article.title, article.byline, article.excerpt, article.siteName, article.publishedTime];
    if (metadata.some((value) => value != null && typeof value !== 'string')) {
        return { tag: 'Failure', failure: { tag: 'Readability' } };
    }
    return {
        tag: 'Success',
        final_url: fetched.final_url,
        base_url: fetched.final_url,
        title: boundedText(article.title, 1000),
        content_html: article.content,
        source_html: fetched.source_html,
        byline: boundedText(article.byline, 1000),
        excerpt: boundedText(article.excerpt, 2000),
        site_name: boundedText(article.siteName, 255),
        published_time: boundedText(article.publishedTime, 64),
    };
}

function boundedText(value, limit) {
    let result = '';
    let count = 0;
    for (const codePoint of value ?? '') {
        if (count++ === limit) break;
        result += codePoint;
    }
    return result;
}

async function main() {
    try {
        const chunks = [];
        for await (const chunk of process.stdin) chunks.push(chunk);
        const input = JSON.parse(Buffer.concat(chunks).toString('utf-8'));
        if (!input || typeof input !== 'object' || Array.isArray(input)
            || Object.keys(input).length !== 2
            || !Object.hasOwn(input, 'url') || !Object.hasOwn(input, 'timeout_ms')) {
            throw new Error('Input must contain exactly url and timeout_ms');
        }
        const { url, timeout_ms: timeoutMs } = input;
        if (!url || typeof url !== 'string') throw new Error('Missing required field: url');
        if (!Number.isInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > MAX_ACCEPTED_URL_TIMEOUT_MS) {
            throw new Error(
                `Invalid timeout_ms: ${timeoutMs}. Expected integer in range 1-${MAX_ACCEPTED_URL_TIMEOUT_MS}`,
            );
        }
        const result = await ingest(url, timeoutMs);
        process.stdout.write(JSON.stringify({ version: 1, ...result }) + '\n');
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        process.stderr.write(JSON.stringify({ error: message }) + '\n');
        // Let piped stdout/stderr flush before the process exits.
        process.exitCode = 1;
    }
}

main();
