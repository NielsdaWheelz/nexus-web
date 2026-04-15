globalThis.__nexusCaptureArticle = function () {
  if (typeof Readability !== "function") {
    throw new Error("Readability is not available");
  }

  const article = new Readability(document.cloneNode(true)).parse();
  if (!article || !article.content) {
    throw new Error("This page does not contain a readable article");
  }

  const publishedTime =
    document.querySelector("meta[property='article:published_time']")?.content ||
    document.querySelector("meta[name='date']")?.content ||
    null;

  return {
    url: location.href,
    title: article.title || document.title || location.href,
    byline: article.byline || null,
    excerpt: article.excerpt || null,
    site_name:
      document.querySelector("meta[property='og:site_name']")?.content ||
      location.hostname,
    published_time: publishedTime,
    content_html: article.content,
  };
};
