import assert from 'node:assert/strict';
import test from 'node:test';

import { JSDOM } from 'jsdom';

import { extractArticle } from '../article_extraction.mjs';

test('a unique semantic main landmark owns article extraction', () => {
    const intended = 'The brief authored poem remains the page article. '.repeat(7);
    const unrelated = 'A longer related card must not become the article. '.repeat(80);
    const dom = new JSDOM(`<!doctype html>
        <html lang="en">
          <head><title>This Living Hand</title></head>
          <body>
            <main id="main-content" role="main">
              <article><h1>This Living Hand</h1><p>${intended}</p></article>
            </main>
            <div aria-label="Related poems">
              <article><h2>Ode on a Grecian Urn</h2><p>${unrelated}</p></article>
            </div>
          </body>
        </html>`, { url: 'https://example.com/poem' });

    const article = extractArticle(dom.window.document);

    assert(article, 'the semantic main article was not extracted');
    assert.match(article.content, /The brief authored poem remains the page article/);
    assert.doesNotMatch(article.content, /A longer related card must not become the article/);
});
