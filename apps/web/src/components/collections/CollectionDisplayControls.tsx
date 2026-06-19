"use client";

import { LayoutGrid, LayoutList, Rows2, Rows3 } from "lucide-react";
import type { ReactNode } from "react";
import type {
  CollectionDensity,
  CollectionDisplayState,
  CollectionViewMode,
} from "@/lib/collections/collectionViewState";
import styles from "./CollectionDisplayControls.module.css";

type DisplayPatch =
  | { view: CollectionViewMode }
  | { density: CollectionDensity };

export default function CollectionDisplayControls({
  value,
  onChange,
  gallery = true,
}: {
  value: CollectionDisplayState;
  onChange: (next: CollectionDisplayState) => void;
  gallery?: boolean;
}) {
  const update = (patch: DisplayPatch) => onChange({ ...value, ...patch });
  return (
    <div className={styles.controls}>
      {gallery ? (
        <span className={styles.segment} role="group" aria-label="Collection view">
          <IconToggle
            label="List view"
            pressed={value.view === "list"}
            onClick={() => update({ view: "list" })}
            icon={<LayoutList size={16} aria-hidden="true" />}
          />
          <IconToggle
            label="Gallery view"
            pressed={value.view === "gallery"}
            onClick={() => update({ view: "gallery" })}
            icon={<LayoutGrid size={16} aria-hidden="true" />}
          />
        </span>
      ) : null}
      <span className={styles.segment} role="group" aria-label="Collection density">
        <IconToggle
          label="Comfortable density"
          pressed={value.density === "comfortable"}
          onClick={() => update({ density: "comfortable" })}
          icon={<Rows2 size={16} aria-hidden="true" />}
        />
        <IconToggle
          label="Compact density"
          pressed={value.density === "compact"}
          onClick={() => update({ density: "compact" })}
          icon={<Rows3 size={16} aria-hidden="true" />}
        />
      </span>
    </div>
  );
}

function IconToggle({
  label,
  pressed,
  onClick,
  icon,
}: {
  label: string;
  pressed: boolean;
  onClick: () => void;
  icon: ReactNode;
}) {
  return (
    <button
      type="button"
      className={styles.button}
      aria-label={label}
      title={label}
      aria-pressed={pressed}
      data-pressed={pressed ? "true" : "false"}
      onClick={onClick}
    >
      {icon}
    </button>
  );
}
