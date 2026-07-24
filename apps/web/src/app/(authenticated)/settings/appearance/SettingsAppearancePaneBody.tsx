"use client";

import { useEffect, useState } from "react";
import PaneSection from "@/components/ui/PaneSection";
import PaneSurface from "@/components/ui/PaneSurface";
import SectionOpener from "@/components/ui/SectionOpener";
import { setAppearanceAction } from "@/lib/theme/setAppearanceAction";
import { usePaneReturnReady } from "@/lib/panes/paneRuntime";
import styles from "./page.module.css";

type Selection = "light" | "dark" | "system";

export default function SettingsAppearancePaneBody() {
  const [selection, setSelection] = useState<Selection | null>(null);

  useEffect(() => {
    const value = document.cookie.match(/(?:^|;\s*)nx-theme=(light|dark)/)?.[1];
    setSelection(value === "light" || value === "dark" ? value : "system");
  }, []);
  usePaneReturnReady(selection !== null);

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
    <PaneSurface opener={<SectionOpener heading="Appearance" />}>
      <PaneSection title="Theme">
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
            <span className={styles.optionLabel}>Study</span>
            <span className={styles.optionHint}>Warm paper, dark ink — day.</span>
          </label>
          <label className={styles.option}>
            <input
              type="radio"
              name="appearance"
              value="dark"
              checked={selection === "dark"}
              onChange={() => handleChange("dark")}
            />
            <span className={styles.optionLabel}>Press</span>
            <span className={styles.optionHint}>Near-black canvas, warm ink — night.</span>
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
      </PaneSection>
    </PaneSurface>
  );
}
