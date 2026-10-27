/** One-shot semantic process. This boundary closes request/command keys and
 * scalar shapes. Python producers supply nested semantic records; shared merge
 * validation and Python's closed result decoder admit their published effects.
 * The platform owns transactions and SQL publication. */
import { mergeChanges, isVisible } from "./src/merge.ts";
import { createNoteIntent, prepareChange, type CommandContext, type Intent } from "./src/commands.ts";
import { parseBody } from "./src/body.ts";
import { dailyId, linkId, normalizeQuote, passageId, passageKey, validateBindings } from "./src/identity.ts";
import { generateKeyBetween } from "fractional-indexing";
import type { Change, Corpus } from "./src/types.ts";
type ServerCommand =
  | Exclude<Intent, { kind: "create_note" | "add_link" | "batch" }>
  | { kind: "create_note"; ref: string; body_pm_json: unknown }
  | (Omit<Extract<Intent, { kind: "add_link" }>, "link_id" | "position_a" | "position_b"> & { link_id: null; position_a: string | null; position_b: string | null })
  | { kind: "capture_passage"; anchor_id: null; source_ref: string; exact: string; prefix: string | null; suffix: string | null; capture: Extract<Intent, { kind: "capture_passage" }>["capture"] }
  | { kind: "batch"; intents: ServerCommand[] };
const commandKeys = new Map<string, string>(Object.entries({
  create_note: "ref body_pm_json", create_page: "ref title local_date",
  edit_body: "ref body_update", edit_title: "ref title_update",
  delete_resource: "ref observed_touch", restore_resource: "ref",
  add_link: "link_id endpoint_a endpoint_b position_a position_b", restore_link: "link_id",
  unlink: "link_id observed_add", restore_position: "link_id endpoint_ref expected position",
  move_link: "link_id endpoint_ref position", create_highlight: "ref source_ref selection color",
  update_highlight: "ref selection color", capture_source: "source_ref capture",
  capture_passage: "anchor_id source_ref normalized_exact prefix suffix capture", batch: "intents",
} satisfies Record<Intent["kind"], string>));
function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new TypeError("Expected semantic object");
  // justify-type-assertion: JSON object shape was checked; fields remain unknown.
  return value as Record<string, unknown>;
}
function closed(value: unknown, fields: string): Record<string, unknown> {
  const record = object(value), expected = fields.split(" ");
  if (Object.keys(record).length !== expected.length || expected.some(key => !Object.hasOwn(record, key))) throw new TypeError("Unknown or missing semantic field");
  return record;
}
function text(value: unknown): string {
  if (typeof value !== "string") throw new TypeError("Expected semantic text");
  return value;
}
function serverCommand(value: unknown): ServerCommand {
  const command = object(value), kind = text(command.kind);
  let fields = commandKeys.get(kind);
  if (fields === undefined) throw new TypeError("Unknown semantic command kind");
  if (kind === "capture_passage" && command.anchor_id === null) fields = "anchor_id source_ref exact prefix suffix capture";
  closed(command, `kind ${fields}`);
  for (const field of ["ref", "title", "body_update", "title_update", "endpoint_a", "endpoint_b", "endpoint_ref", "position", "source_ref", "exact", "normalized_exact"]) if (field in command) text(command[field]);
  for (const field of ["local_date", "position_a", "position_b", "prefix", "suffix"]) if (field in command && command[field] !== null) text(command[field]);
  if (kind === "add_link") { if (command.link_id !== null) throw new TypeError("Server link identity must be unresolved"); }
  else if ("link_id" in command) text(command.link_id);
  if (kind === "capture_passage" && command.anchor_id !== null) { text(command.anchor_id); text(command.prefix); text(command.suffix); }
  if ("color" in command && !(kind === "update_highlight" && command.color === null)) text(command.color);
  for (const field of ["observed_touch", "observed_add", "capture"]) if (field in command) object(command[field]);
  if ("selection" in command && !(kind === "update_highlight" && command.selection === null)) object(command.selection);
  if ("expected" in command) { const stamp = closed(command.expected, "lamport replica_id"); text(stamp.lamport); text(stamp.replica_id); }
  if (kind === "batch" && !Array.isArray(command.intents)) throw new TypeError("Expected semantic batch intents");
  // justify-type-assertion: keys/scalars are checked above; nested records are trusted Python inputs, whose effects shared merge and the closed Python result decoder validate.
  return command as ServerCommand;
}
function corpus(value: unknown): Corpus {
  const states = closed(value, "resources links passages source_stubs");
  if (Object.values(states).some(items => !Array.isArray(items))) throw new TypeError("Expected semantic state arrays");
  // justify-type-assertion: Python's closed Corpus decoder owns these nested state records.
  return states as unknown as Corpus;
}
let input = "";
for await (const chunk of process.stdin) {
  input += chunk;
  if (Buffer.byteLength(input) > 12 * 1024 * 1024) throw new TypeError("Semantic input exceeds process budget");
}
const request = object(JSON.parse(input));
let result;
async function serverIntent(value: unknown, states: Corpus, account_id: string, context: CommandContext): Promise<Intent> {
  const command = serverCommand(value);
  if (command.kind === "batch") {
    const intents: Intent[] = [];
    let observed = states;
    for (const child of command.intents) {
      const intent = await serverIntent(child, observed, account_id, context);
      intents.push(intent);
      observed = mergeChanges(observed, [prepareChange(context, intent, observed)]);
    }
    return { kind: "batch", intents };
  }
  if (command.kind === "create_note") return createNoteIntent(command.ref, parseBody(command.body_pm_json));
  if (command.kind === "add_link") {
    const a = command.endpoint_a, b = command.endpoint_b;
    const known = states.links.find(link => link.endpoint_a === a && link.endpoint_b === b);
    const lastPosition = (ref: string): string | null => {
      const keys = states.links.filter(link => [link.endpoint_a,link.endpoint_b].every(ref => { const resource=states.resources.find(resource=>resource.ref===ref);return !resource||isVisible(resource.touch_vv,resource.delete_vv); }) && isVisible(link.add_vv, link.remove_vv) && (link.endpoint_a === ref || link.endpoint_b === ref)).flatMap(link => {
        const position = link.endpoint_a === ref ? link.position_a : link.position_b;
        return position === null ? [] : [position.value];
      }).sort();
      return keys.at(-1) ?? null;
    };
    return { kind: "add_link", link_id: known?.link_id ?? linkId(account_id, a, b), endpoint_a: a, endpoint_b: b, position_a: command.position_a === null ? generateKeyBetween(lastPosition(a), null) : command.position_a, position_b: command.position_b === null ? generateKeyBetween(lastPosition(b), null) : command.position_b };
  }
  if (command.kind === "capture_passage") {
    if (command.anchor_id !== null) return command;
    const exact = normalizeQuote(command.exact);
    const prefix = normalizeQuote(command.prefix ?? "");
    const suffix = normalizeQuote(command.suffix ?? "");
    const source_ref = command.source_ref;
    const known = states.passages.find(p => p.source_ref === source_ref && p.normalized_exact === exact && p.prefix === prefix && p.suffix === suffix);
    const anchor_id = known?.anchor_id ?? passageId(account_id, source_ref, await passageKey(exact, prefix, suffix));
    return { kind: "capture_passage", anchor_id, source_ref, normalized_exact: exact, prefix, suffix, capture: command.capture };
  }
  return command;
}
switch (request.op) {
  case "identity":
    if (request.kind === "link") { closed(request, "op account_id kind endpoint_a endpoint_b"); result = { id: linkId(text(request.account_id), text(request.endpoint_a), text(request.endpoint_b)) }; }
    else if (request.kind === "daily") { closed(request, "op account_id kind local_date"); result = { ref: `page:${dailyId(text(request.account_id), text(request.local_date))}` }; }
    else throw new TypeError("Unknown semantic identity kind");
    break;
  case "prepare_server": {
    closed(request, "op account_id states replica_id command_seq lamport command");
    const account_id = text(request.account_id), states = corpus(request.states);
    const context = { replica_id: text(request.replica_id), command_seq: text(request.command_seq), lamport: text(request.lamport) };
    const command = await serverIntent(request.command, states, account_id, context);
    const change = prepareChange(context, command, states);
    await validateBindings(account_id, states, [change]);
    result = { change, states: mergeChanges(states, [change]) };
    break;
  }
  case "merge": {
    closed(request, "op account_id states changes");
    if (!Array.isArray(request.changes)) throw new TypeError("Expected semantic changes");
    const account_id = text(request.account_id), states = corpus(request.states);
    // justify-type-assertion: Python's closed Change decoder owns nested change shapes; shared merge validates semantic effects.
    const changes = request.changes as Change[];
    await validateBindings(account_id, states, changes); result = mergeChanges(states, changes); break;
  }
  default: throw new TypeError("Unknown semantic operation");
}
process.stdout.write(JSON.stringify(result));
