"use client";

import type { HydratedObjectRef } from "@/lib/objectRefs";
import styles from "./ObjectRefAutocomplete.module.css";

export default function ObjectRefAutocomplete({
  objects,
  onPick,
}: {
  objects: HydratedObjectRef[];
  onPick: (object: HydratedObjectRef) => void;
}) {
  if (objects.length === 0) {
    return null;
  }
  return (
    <div className={styles.menu} role="listbox" aria-label="Object references">
      {objects.map((object) => (
        <button
          key={`${object.objectType}:${object.objectId}`}
          type="button"
          className={styles.option}
          onMouseDown={(event) => {
            event.preventDefault();
            onPick(object);
          }}
          onClick={(event) => {
            if (event.detail === 0) {
              onPick(object);
            }
          }}
        >
          <span>{object.label}</span>
          <span>{object.objectType}</span>
        </button>
      ))}
    </div>
  );
}
