"use client";

import Button from "@/components/ui/Button";
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
        <Button
          key={`${object.objectType}:${object.objectId}`}
          variant="ghost"
          size="sm"
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
          <span className={styles.optionRow}>
            <span className={styles.optionLabel}>{object.label}</span>
            <span className={styles.optionType}>{object.objectType}</span>
          </span>
        </Button>
      ))}
    </div>
  );
}
