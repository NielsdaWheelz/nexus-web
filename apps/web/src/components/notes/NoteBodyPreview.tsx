"use client";

/** Canonical rich reading has no editing host or history owner. */
import {useLayoutEffect, useRef} from "react";
import {DOMSerializer} from "prosemirror-model";
import {docFromBody, noteBodySchema, sameBody, type NoteBody} from "@nexus/authored/body";
import {embedDisplayLabel} from "@/lib/resources/localResource";
import styles from "./NoteEditor.module.css";

export default function NoteBodyPreview({body}: {body: NoteBody}) {
  const element = useRef<HTMLDivElement>(null);
  const displayed = useRef<NoteBody | null>(null);
  useLayoutEffect(() => {
    if (!element.current || displayed.current && sameBody(displayed.current, body)) return;
    const serializer = DOMSerializer.fromSchema(noteBodySchema);
    const content = new DOMSerializer({...serializer.nodes, resource_embed: node => ["span", {
      "data-resource-ref": node.attrs.resource_ref, "data-field": node.attrs.field, "data-label": node.attrs.label,
      contenteditable: "false", class: "note-resource-embed",
    }, embedDisplayLabel(node.attrs.resource_ref, node.attrs.field, node.attrs.label)]}, serializer.marks).serializeFragment(docFromBody(body).content);
    element.current.replaceChildren(content);
    displayed.current = body;
  }, [body]);
  return <div ref={element} className={styles.view}/>;
}
