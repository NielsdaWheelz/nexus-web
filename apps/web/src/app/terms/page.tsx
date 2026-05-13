import type { Metadata } from "next";
import Link from "next/link";
import styles from "../legal.module.css";

export const metadata: Metadata = {
  title: "Terms of Service | Nexus",
  description: "Terms governing use of the Nexus product and workspace.",
};

export default function TermsPage() {
  return (
    <article className={styles.article}>
      <h1>Terms of Service</h1>
      <p>Last updated March 22, 2026.</p>
      <p>
        These Terms of Service govern your access to and use of Nexus. By using
        Nexus, you agree to these terms.
      </p>

      <h2>Acceptable use</h2>
      <p>
        Do not use Nexus to violate the law, infringe the rights of others,
        attempt unauthorized access, interfere with service operation, or upload
        harmful or abusive content.
      </p>

      <h2>Your account and content</h2>
      <p>
        You are responsible for maintaining access to your Google or GitHub login
        and for activity that occurs through your account.
      </p>
      <p>
        You remain responsible for the content you upload, store, or generate in
        Nexus and for ensuring you have the rights needed to use that content.
      </p>

      <h2>Service changes</h2>
      <p>
        Nexus may change, suspend, or discontinue features at any time. We may
        also suspend or terminate access to protect the service, enforce these
        terms, or comply with legal requirements.
      </p>

      <h2>Disclaimers</h2>
      <p>
        Nexus is provided on an as-is and as-available basis. To the maximum
        extent allowed by law, we disclaim warranties of merchantability, fitness
        for a particular purpose, and non-infringement.
      </p>

      <h2>Questions</h2>
      <p>
        Questions about these terms should be sent to the support contact listed
        for your Nexus deployment or on the associated sign-in and consent
        screens.
      </p>

      <p>
        <Link href="/login">Return to sign in</Link>
      </p>
    </article>
  );
}
