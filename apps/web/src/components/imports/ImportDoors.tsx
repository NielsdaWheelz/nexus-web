"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { extractLinks } from "@/lib/extractLinks";
import { ADMIT_LIMIT, useImportIntake, type Admission } from "@/lib/imports/intake";
import { libraryNames } from "@/lib/libraries/views";
import { requestNexusOpen } from "@/lib/nexus/events";
import { getInteractionOwner } from "@/lib/ui/overlay";
import ImportVeil from "./ImportVeil";

/** Document ingress yields to the actual input or overlay owner before admitting. */
export default function ImportDoors({ admit }: { readonly admit: (input: Admission) => void }) {
  const { into, disarmExcept, setFieldLine } = useImportIntake();
  const [label, setLabel] = useState<string | null>(null);
  const internal = useRef(false);
  const latest = useRef({ into, admit });
  useLayoutEffect(() => { latest.current = { into, admit }; });

  useEffect(() => {
    const editable = (target: EventTarget | null) => target instanceof Element && target.closest("[contenteditable], input, textarea") !== null;
    function destination(event: DragEvent): "Page" | "Outside" | null {
      if (event.defaultPrevented || internal.current || editable(event.target)) return null;
      const owner = getInteractionOwner();
      return owner === null ? "Outside" : owner.element?.querySelector("[data-import-page]") ? "Page" : null;
    }
    function hover(event: DragEvent) {
      const target = event.dataTransfer?.types.includes("Files") ? destination(event) : null;
      if (target === null) return setLabel(null);
      event.preventDefault();
      const { into } = latest.current;
      setLabel(target === "Page" && into.length > 0 ? `drop into ${libraryNames(into)}` : "drop to import");
    }
    function leave(event: DragEvent) {
      if (event.relatedTarget === null && (event.target === document.body || event.target === document.documentElement
        || event.clientX <= 0 || event.clientY <= 0 || event.clientX >= innerWidth || event.clientY >= innerHeight)) setLabel(null);
    }
    function start(event: DragEvent) {
      if (!event.defaultPrevented) internal.current = true;
      setLabel(null);
    }
    function end() {
      internal.current = false;
      setLabel(null);
    }
    function drop(event: DragEvent) {
      const target = destination(event);
      end();
      const files = Array.from(event.dataTransfer?.files ?? []);
      if (event.defaultPrevented || files.length === 0 && !event.dataTransfer?.types.includes("Files")
        || event.target instanceof HTMLInputElement && event.target.type === "file") return;
      // Even a rejected, unclaimed file drop must not navigate away from the workspace.
      event.preventDefault();
      if (target === null || files.length === 0) return;
      if (target === "Outside") requestNexusOpen({ kind: "Import", into: [] });
      disarmExcept(null);
      if (files.length > ADMIT_LIMIT) setFieldLine({ fact: `100 at a time. this has ${files.length}.` });
      else latest.current.admit({ links: [], files });
    }
    function paste(event: ClipboardEvent) {
      if (event.defaultPrevented || editable(event.target) || getInteractionOwner() !== null) return;
      const text = event.clipboardData?.getData("text/plain") ?? "";
      const { links, rest } = extractLinks(text, "Urls");
      if (links.length === 0 || rest !== "") return;
      event.preventDefault();
      requestNexusOpen({ kind: "Root", query: text.replace(/[\r\n]+/g, " ") });
    }
    window.addEventListener("dragenter", hover);
    window.addEventListener("dragover", hover);
    window.addEventListener("dragleave", leave);
    window.addEventListener("dragstart", start);
    window.addEventListener("dragend", end);
    window.addEventListener("blur", end);
    window.addEventListener("drop", drop);
    window.addEventListener("paste", paste);
    return () => {
      window.removeEventListener("dragenter", hover);
      window.removeEventListener("dragover", hover);
      window.removeEventListener("dragleave", leave);
      window.removeEventListener("dragstart", start);
      window.removeEventListener("dragend", end);
      window.removeEventListener("blur", end);
      window.removeEventListener("drop", drop);
      window.removeEventListener("paste", paste);
    };
  }, [disarmExcept, setFieldLine]);

  return label === null ? null : <ImportVeil label={label} />;
}
