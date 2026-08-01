function requiredExactHttpsOrigin(variable: string): string {
  const value = process.env[variable];
  if (!value) throw new Error(`${variable} is required for deployment smoke.`);
  const url = new URL(value);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  ) {
    throw new Error(`${variable} must be an exact HTTPS origin.`);
  }
  return url.origin;
}

function requiredEmailDomain(): string {
  const value = process.env.NEXUS_SMOKE_EMAIL_DOMAIN;
  if (!value || !/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/i.test(value)) {
    throw new Error("NEXUS_SMOKE_EMAIL_DOMAIN must be an exact email domain.");
  }
  return value.toLowerCase();
}

export interface DeploymentRuntime {
  appOrigin: string;
  mailboxOrigin: string;
  supabaseOrigin: string;
  emailDomain: string;
}

let cached: DeploymentRuntime | null = null;

export function loadDeploymentRuntime(): DeploymentRuntime {
  cached ??= {
    appOrigin: requiredExactHttpsOrigin("NEXUS_SMOKE_APP_URL"),
    mailboxOrigin: requiredExactHttpsOrigin("E2E_MAILBOX_URL"),
    supabaseOrigin: requiredExactHttpsOrigin("NEXUS_SMOKE_SUPABASE_URL"),
    emailDomain: requiredEmailDomain(),
  };
  return cached;
}
