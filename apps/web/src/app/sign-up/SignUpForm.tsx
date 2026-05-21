"use client";

import Link from "next/link";
import { useState, useTransition, type FormEvent } from "react";
import Button from "@/components/ui/Button";
import {
  FeedbackNotice,
  type FeedbackContent,
} from "@/components/feedback/Feedback";
import { signUpWithPasswordAction } from "@/lib/auth/password-actions";
import styles from "./page.module.css";

export default function SignUpForm() {
  const [displayName, setDisplayName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    startTransition(async () => {
      const result = await signUpWithPasswordAction({
        email,
        password,
        displayName,
      });
      if (!result?.ok) {
        setError(result.error);
      }
    });
  }

  const errorFeedback: FeedbackContent | null = error
    ? { severity: "error", title: error }
    : null;

  return (
    <div className={styles.container}>
      <section className={styles.card}>
        <h1 className={styles.title}>Create your account</h1>

        {errorFeedback ? <FeedbackNotice feedback={errorFeedback} /> : null}

        <form className={styles.form} onSubmit={handleSubmit}>
          <label className={styles.field}>
            <span className={styles.label}>Display name</span>
            <input
              className={styles.input}
              name="display_name"
              type="text"
              autoComplete="name"
              required
              minLength={1}
              maxLength={80}
              value={displayName}
              onChange={(event) => setDisplayName(event.target.value)}
              disabled={isPending}
            />
          </label>

          <label className={styles.field}>
            <span className={styles.label}>Email</span>
            <input
              className={styles.input}
              name="email"
              type="email"
              autoComplete="email"
              required
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              disabled={isPending}
            />
          </label>

          <label className={styles.field}>
            <span className={styles.label}>Password</span>
            <input
              className={styles.input}
              name="password"
              type="password"
              autoComplete="new-password"
              required
              minLength={12}
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              disabled={isPending}
            />
          </label>

          <Button
            type="submit"
            variant="primary"
            size="lg"
            loading={isPending}
          >
            Create account
          </Button>
        </form>

        <p className={styles.footer}>
          <Link className={styles.footerLink} href="/login">
            Already have an account? Sign in
          </Link>
        </p>
      </section>
    </div>
  );
}
