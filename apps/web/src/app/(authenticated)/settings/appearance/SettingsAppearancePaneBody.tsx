"use client";

import { useEffect, useState } from "react";
import SectionCard from "@/components/ui/SectionCard";
import { setAppearanceAction } from "@/lib/theme/setAppearanceAction";
import styles from "./page.module.css";

type Selection = "light" | "dark" | "system";

function readCookieSelection(): Selection {
  const match = document.cookie.match(/(?:^|;\s*)nx-theme=(light|dark)/);
  return match ? (match[1] as Selection) : "system";
}

function resolveAppliedTheme(value: Selection): "light" | "dark" {
  if (value !== "system") return value;
  return matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
}

export default function SettingsAppearancePaneBody() {
  const [selection, setSelection] = useState<Selection | null>(null);

  useEffect(() => {
    setSelection(readCookieSelection());
  }, []);

  async function handleChange(next: Selection) {
    setSelection(next);
    document.documentElement.dataset.theme = resolveAppliedTheme(next);
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
