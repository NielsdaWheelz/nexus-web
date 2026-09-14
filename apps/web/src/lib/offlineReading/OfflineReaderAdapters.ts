import { normalizeEpubPathname } from "@/lib/reader/epubHref";
import { ApiError, decodeApiPayload } from "@/lib/api/client";
import type { ResourceCache } from "@/lib/api/resourceCache";
import { readBoundedResponseBytes } from "@/lib/api/readBoundedResponseBytes";
import type {
  ReaderDocumentSource,
  ReaderMedia,
  ReaderUnitAcquisition,
  ReaderSourceCapacity,
} from "@/lib/reader/ReaderDocumentSource";
import type {
  ReaderProgressPort,
  ReaderProgressView,
} from "@/lib/reader/ReaderProgressPort";
import type { ReaderCapacity } from "@/lib/reader/readerCapacity";
import {
  QUOTE_MAX_CODE_POINTS,
  QUOTE_CONTEXT_MAX_CODE_POINTS,
  type ReaderResumeState,
} from "@/lib/reader/types";
import type { SelectedReaderSource } from "@/lib/reader/readerIntentStore";
import {
  decodeReaderPublicationDescriptor,
  decodeReaderPublicationIndex,
  decodeReaderPublicationUnit,
  type ReaderMemberRef,
  type ReaderPublicationIndex,
  type ReaderPublicationResolution,
  type ReaderPublicationTarget,
  type ReaderPublicationUnit,
  type ReaderPublicationUnitIndex,
  type ReaderPublicationUnitAddress,
} from "@/lib/reader/publicationContract";
import { codepointToUtf16 } from "@/lib/highlights/codepoints";
import { canonicalCpLength } from "@/lib/reader/textOffsets";
import { decodeInternalReaderUrl } from "./contract";
import type {
  OfflineReadingControllerRuntime,
  OpenedOfflineReading,
} from "./runtime";

function siblingEntryUrl(readerUrl: string, entryPath: string): string {
  const reader = new URL(decodeInternalReaderUrl(readerUrl));
  if (
    new TextEncoder().encode(entryPath).length > 512 ||
    entryPath.normalize("NFC") !== entryPath ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]*(?:\/[A-Za-z0-9][A-Za-z0-9._-]*)*$/u.test(
      entryPath,
    ) ||
    entryPath === "manifest.json" ||
    /\.(?:7z|apk|bz2|epub|gz|jar|rar|tar|xz|zip)$/iu.test(entryPath)
  ) {
    throw new TypeError("Offline reader entry path is unsafe");
  }
  reader.pathname = reader.pathname.replace(/descriptor\.json$/u, entryPath);
  return reader.toString();
}

/** Native verified every member before publishing this no-network lease. */
export class OfflineReaderSource implements ReaderDocumentSource {
  readonly #cache: ResourceCache;
  readonly queryScratchBytes: number;
  /**
   * The most recently decoded index page — the single in-flight decode this
   * source's `queryScratchBytes` already budgets, kept between traversals so a
   * neighbouring unit resolves without rereading the chain from its first page.
   * The chain is immutable for the life of the lease.
   */
  #retained: {
    readonly reference: ReaderMemberRef;
    readonly page: ReaderPublicationIndex;
  } | null = null;

  constructor(
    readonly mediaId: string,
    readonly opened: OpenedOfflineReading,
    readonly accountId: string,
    readonly capacity: ReaderCapacity,
    cache: ResourceCache,
    readonly fetchReader: typeof fetch = fetch,
  ) {
    decodeInternalReaderUrl(opened.readerUrl);
    this.#cache = cache;
    // One index decode + one unit decode, plus the 512cp combined
    // quote/context and its bounded carry (two UTF-16 strings).
    this.queryScratchBytes =
      11 * (capacity.indexBytes + capacity.unitBytes) +
      (QUOTE_MAX_CODE_POINTS + 2 * QUOTE_CONTEXT_MAX_CODE_POINTS) * 4;
  }

  async #read<T>(
    path: string,
    signal: AbortSignal,
    maxBytes: number,
    decode: (raw: unknown) => T,
    reference?: ReaderMemberRef,
  ): Promise<T> {
    signal.throwIfAborted();
    const response = await this.fetchReader(
      siblingEntryUrl(this.opened.readerUrl, path),
      {
        signal,
        cache: "no-store",
        credentials: "omit",
        redirect: "error",
      },
    );
    if (
      response.status !== 200 ||
      response.headers.get("content-type")?.split(";", 1)[0] !==
        "application/json"
    ) {
      await response.body?.cancel().catch(() => undefined);
      throw new ApiError(
        response.status,
        "E_INVALID_RESPONSE",
        "Verified offline member is unavailable",
      );
    }
    const bytes = await readBoundedResponseBytes(
      response,
      signal,
      maxBytes,
      reference?.bytes,
    );
    return decodeApiPayload(
      JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)),
      decode,
      "Offline publication member",
    );
  }

  #assertSelected(descriptor: ReaderMedia): void {
    if (
      descriptor.media_id !== this.mediaId ||
      descriptor.reader_generation !== this.opened.readerGeneration
    ) {
      throw new Error("Offline reader publication identity mismatch");
    }
  }

  async loadDescriptor(
    mediaId: string,
    signal: AbortSignal,
  ): Promise<ReaderMedia | ReaderSourceCapacity> {
    if (mediaId !== this.mediaId)
      throw new Error("Offline reader media identity mismatch");
    const permit = this.#cache.acquireRead();
    if (permit.kind === "Capacity") return permit;
    try {
      const descriptor = await this.#read(
        "descriptor.json",
        signal,
        this.capacity.descriptorBytes,
        decodeReaderPublicationDescriptor,
      );
      const selected: ReaderMedia = {
        ...descriptor,
        source: {
          kind: "Publication",
          reader_generation: descriptor.reader_generation,
        },
      };
      this.#assertSelected(selected);
      return selected;
    } finally {
      permit.release();
    }
  }

  async readIndex(
    descriptor: ReaderMedia,
    reference: ReaderMemberRef,
    signal: AbortSignal,
  ): Promise<ReaderPublicationIndex | ReaderSourceCapacity> {
    this.#assertSelected(descriptor);
    if (!reference.key.startsWith("index/"))
      throw new Error("Offline index reference has the wrong role");
    const permit = this.#cache.acquireRead();
    if (permit.kind === "Capacity") return permit;
    try {
      return await this.#read(
        reference.key,
        signal,
        this.capacity.indexBytes,
        decodeReaderPublicationIndex,
        reference,
      );
    } finally {
      permit.release();
    }
  }

  acquireUnit(
    descriptor: ReaderMedia,
    reference: ReaderMemberRef,
  ): ReaderUnitAcquisition {
    this.#assertSelected(descriptor);
    if (
      !reference.key.startsWith("units/") ||
      reference.bytes > this.capacity.unitBytes
    )
      throw new Error("Offline reader unit violates its format bound");
    return this.#cache.acquirePublicationUnit({
      accountId: this.accountId,
      mediaId: this.mediaId,
      generation: descriptor.reader_generation,
      leaseId: this.opened.leaseId,
      reference,
      read: (signal) =>
        this.#read(
          reference.key,
          signal,
          this.capacity.unitBytes,
          (raw) => {
            const unit = decodeReaderPublicationUnit(raw);
            if (
              (descriptor.kind === "epub") !== (unit.epub_target !== null) ||
              unit.end_cp - unit.start_cp > this.capacity.unitCodePoints ||
              unit.render_nodes.length + 2 > this.capacity.unitDomNodes
            )
              throw new Error(
                "Offline reader unit violates its publication contract",
              );
            return unit;
          },
          reference,
        ),
    });
  }

  async *#pages(
    descriptor: ReaderMedia,
    signal: AbortSignal,
    from?: ReaderMemberRef,
  ): AsyncGenerator<ReaderPublicationIndex | ReaderSourceCapacity> {
    if (descriptor.kind === "pdf") return;
    let reference: ReaderMemberRef | null = from ?? descriptor.index_ref;
    while (reference !== null) {
      signal.throwIfAborted();
      const retained = this.#retained;
      let page: ReaderPublicationIndex | ReaderSourceCapacity;
      if (retained !== null && retained.reference.key === reference.key) {
        page = retained.page;
      } else {
        // Never hold two decoded pages: drop the retained one before reading.
        this.#retained = null;
        page = await this.readIndex(descriptor, reference, signal);
      }
      if ("kind" in page) {
        yield page;
        return;
      }
      this.#retained = { reference, page };
      reference = page.next_ref;
      yield page;
    }
  }

  async *#records(
    descriptor: ReaderMedia,
    signal: AbortSignal,
    from?: ReaderMemberRef,
  ): AsyncGenerator<ReaderPublicationUnitIndex | ReaderSourceCapacity> {
    for await (const page of this.#pages(descriptor, signal, from)) {
      if ("kind" in page) {
        yield page;
        return;
      }
      for (const record of page.units) yield record;
    }
  }

  async #address(
    descriptor: ReaderMedia,
    key: string,
    signal: AbortSignal,
  ): Promise<
    | (ReaderPublicationUnitAddress & { record: ReaderPublicationUnitIndex })
    | ReaderSourceCapacity
  > {
    // Resume at the retained page when it names this unit behind a predecessor:
    // reading unit by unit then never rereads the pages before it.
    const retained = this.#retained;
    const resume =
      retained !== null &&
      retained.page.units.findIndex((record) => record.member.key === key) > 0
        ? retained.reference
        : undefined;
    let previous: ReaderMemberRef | null = null;
    let selected: ReaderPublicationUnitIndex | null = null;
    for await (const record of this.#records(descriptor, signal, resume)) {
      if ("kind" in record) return record;
      if (selected !== null)
        return {
          record: selected,
          unit_ref: selected.member,
          ordinal: selected.ordinal,
          previous_ref: previous,
          next_ref: record.member,
        };
      if (record.member.key === key) selected = record;
      else previous = record.member;
    }
    if (selected === null)
      throw new Error("Offline publication names an absent unit");
    return {
      record: selected,
      unit_ref: selected.member,
      ordinal: selected.ordinal,
      previous_ref: previous,
      next_ref: null,
    };
  }

  async #section(
    descriptor: ReaderMedia,
    id: string,
    signal: AbortSignal,
  ): Promise<
    ReaderPublicationIndex["sections"][number] | ReaderSourceCapacity | null
  > {
    for await (const page of this.#pages(descriptor, signal)) {
      if ("kind" in page) return page;
      const section = page.sections.find((item) => item.section_id === id);
      if (section !== undefined) return section;
    }
    return null;
  }

  async #withUnit<T>(
    descriptor: ReaderMedia,
    reference: ReaderMemberRef,
    signal: AbortSignal,
    consume: (unit: ReaderPublicationUnit) => T,
  ): Promise<T | ReaderSourceCapacity> {
    signal.throwIfAborted();
    const acquired = this.acquireUnit(descriptor, reference);
    if (acquired.kind === "Capacity") return acquired;
    const release = () => acquired.lease.release();
    signal.addEventListener("abort", release, { once: true });
    try {
      const settled = await acquired.lease.promise;
      signal.throwIfAborted();
      return settled.kind === "Capacity" ? settled : consume(settled.unit);
    } finally {
      signal.removeEventListener("abort", release);
      release();
    }
  }

  async resolve(
    descriptor: ReaderMedia,
    target: ReaderPublicationTarget,
    signal: AbortSignal,
  ): Promise<ReaderPublicationResolution | ReaderSourceCapacity> {
    this.#assertSelected(descriptor);
    signal.throwIfAborted();
    if (target.kind === "Unit") {
      const resolved = await this.#address(descriptor, target.unit_key, signal);
      if ("kind" in resolved) return resolved;
      const { record, ...address } = resolved;
      return {
        kind: "Unit",
        ...address,
        fragment_id: record.fragment_id,
        start_cp: record.start_cp,
        end_cp: record.end_cp,
      };
    }
    if (target.kind === "EpubHref") {
      if (descriptor.kind !== "epub")
        throw new Error("Offline EPUB link has the wrong publication format");
      let key: string | null = null;
      let offset = 0;
      let fragment: string | null = null;
      // Every section page precedes the anchor pages in the packed chain, so
      // one traversal collects both the addressed anchor and the authored
      // sections this link can own, in their authored order.
      const sections: (ReaderPublicationIndex["sections"][number] & {
        readonly href_path: string;
      })[] = [];
      for await (const page of this.#pages(descriptor, signal)) {
        if ("kind" in page) return page;
        for (const row of page.sections) {
          const path = row.href_path;
          if (
            path !== null &&
            (normalizeEpubPathname(path) === target.pathname ||
              row.section_id === target.pathname)
          )
            sections.push({ ...row, href_path: path });
        }
        if (target.anchor_id !== null) {
          const anchor = page.anchors.find(
            (row) =>
              normalizeEpubPathname(row.href_path) === target.pathname &&
              row.anchor_id === target.anchor_id,
          );
          if (anchor !== undefined) {
            key = anchor.unit_key;
            offset = anchor.offset_cp;
            break;
          }
        } else {
          const section = sections[0];
          if (section !== undefined) {
            fragment = section.fragment_id;
            break;
          }
        }
      }
      if (fragment !== null)
        for await (const record of this.#records(descriptor, signal)) {
          if ("kind" in record) return record;
          if (record.fragment_id === fragment) {
            key = record.member.key;
            offset = record.start_cp;
            break;
          }
        }
      if (key === null)
        return { kind: "Unresolved", locator: null, reason: "TargetMissing" };
      const resolved = await this.#address(descriptor, key, signal);
      if ("kind" in resolved) return resolved;
      const selected = await this.#withUnit(
        descriptor,
        resolved.unit_ref,
        signal,
        (unit) => {
          if (
            unit.epub_target === null ||
            normalizeEpubPathname(unit.epub_target.href_path) !==
              target.pathname
          )
            throw new Error("Offline EPUB anchor source mismatch");
          if (offset < unit.start_cp || offset > unit.end_cp)
            throw new Error(
              "Offline EPUB anchor lies outside its declared unit",
            );
          // One ownership rule for a point, shared with the hosted route: the
          // first authored section at the greatest offset at or before it, on
          // the source path the first matching section named. The unit's own
          // target covers a whole source fragment, so it is only the fallback.
          const authored = sections[0];
          const owning = sections.reduce<(typeof sections)[number] | null>(
            (best, row) =>
              authored !== undefined &&
              row.href_path === authored.href_path &&
              row.start_offset <= offset &&
              (best === null || row.start_offset > best.start_offset)
                ? row
                : best,
            null,
          );
          return {
            fragmentId: unit.fragment_id,
            epubTarget:
              owning === null
                ? { ...unit.epub_target, anchor_id: target.anchor_id }
                : {
                    section_id: owning.section_id,
                    href_path: owning.href_path,
                    anchor_id: target.anchor_id,
                  },
          };
        },
      );
      if ("kind" in selected) return selected;
      const { record: _record, ...address } = resolved;
      return {
        kind: "Text",
        ...address,
        fragment_id: selected.fragmentId,
        offset_cp: offset,
        local_offset_cp: offset - resolved.record.start_cp,
        locator: {
          kind: "epub",
          target: selected.epubTarget,
          locations: {
            text_offset: offset,
            progression: null,
            total_progression: null,
            position: null,
          },
          text: { quote: null, quote_prefix: null, quote_suffix: null },
        },
      };
    }
    let locator: ReaderResumeState;
    let explicitUnit: string | null = null;
    let fragmentId: string;
    let baseOffset = 0;
    if (target.kind === "Navigation") {
      const section = await this.#section(descriptor, target.target_id, signal);
      if (section === null)
        return { kind: "Unresolved", locator: null, reason: "TargetMissing" };
      if ("kind" in section) return section;
      explicitUnit = section.unit_key;
      fragmentId = section.fragment_id;
      baseOffset = section.start_offset;
      const locations = {
        text_offset: baseOffset,
        progression: null,
        total_progression: null,
        position: null,
      };
      const text = { quote: null, quote_prefix: null, quote_suffix: null };
      if (descriptor.kind === "epub") {
        if (section.href_path === null)
          throw new Error("Offline EPUB navigation lost its source target");
        locator = {
          kind: "epub",
          target: {
            section_id: section.section_id,
            href_path: section.href_path,
            anchor_id: section.anchor_id,
          },
          locations,
          text,
        };
      } else
        locator = {
          kind: "web",
          target: { fragment_id: fragmentId },
          locations,
          text,
        };
    } else {
      locator = target.locator;
      if (descriptor.kind === "pdf" && locator.kind === "pdf") {
        return locator.page <= descriptor.page_count
          ? {
              kind: "Pdf",
              locator,
              page: locator.page,
              document_asset_ref: descriptor.document_asset_ref,
            }
          : { kind: "Unresolved", locator, reason: "OffsetOutOfRange" };
      }
      if (descriptor.kind === "web_article" && locator.kind === "web")
        fragmentId = locator.target.fragment_id;
      else if (descriptor.kind === "epub" && locator.kind === "epub") {
        const section = await this.#section(
          descriptor,
          locator.target.section_id,
          signal,
        );
        if (section !== null && "kind" in section) return section;
        if (section === null || section.href_path !== locator.target.href_path)
          return { kind: "Unresolved", locator, reason: "TargetMissing" };
        fragmentId = section.fragment_id;
        baseOffset = section.start_offset;
        explicitUnit = section.unit_key;
      } else
        throw new Error(
          "Offline locator does not describe this publication format",
        );
    }
    let offset = locator.locations.text_offset;
    if (offset === null && locator.text.quote !== null) {
      const prefix = locator.text.quote_prefix ?? "";
      const needle =
        prefix + locator.text.quote + (locator.text.quote_suffix ?? "");
      const carryPoints = Math.max(0, canonicalCpLength(needle) - 1);
      let carry = "";
      let matchOffset: number | null = null;
      let hasFragment = false;
      for await (const record of this.#records(descriptor, signal)) {
        if ("kind" in record) return record;
        if (record.fragment_id !== fragmentId) continue;
        hasFragment = true;
        const result = await this.#withUnit(
          descriptor,
          record.member,
          signal,
          (unit) => {
            const body = carry + unit.canonical_text;
            const start = unit.start_cp - canonicalCpLength(carry);
            let match = body.indexOf(needle);
            while (match !== -1) {
              const next =
                start +
                canonicalCpLength(body.slice(0, match)) +
                canonicalCpLength(prefix);
              if (matchOffset !== null && matchOffset !== next)
                return {
                  kind: "Unresolved" as const,
                  locator,
                  reason: "QuoteAmbiguous" as const,
                };
              matchOffset = next;
              const point = body.codePointAt(match)!;
              match = body.indexOf(needle, match + (point > 0xffff ? 2 : 1));
            }
            const length = canonicalCpLength(body);
            carry = body.slice(
              codepointToUtf16(body, Math.max(0, length - carryPoints)),
            );
            return null;
          },
        );
        if (result !== null) return result;
      }
      if (!hasFragment || matchOffset === null)
        return {
          kind: "Unresolved",
          locator,
          reason: hasFragment ? "QuoteMissing" : "TargetMissing",
        };
      offset = matchOffset;
    }
    offset ??= baseOffset;
    let selected: ReaderPublicationUnitIndex | null = null;
    let endpoint: ReaderPublicationUnitIndex | null = null;
    let hasFragment = false;
    for await (const record of this.#records(descriptor, signal)) {
      if ("kind" in record) return record;
      if (record.fragment_id !== fragmentId) continue;
      hasFragment = true;
      if (explicitUnit === record.member.key && offset === baseOffset) {
        selected = record;
        break;
      }
      if (record.start_cp <= offset && offset < record.end_cp) {
        selected ??= record;
        // Only the explicit section unit above can still replace this choice.
        if (explicitUnit === null || offset !== baseOffset) break;
      }
      if (
        record.end_cp === offset &&
        (record.end_cp > record.start_cp || (offset === 0 && endpoint === null))
      )
        endpoint = record;
    }
    selected ??= endpoint;
    if (selected === null)
      return {
        kind: "Unresolved",
        locator,
        reason: hasFragment ? "OffsetOutOfRange" : "TargetMissing",
      };
    const resolved = await this.#address(
      descriptor,
      selected.member.key,
      signal,
    );
    if ("kind" in resolved) return resolved;
    const { record: _record, ...address } = resolved;
    return {
      kind: "Text",
      locator,
      fragment_id: fragmentId,
      offset_cp: offset,
      local_offset_cp: offset - selected.start_cp,
      ...address,
    };
  }

  readonly find = null;
  readonly sectionContext = null;
  readonly sourceRange = null;
  readonly overlays = null;

  assetUrl(descriptor: ReaderMedia, reference: ReaderMemberRef): string {
    this.#assertSelected(descriptor);
    if (!reference.key.startsWith("assets/"))
      throw new Error("Offline asset reference has the wrong role");
    return siblingEntryUrl(this.opened.readerUrl, reference.key);
  }
}

export class OfflineReaderProgressPort implements ReaderProgressPort {
  #view: ReaderProgressView;

  constructor(
    readonly controller: OfflineReadingControllerRuntime,
    readonly mediaId: string,
    readonly opened: OpenedOfflineReading,
  ) {
    this.#view = opened.progress;
  }

  async load(mediaId: string): Promise<ReaderProgressView> {
    this.#assertMedia(mediaId);
    return this.#view;
  }

  observeNativeProgress(view: ReaderProgressView): void {
    this.#view = view;
  }

  bindSource(mediaId: string, source: SelectedReaderSource): void {
    this.#assertMedia(mediaId);
    if (
      source.kind !== "Publication" ||
      source.reader_generation !== this.opened.readerGeneration
    ) {
      throw new Error("Offline reader progress publication mismatch");
    }
  }

  attach(): () => void {
    return () => {};
  }

  async capture(mediaId: string, locator: ReaderResumeState) {
    this.#assertMedia(mediaId);
    const result = await this.controller.saveReaderProgress({
      mediaId,
      readerGeneration: this.opened.readerGeneration,
      readerRevisionKey: this.opened.readerRevisionKey,
      locator,
    });
    this.#view =
      result.kind === "Canonical"
        ? result
        : result.kind === "Conflict"
          ? result
          : result.view;
    return result;
  }

  async flush(mediaId: string) {
    this.#assertMedia(mediaId);
    // Native capture already schedules its durable synchronizer. The bridge
    // offers no force-delivery command; report only the observed outcome.
    const view = this.#view;
    switch (view.kind) {
      case "Canonical":
      case "Conflict":
        return view;
      case "Pending":
        return { kind: "DurablyPending" as const, view };
      case "ContentChanged":
        return { kind: "ContentChanged" as const, view };
      case "SourceUnavailable":
        return { kind: "SourceUnavailable" as const, view };
    }
  }

  async resolve(mediaId: string, choice: "Canonical" | "Device") {
    this.#assertMedia(mediaId);
    this.#view = await this.controller.resolveReaderProgress({
      mediaId,
      choice,
      expected: this.#view,
      readerGeneration: this.opened.readerGeneration,
      readerRevisionKey: this.opened.readerRevisionKey,
    });
    return this.#view;
  }

  #assertMedia(mediaId: string): void {
    if (mediaId !== this.mediaId)
      throw new Error("Offline reader progress identity mismatch");
  }
}
