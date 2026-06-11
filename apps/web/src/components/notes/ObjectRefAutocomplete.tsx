"use client";

import type { HydratedObjectRef } from "@/lib/objectRefs";
import styles from "./ObjectRefAutocomplete.module.css";

export default function ObjectRefAutocomplete({
  id,
  objects,
  activeObjectKey,
  optionIdForObject,
  onActiveChange,
  onPick,
}: {
  id: string;
  objects: HydratedObjectRef[];
  activeObjectKey: string | null;
  optionIdForObject: (object: HydratedObjectRef) => string;
  onActiveChange: (objectKey: string) => void;
  onPick: (object: HydratedObjectRef) => void;
}) {
  if (objects.length === 0) {
    return null;
  }
  return (
    <div id={id} className={styles.menu} role="listbox" aria-label="Object references">
      {objects.map((object) => (
        <div
          key={`${object.objectType}:${object.objectId}`}
          id={optionIdForObject(object)}
          role="option"
          aria-selected={activeObjectKey === objectRefKey(object)}
          data-active={activeObjectKey === objectRefKey(object) ? "true" : "false"}
          tabIndex={-1}
          className={styles.option}
          onMouseMove={() => onActiveChange(objectRefKey(object))}
          onMouseDown={(event) => {
            event.preventDefault();
            onPick(object);
          }}
        >
          <span className={styles.optionRow}>
            <span className={styles.optionLabel}>{object.label}</span>
            <span className={styles.optionType}>{object.objectType}</span>
          </span>
        </div>
      ))}
    </div>
  );
}

function objectRefKey(object: HydratedObjectRef): string {
  return `${object.objectType}:${object.objectId}`;
}
