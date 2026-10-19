import { Readability } from '@mozilla/readability';

// The browser's qualified X reading view, not a post teaser or page-wide
// Readability guess. The server has already classified the pinned page URL;
// its carrier number must also occur in this view's own source links.
export function extractXArticle(document, sourceUrl) {
    const source = new URL(sourceUrl);
    const carrier = /^\/([A-Za-z0-9_]+)\/article\/([0-9]+)\/?$/.exec(source.pathname);
    if (!carrier) return null;
    const views = document.querySelectorAll('article[data-testid="twitterArticleReadView"]');
    if (views.length !== 1) return null;
    const view = views[0];
    const bodies = view.querySelectorAll('[data-testid="twitterArticleRichTextView"]');
    if (bodies.length !== 1 || view.getAttribute('aria-busy') === 'true') return null;
    const body = bodies[0];
    if (!body.querySelector('[data-testid="longformRichTextComponent"] [data-block="true"]')
        || body.querySelector('[contenteditable="true"], [role="progressbar"], [aria-busy="true"]')) return null;
    const pagePath = `/${carrier[1]}/article/${carrier[2]}`;
    const statusPath = `/${carrier[1]}/status/${carrier[2]}/analytics`;
    const linkedCarrier = [...view.querySelectorAll('a[href]')].some(link => {
        const url = new URL(link.getAttribute('href'), source);
        return url.origin === source.origin
            && (url.pathname === statusPath || url.pathname.startsWith(`${pagePath}/media/`));
    });
    if (!linkedCarrier) return null;

    const headerRange = document.createRange();
    headerRange.setStart(view, 0);
    headerRange.setEndBefore(body);
    const header = headerRange.cloneContents();
    const titles = header.querySelectorAll('[data-testid="twitter-article-title"]');
    if (titles.length !== 1 || !titles[0].textContent.trim()) return null;
    const author = [...header.querySelectorAll('a[href]')].find(link => {
        const url = new URL(link.getAttribute('href'), source);
        const text = link.textContent.trim();
        return url.origin === source.origin && url.pathname === `/${carrier[1]}`
            && text && !text.startsWith('@');
    });
    const content = body.cloneNode(true);

    // The current reader cannot play X's player. Keep its actual poster and
    // direct media URL, without playback controls or invented caption text.
    for (const player of content.querySelectorAll('[data-testid="videoPlayer"]')) {
        const video = player.querySelector('video');
        const poster = video?.getAttribute('poster');
        if (!poster) return null;
        const image = document.createElement('img');
        image.setAttribute('src', poster);
        image.setAttribute('alt', '');
        const mediaUrl = video.getAttribute('src');
        if (mediaUrl && /^https?:$/.test(new URL(mediaUrl, source).protocol)) {
            const link = document.createElement('a');
            link.setAttribute('href', mediaUrl);
            link.append(image);
            player.replaceWith(link);
        } else player.replaceWith(image);
    }
    // These are authored inline styles in the observed DraftJS body. Convert
    // them before the shared privacy reducer removes every style attribute.
    for (const element of content.querySelectorAll('span[style]')) {
        for (const [matches, tag] of [
            [element.style.fontWeight === 'bold', 'strong'],
            [element.style.fontStyle === 'italic', 'em'],
        ]) {
            if (!matches) continue;
            const wrapper = document.createElement(tag);
            wrapper.append(...element.childNodes);
            element.append(wrapper);
        }
    }
    for (const block of content.querySelectorAll('.longform-unstyled')) {
        const paragraph = document.createElement('p');
        paragraph.append(...block.childNodes);
        block.replaceWith(paragraph);
    }
    for (const caption of content.querySelectorAll('.twitter-article-media-caption-id')) {
        const block = caption.closest('section[data-block="true"]');
        if (!block) return null;
        const replacement = document.createElement('figcaption');
        replacement.append(...caption.childNodes);
        caption.replaceWith(replacement);
        const figure = document.createElement('figure');
        figure.append(...block.childNodes);
        block.replaceWith(figure);
    }
    for (const separator of content.querySelectorAll('[role="separator"]'))
        separator.replaceWith(document.createElement('hr'));
    // Layout wrappers carry neither source text boundaries nor formatting once
    // the actual paragraphs/headings/quotes/media above have their own tags.
    for (const wrapper of [...content.querySelectorAll('div')].reverse())
        wrapper.replaceWith(...wrapper.childNodes);

    const article = document.createElement('article');
    for (const cover of header.querySelectorAll('a[href]')) {
        const url = new URL(cover.getAttribute('href'), source);
        const image = cover.querySelector('img');
        if (url.origin !== source.origin || !url.pathname.startsWith(`${pagePath}/media/`) || !image) continue;
        const link = document.createElement('a');
        link.setAttribute('href', url.href);
        link.append(image.cloneNode(true));
        article.append(link);
    }
    article.append(...content.childNodes);
    return {
        title: titles[0].textContent.trim(),
        content: article.outerHTML,
        byline: author?.textContent.trim() ?? '',
        excerpt: '',
        siteName: 'X',
        publishedTime: header.querySelector('time[datetime]')?.getAttribute('datetime') ?? '',
        sourceRoot: body,
    };
}

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
