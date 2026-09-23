// Ambient declarations the extension bundles need and nothing installed
// provides.
//
// 1. The readable-document selection policy is owned by node/ingest and
//    bundled into content.js through the "@nexus-ingest/article_extraction"
//    vite alias (apps/web/vite.extension.config.ts). The shape is
//    Readability's parse() result, which the Wikisource branch mirrors with
//    plain strings.
declare module "@nexus-ingest/article_extraction" {
  export interface ExtractedArticle {
    title: string | null | undefined;
    /** readable html, or empty when nothing readable was found */
    content: string | null | undefined;
    byline: string | null | undefined;
    excerpt: string | null | undefined;
    siteName: string | null | undefined;
    publishedTime: string | null | undefined;
  }
  export function extractArticle(document: Document): ExtractedArticle | null;
}

// 2. The Firefox 153 surface @types/firefox-webext-browser (143) lacks:
//    scripting.InjectionTarget.documentIds and runtime.MessageSender.documentId
//    are both version_added 153 in mdn/browser-compat-data. background.ts pins
//    every later operation to a document through them.
declare namespace browser.scripting {
  interface InjectionTarget {
    documentIds?: string[] | undefined;
  }
}

declare namespace browser.runtime {
  interface MessageSender {
    documentId?: string | undefined;
  }
}
