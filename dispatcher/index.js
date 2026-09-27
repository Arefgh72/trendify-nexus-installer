const JOB_TTL_SECONDS = 24 * 60 * 60;
const TOKEN_TTL_SECONDS = 20 * 60;
const RATE_TTL_SECONDS = 60;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin") || "";
    const cors = corsHeaders(origin, env.ALLOWED_ORIGIN);
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: cors });
    }
    if (origin !== env.ALLOWED_ORIGIN) {
      return json({ success: false, error: "Origin not allowed" }, 403, cors);
    }
    if (!env.JOBS || !env.GITHUB_TOKEN) {
      return json({ success: false, error: "Installer dispatcher is not configured" }, 503, cors);
    }

    try {
      if (url.pathname === "/api/install" && request.method === "POST") {
        return await startInstall(request, env, cors);
      }
      if (url.pathname === "/api/status" && request.method === "GET") {
        return await getStatus(url, env, cors);
      }
      if (url.pathname === "/internal/claim" && request.method === "POST") {
        if (!await authorized(request, env)) return json({ success: false, error: "Unauthorized" }, 401);
        return await claimJob(request, env);
      }
      if (url.pathname === "/internal/progress" && request.method === "POST") {
        if (!await authorized(request, env)) return json({ success: false, error: "Unauthorized" }, 401);
        return await updateProgress(request, env);
      }
      return json({ success: false, error: "Not found" }, 404, cors);
    } catch {
      return json({ success: false, error: "Installer request failed" }, 500, cors);
    }
  }
};

async function startInstall(request, env, cors) {
  const ip = request.headers.get("CF-Connecting-IP") || "unknown";
  const rateKey = `rate:${await digestHex(ip)}`;
  if (await env.JOBS.get(rateKey)) {
    return json({ success: false, error: "Please wait a minute before starting another installation." }, 429, cors);
  }
  await env.JOBS.put(rateKey, "1", { expirationTtl: RATE_TTL_SECONDS });

  const body = await readJsonBounded(request, 8192);
  const token = typeof body.token === "string" ? body.token.trim() : "";
  if (token.length < 20 || token.length > 4096) {
    return json({ success: false, error: "Enter a valid Cloudflare API token." }, 400, cors);
  }

  const verify = await fetch("https://api.cloudflare.com/client/v4/user/tokens/verify", {
    headers: { Authorization: `Bearer ${token}` }
  });
  const verifyData = await verify.json().catch(() => null);
  if (!verify.ok || verifyData?.success !== true || verifyData?.result?.status !== "active") {
    return json({ success: false, error: "The Cloudflare API token is invalid or inactive." }, 400, cors);
  }

  const jobId = crypto.randomUUID();
  const encryptedToken = await encryptToken(token, env.GITHUB_TOKEN);
  await env.JOBS.put(`token:${jobId}`, JSON.stringify(encryptedToken), { expirationTtl: TOKEN_TTL_SECONDS });
  await env.JOBS.put(`job:${jobId}`, JSON.stringify({
    success: true,
    state: "queued",
    stage: "validating_token",
    message: "Token verified; waiting for the installer workflow.",
    panel_url: null
  }), { expirationTtl: JOB_TTL_SECONDS });

  const dispatch = await fetch("https://api.github.com/repos/Arefgh72/trendify-nexus-installer/actions/workflows/install.yml/dispatches", {
    method: "POST",
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${env.GITHUB_TOKEN}`,
      "X-GitHub-Api-Version": "2022-11-28",
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ ref: "main", inputs: { job_id: jobId } })
  });

  if (!dispatch.ok) {
    await env.JOBS.delete(`token:${jobId}`);
    await env.JOBS.put(`job:${jobId}`, JSON.stringify({
      success: true, state: "failed", stage: "validating_token",
      message: "GitHub could not start the installer workflow.", panel_url: null
    }), { expirationTtl: JOB_TTL_SECONDS });
    return json({ success: false, error: "Could not start the installer. Please try again later." }, 502, cors);
  }

  return json({ success: true, job_id: jobId }, 202, cors);
}

async function getStatus(url, env, cors) {
  const jobId = url.searchParams.get("job_id") || "";
  if (!/^[0-9a-f-]{36}$/i.test(jobId)) {
    return json({ success: false, error: "Invalid installation id" }, 400, cors);
  }
  const value = await env.JOBS.get(`job:${jobId}`);
  if (!value) return json({ success: false, error: "Installation status expired" }, 404, cors);
  return json(JSON.parse(value), 200, cors);
}

async function claimJob(request, env) {
  const body = await readJsonBounded(request, 2048);
  const jobId = typeof body.job_id === "string" ? body.job_id : "";
  if (!/^[0-9a-f-]{36}$/i.test(jobId)) return json({ success: false, error: "Invalid job id" }, 400);
  const key = `token:${jobId}`;
  const encrypted = await env.JOBS.get(key);
  if (!encrypted) return json({ success: false, error: "Installation token expired or already claimed" }, 410);
  const token = await decryptToken(JSON.parse(encrypted), env.GITHUB_TOKEN);
  await env.JOBS.delete(key);
  await putJob(env, jobId, { state: "running", stage: "validating_token", message: "Installer started.", panel_url: null });
  return json({ success: true, token });
}

async function updateProgress(request, env) {
  const body = await readJsonBounded(request, 4096);
  const jobId = typeof body.job_id === "string" ? body.job_id : "";
  if (!/^[0-9a-f-]{36}$/i.test(jobId)) return json({ success: false, error: "Invalid job id" }, 400);
  const stages = new Set([
    "validating_token", "detecting_account", "creating_database", "deploying_worker",
    "setting_secrets", "initializing_database", "enabling_workers_dev", "complete", "failed"
  ]);
  const states = new Set(["running", "complete", "failed"]);
  if (!stages.has(body.stage) || !states.has(body.state)) return json({ success: false, error: "Invalid progress update" }, 400);
  const message = typeof body.message === "string" ? body.message.slice(0, 180) : "Working";
  const panelUrl = body.state === "complete" && typeof body.panel_url === "string" && /^https:\/\/[a-z0-9-]+\.[a-z0-9-]+\.workers\.dev\/?$/i.test(body.panel_url)
    ? body.panel_url
    : null;
  await putJob(env, jobId, { state: body.state, stage: body.stage, message, panel_url: panelUrl });
  return json({ success: true });
}

async function putJob(env, jobId, data) {
  await env.JOBS.put(`job:${jobId}`, JSON.stringify({ success: true, ...data }), { expirationTtl: JOB_TTL_SECONDS });
}

async function authorized(request, env) {
  const supplied = request.headers.get("Authorization") || "";
  const expected = `Bearer ${env.GITHUB_TOKEN}`;
  const [left, right] = await Promise.all([digestBytes(supplied), digestBytes(expected)]);
  let difference = left.length ^ right.length;
  for (let i = 0; i < Math.max(left.length, right.length); i++) difference |= (left[i] || 0) ^ (right[i] || 0);
  return difference === 0;
}

async function encryptToken(token, secret) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(secret);
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, encoder.encode(token));
  return { iv: toBase64(iv), ciphertext: toBase64(new Uint8Array(ciphertext)) };
}

async function decryptToken(value, secret) {
  const key = await deriveKey(secret);
  const clear = await crypto.subtle.decrypt({ name: "AES-GCM", iv: fromBase64(value.iv) }, key, fromBase64(value.ciphertext));
  return decoder.decode(clear);
}

async function deriveKey(secret) {
  const material = await crypto.subtle.importKey("raw", encoder.encode(secret), "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey({
    name: "HKDF", hash: "SHA-256",
    salt: encoder.encode("trendify-nexus-installer-dispatcher-v1"),
    info: encoder.encode("temporary-cloudflare-token")
  }, material, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
}

async function digestBytes(value) {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(value)));
}

async function digestHex(value) {
  return [...await digestBytes(value)].map(byte => byte.toString(16).padStart(2, "0")).join("");
}

function toBase64(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function fromBase64(value) {
  return Uint8Array.from(atob(value), character => character.charCodeAt(0));
}

async function readJsonBounded(request, maxBytes) {
  const declared = Number(request.headers.get("Content-Length") || 0);
  if (declared > maxBytes) throw new Error("Request too large");
  if (!request.body) throw new Error("Missing request body");
  const reader = request.body.getReader();
  const chunks = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new Error("Request too large");
    }
    chunks.push(value);
  }
  const all = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { all.set(chunk, offset); offset += chunk.length; }
  return JSON.parse(decoder.decode(all));
}

function corsHeaders(origin, allowedOrigin) {
  const headers = new Headers({
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin"
  });
  if (origin && origin === allowedOrigin) headers.set("Access-Control-Allow-Origin", origin);
  return headers;
}

function json(value, status = 200, headers = new Headers()) {
  headers.set("Content-Type", "application/json; charset=utf-8");
  headers.set("Cache-Control", "no-store");
  return new Response(JSON.stringify(value), { status, headers });
}

