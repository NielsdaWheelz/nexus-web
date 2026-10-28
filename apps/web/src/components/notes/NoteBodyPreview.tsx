"use client";

/** Canonical rich reading has no editing host or history owner. */
import {useLayoutEffect, useRef} from "react";
import {DOMSerializer} from "prosemirror-model";
import {docFromBody, noteBodySchema, sameBody, type NoteBody} from "@nexus/authored/body";
import styles from "./NoteEditor.module.css";

export default function NoteBodyPreview({body}: {body: NoteBody}) {
  const element = useRef<HTMLDivElement>(null);
  const displayed = useRef<NoteBody | null>(null);
  useLayoutEffect(() => {
    if (!element.current || displayed.current && sameBody(displayed.current, body)) return;
    const content = DOMSerializer.fromSchema(noteBodySchema).serializeFragment(docFromBody(body).content);
    element.current.replaceChildren(content);
    displayed.current = body;
  }, [body]);
  return <div ref={element} className={`${styles.view} ${styles.compact}`}/>;
}
