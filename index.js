const API_BASE = "https://api.cloudflare.com/client/v4";
const SOURCE_REPOSITORY = "Arefgh72/trendify-nexus-private";
const PANEL_VERSIONS = {
  "v1.0.0": {
    sourcePath: "v1.0.0/main.js"
  },
  "v2.0.0": {
    sourcePath: "v2.0.0/main.js"
  },
  "v3.0.0": {
    sourcePath: "v3.0.0/main.js"
  }
};
const COMPATIBILITY_DATE = "2026-09-27";
const MAX_REQUEST_BYTES = 8192;
const textDecoder = new TextDecoder();

function randomHex(length = 16) {
  const bytes = new Uint8Array(Math.ceil(length / 2));
  crypto.getRandomValues(bytes);

  return Array.from(bytes, byte => byte.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, length);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const origin = request.headers.get("Origin") || "";
    const cors = corsHeaders(origin, env.ALLOWED_ORIGIN);

    if (request.method === "OPTIONS") {
      return origin === env.ALLOWED_ORIGIN
        ? new Response(null, { status: 204, headers: cors })
        : json({ success: false, error: "Origin not allowed." }, 403, cors);
    }

    if (url.pathname === "/health" && request.method === "GET") {
      return json({ success: true, status: "online" }, 200, cors);
    }

    if (origin !== env.ALLOWED_ORIGIN) {
      return json({ success: false, error: "Origin not allowed." }, 403, cors);
    }

    if (url.pathname !== "/install") {
      return json({ success: false, error: "Not found." }, 404, cors);
    }

    if (request.method !== "POST") {
      return json({ success: false, error: "Method not allowed." }, 405, cors);
    }

    if (!env.PRIVATE_REPO_TOKEN) {
      return json({ success: false, error: "Private source access is not configured." }, 503, cors);
    }

    let cloudflareToken = "";
    try {
      const body = await readJsonBounded(request, MAX_REQUEST_BYTES);
      cloudflareToken = typeof body?.token === "string" ? body.token.trim() : "";
      const requestedVersion = typeof body?.version === "string" ? body.version.trim() : "v1.0.0";
      const panelVersion = PANEL_VERSIONS[requestedVersion];
      if (!panelVersion) {
        throw httpError("Choose a supported panel version.", 400);
      }
      if (cloudflareToken.length < 20 || cloudflareToken.length > 4096) {
        throw httpError("Enter a valid Cloudflare API token.", 400);
      }

      const result = await installPanel(cloudflareToken, env, requestedVersion, panelVersion);
      return json({ success: true, ...result }, 200, cors);
    } catch (error) {
      const message = safeMessage(error, cloudflareToken);
      return json({ success: false, error: message }, error?.httpStatus || 500, cors);
    } finally {
      cloudflareToken = "";
    }
  }
};

async function installPanel(token, env, version, panelVersion) {
  const verification = await cloudflare(token, "/user/tokens/verify");
  if (verification?.status !== "active") {
    throw httpError("The Cloudflare API token is inactive.", 401);
  }

  const accounts = await cloudflare(token, "/accounts?per_page=100");
  if (!Array.isArray(accounts) || accounts.length === 0 || !accounts[0]?.id) {
    throw httpError("The token has no accessible Cloudflare account.", 403);
  }

  const account = accounts[0];
  const source = await fetchPrivatePanelSource(env.PRIVATE_REPO_TOKEN, panelVersion.sourcePath);
  const workerName = randomHex(16);
  const databaseName = randomHex(16);

  // Names are random and never reused, so a database created by a failed
  // install would otherwise sit in the account forever. Every free plan
  // account only gets 10 of them, so the database is removed again when a
  // later step fails.
  let database = null;
  let workerDeployed = false;

  try {
    database = await ensureDatabase(token, account.id, databaseName);
    const subdomain = await ensureWorkersSubdomain(token, account.id);
    const panelUrl = "https://" + workerName + "." + subdomain + ".workers.dev";
    await uploadPanel(token, account.id, database.uuid, subdomain, source, workerName);
    workerDeployed = true;
    await setPanelSecrets(token, account.id, token, account.id, workerName);
    await enableWorkersDev(token, account.id, workerName);
    const setupCheck = await verifyPanel(panelUrl);

    return {
      version,
      account: {
        id: account.id,
        name: account.name || "Cloudflare account"
      },
      database: {
        id: database.uuid,
        name: databaseName
      },
      worker: {
        name: workerName,
        url: panelUrl,
        setupCheck
      }
    };
  } catch (error) {
    if (workerDeployed) {
      await deleteWorkerQuietly(token, account.id, workerName);
    }

    if (database && database.uuid) {
      await deleteDatabaseQuietly(token, account.id, database.uuid);
    }

    throw error;
  }
}

// Best-effort cleanup helpers: the original failure is what the user needs to
// see, so a cleanup problem is only logged.
async function deleteWorkerQuietly(token, accountId, workerName) {
  try {
    await cloudflare(
      token,
      "/accounts/" + accountId + "/workers/scripts/" + workerName + "?force=true",
      "DELETE"
    );
  } catch (error) {
    console.log("Could not remove the failed panel Worker " + workerName + ": " + (error?.message || String(error)));
  }
}

async function deleteDatabaseQuietly(token, accountId, databaseId) {
  try {
    await cloudflare(
      token,
      "/accounts/" + accountId + "/d1/database/" + databaseId,
      "DELETE"
    );
  } catch (error) {
    console.log("Could not remove the orphaned D1 database " + databaseId + ": " + (error?.message || String(error)));
  }
}

async function fetchPrivatePanelSource(privateRepoToken, sourcePath) {
  const githubToken = typeof privateRepoToken === "string" ? privateRepoToken.trim() : "";
  if (!githubToken) {
    throw httpError("Private source access is not configured.", 503);
  }

  const url = "https://api.github.com/repos/" + SOURCE_REPOSITORY +
    "/contents/" + sourcePath + "?ref=main";
  const response = await fetch(url, {
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: "Bearer " + githubToken,
      "User-Agent": "Trendify-Nexus-Installer",
      "X-GitHub-Api-Version": "2022-11-28"
    }
  });
  const data = await response.json().catch(() => null);
  if (!response.ok) {
    const githubMessage = typeof data?.message === "string"
      ? data.message.replaceAll(githubToken, "[redacted]").slice(0, 240)
      : "GitHub returned no error details.";
    const remaining = response.headers.get("x-ratelimit-remaining");
    const reset = response.headers.get("x-ratelimit-reset");
    const retryAfter = response.headers.get("retry-after");
    const rateLimitDetails = remaining === "0"
      ? "; GitHub rate limit exhausted" + (reset ? " (reset Unix time: " + reset + ")" : "")
      : retryAfter
        ? "; GitHub asked the client to retry after " + retryAfter + " seconds"
        : "";
    throw httpError(
      "GitHub private source request failed (" + response.status + "): " + githubMessage + rateLimitDetails,
      502
    );
  }
  if (typeof data?.content !== "string" || data.encoding !== "base64") {
    throw httpError("GitHub returned an unexpected response for " + sourcePath + " in " + SOURCE_REPOSITORY + ".", 502);
  }

  const decoded = atob(data.content.replace(/\s/g, ""));
  const bytes = Uint8Array.from(decoded, character => character.charCodeAt(0));
  const source = textDecoder.decode(bytes);
  if (!source.includes("export default")) {
    throw httpError("The private repository did not return a valid panel Worker module.", 502);
  }
  return source;
}

async function ensureDatabase(token, accountId, databaseName) {
  const query = new URLSearchParams({ name: databaseName, per_page: "100" });
  const listPath = "/accounts/" + accountId + "/d1/database?" + query.toString();
  const list = await cloudflare(token, listPath);
  const existing = Array.isArray(list) ? list.find(item => item.name === databaseName) : null;
  if (existing?.uuid) return existing;

  try {
    return await cloudflare(token, "/accounts/" + accountId + "/d1/database", "POST", {
      name: databaseName
    });
  } catch (error) {
    // Reuse a database created by a concurrent installer request.
    const refreshed = await cloudflare(token, listPath);
    const createdElsewhere = Array.isArray(refreshed)
      ? refreshed.find(item => item.name === databaseName)
      : null;
    if (createdElsewhere?.uuid) return createdElsewhere;
    throw error;
  }
}

async function ensureWorkersSubdomain(token, accountId) {
  let existing = null;
  try {
    existing = await cloudflare(token, "/accounts/" + accountId + "/workers/subdomain");
  } catch (error) {
    if (error?.httpStatus !== 404) throw error;
  }
  if (existing?.subdomain) return existing.subdomain;

  const candidate = "nexus-" + accountId.slice(0, 8).toLowerCase();
  const created = await cloudflare(
    token,
    "/accounts/" + accountId + "/workers/subdomain",
    "PUT",
    { subdomain: candidate }
  );
  if (!created?.subdomain) {
    throw httpError("Cloudflare did not return a workers.dev subdomain.", 502);
  }
  return created.subdomain;
}

async function uploadPanel(token, accountId, databaseId, subdomain, source, workerName) {
  const hostname = workerName + "." + subdomain + ".workers.dev";
  const metadata = {
    main_module: "main.js",
    compatibility_date: COMPATIBILITY_DATE,
    bindings: [
      // database_id is the current D1 binding field; the older id field is
      // deprecated and rejected by Cloudflare schema validation.
      { type: "d1", name: "DB", database_id: databaseId },
      { type: "plain_text", name: "NEXUS_D1_DATABASE_ID", text: databaseId },
      { type: "plain_text", name: "NEXUS_HOSTNAME", text: hostname }
    ]
  };

  const form = new FormData();
  form.set("metadata", new Blob([JSON.stringify(metadata)], { type: "application/json" }), "metadata.json");
  form.set("main.js", new Blob([source], { type: "application/javascript+module" }), "main.js");

  const response = await fetch(
    API_BASE + "/accounts/" + accountId + "/workers/scripts/" + workerName,
    {
      method: "PUT",
      headers: { Authorization: "Bearer " + token },
      body: form
    }
  );
  await readCloudflareResponse(response, token, "Panel Worker deployment failed");
}

async function setPanelSecrets(apiToken, accountId, cloudflareToken, accountIdValue, workerName) {
  const secrets = {
    CF_TOKEN: {
      name: "CF_TOKEN",
      type: "secret_text",
      text: cloudflareToken
    },
    CF_ACCOUNT_ID: {
      name: "CF_ACCOUNT_ID",
      type: "secret_text",
      text: accountIdValue
    }
  };

  await cloudflare(
    apiToken,
    "/accounts/" + accountId + "/workers/scripts/" + workerName + "/secrets-bulk",
    "PATCH",
    { secrets }
  );
}

async function enableWorkersDev(token, accountId, workerName) {
  await cloudflare(
    token,
    "/accounts/" + accountId + "/workers/scripts/" + workerName + "/subdomain",
    "POST",
    { enabled: true, previews_enabled: false }
  );
}

async function verifyPanel(panelUrl) {
  const attempts = 8;
  let lastResult = { reachable: false, status: null, detail: "No response received." };

  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const response = await fetch(panelUrl + "/api/auth/setup-status", {
        redirect: "error",
        headers: { Accept: "application/json" }
      });
      const data = await response.json().catch(() => null);

      if (response.ok && data?.success === true && typeof data.setup_required === "boolean") {
        return {
          reachable: true,
          attempts: attempt,
          setupRequired: data.setup_required
        };
      }

      lastResult = {
        reachable: false,
        status: response.status,
        detail: typeof data?.error === "string"
          ? data.error.slice(0, 200)
          : "The setup-status endpoint did not return the expected JSON response."
      };
    } catch (error) {
      lastResult = {
        reachable: false,
        status: null,
        detail: String(error?.message || "Network or workers.dev startup error.").slice(0, 200)
      };
    }

    if (attempt < attempts) {
      await new Promise(resolve => setTimeout(resolve, 1500));
    }
  }

  // Deployment and workers.dev activation succeeded. Return the URL anyway so
  // the installer can show it; a failed immediate health check must not hide it.
  return { ...lastResult, attempts };
}

async function cloudflare(token, path, method = "GET", body = undefined) {
  const response = await fetch(API_BASE + path, {
    method,
    headers: {
      Authorization: "Bearer " + token,
      ...(body === undefined ? {} : { "Content-Type": "application/json" })
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  });
  return await readCloudflareResponse(response, token, "Cloudflare API request failed");
}

async function readCloudflareResponse(response, token, fallback) {
  const data = await response.json().catch(() => null);
  if (!response.ok || data?.success !== true) {
    const details = Array.isArray(data?.errors)
      ? data.errors.map(item => item.message || "").filter(Boolean).join("; ")
      : "";
    const message = (details || fallback).replaceAll(token, "[redacted]").slice(0, 400);
    throw httpError(message, response.status);
  }
  return data.result;
}

async function readJsonBounded(request, maximumBytes) {
  const declaredLength = Number(request.headers.get("Content-Length") || 0);
  if (declaredLength > maximumBytes || !request.body) {
    throw httpError("Invalid or oversized request.", 400);
  }

  const reader = request.body.getReader();
  const chunks = [];
  let total = 0;
  while (true) {
    const part = await reader.read();
    if (part.done) break;
    total += part.value.byteLength;
    if (total > maximumBytes) {
      await reader.cancel();
      throw httpError("Request is too large.", 413);
    }
    chunks.push(part.value);
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(textDecoder.decode(bytes));
  } catch {
    throw httpError("Request body must be valid JSON.", 400);
  }
}

function corsHeaders(origin, allowedOrigin) {
  const headers = new Headers({
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
    "Cache-Control": "no-store",
    "Vary": "Origin"
  });
  if (origin && origin === allowedOrigin) {
    headers.set("Access-Control-Allow-Origin", origin);
  }
  return headers;
}

function json(value, status, headers) {
  headers.set("Content-Type", "application/json; charset=utf-8");
  return new Response(JSON.stringify(value), { status, headers });
}

function httpError(message, httpStatus) {
  const error = new Error(message);
  error.httpStatus = httpStatus;
  return error;
}

function safeMessage(error, token) {
  const message = String(error?.message || "Installation failed.");
  return token ? message.replaceAll(token, "[redacted]").slice(0, 400) : message.slice(0, 400);
}