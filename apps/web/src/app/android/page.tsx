import type { Metadata } from "next";
import Link from "next/link";
import AsterismMark from "@/components/AsterismMark";
import EntryCanvas from "@/components/EntryCanvas";
import Button from "@/components/ui/Button";
import { ANDROID_RELEASE_LINKS } from "@/lib/androidReleaseLinks";
import { PRODUCT_DESCRIPTOR, PRODUCT_NAME } from "@/lib/productIdentity";
import styles from "./page.module.css";

export const metadata: Metadata = {
  title: "Nexus for Android",
  description: "Private Android distribution for Nexus.",
  alternates: { canonical: "/android" },
  robots: { index: false, follow: true, noarchive: true },
};

export default function AndroidPage() {
  return (
    <EntryCanvas>
      <main className={styles.page}>
        <header className={styles.identity}>
          <AsterismMark
            size={48}
            className={styles.brandMark}
            aria-hidden="true"
          />
          <div className={styles.identityCopy}>
            <p className={styles.wordmark}>{PRODUCT_NAME}</p>
            <p className={styles.descriptor}>{PRODUCT_DESCRIPTOR}</p>
          </div>
        </header>

        <section
          className={styles.release}
          aria-labelledby="android-release-heading"
        >
          <div className={styles.introduction}>
            <p className={styles.eyebrow}>Private distribution</p>
            <h1 id="android-release-heading" className={styles.title}>
              Nexus for Android
            </h1>
            <p className={styles.support}>
              The first-party Android companion for your Nexus library.
            </p>
            <p id="android-release-access" className={styles.accessNote}>
              GitHub access is required to download this release.
            </p>
          </div>

          <Button
            asChild
            variant="primary"
            size="lg"
            className={styles.download}
          >
            <a
              href={ANDROID_RELEASE_LINKS.apk}
              aria-describedby="android-release-access"
            >
              Download APK
            </a>
          </Button>

          <section
            className={styles.verification}
            aria-labelledby="android-release-verification-heading"
          >
            <h2
              id="android-release-verification-heading"
              className={styles.verificationHeading}
            >
              Verify this release
            </h2>
            <p className={styles.verificationCopy}>
              Compare the APK&apos;s SHA-256 with the checksum. The release
              manifest records the source commit, signing-certificate fingerprint,
              and artifact digests accepted by the release gate.
            </p>
            <nav aria-label="Release verification">
              <ul className={styles.verificationLinks}>
                <li>
                  <a
                    className={styles.verificationLink}
                    href={ANDROID_RELEASE_LINKS.checksum}
                  >
                    SHA-256 checksum
                  </a>
                </li>
                <li>
                  <a
                    className={styles.verificationLink}
                    href={ANDROID_RELEASE_LINKS.manifest}
                  >
                    Release manifest
                  </a>
                </li>
                <li>
                  <a
                    className={styles.verificationLink}
                    href={ANDROID_RELEASE_LINKS.latestRelease}
                  >
                    View release on GitHub
                  </a>
                </li>
              </ul>
            </nav>
          </section>

          <p className={styles.installNote}>
            Android may ask you to allow installs from this browser. Only install
            Nexus from this page or its linked GitHub release.
          </p>

          <nav className={styles.returnNavigation} aria-label="Nexus">
            <Link className={styles.returnAction} href="/">
              Open Nexus
            </Link>
          </nav>
        </section>

        <footer className={styles.footer}>
          <nav className={styles.footerNavigation} aria-label="Legal">
            <Link className={styles.footerLink} href="/privacy">
              Privacy
            </Link>
            <Link className={styles.footerLink} href="/terms">
              Terms
            </Link>
          </nav>
        </footer>
      </main>
    </EntryCanvas>
  );
}
