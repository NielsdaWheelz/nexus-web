import { planDocumentEmbedCards, type DocumentEmbed, type DocumentEmbedClassNames, type DocumentEmbedThumbnail } from "@/lib/media/documentEmbeds";
import { buildCanonicalCursor, type CanonicalCursorResult } from "@/lib/highlights/canonicalCursor";
import { codepointToUtf16 } from "@/lib/highlights/codepoints";
import { planHighlightsForDom, type HighlightInput } from "@/lib/highlights/applySegments";
import type { DocumentReaderSession } from "./DocumentReaderSession";
import type { ReaderMemberRef, ReaderPublicationAsset, ReaderPublicationUnit, ReaderRenderAttributeValue } from "./publicationContract";

const ELEMENT_NAMESPACES = {
  html: "http://www.w3.org/1999/xhtml",
  svg: "http://www.w3.org/2000/svg",
  mathml: "http://www.w3.org/1998/Math/MathML",
} as const;
const ATTRIBUTE_NAMESPACES = {
  xlink: "http://www.w3.org/1999/xlink",
  xml: "http://www.w3.org/XML/1998/namespace",
  xmlns: "http://www.w3.org/2000/xmlns/",
} as const;
const URL_ATTRIBUTES = new Set(["action", "background", "cite", "formaction", "href", "ping", "poster", "src", "srcset", "xlink:href"]);
/** The archived-member URI grammar. Each read gets its own cursor. */
const memberReferences = () => /nexus-reader-member:([^#\s,)'";]+)/g;

/** The visible-asset owner supplies these attributes only after its admission. */
interface DeferredReaderResource {
  readonly element: Element;
  readonly namespace: string | null;
  readonly name: string;
  readonly value: ReaderRenderAttributeValue;
  readonly assets: readonly Extract<ReaderPublicationAsset, { kind: "Captured" }>[];
}

export interface PreparedReaderUnit {
  readonly root: HTMLElement;
  readonly canonicalText: string;
  readonly cursor: CanonicalCursorResult;
  readonly resources: readonly DeferredReaderResource[];
  /** Embed-card thumbnails awaiting their artwork owner, already narrowed to how each is fetched. */
  readonly artwork: readonly { readonly image: HTMLImageElement; readonly source: Exclude<DocumentEmbedThumbnail, { kind: "Absent" }> }[];
  /** Caller first releases asset leases and any active selection/focus pins. */
  release(): void;
}

/** Construct the admitted source tree once; never invoke an HTML parser. */
export function prepareReaderUnit({ session, unit, unitKey, highlights, headingLevelOffset, embeds }: {
  readonly session: DocumentReaderSession;
  readonly unit: ReaderPublicationUnit;
  readonly unitKey: string;
  readonly highlights: readonly HighlightInput[];
  readonly headingLevelOffset: 0 | 1 | 2 | 3 | 4 | 5;
  readonly embeds?: { readonly items: readonly DocumentEmbed[]; readonly classNames: DocumentEmbedClassNames };
}): { readonly kind: "Ready"; readonly value: PreparedReaderUnit } | { readonly kind: "Capacity"; readonly reason: "Dom" } {
  const count = unit.render_nodes.length + 2; // Prepared root and HtmlRenderer host.
  if (count > session.capacity.unitDomNodes) throw new Error("Publication unit exceeds its render-node contract");
  const lease = session.reserveDomNodes(count);
  if (lease === null) return { kind: "Capacity", reason: "Dom" };
  const root = document.createElement("div");
  root.style.position = "relative";
  root.dataset.fragmentId = unit.fragment_id;
  root.dataset.readerUnit = unitKey;
  root.dataset.readerStart = String(unit.render_start_cp);
  root.dataset.readerEnd = String(unit.render_end_cp);
  try {
    const resources: DeferredReaderResource[] = [];
    const nodes: Node[] = [];
    for (const record of unit.render_nodes) {
      let node: Node;
      if (record.kind !== "Element") {
        node = record.kind === "Text" ? document.createTextNode(record.text) : document.createComment(record.text);
      } else {
        const unavailable = record.namespace === "html" && record.name === "img"
          ? record.attributes.find((attribute) => attribute.namespace === null && attribute.name === "src" && typeof attribute.value === "string" && attribute.value.startsWith("nexus-reader-unavailable:"))
          : undefined;
        if (unavailable !== undefined && typeof unavailable.value === "string") {
          const source = decodeURIComponent(unavailable.value.slice("nexus-reader-unavailable:".length).split("#", 1)[0]);
          if (!unit.assets.some((asset) => asset.kind === "Unavailable" && asset.source_url === source)) {
            throw new Error("Publication image references an undeclared unavailable asset");
          }
          const placeholder = document.createElement("img");
          const altValue = record.attributes.find((attribute) => attribute.namespace === null && attribute.name === "alt")?.value;
          const alt = typeof altValue === "string" ? altValue : null;
          placeholder.dataset.readerImageUnavailable = "true";
          placeholder.alt = alt ? `Image unavailable: ${alt}` : "Image unavailable";
          for (const attribute of record.attributes) {
            if (attribute.namespace === null && (attribute.name === "width" || attribute.name === "height") && typeof attribute.value === "string") {
              placeholder.setAttribute(attribute.name, attribute.value);
            }
          }
          placeholder.setAttribute("role", "img");
          placeholder.setAttribute("aria-label", alt ? `Image unavailable: ${alt}` : "Image unavailable");
          node = placeholder;
        } else {
          const name = record.namespace === "html" && /^h[1-6]$/.test(record.name)
            ? `h${Math.min(6, Number(record.name[1]) + headingLevelOffset)}` : record.name;
          const element = document.createElementNS(ELEMENT_NAMESPACES[record.namespace], name);
          for (const attribute of record.attributes) {
            const namespace = attribute.namespace === null ? null : ATTRIBUTE_NAMESPACES[attribute.namespace];
            const qualifiedName = attribute.namespace === null || (attribute.namespace === "xmlns" && attribute.name === "xmlns")
              ? attribute.name : `${attribute.namespace}:${attribute.name}`;
            if (typeof attribute.value !== "string") {
              resources.push({ element, namespace, name: qualifiedName, value: attribute.value, assets: [] });
              continue;
            }
            const url = URL_ATTRIBUTES.has(attribute.name);
            const navigation = record.namespace === "html" && record.name === "a" && attribute.namespace === null && attribute.name === "href";
            if ((url && !navigation) || attribute.value.includes("nexus-reader-member:")) {
              const assets: Extract<ReaderPublicationAsset, { kind: "Captured" }>[] = [];
              for (const match of attribute.value.matchAll(memberReferences())) {
                const asset = unit.assets.find((candidate) => candidate.kind === "Captured" && candidate.member.key === match[1]);
                if (asset?.kind !== "Captured") throw new Error("Publication resource references an undeclared member");
                if (!assets.includes(asset)) assets.push(asset);
              }
              resources.push({ element, namespace, name: qualifiedName, value: attribute.value, assets });
            } else if (namespace === null) element.setAttribute(qualifiedName, attribute.value);
            else element.setAttributeNS(namespace, qualifiedName, attribute.value);
          }
          // Block-layout excerpts can contain no resident header. Chromium's
          // layout-table heuristic otherwise removes their table semantics.
          if (record.namespace === "html" && name === "table" && element.hasAttribute("data-nexus-table") && !element.hasAttribute("role")) {
            element.setAttribute("role", "table");
          }
          node = element;
        }
      }
      nodes.push(node);
      (record.parent === null ? root : nodes[record.parent]).appendChild(node);
    }
    const canonicalText = unit.canonical_text.slice(
      codepointToUtf16(unit.canonical_text, unit.render_start_cp - unit.start_cp),
      codepointToUtf16(unit.canonical_text, unit.render_end_cp - unit.start_cp),
    );
    const relevant: HighlightInput[] = [];
    const anchorIds = new Set<string>();
    for (const highlight of highlights) {
      if (highlight.end_offset <= unit.render_start_cp || highlight.start_offset >= unit.render_end_cp) continue;
      if (highlight.start_offset >= unit.render_start_cp) anchorIds.add(highlight.id);
      relevant.push({ ...highlight,
        start_offset: Math.max(highlight.start_offset, unit.render_start_cp) - unit.render_start_cp,
        end_offset: Math.min(highlight.end_offset, unit.render_end_cp) - unit.render_start_cp,
      });
    }
    const plan = planHighlightsForDom(root, canonicalText, unit.fragment_id, relevant, anchorIds);
    if (plan.kind === "Mismatch") throw new Error("Publication render tree does not match its canonical text");
    if (!lease.extend(plan.additionalNodes)) {
      lease.release();
      return { kind: "Capacity", reason: "Dom" };
    }
    if (plan.apply().failedIds.length > 0) throw new Error("Publication highlights did not project into their admitted source tree");
    const cursor = buildCanonicalCursor(root);
    const artwork: { image: HTMLImageElement; source: Exclude<DocumentEmbedThumbnail, { kind: "Absent" }> }[] = [];
    if (embeds !== undefined) {
      const cards = planDocumentEmbedCards(root, embeds.items, embeds.classNames, (image, source) => { artwork.push({ image, source }); });
      if (!lease.extend(cards.additionalNodes)) { root.remove(); lease.release(); return { kind: "Capacity", reason: "Dom" }; }
      cards.apply();
    }
    return { kind: "Ready", value: {
      root, canonicalText, resources, artwork, cursor,
      release() { root.remove(); lease.release(); },
    } };
  } catch (error) {
    root.remove();
    lease.release();
    throw error;
  }
}

/**
 * Supply the attributes `prepareReaderUnit` deferred, once the visible-asset
 * owner can name a URL for every archived member the source tree references.
 * The member grammar and the namespace-qualified write stay with the module
 * that produced the deferral.
 */
export function applyReaderUnitResources(prepared: PreparedReaderUnit, memberUrl: (member: ReaderMemberRef) => string): void {
  for (const resource of prepared.resources) {
    if (typeof resource.value !== "string" || resource.assets.length === 0) continue;
    const value = resource.value.replace(memberReferences(), (_match, key: string) => {
      const asset = resource.assets.find((candidate) => candidate.member.key === key);
      if (asset === undefined) throw new Error("Prepared reader resource lost its member");
      return memberUrl(asset.member);
    });
    if (resource.namespace === null) resource.element.setAttribute(resource.name, value);
    else resource.element.setAttributeNS(resource.namespace, resource.name, value);
  }
}
