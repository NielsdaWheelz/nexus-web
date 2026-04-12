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

import { useEffect, useState, useCallback } from "react";
import { apiFetch, isApiError } from "@/lib/api/client";
import SectionCard from "@/components/ui/SectionCard";
import StateMessage from "@/components/ui/StateMessage";
import StatusPill from "@/components/ui/StatusPill";
import { AppList, AppListItem } from "@/components/ui/AppList";
import styles from "./page.module.css";

interface ApiKey {
  id: string;
  provider: string;
  key_fingerprint: string;
  status: "untested" | "valid" | "invalid" | "revoked";
  created_at: string;
  last_tested_at: string | null;
}

export default function SettingsKeysPaneBody() {
  const [keys, setKeys] = useState<ApiKey[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [provider, setProvider] = useState("openai");
  const [apiKey, setApiKey] = useState("");
  const [formError, setFormError] = useState<string | null>(null);
  const [formSuccess, setFormSuccess] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

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

  const handleSubmit = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      setFormError(null);
      setFormSuccess(null);
      setSubmitting(true);

      try {
        await apiFetch("/api/keys", {
          method: "POST",
          body: JSON.stringify({ provider, api_key: apiKey }),
        });
        setFormSuccess(`Key for ${provider} saved.`);
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
        setSubmitting(false);
      }
    },
    [provider, apiKey, fetchKeys]
  );

  const handleRevoke = useCallback(
    async (keyId: string) => {
      try {
        await apiFetch(`/api/keys/${keyId}`, { method: "DELETE" });
        await fetchKeys();
      } catch (err) {
        console.error("Failed to revoke key:", err);
      }
    },
    [fetchKeys]
  );

  return (
    <SectionCard>
      <div className={styles.content}>
        <form className={styles.form} onSubmit={handleSubmit}>
          <div className={styles.formRow}>
            <div className={styles.formField}>
              <label className={styles.formLabel} htmlFor="provider">
                Provider
              </label>
              <select
                id="provider"
                className={styles.providerSelect}
                value={provider}
                onChange={(e) => setProvider(e.target.value)}
                disabled={submitting}
              >
                <option value="openai">OpenAI</option>
                <option value="anthropic">Anthropic</option>
                <option value="gemini">Gemini</option>
                <option value="deepseek">DeepSeek</option>
              </select>
            </div>

            <div className={styles.formFieldWide}>
              <label className={styles.formLabel} htmlFor="apiKey">
                API Key
              </label>
              <input
                id="apiKey"
                type="password"
                className={styles.keyInput}
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                placeholder="sk-..."
                autoComplete="off"
                disabled={submitting}
              />
            </div>

            <button
              type="submit"
              className={styles.submitBtn}
              disabled={submitting || !apiKey.trim()}
            >
              {submitting ? "Saving..." : "Save"}
            </button>
          </div>

          {formError && <StateMessage variant="error">{formError}</StateMessage>}
          {formSuccess && <StateMessage variant="success">{formSuccess}</StateMessage>}
        </form>

        {loading && <StateMessage variant="loading">Loading...</StateMessage>}
        {error && <StateMessage variant="error">{error}</StateMessage>}

        {!loading && keys.length === 0 && (
          <StateMessage variant="empty">No API keys configured yet.</StateMessage>
        )}

        {keys.length > 0 && (
          <AppList>
            {keys.map((key) => (
              <AppListItem
                key={key.id}
                title={key.provider}
                description={`...${key.key_fingerprint}`}
                meta={
                  key.last_tested_at
                    ? `tested ${new Date(key.last_tested_at).toLocaleDateString()}`
                    : "never tested"
                }
                trailing={
                  <StatusPill
                    variant={
                      key.status === "valid" ? "success"
                        : key.status === "untested" ? "warning"
                        : key.status === "invalid" ? "danger"
                        : "neutral"
                    }
                  >
                    {key.status}
                  </StatusPill>
                }
                actions={
                  key.status !== "revoked" ? (
                    <button
                      type="button"
                      className={styles.revokeBtn}
                      onClick={() => handleRevoke(key.id)}
                    >
                      Revoke
                    </button>
                  ) : null
                }
              />
            ))}
          </AppList>
        )}
      </div>
    </SectionCard>
  );
}
