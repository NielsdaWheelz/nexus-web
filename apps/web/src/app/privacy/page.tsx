import type { Metadata } from "next";
import Link from "next/link";
import styles from "../legal.module.css";

export const metadata: Metadata = {
  title: "Privacy Policy | Nexus",
  description: "How Nexus collects, uses, and safeguards account and workspace data.",
};

export default function PrivacyPage() {
  return (
    <main className={styles.page}>
      <div className={styles.shell}>
        <Link className={styles.backLink} href="/login">
          Return to sign in
        </Link>

        <article className={styles.card}>
          <p className={styles.eyebrow}>Nexus</p>
          <h1 className={styles.title}>Privacy Policy</h1>
          <p className={styles.meta}>Last updated March 22, 2026.</p>
          <p className={styles.sectionBody}>
            This Privacy Policy explains how Nexus collects, uses, and protects
            information when you sign in, upload content, and use the product.
          </p>

          <section className={styles.section}>
            <h2 className={styles.sectionTitle}>Information we collect</h2>
            <p className={styles.sectionBody}>
              We collect account information needed to operate the service, including
              Google and GitHub sign-in information such as your email address,
              provider account identifier, and basic profile details returned by the
              provider.
            </p>
            <p className={styles.sectionBody}>
              We also collect the content you choose to store or generate in Nexus,
              including documents, media, notes, and highlights, plus
              technical logs needed for security, reliability, and abuse prevention.
            </p>
          </section>

          <section className={styles.section}>
            <h2 className={styles.sectionTitle}>How we use information</h2>
            <p className={styles.sectionBody}>
              We use this information to authenticate you, provision and operate your
              workspace, secure the service, troubleshoot issues, and improve product
              quality.
            </p>
            <p className={styles.sectionBody}>
              If you use AI-powered features, the content submitted to those features
              may be processed by the third-party model providers configured for Nexus
              so the requested feature can function.
            </p>
          </section>

          <section className={styles.section}>
            <h2 className={styles.sectionTitle}>How information is shared</h2>
            <p className={styles.sectionBody}>
              We share information only with the service providers needed to run Nexus,
              such as hosting, authentication, storage, database, and other
              infrastructure providers, or when disclosure is required by law or needed
              to protect the service and its users.
            </p>
          </section>

          <section className={styles.section}>
            <h2 className={styles.sectionTitle}>Retention and control</h2>
            <p className={styles.sectionBody}>
              We retain information while your account is active and for as long as
              needed to operate the service, resolve disputes, enforce agreements, and
              comply with legal obligations. You can stop using Nexus at any time and
              request account or content deletion through the support contact provided
              with your deployment.
            </p>
          </section>

          <section className={styles.section}>
            <h2 className={styles.sectionTitle}>Questions</h2>
            <p className={styles.sectionBody}>
              Questions about this policy should be sent to the support contact listed
              for your Nexus deployment or on the associated sign-in and consent
              screens.
            </p>
          </section>
        </article>
      </div>
    </main>
  );
}
