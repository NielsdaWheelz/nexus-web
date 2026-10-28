/** User links belong to the local authored graph. Server-owned citation, machine
 * and context facts retain their existing query/removal owners. Unlink observes
 * only the selected edge's add vector and never deletes either endpoint. */
import { apiFetch, apiTransportFeedback, isApiError, isSameSystemApiDefect, outcomeUnknown } from "@/lib/api/client";
import type { ApiJson, Schema } from "@/lib/api/wire";
import type { FeedbackContent } from "@/components/feedback/Feedback";
import { insertionPositions, type Intent } from "@nexus/authored/commands";
import { isVisible } from "@nexus/authored/merge";
import { captureLocator } from "@nexus/authored/capture";
import { linkId, sortedEndpoints, normalizeQuote, passageId, passageKey } from "@nexus/authored/identity";
import type { LinkState } from "@nexus/authored/types";
import { type WritingRuntime, selectStates } from "@/lib/notes/runtime";
import { parseResourceRef } from "./resourceRef";
import { RESOURCE_CAPABILITIES } from "@/lib/resources/resourceCapabilities";
export type ConnectionOut = Schema<"ConnectionOut">;
export type ConnectionMutation = NonNullable<ConnectionOut["mutation"]>;
export type ConnectionCommand = { kind: "unlink"; link_id: string } | Extract<ConnectionMutation, { kind: "detach_context" }> | { kind: "remove_fact"; edge_id: string };
export type LinkTarget = { kind: "resource"; ref: string } | { kind: "passage"; candidate_ref: string; passage_target: Schema<"CapturedPassageTarget"> | null };
export type InsertionSource = LinkTarget | { kind: "daily_page"; local_date: string; page_id: string };
export interface Position { after: string | null; before?: string | null; prelude?: readonly Intent[] }
export interface LinkRequest { source_ref: string; target_ref: string; source_label: string | null; target_label: string | null; after: string | null; before?: string | null; prelude?: readonly Intent[] }
export function endpointForResource(ref: string): LinkTarget | null {
  const parsed = parseResourceRef(ref);
  if (!parsed) return null;
  const mode = RESOURCE_CAPABILITIES[parsed.scheme].link_mode;
  return mode === "none" ? null : mode === "direct" ? { kind: "resource", ref } : { kind: "passage", candidate_ref: ref, passage_target: null };
}
/** Fetch only the adjacent keys. A collision expands to its observed tie run,
 * never to the endpoint's resource bodies or unrelated relationships. */
export async function preparePosition(runtime: WritingRuntime, ref: string, id: string, after: string | null, before: string | null): Promise<{ value: string; moves: Intent[]; previous: LinkState[] }> {
  const store = await runtime.store;
  const at = before !== null ? {kind:"neighbors" as const,link_id:before,side:"before" as const} : after !== null ? {kind:"neighbors" as const,link_id:after,side:"after" as const} : {kind:"tail" as const};
  let siblings = (await store.query({kind:"positions",ref,exclude_link_id:id,at})).positions;
  const key = (link:LinkState) => (link.endpoint_a===ref?link.position_a:link.position_b)!.value;
  const anchor = before ?? after;
  if (anchor !== null && !siblings.some(link=>link.link_id===anchor)) throw new Error("The selected insertion position is no longer available");
  let index = before !== null ? siblings.findIndex(link=>link.link_id===before) : after !== null ? siblings.findIndex(link=>link.link_id===after)+1 : siblings.length;
  if (index>0 && index<siblings.length && key(siblings[index-1]!)===key(siblings[index]!)) {
    const position=key(siblings[index]!);
    const run:LinkState[]=[];
    let cursor:string|null=null;
    do {
      const page=await store.query({kind:"positions",ref,exclude_link_id:id,at:{kind:"tie",position,cursor,limit:100}});
      run.push(...page.positions);
      cursor=page.next_cursor;
    } while(cursor!==null);
    const bounds=(await store.query({kind:"positions",ref,exclude_link_id:id,at:{kind:"bounds",position}})).positions;
    siblings=[...bounds.filter(link=>key(link)<position),...run,...bounds.filter(link=>key(link)>position)];
    index=siblings.findIndex(link=>link.link_id===anchor)+(before!==null?0:1);
  }
  const positions=insertionPositions(siblings.map(link=>({link_id:link.link_id,position:key(link)})),index,id);
  return {value:positions.find(item=>item.link_id===id)!.position,previous:siblings,moves:positions.filter(item=>item.link_id!==id).map(item=>({kind:"move_link",link_id:item.link_id,endpoint_ref:ref,position:item.position}))};
}
export async function prepareLink(runtime: WritingRuntime, input: LinkRequest, sourcePlacement?: {value:string;moves:Intent[]}): Promise<{ link_id: string; intents: Intent[] }> {
  const store = await runtime.store;
  const replica = await store.readReplica();
  const [a, b] = sortedEndpoints(input.source_ref, input.target_ref);
  const binding = await store.query({ kind: "binding", key: { kind: "link", endpoint_a: a, endpoint_b: b } });
  const id = binding.binding_id ?? linkId(replica.account_id, a, b);
  const known = (await store.readStates(selectStates({ link_ids: [id] }))).links[0];
  const intents: Intent[] = [];
  if (!known || !isVisible(known.add_vv, known.remove_vv)) {
    const sourcePosition = sourcePlacement ?? await preparePosition(runtime, input.source_ref, id, input.after, input.before ?? null);
    const targetPosition = await preparePosition(runtime, input.target_ref, id, null, null);
    intents.push(...sourcePosition.moves, ...targetPosition.moves, {
      kind: "add_link", link_id: id, endpoint_a: a, endpoint_b: b,
      position_a: a === input.source_ref ? sourcePosition.value : targetPosition.value,
      position_b: b === input.source_ref ? sourcePosition.value : targetPosition.value,
    });
  }
  const capturedSources=await store.readStates(selectStates({source_refs:[input.source_ref,input.target_ref]}));
  for (const [ref, label] of [[input.source_ref, input.source_label], [input.target_ref, input.target_label]] as const) {
    if (/^(note_block|page|highlight):/u.test(ref)) continue;
    const parsed = parseResourceRef(ref);
    if (!parsed) throw new TypeError("Invalid link endpoint");
    if(parsed.scheme==="passage_anchor")continue;
    const existing=capturedSources.source_stubs.find(source=>source.source_ref===ref);
    if(existing && label===null)continue;
    intents.push({ kind: "capture_source", source_ref: ref, capture: { kind: parsed.scheme, label: label ?? ref, publication: existing?.capture.value.publication??null } });
  }
  return { link_id: id, intents };
}
export async function createLink(runtime: WritingRuntime, input: LinkRequest): Promise<string> {
  const prepared = await prepareLink(runtime, input);
  const intents = [...input.prelude ?? [], ...prepared.intents];
  if (intents.length) await runtime.run({ kind: "batch", intents });
  return prepared.link_id;
}
export async function deleteLink(runtime: WritingRuntime, { linkId }: { linkId: string }): Promise<void> {
  const state = await (await runtime.store).readStates(selectStates({ link_ids: [linkId] }));
  const link = state.links.find(link => link.link_id === linkId);
  if (!link) return;
  await runtime.run({ kind: "unlink", link_id: linkId, observed_add: link.add_vv });
}
export async function deleteResource(runtime: WritingRuntime, { ref }: { ref: string }): Promise<import("@/lib/notes/runtime").LocalCommit> {
  let observed_touch;
  if (ref.startsWith("note_block:") || ref.startsWith("page:")) {
    observed_touch = (await (await runtime.openDocument(ref)).capture()).observed_touch;
  } else {
    const states = await (await runtime.store).readStates(selectStates({ refs: [ref] }));
    const resource = states.resources.find(resource => resource.ref === ref);
    if (!resource) throw new Error("This resource is unavailable on this device");
    observed_touch = resource.touch_vv;
  }
  return runtime.run({ kind: "delete_resource", ref, observed_touch });
}
export async function queryConnections(input: Schema<"ConnectionQueryRequest">, signal?: AbortSignal): Promise<Schema<"ConnectionPageOut">> {
  const { data } = await apiFetch<ApiJson<"/resource-graph/connections/query", "post">>("/api/resource-graph/connections/query", { method: "POST", signal, body: JSON.stringify({ ...input, limit: Math.min(input.limit ?? 100, 100) }) });
  return data;
}
export async function mutateConnection(runtime: WritingRuntime, command: ConnectionCommand): Promise<void> {
  if (command.kind === "unlink") return deleteLink(runtime, { linkId: command.link_id });
  if (command.kind === "remove_fact") { await apiFetch(`/api/resource-graph/facts/${command.edge_id}`, { method: "DELETE" }); return; }
  await apiFetch(`/api/conversations/${command.conversation_id}/context/${encodeURIComponent(command.target_ref)}?expected_context_version=${command.expected_context_version}`, { method: "DELETE" });
}
export function connectionMutationErrorMessage(error: unknown): FeedbackContent {
  if (!isApiError(error) || isSameSystemApiDefect(error)) return { tone: "Warning", title: "couldn’t save this change on this device", message: "keep this page open and retry saving." };
  if (outcomeUnknown(error)) return { tone: "Warning", title: "couldn’t confirm removal", requestId: error.requestId };
  return apiTransportFeedback(error, "couldn’t remove connection") ?? { tone: "Warning", title: "this connection can’t be removed here", requestId: error.requestId };
}

/** A passage picker result carries its own quote/locator baseline. Known semantic
 * bindings survive deletion; no server reread is substituted during acceptance. */
export async function prepareTarget(runtime: WritingRuntime, target: LinkTarget): Promise<{ ref: string; intents: Intent[] }> {
  if (target.kind === "resource") return { ref: target.ref, intents: [] };
  const capture = target.passage_target;
  if (capture === null) throw new Error("This passage has no retained selection. select it again before linking.");
  const locator = captureLocator(capture.locator, capture.owner_ref);
  const selector = "text_quote_selector" in locator ? locator.text_quote_selector : null;
  const quote_exact = selector?.exact ?? (locator.type === "pdf_page_geometry" ? locator.exact : null);
  if (quote_exact === null || quote_exact.length === 0) throw new Error("This passage has no retained quote. select it again before linking.");
  const prefix = normalizeQuote(selector?.prefix ?? (locator.type === "pdf_page_geometry" ? locator.prefix ?? "" : ""));
  const suffix = normalizeQuote(selector?.suffix ?? (locator.type === "pdf_page_geometry" ? locator.suffix ?? "" : ""));
  const normalized_exact = normalizeQuote(quote_exact);
  const source_ref = capture.owner_ref;
  const store = await runtime.store;
  const replica = await store.readReplica();
  const known = await store.query({ kind: "binding", key: { kind: "passage", source_ref, normalized_exact, prefix, suffix } });
  const anchor_id = known.binding_id ?? passageId(replica.account_id, source_ref, await passageKey(normalized_exact, prefix, suffix));
  const publication = null;
  const source = parseResourceRef(source_ref);
  if (!source) throw new TypeError("Invalid passage source");
  const sources=await store.readStates(selectStates({source_refs:[source_ref]}));
  const stub:Intent[] = /^(note_block|page|highlight):/u.test(source_ref) || sources.source_stubs.some(stub=>stub.source_ref===source_ref) ? [] : [{kind:"capture_source",source_ref,capture:{kind:source.scheme,label:source_ref,publication}}];
  return { ref: `passage_anchor:${anchor_id}`, intents: [
    ...stub,
    { kind: "capture_passage", anchor_id, source_ref, normalized_exact, prefix, suffix, capture: { quote_exact, publication, locator } },
  ] };
}
