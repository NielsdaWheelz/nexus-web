import { Readability } from '@mozilla/readability';

function extractWikisourceArticle(document) {
    const contentRoot = document.querySelector('.mw-parser-output');
    if (!contentRoot) return null;

    // Wikisource's browser layout wraps the authored body in column containers.
    const body = contentRoot.querySelector('.prp-pages-output:not(.reflist)')
        || contentRoot.querySelector('.prp-pages-output');
    if (!body) return null;

    const clone = body.cloneNode(true);
    for (const selector of [
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

function extractSemanticMainArticle(document) {
    const landmarks = document.querySelectorAll('main, [role="main"]');
    if (landmarks.length !== 1) return null;

    const scopedDocument = document.cloneNode(true);
    const scopedMain = scopedDocument.querySelector('main, [role="main"]');
    if (!scopedDocument.body || !scopedMain) return null;
    if (scopedMain !== scopedDocument.body) {
        scopedDocument.body.replaceChildren(scopedMain.cloneNode(true));
    }
    return new Readability(scopedDocument, { keepClasses: true }).parse();
}

export function extractArticle(document) {
    // Readability absolutizes fragments against <base>. Preserve an authored
    // local relationship only when its target exists in this source document.
    const fragmentAttribute = 'data-nexus-authored-fragment';
    for (const element of document.querySelectorAll(`[${fragmentAttribute}]`)) {
        element.removeAttribute(fragmentAttribute);
    }
    for (const anchor of document.querySelectorAll('a[href^="#"]')) {
        const href = anchor.getAttribute('href');
        let targetId;
        try {
            targetId = decodeURIComponent(href.slice(1));
        } catch {
            continue;
        }
        if (targetId && document.getElementById(targetId)) {
            anchor.setAttribute(fragmentAttribute, href);
        }
    }
    const article = extractWikisourceArticle(document)
        || extractSemanticMainArticle(document)
        || new Readability(document, { keepClasses: true }).parse();
    if (!article || !article.content.includes(fragmentAttribute)) return article;
    const content = document.createElement('div');
    content.innerHTML = article.content;
    for (const anchor of content.querySelectorAll(`[${fragmentAttribute}]`)) {
        anchor.setAttribute('href', anchor.getAttribute(fragmentAttribute));
        anchor.removeAttribute(fragmentAttribute);
    }
    article.content = content.innerHTML;
    return article;
}
