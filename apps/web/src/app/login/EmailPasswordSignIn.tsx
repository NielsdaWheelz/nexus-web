"use client";

import Link from "next/link";
import { useState, useTransition, type FormEvent } from "react";
import Button from "@/components/ui/Button";
import { FeedbackNotice } from "@/components/feedback/Feedback";
import { signInWithPasswordAction } from "@/lib/auth/password-actions";
import styles from "./page.module.css";

export default function EmailPasswordSignIn({
  nextPath,
}: {
  nextPath?: string;
}) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    startTransition(async () => {
      const result = await signInWithPasswordAction({
        email,
        password,
        nextPath,
      });
      if (!result.ok) {
        setError(result.error);
      }
    });
  }

  return (
    <form className={styles.passwordForm} onSubmit={handleSubmit}>
      {error ? (
        <FeedbackNotice severity="error" title={error} />
      ) : null}

      <label className={styles.field}>
        <span className={styles.fieldLabel}>Email</span>
        <input
          className={styles.fieldInput}
          name="email"
          type="email"
          autoComplete="email"
          required
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          disabled={pending}
        />
      </label>

      <label className={styles.field}>
        <span className={styles.fieldLabel}>Password</span>
        <input
          className={styles.fieldInput}
          name="password"
          type="password"
          autoComplete="current-password"
          required
          minLength={12}
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          disabled={pending}
        />
      </label>

      <Button variant="primary" size="lg" type="submit" loading={pending}>
        Sign in
      </Button>

      <Link className={styles.legalLink} href="/sign-up">
        Create account
      </Link>
    </form>
  );
}
