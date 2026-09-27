import { readFile } from "node:fs/promises";

const apiBase = "https://api.cloudflare.com/client/v4";
const dispatcherUrl = requiredEnv("INSTALLER_DISPATCHER_URL").replace(/\/$/, "");
const actionToken = requiredEnv("NEXUS_PRIVATE_SOURCE_TOKEN");
const jobId = requiredEnv("JOB_ID");
const sourcePath = requiredEnv("PRIVATE_WORKER_SOURCE");
const workerName = "trendify-nexus";
const databaseName = "trendify-nexus";

let cloudflareToken = "";

async function progress(stage, state, message, panelUrl = null) {
  try {
    await fetch(`${dispatcherUrl}/internal/progress`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${actionToken}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ job_id: jobId, stage, state, message, panel_url: panelUrl })
    });
  } catch {
    // Status reporting must not hide the installer result.
  }
}

function maskSecret(value) {
  if (value) process.stdout.write(`::add-mask::${value}\n`);
}

async function claimCloudflareToken() {
  const response = await fetch(`${dispatcherUrl}/internal/claim`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${actionToken}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ job_id: jobId })
  });
  const data = await response.json().catch(() => null);
  if (!response.ok || data?.success !== true || typeof data.token !== "string") {
    throw new Error("Could not retrieve the temporary Cloudflare token. Start a new installation.");
  }
  return data.token;
}

async function cloudflare(path, method = "GET", body = undefined) {
  const response = await fetch(`${apiBase}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${cloudflareToken}`,
      ...(body === undefined ? {} : { "Content-Type": "application/json" })
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  });
  const data = await response.json().catch(() => null);
  if (!response.ok || data?.success !== true) {
    const detail = Array.isArray(data?.errors)
      ? data.errors.map(error => `${error.code ?? ""} ${error.message ?? ""}`.trim()).join("; ")
      : "Unexpected Cloudflare API response";
    throw new Error(`Cloudflare API failed (${response.status}): ${detail}`.replaceAll(cloudflareToken, "[redacted]").slice(0, 500));
  }
  return data.result;
}

async function setWorkerSecret(accountId, name, text) {
  await cloudflare(`/accounts/${accountId}/workers/scripts/${workerName}/secrets-bulk`, "PATCH", {
    secrets: { [name]: { name, type: "secret_text", text } }
  });
}

async function ensureDatabase(accountId) {
  const existing = await cloudflare(`/accounts/${accountId}/d1/database?name=${encodeURIComponent(databaseName)}&per_page=100`);
  const found = Array.isArray(existing) ? existing.find(database => database.name === databaseName) : null;
  if (found?.uuid) return found;
  return await cloudflare(`/accounts/${accountId}/d1/database`, "POST", { name: databaseName });
}

async function ensureWorkersSubdomain(accountId) {
  const current = await cloudflare(`/accounts/${accountId}/workers/subdomain`);
  if (current?.subdomain) return current.subdomain;
  const candidate = `nexus-${accountId.slice(0, 8)}`.toLowerCase();
  const created = await cloudflare(`/accounts/${accountId}/workers/subdomain`, "PUT", { subdomain: candidate });
  if (!created?.subdomain) throw new Error("Could not enable a workers.dev subdomain for this account.");
  return created.subdomain;
}

async function uploadPanel(accountId, databaseId, subdomain) {
  const source = await readFile(sourcePath, "utf8");
  const panelUrl = `https://${workerName}.${subdomain}.workers.dev`;
  const metadata = {
    main_module: "main.js",
    compatibility_date: "2026-09-27",
    observability: {
      enabled: true,
      logs: { enabled: true, invocation_logs: true, head_sampling_rate: 1, persist: true }
    },
    bindings: [
      { type: "d1", name: "DB", id: databaseId },
      { type: "plain_text", name: "NEXUS_D1_DATABASE_ID", text: databaseId },
      { type: "plain_text", name: "NEXUS_HOSTNAME", text: `${workerName}.${subdomain}.workers.dev` }
    ]
  };
  const form = new FormData();
  form.set("metadata", new Blob([JSON.stringify(metadata)], { type: "application/json" }), "metadata.json");
  form.set("main.js", new Blob([source], { type: "application/javascript+module" }), "main.js");
  const response = await fetch(`${apiBase}/accounts/${accountId}/workers/scripts/${workerName}`, {
    method: "PUT",
    headers: { Authorization: `Bearer ${cloudflareToken}` },
    body: form
  });
  const data = await response.json().catch(() => null);
  if (!response.ok || data?.success !== true) {
    const detail = Array.isArray(data?.errors) ? data.errors.map(error => error.message).join("; ") : "Worker upload failed";
    throw new Error(`Cloudflare could not deploy the Nexus Worker: ${detail}`.replaceAll(cloudflareToken, "[redacted]").slice(0, 500));
  }
  return panelUrl;
}

async function main() {
  try {
    await progress("validating_token", "running", "Validating Cloudflare token.");
    cloudflareToken = await claimCloudflareToken();
    maskSecret(cloudflareToken);

    const verification = await cloudflare("/user/tokens/verify");
    if (verification?.status !== "active") throw new Error("The Cloudflare token is inactive.");

    await progress("detecting_account", "running", "Finding the Cloudflare account.");
    const accounts = await cloudflare("/accounts?per_page=100");
    if (!Array.isArray(accounts) || accounts.length === 0 || !accounts[0]?.id) {
      throw new Error("This Cloudflare token has no accessible account.");
    }
    const account = accounts[0];
    await progress("detecting_account", "running", `Using Cloudflare account ${account.name || account.id}.`);

    await progress("creating_database", "running", "Creating or reusing the Nexus D1 database.");
    const database = await ensureDatabase(account.id);
    if (!database?.uuid) throw new Error("Cloudflare did not return the Nexus D1 database ID.");

    await progress("deploying_worker", "running", "Deploying the private Nexus Worker source.");
    const subdomain = await ensureWorkersSubdomain(account.id);
    const panelUrl = await uploadPanel(account.id, database.uuid, subdomain);

    await progress("setting_secrets", "running", "Adding Cloudflare credentials to the panel Worker secrets.");
    await setWorkerSecret(account.id, "CF_TOKEN", cloudflareToken);
    await setWorkerSecret(account.id, "CF_ACCOUNT_ID", account.id);
    await progress("enabling_workers_dev", "running", "Enabling the panel workers.dev address.");
    await cloudflare(`/accounts/${account.id}/workers/scripts/${workerName}/subdomain`, "POST", {
      enabled: true,
      previews_enabled: false
    });

    await progress("initializing_database", "running", "Initializing the panel database.");
    const setupResponse = await fetch(`${panelUrl}/api/auth/setup-status`, { redirect: "error" });
    const setupStatus = await setupResponse.json().catch(() => null);
    if (!setupResponse.ok || setupStatus?.success !== true || typeof setupStatus.setup_required !== "boolean") {
      throw new Error("The deployed panel did not pass its database initialization check.");
    }

    await progress("complete", "complete", "Nexus is ready. Open the panel to create its administrator account.", panelUrl);
    process.stdout.write(`Panel deployed: ${panelUrl}\n`);
  } catch (error) {
    const safeMessage = String(error?.message || "Installation failed").replaceAll(cloudflareToken, "[redacted]").slice(0, 400);
    await progress("failed", "failed", safeMessage);
    process.stderr.write(`${safeMessage}\n`);
    process.exitCode = 1;
  } finally {
    cloudflareToken = "";
  }
}

function requiredEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

await main();

