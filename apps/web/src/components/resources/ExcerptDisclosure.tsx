"use client";

import { useEffect, useRef, useState, type ComponentProps } from "react";
import type { ApiJson } from "@/lib/api/wire";
import { apiFetch, isApiError } from "@/lib/api/client";
import { useAuthoredQuery } from "@/lib/notes/hooks";
import { authoredItem } from "@/lib/notes/presentation";
import { resolveResourceItem, type ResourceItem } from "@/lib/resources/items";
import Button from "@/components/ui/Button";
import Dialog from "@/components/ui/Dialog";
import ResourceBody from "./ResourceBody";
import ResourceQuotation from "./ResourceQuotation";

/** Matching capture evidence keeps its occurrence owner; unavailable responses own the whole item. */
function replaceExcerptBody(subject: ResourceItem, projected: ResourceItem): ResourceItem {
  if (projected.missing || projected.preview.body.kind !== "passage" || projected.preview.body.capture_revision === null) return projected;
  return { ...subject, label: projected.label, preview: { ...subject.preview, body: projected.preview.body } };
}

/** Compare the admitted compact capture before replacing it with full evidence. */
function useFullExcerpt(observed: ResourceItem) {
  const [subject, setSubject] = useState(observed);
  const local = subject.authored_by_viewer && /^(highlight|passage_anchor):/u.test(subject.ref);
  const body = subject.preview.body;
  const readingRef = observed.preview.body.kind === "passage" ? observed.preview.body.reading_ref : null;
  const query = useAuthoredQuery(local && body.kind === "passage" ? { kind: "excerpt", ref: subject.ref, reading_ref: readingRef } : null);
  const [remote, setRemote] = useState<{ item: ResourceItem | null; conflict: boolean; failed: boolean }>({ item: null, conflict: false, failed: false });
  useEffect(() => {
    if (local || body.kind !== "passage" || body.capture_revision === null) return;
    const controller = new AbortController();
    const parameters = new URLSearchParams({ excerpt_mode: "full", expected_capture_revision: body.capture_revision });
    if (readingRef !== null) parameters.set("reading_media_id", readingRef.replace(/^media:/u, ""));
    setRemote({ item: null, conflict: false, failed: false });
    void apiFetch<ApiJson<"/resource-items/{resource_ref}", "get">>(`/api/resource-items/${encodeURIComponent(subject.ref)}?${parameters}`, { signal: controller.signal, cache: "no-store" }).then(response => {
      if (!controller.signal.aborted) setRemote({ item: replaceExcerptBody(subject, response.data), conflict: false, failed: false });
    }).catch((error: unknown) => {
      if (!controller.signal.aborted) setRemote({ item: null, conflict: isApiError(error) && error.status === 409, failed: true });
    });
    return () => controller.abort();
  }, [subject, local, body, readingRef]);
  const resource = query.data?.rows[0]?.resource;
  const conflict = local ? resource !== undefined && body.kind === "passage" && resource.capture_revision !== body.capture_revision : remote.conflict;
  const full = local ? !conflict && resource?.excerpt ? replaceExcerptBody(subject, authoredItem(resource, readingRef)) : null : remote.item;
  const reload = () => {
    if (local) { if (resource) setSubject(replaceExcerptBody(subject, authoredItem(resource, readingRef))); query.retry(); }
    else {
      setRemote({ item: null, conflict: false, failed: false });
      void resolveResourceItem(subject.ref, undefined, readingRef).then(projected => {
        const replacement = replaceExcerptBody(subject, projected);
        if (replacement.missing || replacement.preview.body.kind !== "passage" || replacement.preview.body.capture_revision === null)
          setRemote({ item: replacement, conflict: false, failed: false });
        else setSubject(replacement);
      }).catch(() => setRemote({ item: null, conflict: false, failed: true }));
    }
  };
  return { item: full, conflict, unavailable: local && query.data !== null && (query.data.scope_available === false || resource === undefined || resource.excerpt === null), failed: local ? query.error !== null : remote.failed, reload };
}

function LoadedExcerpt({ item, quotation }: { item: ResourceItem; quotation: boolean }) {
  const loaded = useFullExcerpt(item);
  if (loaded.conflict) return <p>this excerpt changed. <Button type="button" onClick={loaded.reload}>reload excerpt</Button></p>;
  if (loaded.unavailable) return <p>excerpt unavailable in this reading.</p>;
  if (loaded.failed) return <p>couldn’t load this excerpt. <Button type="button" onClick={loaded.reload}>retry</Button></p>;
  if (!loaded.item) return <p role="status">loading excerpt…</p>;
  return quotation ? <ResourceQuotation item={loaded.item} /> : <ResourceBody body={loaded.item.preview.body} full />;
}

/** Full ordinary bodies query frozen authored evidence; historical bodies stay supplied. */
export function FullResourceBody({ item, historical = false }: { item: ResourceItem; historical?: boolean }) {
  const body = item.preview.body;
  return body.kind === "passage" && !historical && body.capture_revision !== null
    ? <LoadedExcerpt key={`${item.ref}:${body.capture_revision}:${body.reading_ref}`} item={item} quotation={false} />
    : <ResourceBody body={body} full />;
}

/** A sibling action, never a listbox option or part of resource activation. */
export default function ExcerptDisclosure({ item, returnFocus, triggerAttributes }: { item: ResourceItem | null; returnFocus?: () => HTMLElement | null; triggerAttributes?: Pick<ComponentProps<typeof Button>, "tabIndex" | "onFocus" | "onBlur" | "aria-label"> }) {
  const [opened, setOpened] = useState<ResourceItem | null>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const candidate = item?.preview.body.kind === "passage" && item.preview.body.capture_revision !== null ? item : null;
  if (candidate === null && opened === null) return null;
  return <span onPointerDown={event => event.stopPropagation()} onClick={event => event.stopPropagation()}>
    <Button {...triggerAttributes} ref={trigger} type="button" aria-expanded={opened !== null} onKeyDown={event => { if (event.repeat && (event.key === "Enter" || event.key === " ")) event.preventDefault(); }} onPointerDown={event => event.stopPropagation()} onClick={event => { event.stopPropagation(); setOpened(value => value ? null : candidate); }}>
      {opened ? "hide excerpt" : "show excerpt"}
    </Button>
    {opened ? <Dialog open title="excerpt" onClose={() => setOpened(null)} returnFocusTo={returnFocus ?? (() => trigger.current)}>
      <LoadedExcerpt item={opened} quotation />
      <Button type="button" onClick={() => setOpened(null)}>hide excerpt</Button>
    </Dialog> : null}
  </span>;
}
