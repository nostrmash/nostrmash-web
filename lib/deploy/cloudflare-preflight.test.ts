import { describe, expect, it, vi } from "vitest";

import {
  bucketNameFromWranglerConfig,
  classifyWranglerOutput,
  inspectCloudflareCredentials,
  runLiveChecks,
  sanitizeCommandOutput,
} from "./cloudflare-preflight";

const ACCOUNT = "a".repeat(32);
const TOKEN = "cf-token-value-not-a-real-secret-012345";

describe("Cloudflare deploy preflight", () => {
  it("names each missing credential and does not start OAuth", () => {
    const result = inspectCloudflareCredentials({});
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.kind).toBe("missing_credentials");
    expect(result.names).toEqual(["CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID"]);
    expect(result.message).toContain("not an application build failure");
    expect(result.message).toContain("Interactive OAuth will not be started");
    expect(result.message).not.toContain(TOKEN);
  });

  it("rejects a short token and a non-account id without printing them", () => {
    const result = inspectCloudflareCredentials({
      CLOUDFLARE_API_TOKEN: "short-token",
      CLOUDFLARE_ACCOUNT_ID: "not-an-account",
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.names).toEqual(["CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID"]);
    expect(result.message).not.toContain("short-token");
    expect(result.message).not.toContain("not-an-account");
  });

  it("accepts a token and a 32-character account id", () => {
    expect(
      inspectCloudflareCredentials({
        CLOUDFLARE_API_TOKEN: TOKEN,
        CLOUDFLARE_ACCOUNT_ID: ACCOUNT,
      })
    ).toEqual({ ok: true, accountId: ACCOUNT });
  });

  it("reads only the incremental-cache bucket", () => {
    const source = `{
      "r2_buckets": [
        { "binding": "OTHER", "bucket_name": "other-bucket" },
        { "binding": "NEXT_INC_CACHE_R2_BUCKET", "bucket_name": "nostrmash-web-opennext-cache" }
      ]
    }`;
    expect(bucketNameFromWranglerConfig(source)).toBe("nostrmash-web-opennext-cache");
  });

  it("classifies OAuth, authentication, permission, and missing bucket output", () => {
    expect(classifyWranglerOutput("Attempting to login via OAuth...")).toBe("interactive_oauth");
    expect(classifyWranglerOutput("Authentication error [code: 10000]")).toBe("authentication");
    expect(classifyWranglerOutput("A request to the Cloudflare API failed: not authorized")).toBe(
      "permission"
    );
    expect(classifyWranglerOutput("The specified bucket does not exist")).toBe("missing_resource");
  });

  it("redacts secret values and email addresses", () => {
    const output = sanitizeCommandOutput(`token ${TOKEN} for admin@example.com`, [TOKEN]);
    expect(output).not.toContain(TOKEN);
    expect(output).not.toContain("admin@example.com");
    expect(output).toContain("[redacted]");
  });

  it("stops when whoami would open a browser", async () => {
    const run = vi.fn(async () => ({
      code: 1,
      output: "Attempting to login via OAuth...\nhttps://dash.cloudflare.com/oauth2/auth",
    }));
    const result = await runLiveChecks({
      env: { CLOUDFLARE_API_TOKEN: TOKEN, CLOUDFLARE_ACCOUNT_ID: ACCOUNT },
      run,
      bucketName: "nostrmash-web-opennext-cache",
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.kind).toBe("interactive_oauth");
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("refuses a whoami result that does not contain the configured account", async () => {
    const run = vi.fn(async () => ({
      code: 0,
      output: "Account ID  bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    }));
    const result = await runLiveChecks({
      env: { CLOUDFLARE_API_TOKEN: TOKEN, CLOUDFLARE_ACCOUNT_ID: ACCOUNT },
      run,
      bucketName: "nostrmash-web-opennext-cache",
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.kind).toBe("account_mismatch");
  });

  it("reports a missing cache bucket without creating one", async () => {
    const run = vi.fn(async (args: string[]) => {
      if (args[0] === "whoami") {
        return { code: 0, output: `Account ID ${ACCOUNT}` };
      }
      return { code: 1, output: "The specified bucket does not exist" };
    });
    const result = await runLiveChecks({
      env: { CLOUDFLARE_API_TOKEN: TOKEN, CLOUDFLARE_ACCOUNT_ID: ACCOUNT },
      run,
      bucketName: "nostrmash-web-opennext-cache",
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.kind).toBe("missing_resource");
    expect(result.message).toContain("does not create it");
    expect(run.mock.calls.some((call) => call[0]?.includes("create"))).toBe(false);
  });

  it("passes when whoami matches the account and the bucket exists", async () => {
    const run = vi.fn(async (args: string[]) => {
      if (args[0] === "whoami") return { code: 0, output: `Account ID ${ACCOUNT}` };
      return { code: 0, output: "name: nostrmash-web-opennext-cache" };
    });
    await expect(
      runLiveChecks({
        env: { CLOUDFLARE_API_TOKEN: TOKEN, CLOUDFLARE_ACCOUNT_ID: ACCOUNT },
        run,
        bucketName: "nostrmash-web-opennext-cache",
      })
    ).resolves.toEqual({ ok: true });
  });
});
