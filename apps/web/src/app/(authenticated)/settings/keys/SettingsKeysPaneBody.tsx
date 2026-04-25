/**
 * API Keys management page (BYOK).
 *
 * Security constraints (binding per s3_pr07 §7.3):
 * - Never console.log form state containing the api key.
 * - On submit success or failure, explicitly clear the input state.
 * - Mark input autoComplete="off".
 * - Never store api keys in localStorage.
 * - Key input value exists only in component state during form lifecycle.
 */

"use client";

import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import { apiFetch, isApiError } from "@/lib/api/client";
import StateMessage from "@/components/ui/StateMessage";
import StatusPill from "@/components/ui/StatusPill";
import styles from "./page.module.css";

type ApiKeyStatus = "missing" | "untested" | "valid" | "invalid" | "revoked";

interface ApiKey {
  id: string | null;
  provider: string;
  provider_display_name: string;
  fingerprint: string | null;
  key_fingerprint: string | null;
  status: ApiKeyStatus;
  created_at: string | null;
  last_tested_at: string | null;
  last_used_at: string | null;
}

const PROVIDER_ORDER = ["openai", "anthropic", "gemini", "deepseek"] as const;

const PROVIDER_META = {
  openai: { label: "OpenAI", placeholder: "sk-..." },
  anthropic: { label: "Anthropic", placeholder: "sk-ant-..." },
  gemini: { label: "Google", placeholder: "AIza..." },
  deepseek: { label: "DeepSeek", placeholder: "sk-..." },
} as const;

type EditState = {
  provider: string;
  mode: "connect" | "replace";
} | null;

function statusVariant(status: ApiKeyStatus) {
  if (status === "valid") return "success";
  if (status === "untested") return "warning";
  if (status === "invalid") return "danger";
  return "neutral";
}

function formatDate(value: string | null | undefined): string {
  if (!value) return "Never";

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Never";

  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(date);
}

function providerSortRank(provider: string): number {
  const index = PROVIDER_ORDER.findIndex((item) => item === provider);
  return index === -1 ? PROVIDER_ORDER.length : index;
}

function providerLabel(provider: string, key?: ApiKey): string {
  if (key?.provider_display_name) return key.provider_display_name;
  return PROVIDER_META[provider as keyof typeof PROVIDER_META]?.label ?? provider;
}

function providerPlaceholder(provider: string): string {
  return PROVIDER_META[provider as keyof typeof PROVIDER_META]?.placeholder ?? "sk-...";
}

function statusLabel(status: ApiKeyStatus): string {
  return status === "missing" ? "not connected" : status;
}

export default function SettingsKeysPaneBody() {
  const [keys, setKeys] = useState<ApiKey[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<EditState>(null);
  const [apiKey, setApiKey] = useState("");
  const [formError, setFormError] = useState<string | null>(null);
  const [formSuccess, setFormSuccess] = useState<string | null>(null);
  const [busyProvider, setBusyProvider] = useState<string | null>(null);

  const providerStates = useMemo(() => {
    return [...keys].sort((a, b) => {
      const rankDelta = providerSortRank(a.provider) - providerSortRank(b.provider);
      if (rankDelta !== 0) return rankDelta;
      return a.provider.localeCompare(b.provider);
    });
  }, [keys]);

  const fetchKeys = useCallback(async () => {
    try {
      const response = await apiFetch<{ data: ApiKey[] }>("/api/keys");
      setKeys(response.data);
      setError(null);
    } catch (err) {
      if (isApiError(err)) {
        setError(err.message);
      } else {
        setError("Failed to load keys");
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchKeys();
  }, [fetchKeys]);

  const openEditor = useCallback((provider: string, mode: "connect" | "replace") => {
    setEditing({ provider, mode });
    setApiKey("");
    setFormError(null);
    setFormSuccess(null);
  }, []);

  const closeEditor = useCallback(() => {
    setEditing(null);
    setApiKey("");
    setFormError(null);
  }, []);

  const handleSubmit = useCallback(
    async (e: FormEvent) => {
      e.preventDefault();
      if (!editing) return;

      const provider = editing.provider;
      setFormError(null);
      setFormSuccess(null);
      setBusyProvider(provider);

      try {
        await apiFetch("/api/keys", {
          method: "POST",
          body: JSON.stringify({ provider, api_key: apiKey }),
        });
        setFormSuccess(`${providerLabel(provider)} key saved.`);
        setEditing(null);
        await fetchKeys();
      } catch (err) {
        if (isApiError(err)) {
          setFormError(err.message);
        } else {
          setFormError("Failed to save key");
        }
      } finally {
        // SECURITY: always clear key input regardless of success/failure
        setApiKey("");
        setBusyProvider(null);
      }
    },
    [apiKey, editing, fetchKeys]
  );

  const handleRevoke = useCallback(
    async (key: ApiKey) => {
      if (!key.id) return;

      setFormError(null);
      setFormSuccess(null);
      setBusyProvider(key.provider);
      try {
        await apiFetch(`/api/keys/${key.id}`, { method: "DELETE" });
        await fetchKeys();
        setFormSuccess(`${providerLabel(key.provider, key)} key revoked.`);
      } catch (err) {
        if (isApiError(err)) {
          setFormError(err.message);
        } else {
          setFormError("Failed to revoke key");
        }
      } finally {
        setBusyProvider(null);
      }
    },
    [fetchKeys]
  );

  const handleTest = useCallback(
    async (key: ApiKey) => {
      if (!key.id) {
        setFormError(`Connect ${providerLabel(key.provider, key)} before testing.`);
        return;
      }

      setFormError(null);
      setFormSuccess(null);
      setBusyProvider(key.provider);
      try {
        await apiFetch(`/api/keys/${key.id}/test`, { method: "POST" });
        await fetchKeys();
        setFormSuccess(`${providerLabel(key.provider, key)} key tested.`);
      } catch (err) {
        if (isApiError(err)) {
          setFormError(err.message);
        } else {
          setFormError("Failed to test key");
        }
      } finally {
        setBusyProvider(null);
      }
    },
    [fetchKeys]
  );

  return (
    <div className={styles.content}>
      <div className={styles.header}>
        <div>
          <h2 className={styles.title}>API keys</h2>
          <p className={styles.subtitle}>
            Connect provider keys without storing plaintext in the browser.
          </p>
        </div>
      </div>

      <div className={styles.messages}>
        {loading && <StateMessage variant="loading">Loading...</StateMessage>}
        {error && <StateMessage variant="error">{error}</StateMessage>}
        {formError && <StateMessage variant="error">{formError}</StateMessage>}
        {formSuccess && <StateMessage variant="success">{formSuccess}</StateMessage>}
      </div>

      {!loading && !error && providerStates.length === 0 && (
        <StateMessage variant="empty">No providers are enabled.</StateMessage>
      )}

      <div className={styles.providerGrid}>
        {providerStates.map((key) => {
          const hasSavedKey = Boolean(
            key.id && key.status !== "missing" && key.status !== "revoked"
          );
          const isEditing = editing?.provider === key.provider;
          const isBusy = busyProvider === key.provider;
          const rawFingerprint = key.key_fingerprint ?? key.fingerprint;
          const fingerprint = rawFingerprint ? `...${rawFingerprint}` : "Not connected";
          const label = providerLabel(key.provider, key);

          return (
            <section
              key={key.provider}
              className={styles.providerCard}
              data-provider-card={key.provider}
              aria-labelledby={`provider-${key.provider}`}
            >
              <div className={styles.providerCardHeader}>
                <div>
                  <h3 id={`provider-${key.provider}`} className={styles.providerName}>
                    {label}
                  </h3>
                  <p className={styles.fingerprint}>{fingerprint}</p>
                </div>
                <StatusPill variant={statusVariant(key.status)}>
                  {statusLabel(key.status)}
                </StatusPill>
              </div>

              <dl className={styles.metaGrid}>
                <div>
                  <dt>Status</dt>
                  <dd>{statusLabel(key.status)}</dd>
                </div>
                <div>
                  <dt>Fingerprint</dt>
                  <dd>{fingerprint}</dd>
                </div>
                <div>
                  <dt>Last tested</dt>
                  <dd>{formatDate(key.last_tested_at)}</dd>
                </div>
                <div>
                  <dt>Last used</dt>
                  <dd>{formatDate(key.last_used_at)}</dd>
                </div>
              </dl>

              {isEditing ? (
                <form className={styles.inlineForm} onSubmit={handleSubmit}>
                  <label className={styles.formLabel} htmlFor={`apiKey-${key.provider}`}>
                    API key
                  </label>
                  <div className={styles.inlineFormRow}>
                    <input
                      id={`apiKey-${key.provider}`}
                      type="password"
                      className={styles.keyInput}
                      value={apiKey}
                      onChange={(e) => setApiKey(e.target.value)}
                      placeholder={providerPlaceholder(key.provider)}
                      autoComplete="off"
                      disabled={isBusy}
                    />
                    <button
                      type="submit"
                      className={styles.primaryBtn}
                      disabled={isBusy || !apiKey.trim()}
                    >
                      {isBusy ? "Saving..." : editing.mode === "replace" ? "Replace" : "Connect"}
                    </button>
                    <button
                      type="button"
                      className={styles.secondaryBtn}
                      onClick={closeEditor}
                      disabled={isBusy}
                    >
                      Cancel
                    </button>
                  </div>
                </form>
              ) : (
                <div className={styles.actions}>
                  {hasSavedKey ? (
                    <>
                      <button
                        type="button"
                        className={styles.secondaryBtn}
                        onClick={() => handleTest(key)}
                        disabled={isBusy}
                      >
                        {isBusy ? "Testing..." : "Test"}
                      </button>
                      <button
                        type="button"
                        className={styles.secondaryBtn}
                        onClick={() => openEditor(key.provider, "replace")}
                        disabled={isBusy}
                      >
                        Replace
                      </button>
                      <button
                        type="button"
                        className={styles.dangerBtn}
                        onClick={() => handleRevoke(key)}
                        disabled={isBusy}
                      >
                        {isBusy ? "Revoking..." : "Revoke"}
                      </button>
                    </>
                  ) : (
                    <button
                      type="button"
                      className={styles.primaryBtn}
                      onClick={() => openEditor(key.provider, "connect")}
                      disabled={isBusy}
                    >
                      Connect
                    </button>
                  )}
                </div>
              )}
            </section>
          );
        })}
      </div>
    </div>
  );
}
