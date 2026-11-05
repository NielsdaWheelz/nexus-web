// The current public full reading view. The route number is a carrier post,
// never the logical article id; only the server resolves that identity.
export function qualifyXArticleView(document, sourceUrl) {
    const source = new URL(sourceUrl);
    const carrier = /^\/([A-Za-z0-9_]{1,15})\/article\/([0-9]+)\/?$/.exec(source.pathname);
    if (source.protocol !== 'https:' || !['x.com', 'twitter.com', 'mobile.twitter.com'].includes(source.hostname)
        || !carrier || carrier[1] === 'i') return null;
    const canonical = document.querySelectorAll('link[rel="canonical"][href]');
    if (canonical.length !== 1) return null;
    const canonicalUrl = new URL(canonical[0].getAttribute('href'), source);
    if (canonicalUrl.origin !== source.origin
        || canonicalUrl.pathname.replace(/\/$/, '') !== source.pathname.replace(/\/$/, '')) return null;
    const titles = document.querySelectorAll('h1[data-article-part="title"]');
    const bylines = document.querySelectorAll('[data-article-part="byline"]');
    const bodies = document.querySelectorAll('[data-article-part="body"]');
    if (titles.length !== 1 || bylines.length !== 1 || bodies.length !== 1) return null;
    const title = titles[0];
    const byline = bylines[0];
    const body = bodies[0];
    const owner = title.parentElement;
    if (!owner || byline.parentElement !== owner || body.parentElement !== owner
        || !title.textContent.trim() || owner.closest('[hidden], [aria-busy="true"]')
        || !body.querySelector('[data-article-body-html]')
        || body.querySelector('[contenteditable="true"], [role="progressbar"], [aria-busy="true"]')) return null;
    const authors = [...new Set([...byline.querySelectorAll('a[href]')].filter(link => {
        const url = new URL(link.getAttribute('href'), source);
        return url.origin === source.origin && url.pathname.replace(/\/$/, '').toLowerCase() === `/${carrier[1].toLowerCase()}`;
    }).map(link => link.textContent.trim()).filter(text => text && !text.startsWith('@')))];
    return { owner, body, carrier_id: carrier[2], title: title.textContent.trim(),
        byline: authors.length === 1 ? authors[0] : '',
        publishedTime: byline.querySelector('time[datetime]')?.getAttribute('datetime') ?? '' };
}

export function extractXArticle(document, sourceUrl) {
    const view = qualifyXArticleView(document, sourceUrl);
    if (!view) return null;
    const source = new URL(sourceUrl);
    const content = view.body.cloneNode(true);
    // The article's authored chunks surround independently rendered post cards.
    // Preserve their actual source links in the existing embed grammar; neither
    // loading skeletons nor engagement controls are article prose.
    for (const frame of content.querySelectorAll('[data-slot="embedded-tweet-frame"]')) {
        if (frame.parentElement?.closest('[data-slot="embedded-tweet-frame"]')) continue;
        const links = [...frame.children].filter(child => child.matches('a[href]'));
        const urls = [...new Set(links.map(link => new URL(link.getAttribute('href'), source))
            .filter(url => url.origin === source.origin && /^\/(?:[A-Za-z0-9_]+|i\/web)\/status\/[0-9]+\/?$/.test(url.pathname))
            .map(url => url.origin + url.pathname))];
        if (urls.length !== 1) return null;
        const target = frame.getAttribute('data-href');
        if (target) {
            const url = new URL(target, source);
            if (url.origin + url.pathname !== urls[0]) return null;
        }
        const quote = document.createElement('blockquote');
        quote.className = 'twitter-tweet';
        const posts = [...frame.querySelectorAll('article')].filter(post => post.closest('[data-slot="embedded-tweet-frame"]') === frame);
        if (posts.length === 1) {
            const text = [...posts[0].querySelectorAll('div[dir="auto"]')].filter(node => node.closest('article') === posts[0]
                && node.closest('[data-slot="embedded-tweet-frame"]') === frame);
            if (text.length === 1) {
                const paragraph = document.createElement('p');
                paragraph.textContent = text[0].textContent;
                quote.append(paragraph);
            }
        }
        const link = document.createElement('a');
        link.setAttribute('href', urls[0]);
        quote.append(link);
        frame.replaceWith(quote);
    }
    // The reader has no X player. Keep the actual poster and direct media link.
    for (const video of content.querySelectorAll('video')) {
        const poster = video.getAttribute('poster');
        if (!poster) return null;
        const image = document.createElement('img');
        image.setAttribute('src', poster);
        image.setAttribute('alt', '');
        const mediaUrl = video.getAttribute('src');
        if (mediaUrl && /^https?:$/.test(new URL(mediaUrl, source).protocol)) {
            const link = document.createElement('a');
            link.setAttribute('href', mediaUrl);
            link.append(image);
            video.replaceWith(link);
        } else video.replaceWith(image);
    }
    // Current authored HTML already carries paragraphs, headings, emphasis,
    // figures and captions. Its divs only lay out those semantic elements.
    for (const wrapper of [...content.querySelectorAll('div')].reverse())
        wrapper.replaceWith(...wrapper.childNodes);
    const article = document.createElement('article');
    const covers = [...view.owner.children].filter(child => child.matches('[data-article-part="cover"]'));
    if (covers.length > 1) return null;
    if (covers.length === 1) article.append(covers[0].cloneNode(true));
    article.append(...content.childNodes);
    return { title: view.title, content: article.outerHTML, byline: view.byline,
        excerpt: '', siteName: 'X', publishedTime: view.publishedTime, sourceRoot: article };
}
