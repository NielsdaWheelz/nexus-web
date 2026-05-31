"use client";

import { BROWSE_TYPES, TYPE_LABELS, type BrowseSectionType } from "./browseState";
import styles from "./page.module.css";

/** Checkbox cluster controlling which browse result types stay visible. */
export default function BrowseTypeFilters({
  visibleTypes,
  onChange,
}: {
  visibleTypes: BrowseSectionType[];
  onChange: (nextVisibleTypes: BrowseSectionType[]) => void;
}) {
  const selectedTypeSet = new Set(visibleTypes);
  return (
    <div className={styles.filters} aria-label="Browse visible result types">
      {BROWSE_TYPES.map((type) => (
        <label key={type} className={styles.filterOption}>
          <input
            type="checkbox"
            checked={selectedTypeSet.has(type)}
            onChange={(event) => {
              if (event.target.checked) {
                onChange(
                  [...visibleTypes, type].filter(
                    (value, index, values) => values.indexOf(value) === index,
                  ),
                );
                return;
              }
              onChange(visibleTypes.filter((value) => value !== type));
            }}
          />
          <span>{TYPE_LABELS[type]}</span>
        </label>
      ))}
    </div>
  );
}
