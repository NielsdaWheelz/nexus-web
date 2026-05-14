import type { Metadata } from "next";
import Link from "next/link";
import styles from "./page.module.css";

export const metadata: Metadata = {
  title: "Install Nexus for Android | Nexus",
  description: "Download the Nexus Android APK and install the web app shell.",
};

export default function AndroidPage() {
  return (
    <main className={styles.page}>
      <section className={styles.hero}>
        <div className={styles.copy}>
          <p className={styles.eyebrow}>Android APK</p>
          <h1>Install Nexus on Android</h1>
          <p className={styles.deck}>
            Download the Nexus Android APK directly from the latest GitHub
            release.
          </p>
          <div className={styles.actions}>
            <a
              className={styles.primaryLink}
              href="https://github.com/NielsdaWheelz/nexus-web/releases/latest/download/nexus-android.apk"
            >
              Download APK
            </a>
            <a
              className={styles.secondaryLink}
              href="https://github.com/NielsdaWheelz/nexus-web/releases/latest/download/nexus-android.apk.sha256"
            >
              View SHA-256 checksum
            </a>
          </div>
          <p className={styles.fallback}>
            If the direct download does not start, open the{" "}
            <a href="https://github.com/NielsdaWheelz/nexus-web/releases/latest">
              latest GitHub release
            </a>
            .
          </p>
        </div>
        <div className={styles.card} aria-label="Android install summary">
          <span className={styles.cardLabel}>Release install</span>
          <strong>APK sideload</strong>
          <p>
            Built for people who want the hosted Nexus web app inside a small
            Android shell.
          </p>
        </div>
      </section>

      <section className={styles.grid} aria-label="Installation details">
        <div className={styles.panel}>
          <h2>How to install</h2>
          <ol>
            <li>Download the APK on your Android device.</li>
            <li>Open the downloaded file.</li>
            <li>
              If Android asks, allow installs from your browser or file manager.
            </li>
            <li>Confirm the install, then open Nexus.</li>
          </ol>
        </div>
        <div className={styles.panel}>
          <h2>What this app is</h2>
          <p>
            The APK is a thin shell around the hosted Nexus web app. Ordinary
            web updates are delivered from the server and do not require APK
            updates.
          </p>
          <p>
            Install a new APK only when the Android shell itself changes, such
            as app-link, WebView, or file handling behavior.
          </p>
        </div>
      </section>

      <p className={styles.returnLink}>
        <Link href="/login">Return to sign in</Link>
      </p>
    </main>
  );
}
