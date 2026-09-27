const base = requiredEnv("INSTALLER_DISPATCHER_URL").replace(/\/$/, "");
const token = requiredEnv("NEXUS_PRIVATE_SOURCE_TOKEN");
const jobId = requiredEnv("JOB_ID");
const origin = "https://arefgh72.github.io";

try {
  const statusResponse = await fetch(`${base}/api/status?job_id=${encodeURIComponent(jobId)}`, {
    headers: { Origin: origin }
  });
  const status = await statusResponse.json().catch(() => null);
  if (status?.state === "complete" || status?.state === "failed") process.exit(0);

  await fetch(`${base}/internal/progress`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      Origin: origin,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      job_id: jobId,
      state: "failed",
      stage: "failed",
      message: "The installer workflow failed before it could finish. Check the GitHub Actions run details."
    })
  });
} catch {
  // Preserve the original Actions failure if status reporting is unavailable.
}

function requiredEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

