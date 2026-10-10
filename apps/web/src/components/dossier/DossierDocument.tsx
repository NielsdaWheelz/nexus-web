"use client";

import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type RefObject,
} from "react";
import { dossierSheet } from "@/components/dossier/dossierSheet";
import type { CitationOut } from "@/lib/resourceGraph/citations";
import styles from "./DossierSurface.module.css";

const HTML = "http://www.w3.org/1999/xhtml";
const ELEMENTS = new Set(
  "section header h2 h3 h4 p ol ul li dl dt dd blockquote pre code em strong table thead tbody tr th td figure figcaption div span".split(
    " ",
  ),
);
const CLASSES = new Set(
  "dossier-lede dossier-definition dossier-example dossier-warning dossier-steps dossier-diagram dossier-muted".split(
    " ",
  ),
);
const ORDINAL = /^[1-9][0-9]*$/;

function attributeAccepted(element: string, { name, value }: Attr): boolean {
  const cell = element === "th" || element === "td";
  switch (name) {
    case "class": {
      const tokens = value.split(" ");
      return (
        tokens.every((token) => CLASSES.has(token)) &&
        new Set(tokens).size === tokens.length
      );
    }
    case "id":
      return element === "section" && /^[a-z][a-z0-9-]{0,63}$/.test(value);
    case "scope":
      return cell && (value === "row" || value === "col");
    case "colspan":
    case "rowspan":
      return cell && /^([1-9]|1[0-6])$/.test(value);
    default:
      return false;
  }
}

/** The server's compiled citation, exactly: `<button …><sup>n</sup></button>`. */
function citationAccepted(button: Element): boolean {
  const ordinal = button.getAttribute("data-nexus-citation") ?? "";
  const sup = button.firstChild;
  return (
    ORDINAL.test(ordinal) &&
    button.attributes.length === 4 &&
    button.getAttribute("type") === "button" &&
    button.getAttribute("class") === "dossier-citation" &&
    button.getAttribute("aria-label") === `Open citation ${ordinal}` &&
    button.childNodes.length === 1 &&
    sup instanceof Element &&
    sup.namespaceURI === HTML &&
    sup.localName === "sup" &&
    sup.attributes.length === 0 &&
    sup.childNodes.length === 1 &&
    sup.firstChild?.nodeType === Node.TEXT_NODE &&
    sup.textContent === ordinal
  );
}

function childrenAccepted(parent: Node): boolean {
  return Array.from(parent.childNodes).every(
    (node) =>
      node.nodeType === Node.TEXT_NODE ||
      (node instanceof Element &&
        node.namespaceURI === HTML &&
        (node.localName === "button"
          ? citationAccepted(node)
          : ELEMENTS.has(node.localName) &&
            Array.from(node.attributes).every((attribute) =>
              attributeAccepted(node.localName, attribute),
            ) &&
            childrenAccepted(node))),
  );
}

/**
 * The client walk: the server's closed grammar, proven again on the very nodes
 * that will be adopted, so no reserialization separates proof from render.
 * Returns the one `<article>`, or null to refuse the whole document.
 */
export function acceptArticle(content: DocumentFragment): HTMLElement | null {
  const article = content.firstElementChild;
  return article instanceof HTMLElement &&
    article.namespaceURI === HTML &&
    article.localName === "article" &&
    article.attributes.length === 0 &&
    Array.from(content.childNodes).every(
      (node) =>
        node === article ||
        (node.nodeType === Node.TEXT_NODE && !node.textContent?.trim()),
    ) &&
    childrenAccepted(article)
    ? article
    : null;
}

/**
 * A server-accepted article in an open shadow root of the app document, under
 * the app's csp: styles scope both ways, ids stay out of `document`, and one
 * delegated listener turns citation clicks (and Enter/Space, which click a
 * focused button natively) into follow or, with Shift, fork.
 */
export default function DossierDocument({
  html,
  citations,
  onCitation,
  articleRef,
}: {
  html: string;
  citations: readonly CitationOut[];
  onCitation: (citation: CitationOut, disposition: "Follow" | "Fork") => void;
  articleRef?: RefObject<HTMLElement | null>;
}) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const [refused, setRefused] = useState(false);

  useLayoutEffect(() => {
    const host = hostRef.current!;
    const shadow = host.shadowRoot ?? host.attachShadow({ mode: "open" });
    shadow.adoptedStyleSheets = [dossierSheet()];
    const template = document.createElement("template");
    template.innerHTML = html;
    const article = acceptArticle(template.content);
    if (article) shadow.replaceChildren(template.content);
    else shadow.replaceChildren();
    setRefused(!article);
    if (articleRef) articleRef.current = article;
    return () => {
      if (articleRef) articleRef.current = null;
    };
  }, [articleRef, html]);

  useEffect(() => {
    const shadow = hostRef.current!.shadowRoot!;
    const click = (event: Event) => {
      const button =
        event.target instanceof Element
          ? event.target.closest("button.dossier-citation")
          : null;
      const ordinal = button?.getAttribute("data-nexus-citation");
      const citation = citations.find(
        (entry) => String(entry.ordinal) === ordinal,
      );
      if (citation && event instanceof MouseEvent)
        onCitation(citation, event.shiftKey ? "Fork" : "Follow");
    };
    shadow.addEventListener("click", click);
    return () => shadow.removeEventListener("click", click);
  }, [citations, onCitation]);

  return (
    <>
      <div ref={hostRef} />
      {refused ? (
        <p className={styles.note} role="alert">
          This dossier can&apos;t be shown: its document failed the safety
          check.
        </p>
      ) : null}
    </>
  );
}
