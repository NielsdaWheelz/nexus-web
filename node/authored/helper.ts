/** One-shot semantic process. The platform owns admission and SQL publication. */
import { mergeChanges, isVisible } from "./src/merge.ts";
import { createNoteIntent, prepareChange, type Intent } from "./src/commands.ts";
import { parseBody } from "./src/body.ts";
import { dailyId, linkId, normalizeQuote, passageId, passageKey, validateBindings } from "./src/identity.ts";
import { generateKeyBetween } from "fractional-indexing";
import type { Corpus } from "./src/types.ts";
let input = "";
for await (const chunk of process.stdin) {
  input += chunk;
  if (Buffer.byteLength(input) > 12 * 1024 * 1024) throw new TypeError("Semantic input exceeds process budget");
}
const request = JSON.parse(input);
let result;
async function serverIntent(command: Record<string, unknown>, states: Corpus, account_id: string): Promise<Intent> {
  if (command.kind === "batch") {
    const intents: Intent[] = [];
    let observed = states;
    for (const child of command.intents as Record<string, unknown>[]) {
      const intent = await serverIntent(child, observed, account_id);
      intents.push(intent);
      observed = mergeChanges(observed, [prepareChange(request, intent, observed)]);
    }
    return { kind: "batch", intents };
  }
  if (command.kind === "create_note") return createNoteIntent(String(command.ref), parseBody(command.body_pm_json ?? (command.body as { body_pm_json: unknown }).body_pm_json));
  if (command.kind === "add_link") {
    const a = String(command.endpoint_a), b = String(command.endpoint_b);
    const known = states.links.find(link => link.endpoint_a === a && link.endpoint_b === b);
    const lastPosition = (ref: string): string | null => {
      const keys = states.links.filter(link => [link.endpoint_a,link.endpoint_b].every(ref => { const resource=states.resources.find(resource=>resource.ref===ref);return !resource||isVisible(resource.touch_vv,resource.delete_vv); }) && isVisible(link.add_vv, link.remove_vv) && (link.endpoint_a === ref || link.endpoint_b === ref)).flatMap(link => {
        const position = link.endpoint_a === ref ? link.position_a : link.position_b;
        return position === null ? [] : [position.value];
      }).sort();
      return keys.at(-1) ?? null;
    };
    return { kind: "add_link", link_id: known?.link_id ?? linkId(account_id, a, b), endpoint_a: a, endpoint_b: b, position_a: command.position_a === null ? generateKeyBetween(lastPosition(a), null) : String(command.position_a), position_b: command.position_b === null ? generateKeyBetween(lastPosition(b), null) : String(command.position_b) };
  }
  if (command.kind === "capture_passage" && command.anchor_id === null) {
    const exact = normalizeQuote(String(command.exact));
    const prefix = normalizeQuote(String(command.prefix ?? ""));
    const suffix = normalizeQuote(String(command.suffix ?? ""));
    const source_ref = String(command.source_ref);
    const known = states.passages.find(p => p.source_ref === source_ref && p.normalized_exact === exact && p.prefix === prefix && p.suffix === suffix);
    const anchor_id = known?.anchor_id ?? passageId(account_id, source_ref, await passageKey(exact, prefix, suffix));
    // justify-type-assertion: capture is closed by host schema and validated by mergeChanges.
    return { kind: "capture_passage", anchor_id, source_ref, normalized_exact: exact, prefix, suffix, capture: command.capture as Extract<Intent, { kind: "capture_passage" }>["capture"] };
  }
  // justify-type-assertion: command variants are closed by the host; mergeChanges validates their effects.
  return command as Intent;
}
switch (request.op) {
  case "identity":
    if (request.kind === "link") result = { id: linkId(request.account_id, request.endpoint_a, request.endpoint_b) };
    else if (request.kind === "daily") result = { ref: `page:${dailyId(request.account_id, request.local_date)}` };
    else throw new TypeError("Unknown semantic identity kind");
    break;
  case "prepare_server": {
    const command = await serverIntent(request.command, request.states, request.account_id);
    const change = prepareChange(request, command, request.states);
    await validateBindings(request.account_id, request.states, [change]);
    result = { change, states: mergeChanges(request.states, [change]) };
    break;
  }
  case "merge": await validateBindings(request.account_id, request.states, request.changes); result = mergeChanges(request.states, request.changes); break;
  default: throw new TypeError("Unknown semantic operation");
}
process.stdout.write(JSON.stringify(result));
