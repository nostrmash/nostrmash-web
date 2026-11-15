/**
 * Fail closed before Wrangler can start interactive OAuth.
 * The functions here never print credential values.
 */

export const CACHE_BUCKET_BINDING = "NEXT_INC_CACHE_R2_BUCKET";

export type CredentialProblem = {
  ok: false;
  kind: "missing_credentials" | "malformed_credentials";
  names: string[];
  message: string;
};

export type CredentialOk = {
  ok: true;
  accountId: string;
};

export type WranglerFailureKind =
  | "interactive_oauth"
  | "authentication"
  | "permission"
  | "missing_resource"
  | "account_mismatch"
  | "cloudflare_api";

export interface CommandResult {
  code: number | null;
  output: string;
}

type CommandRunner = (args: string[], env: CredentialEnv) => Promise<CommandResult>;

export type CredentialEnv = Record<string, string | undefined>;

function trimmed(env: CredentialEnv, name: string): string {
  return env[name]?.trim() ?? "";
}

export function inspectCloudflareCredentials(env: CredentialEnv): CredentialOk | CredentialProblem {
  const token = trimmed(env, "CLOUDFLARE_API_TOKEN");
  const accountId = trimmed(env, "CLOUDFLARE_ACCOUNT_ID");
  const missing: string[] = [];
  if (!token) missing.push("CLOUDFLARE_API_TOKEN");
  if (!accountId) missing.push("CLOUDFLARE_ACCOUNT_ID");
  if (missing.length > 0) {
    return {
      ok: false,
      kind: "missing_credentials",
      names: missing,
      message: [
        "Cloudflare deployment preflight failed before Wrangler ran.",
        "This is a missing-credential failure, not an application build failure.",
        `Missing: ${missing.join(", ")}.`,
        "Set both on the GitHub production environment. No other account will be selected.",
        "Interactive OAuth will not be started.",
      ].join(" "),
    };
  }

  const malformed: string[] = [];
  if (token.length < 20) malformed.push("CLOUDFLARE_API_TOKEN");
  if (!/^[a-f0-9]{32}$/i.test(accountId)) malformed.push("CLOUDFLARE_ACCOUNT_ID");
  if (token === accountId) {
    malformed.push("CLOUDFLARE_API_TOKEN");
    malformed.push("CLOUDFLARE_ACCOUNT_ID");
  }
  if (malformed.length > 0) {
    return {
      ok: false,
      kind: "malformed_credentials",
      names: [...new Set(malformed)],
      message: [
        "Cloudflare deployment preflight failed before Wrangler ran.",
        "This is a credential-format failure, not an application build failure.",
        `Check: ${[...new Set(malformed)].join(", ")}.`,
        "CLOUDFLARE_ACCOUNT_ID must be the 32-character account id.",
        "Secret values were not printed. Interactive OAuth will not be started.",
      ].join(" "),
    };
  }

  return { ok: true, accountId };
}

export function bucketNameFromWranglerConfig(source: string): string | null {
  const blocks = source.split(/\{/);
  for (const block of blocks) {
    if (!block.includes(CACHE_BUCKET_BINDING)) continue;
    const match = block.match(/"bucket_name"\s*:\s*"([^"]+)"/);
    if (match?.[1]) return match[1];
  }
  return null;
}

export function classifyWranglerOutput(output: string): WranglerFailureKind {
  const text = output.toLowerCase();
  if (
    text.includes("attempting to login via oauth") ||
    text.includes("timed out waiting for authorization") ||
    text.includes("oauth2/auth")
  ) {
    return "interactive_oauth";
  }
  if (
    text.includes("authentication error") ||
    text.includes("invalid access token") ||
    text.includes("invalid api token") ||
    text.includes("error 401") ||
    text.includes("code: 9109") ||
    text.includes("code: 10000")
  ) {
    return "authentication";
  }
  if (
    text.includes("permission") ||
    text.includes("not authorized") ||
    text.includes("error 403")
  ) {
    return "permission";
  }
  if (
    text.includes("not found") ||
    text.includes("does not exist") ||
    text.includes("code: 10006") ||
    text.includes("code: 10007")
  ) {
    return "missing_resource";
  }
  return "cloudflare_api";
}

export function sanitizeCommandOutput(output: string, secrets: string[]): string {
  let sanitized = output;
  for (const secret of secrets) {
    const value = secret.trim();
    if (value.length < 4) continue;
    sanitized = sanitized.split(value).join("[redacted]");
  }
  return sanitized
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[redacted-email]")
    .slice(0, 2000);
}

export function failureMessage(kind: WranglerFailureKind, detail: string): string {
  const lead: Record<WranglerFailureKind, string> = {
    interactive_oauth:
      "Wrangler tried to start interactive OAuth. CI stopped it. This is an authentication failure, not a build failure.",
    authentication:
      "Cloudflare rejected the API token. This is an authentication failure, not a build failure.",
    permission:
      "The API token is missing a permission required for this check. This is an authorization failure, not a build failure.",
    missing_resource:
      "The configured Cloudflare resource was not found in this account. This is not a build failure.",
    account_mismatch:
      "Wrangler did not confirm the configured account id. Refusing to use another account. This is not a build failure.",
    cloudflare_api:
      "Cloudflare API check failed after credentials were accepted. This is not an application build failure.",
  };
  return `${lead[kind]} ${detail}`.trim();
}

export async function runLiveChecks(input: {
  env: CredentialEnv;
  run: CommandRunner;
  bucketName: string | null;
}): Promise<{ ok: true } | { ok: false; kind: string; message: string }> {
  const credentials = inspectCloudflareCredentials(input.env);
  if (!credentials.ok) return credentials;
  if (!input.bucketName) {
    return {
      ok: false,
      kind: "config",
      message:
        "Could not read the OpenNext R2 cache bucket name from wrangler.jsonc. Deployment was not started.",
    };
  }

  const whoami = await input.run(["whoami"], input.env);
  const whoamiOutput = whoami.output;
  if (classifyWranglerOutput(whoamiOutput) === "interactive_oauth") {
    return {
      ok: false,
      kind: "interactive_oauth",
      message: failureMessage(
        "interactive_oauth",
        "Set CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID. Do not use wrangler login in CI."
      ),
    };
  }
  if (whoami.code !== 0) {
    const kind = classifyWranglerOutput(whoamiOutput);
    return {
      ok: false,
      kind,
      message: failureMessage(
        kind,
        sanitizeCommandOutput(whoamiOutput, [
          input.env.CLOUDFLARE_API_TOKEN ?? "",
          input.env.CLOUDFLARE_ACCOUNT_ID ?? "",
        ])
      ),
    };
  }
  if (!whoamiOutput.toLowerCase().includes(credentials.accountId.toLowerCase())) {
    return {
      ok: false,
      kind: "account_mismatch",
      message: failureMessage(
        "account_mismatch",
        "whoami succeeded but its output did not contain CLOUDFLARE_ACCOUNT_ID."
      ),
    };
  }

  const bucket = await input.run(["r2", "bucket", "info", input.bucketName], input.env);
  if (classifyWranglerOutput(bucket.output) === "interactive_oauth") {
    return {
      ok: false,
      kind: "interactive_oauth",
      message: failureMessage(
        "interactive_oauth",
        "The R2 check tried to log in with OAuth. Deployment was not started."
      ),
    };
  }
  if (bucket.code !== 0) {
    const kind = classifyWranglerOutput(bucket.output);
    const hint =
      kind === "missing_resource"
        ? `Create R2 bucket "${input.bucketName}" in this account before deploying. The preflight does not create it.`
        : kind === "permission"
          ? "The token needs Workers R2 Storage Edit for the cache bucket, in addition to Workers Editor."
          : "";
    return {
      ok: false,
      kind,
      message: failureMessage(
        kind,
        `${hint} ${sanitizeCommandOutput(bucket.output, [
          input.env.CLOUDFLARE_API_TOKEN ?? "",
          input.env.CLOUDFLARE_ACCOUNT_ID ?? "",
        ])}`.trim()
      ),
    };
  }

  return { ok: true };
}
