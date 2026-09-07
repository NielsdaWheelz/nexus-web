import type { Metadata } from "next";
import Link from "next/link";
import EntryCanvas from "@/components/EntryCanvas";
import type { GenerationApiProvider } from "@/lib/conversations/generationCatalog";
import { PRODUCT_NAME } from "@/lib/productIdentity";
import styles from "../legal.module.css";

const CONFIGURABLE_PROVIDER_PROCESSORS = {
  openai: "OpenAI",
  anthropic: "Anthropic",
  gemini: "Google",
  moonshot: "Moonshot AI",
  openrouter: "OpenRouter",
  deepseek: "DeepSeek",
  xai: "xAI",
} satisfies Readonly<Record<GenerationApiProvider, string>>;
const CONFIGURABLE_PROCESSOR_NAMES = Object.values(
  CONFIGURABLE_PROVIDER_PROCESSORS,
);
const CONFIGURABLE_PROCESSOR_LIST = `${CONFIGURABLE_PROCESSOR_NAMES.slice(0, -1).join(", ")}, and ${CONFIGURABLE_PROCESSOR_NAMES.at(-1)}`;

export const metadata: Metadata = {
  title: `Privacy Policy · ${PRODUCT_NAME}`,
  description:
    "How Nexus collects, uses, and safeguards account and workspace data.",
  robots: { index: false, follow: true, noarchive: true },
};

export default function PrivacyPage() {
  return (
    <EntryCanvas>
      <article className={styles.article}>
        <h1>Privacy Policy</h1>
        <p>Last updated September 1, 2026.</p>
        <p>
          This Privacy Policy explains how Nexus collects, uses, and protects
          information when you sign in, upload content, and use the product.
        </p>

        <h2>Information we collect</h2>
        <p>
          We collect account information needed to operate the service,
          including your email address and, if you use Google or GitHub, the
          provider account identifier and basic profile details returned by that
          provider. Email-and-password credentials are used only to authenticate
          you; Supabase Auth stores the password hash, and Nexus does not
          persist your password.
        </p>
        <p>
          We also collect the content you choose to store or generate in Nexus,
          including documents, media, notes, and highlights, plus technical logs
          needed for security, reliability, and abuse prevention.
        </p>

        <h2>How we use information</h2>
        <p>
          We use this information to authenticate you, provision and operate
          your workspace, secure the service, troubleshoot issues, and improve
          product quality.
        </p>
        <p>
          AI-powered features send the content submitted for a run through the
          processor chain disclosed for its generation route. Background
          generation and Codex Personal Chat use the operator-managed
          ChatGPT/Codex subscription and OpenAI Codex. If you select a configured
          Provider API route in Chat, Nexus instead uses the operator-managed API
          credential for that provider. Configurable Provider API processors are
          {` ${CONFIGURABLE_PROCESSOR_LIST}. `}OpenRouter also uses the pinned
          upstream provider disclosed in Chat.
          Before dispatch, Chat shows the selected route&apos;s processor chain,
          retention, training, and billing disclosures.
        </p>

        <h2>How information is shared</h2>
        <p>
          We share information only with the service providers needed to run
          Nexus, such as hosting, authentication, storage, database, and other
          infrastructure providers, or when disclosure is required by law or
          needed to protect the service and its users.
        </p>

        <h2>Retention and control</h2>
        <p>
          We retain information while your account is active and for as long as
          needed to operate the service, resolve disputes, enforce agreements,
          and comply with legal obligations. You can stop using Nexus at any
          time and request account or content deletion from the operator who
          provided access.
        </p>

        <h2>Questions</h2>
        <p>
          Questions about this policy should be sent to the operator who
          provided access.
        </p>

        <p>
          <Link className={styles.returnAction} href="/login">
            Return to sign in
          </Link>
        </p>
      </article>
    </EntryCanvas>
  );
}
