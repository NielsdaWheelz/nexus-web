import { Readability } from '@mozilla/readability';

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
    return extractWikisourceArticle(document)
        || extractSemanticMainArticle(document)
        || new Readability(document, { keepClasses: true }).parse();
}
