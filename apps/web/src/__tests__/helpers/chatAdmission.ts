import type { AcceptedChatAdmission } from "@/lib/conversations/chatAdmission";

const readModules = import.meta.glob<
  typeof import("@/lib/conversations/chatAdmissionRead")
>("/src/lib/conversations/chatAdmissionRead.ts");

export async function adoptComposerAdmission(
  receipt: AcceptedChatAdmission,
  isCurrent: () => boolean,
): Promise<boolean> {
  const load = readModules["/src/lib/conversations/chatAdmissionRead.ts"];
  if (load === undefined)
    throw new Error("The chat admission read owner is absent");
  const { readAdmittedChatRun } = await load();
  await readAdmittedChatRun(receipt);
  return isCurrent();
}
