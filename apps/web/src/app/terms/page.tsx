import type { Metadata } from "next";
import Link from "next/link";
import styles from "../legal.module.css";

export const metadata: Metadata = {
  title: "Terms of Service | Nexus",
  description: "Terms governing use of the Nexus product and workspace.",
};

export default function TermsPage() {
  return (
    <main className={styles.page}>
      <div className={styles.shell}>
        <Link className={styles.backLink} href="/login">
          Return to sign in
        </Link>

        <article className={styles.card}>
          <p className={styles.eyebrow}>Nexus</p>
          <h1 className={styles.title}>Terms of Service</h1>
          <p className={styles.meta}>Last updated March 22, 2026.</p>
          <p className={styles.sectionBody}>
            These Terms of Service govern your access to and use of Nexus. By using
            Nexus, you agree to these terms.
          </p>

          <section className={styles.section}>
            <h2 className={styles.sectionTitle}>Acceptable use</h2>
            <p className={styles.sectionBody}>
              Do not use Nexus to violate the law, infringe the rights of others,
              attempt unauthorized access, interfere with service operation, or upload
              harmful or abusive content.
            </p>
          </section>

          <section className={styles.section}>
            <h2 className={styles.sectionTitle}>Your account and content</h2>
            <p className={styles.sectionBody}>
              You are responsible for maintaining access to your Google or GitHub login
              and for activity that occurs through your account.
            </p>
            <p className={styles.sectionBody}>
              You remain responsible for the content you upload, store, or generate in
              Nexus and for ensuring you have the rights needed to use that content.
            </p>
          </section>

          <section className={styles.section}>
            <h2 className={styles.sectionTitle}>Service changes</h2>
            <p className={styles.sectionBody}>
              Nexus may change, suspend, or discontinue features at any time. We may
              also suspend or terminate access to protect the service, enforce these
              terms, or comply with legal requirements.
            </p>
          </section>

          <section className={styles.section}>
            <h2 className={styles.sectionTitle}>Disclaimers</h2>
            <p className={styles.sectionBody}>
              Nexus is provided on an as-is and as-available basis. To the maximum
              extent allowed by law, we disclaim warranties of merchantability, fitness
              for a particular purpose, and non-infringement.
            </p>
          </section>

          <section className={styles.section}>
            <h2 className={styles.sectionTitle}>Questions</h2>
            <p className={styles.sectionBody}>
              Questions about these terms should be sent to the support contact listed
              for your Nexus deployment or on the associated sign-in and consent
              screens.
            </p>
          </section>
        </article>
      </div>
    </main>
  );
}
