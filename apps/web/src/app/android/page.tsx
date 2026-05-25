import type { Metadata } from "next";
import Link from "next/link";
import AsterismMark from "@/components/AsterismMark";
import Button from "@/components/ui/Button";
import styles from "./page.module.css";

export const metadata: Metadata = {
  title: "Nexus for Android",
  description: "Download the Nexus Android APK.",
};

const RELEASE_URL =
  "https://github.com/NielsdaWheelz/nexus-web/releases/latest";
const APK_URL = `${RELEASE_URL}/download/nexus-android.apk`;
const CHECKSUM_URL = `${APK_URL}.sha256`;

export default function AndroidPage() {
  return (
    <div className={styles.container}>
      <main className={styles.frame}>
        <header className={styles.heading}>
          <AsterismMark size={40} className={styles.headingMark} aria-hidden="true" />
          <h1 className={styles.wordmark}>Nexus</h1>
          <p className={styles.subhead}>Android</p>
        </header>

        <Button asChild variant="primary" size="lg">
          <a href={APK_URL}>Download APK</a>
        </Button>

        <p className={styles.links}>
          <a className={styles.link} href={CHECKSUM_URL}>
            Checksum
          </a>
          <span aria-hidden="true">·</span>
          <a className={styles.link} href={RELEASE_URL}>
            Releases
          </a>
        </p>

        <p className={styles.returnLink}>
          <Link href="/login">Sign in</Link>
        </p>
      </main>
    </div>
  );
}
