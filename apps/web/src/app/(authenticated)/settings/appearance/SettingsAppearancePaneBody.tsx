"use client";

import { useEffect, useState } from "react";
import SectionCard from "@/components/ui/SectionCard";
import { setAppearanceAction } from "@/lib/theme/setAppearanceAction";
import styles from "./page.module.css";

type Selection = "light" | "dark" | "system";

export default function SettingsAppearancePaneBody() {
  const [selection, setSelection] = useState<Selection | null>(null);

  useEffect(() => {
    const value = document.cookie.match(/(?:^|;\s*)nx-theme=(light|dark)/)?.[1];
    setSelection(value === "light" || value === "dark" ? value : "system");
  }, []);

  async function handleChange(next: Selection) {
    setSelection(next);
    if (next === "system") {
      delete document.documentElement.dataset.theme;
    } else {
      document.documentElement.dataset.theme = next;
    }
    await setAppearanceAction(next);
  }

  if (selection === null) return null;

  return (
    <SectionCard title="Theme">
      <fieldset className={styles.fieldset}>
        <legend className={styles.legend}>Choose how Nexus looks.</legend>
        <label className={styles.option}>
          <input
            type="radio"
            name="appearance"
            value="light"
            checked={selection === "light"}
            onChange={() => handleChange("light")}
          />
          <span className={styles.optionLabel}>Light</span>
          <span className={styles.optionHint}>Cream paper, dark ink.</span>
        </label>
        <label className={styles.option}>
          <input
            type="radio"
            name="appearance"
            value="dark"
            checked={selection === "dark"}
            onChange={() => handleChange("dark")}
          />
          <span className={styles.optionLabel}>Dark</span>
          <span className={styles.optionHint}>Near-black canvas, warm ink.</span>
        </label>
        <label className={styles.option}>
          <input
            type="radio"
            name="appearance"
            value="system"
            checked={selection === "system"}
            onChange={() => handleChange("system")}
          />
          <span className={styles.optionLabel}>System</span>
          <span className={styles.optionHint}>
            Match your operating-system preference.
          </span>
        </label>
      </fieldset>
    </SectionCard>
  );
}
