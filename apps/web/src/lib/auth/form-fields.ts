interface PasswordSignInForm {
  email: string;
  password: string;
  next: string | null;
}

interface PasswordRecoveryForm {
  email: string;
}

interface PasswordUpdateForm {
  password: string;
  next: string | null;
}

interface EmailConfirmationForm {
  tokenHash: string;
}

function parseExactStringFields(
  formData: FormData,
  required: readonly string[],
  optional: readonly string[] = [],
): Map<string, string> | null {
  const requiredKeys = new Set(required);
  const allowedKeys = new Set([...required, ...optional]);
  const fields = new Map<string, string>();

  for (const [key, value] of formData.entries()) {
    if (!allowedKeys.has(key) || typeof value !== "string" || fields.has(key)) {
      return null;
    }
    fields.set(key, value);
  }

  for (const key of requiredKeys) {
    if (!fields.has(key)) return null;
  }
  return fields;
}

export function parsePasswordSignInForm(
  formData: FormData,
): PasswordSignInForm | null {
  const fields = parseExactStringFields(
    formData,
    ["email", "password"],
    ["next"],
  );
  const email = fields?.get("email");
  const password = fields?.get("password");
  if (email === undefined || password === undefined) return null;
  return { email, password, next: fields?.get("next") ?? null };
}

export function parsePasswordRecoveryForm(
  formData: FormData,
): PasswordRecoveryForm | null {
  const fields = parseExactStringFields(formData, ["email"]);
  const email = fields?.get("email");
  return email === undefined ? null : { email };
}

export function parsePasswordUpdateForm(
  formData: FormData,
): PasswordUpdateForm | null {
  const fields = parseExactStringFields(formData, ["password"], ["next"]);
  const password = fields?.get("password");
  if (password === undefined) return null;
  return { password, next: fields?.get("next") ?? null };
}

export function parseEmailConfirmationForm(
  formData: FormData,
): EmailConfirmationForm | null {
  const fields = parseExactStringFields(formData, ["token_hash"]);
  const tokenHash = fields?.get("token_hash");
  return tokenHash === undefined ? null : { tokenHash };
}
