"use client";

import { useEffect, useRef, useState, type ComponentProps } from "react";
import type { ApiJson } from "@/lib/api/wire";
import { apiFetch, apiTransportFeedback, isApiError, isStaleBuild, type ApiError } from "@/lib/api/client";
import { modeledApiError, useThrowLater } from "@/lib/api/serverState";
import { FeedbackBusy, FeedbackFailure, useFeedbackOccurrence } from "@/components/feedback/Feedback";
import AuthoredReadFailure from "@/components/notes/AuthoredReadFailure";
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

/** Retry keeps the admitted capture; only explicit reload accepts a newer one. */
function useFullExcerpt(observed: ResourceItem) {
  const [subject, setSubject] = useState(observed);
  const local = subject.authored_by_viewer && /^(highlight|passage_anchor):/u.test(subject.ref);
  const body = subject.preview.body;
  const readingRef = observed.preview.body.kind === "passage" ? observed.preview.body.reading_ref : null;
  const query = useAuthoredQuery(local && body.kind === "passage" ? { kind: "excerpt", ref: subject.ref, reading_ref: readingRef } : null);
  const [request, setRequest] = useState<{ mode: "Capture" | "Reload"; attempt: number }>({ mode: "Capture", attempt: 0 });
  const [remote, setRemote] = useState<{ item: ResourceItem | null; conflict: boolean; error: ApiError | null; pending: boolean }>({ item: null, conflict: false, error: null, pending: !local });
  const fail = useThrowLater();
  useEffect(() => {
    if (local || body.kind !== "passage" || body.capture_revision === null) return;
    const captureRevision = body.capture_revision;
    const controller = new AbortController();
    setRemote(previous => ({ ...previous, pending: true }));
    const load = async () => {
      if (request.mode === "Reload") return resolveResourceItem(subject.ref, controller.signal, readingRef);
      const parameters = new URLSearchParams({ excerpt_mode: "full", expected_capture_revision: captureRevision });
      if (readingRef !== null) parameters.set("reading_media_id", readingRef.replace(/^media:/u, ""));
      return (await apiFetch<ApiJson<"/resource-items/{resource_ref}", "get">>(`/api/resource-items/${encodeURIComponent(subject.ref)}?${parameters}`, { signal: controller.signal, cache: "no-store" })).data;
    };
    void load().then(projected => {
      if (controller.signal.aborted) return;
      const replacement = replaceExcerptBody(subject, projected);
      if (request.mode === "Reload" && !replacement.missing && replacement.preview.body.kind === "passage" && replacement.preview.body.capture_revision !== null) {
        setSubject(replacement);
        setRequest(previous => ({ mode: "Capture", attempt: previous.attempt + 1 }));
        setRemote(previous => ({ ...previous, item: replacement, conflict: false, pending: true }));
      } else setRemote({ item: replacement, conflict: false, error: null, pending: false });
    }).catch((error: unknown) => {
      if (controller.signal.aborted) return;
      if (request.mode === "Capture" && isApiError(error) && error.code === "E_RESOURCE_CONFLICT") {
        setRemote(previous => ({ ...previous, conflict: true, error: null, pending: false }));
        return;
      }
      const failure = modeledApiError(error, fail);
      if (failure) setRemote(previous => ({ ...previous, error: failure, pending: false }));
    });
    return () => controller.abort();
  }, [subject, local, body, readingRef, request, fail]);
  const resource = query.data?.rows[0]?.resource;
  const conflict = local ? resource !== undefined && body.kind === "passage" && resource.capture_revision !== body.capture_revision : remote.conflict;
  const full = local ? !conflict && resource?.excerpt ? replaceExcerptBody(subject, authoredItem(resource, readingRef)) : null : remote.item;
  const retry = () => {
    if (local) query.retry();
    else {
      setRemote(previous => ({ ...previous, pending: true }));
      setRequest(previous => ({ ...previous, attempt: previous.attempt + 1 }));
    }
  };
  const reload = () => {
    if (local) {
      if (resource) setSubject(replaceExcerptBody(subject, authoredItem(resource, readingRef)));
      query.retry();
    } else {
      setRemote(previous => ({ ...previous, pending: true }));
      setRequest(previous => ({ mode: "Reload", attempt: previous.attempt + 1 }));
    }
  };
  return { item: full ?? subject, conflict, unavailable: local && query.data !== null && (query.data.scope_available === false || resource === undefined || resource.excerpt === null),
    query, error: remote.error, pending: local ? query.pending : remote.pending, retry, reload };
}

function LoadedExcerpt({ item, quotation }: { item: ResourceItem; quotation: boolean }) {
  const loaded = useFullExcerpt(item);
  const occurrence = useFeedbackOccurrence(loaded.error !== null, item.ref);
  return <>
    <FeedbackBusy pending={loaded.pending} subject={item.ref} />
    <AuthoredReadFailure error={loaded.query.error} occurrence={loaded.query.occurrence} pending={loaded.query.pending} retry={loaded.query.retry} title="couldn’t load this excerpt" />
    {loaded.error ? <FeedbackFailure scope="Local" occurrence={occurrence} announcementOccurrence={loaded.error} content={apiTransportFeedback(loaded.error, "couldn’t load this excerpt") ?? { tone: "Warning", title: "couldn’t load this excerpt", requestId: loaded.error.requestId }} announcement="Polite"
      actions={isStaleBuild(loaded.error) ? undefined : [{ label: "retry", onClick: loaded.retry, busy: loaded.pending }]} /> : null}
    {loaded.conflict ? <p>this excerpt changed. <Button type="button" reserveIcon aria-disabled={loaded.pending || undefined} aria-busy={loaded.pending} onClick={loaded.reload}>reload excerpt</Button></p>
      : loaded.unavailable ? <p>excerpt unavailable in this reading.</p>
        : quotation ? <ResourceQuotation item={loaded.item} /> : <ResourceBody body={loaded.item.preview.body} full />}
  </>;
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
