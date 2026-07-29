"use client";

import { ArrowLeft } from "lucide-react";
import type { DesktopNexusController } from "./types";
import styles from "./desktopNexus.module.css";

export default function DesktopNexusActionsPage({
  controller,
}: {
  controller: DesktopNexusController;
}) {
  if (controller.page.kind !== "Actions") return null;
  return (
    <section className={styles.actionsPage} aria-label={`Actions for ${controller.page.label}`}>
      <header className={styles.pageHeader}>
        <button type="button" className={styles.backButton} onClick={controller.back} aria-label="Back to Nexus">
          <ArrowLeft size={18} aria-hidden="true" />
        </button>
        <h2>Actions for {controller.page.label}</h2>
      </header>
      <ul className={styles.actionsMenu} role="menu" aria-label={`Actions for ${controller.page.label}`}>
        {controller.page.actions.map((action) => (
          <li key={action.id} role="none">
            <button type="button" role="menuitem" onClick={() => controller.runAction(action.id)}>
              <span aria-hidden="true">{action.icon}</span>
              {action.label}
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
