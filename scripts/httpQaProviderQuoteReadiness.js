/**
 * Group 5 — Optional HTTP smoke for unready quote submit.
 *
 * Env:
 *   API_BASE_URL   default http://127.0.0.1:8000/api/v1
 *   QA_EMAIL       default company@truckfix.dev
 *   QA_PASSWORD    default Password123!
 *
 * Prints status/code/message only — no tokens, emails, or job payloads.
 *
 * Usage:
 *   node scripts/httpQaProviderQuoteReadiness.js
 */
import dotenv from "dotenv";

dotenv.config();

const base = `${process.env.API_BASE_URL || "http://127.0.0.1:8000/api/v1"}`.replace(
  /\/$/,
  ""
);
const email = process.env.QA_EMAIL || "company@truckfix.dev";
const password = process.env.QA_PASSWORD || "Password123!";

const json = async (url, options = {}) => {
  const res = await fetch(url, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
  });
  let body = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  return { res, body };
};

const pass = (label) => console.log(`PASS  ${label}`);
const fail = (label, detail) => {
  console.error(`FAIL  ${label}${detail ? `: ${detail}` : ""}`);
  process.exitCode = 1;
};

async function run() {
  console.log(`HTTP QA against ${base}`);

  const login = await json(`${base}/auth/login`, {
    method: "POST",
    body: JSON.stringify({ email, password }),
  });
  if (!login.res.ok) {
    fail("login", `${login.res.status} ${login.body?.message || ""}`);
    return;
  }
  const token = login.body?.data?.accessToken;
  if (!token) {
    fail("login", "missing accessToken");
    return;
  }
  pass(`login (${login.body?.data?.user?.role || "role?"})`);

  const me = await json(`${base}/users/me`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const user = me.body?.data || me.body;
  const ready =
    user?.profileCompletion?.isComplete === true &&
    user?.payoutReadiness?.ready === true;
  console.log(
    `INFO  profileComplete=${Boolean(user?.profileCompletion?.isComplete)} payoutReady=${Boolean(user?.payoutReadiness?.ready)}`
  );
  if (ready) {
    fail("expected unready provider", "sampled account is fully ready");
    return;
  }
  pass("provider is unready");

  const feedPaths = [`${base}/company/feed?page=1&limit=5`, `${base}/jobs/feed?page=1&limit=5`];
  let jobId = null;
  for (const path of feedPaths) {
    const feed = await json(path, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!feed.res.ok) continue;
    const jobs =
      feed.body?.data?.jobs ||
      (Array.isArray(feed.body?.data) ? feed.body.data : []) ||
      [];
    if (jobs[0]?._id) {
      jobId = jobs[0]._id;
      break;
    }
  }

  if (!jobId) {
    console.log(
      "SKIP  no open job in feed — DB assert QA already covered PROVIDER_NOT_READY_TO_QUOTE"
    );
    return;
  }
  pass("found open job");

  const quote = await json(`${base}/jobs/${jobId}/quotes`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify({
      etaMinutes: 45,
      notes: "Group5 HTTP QA — expect 409",
      pricing: { estimatedLabourHours: 1, parts: [] },
    }),
  });

  const code = quote.body?.data?.code || quote.body?.code;
  const message = quote.body?.message || "";
  if (quote.res.status !== 409 || code !== "PROVIDER_NOT_READY_TO_QUOTE") {
    fail(
      "unready quote blocked",
      `status=${quote.res.status} code=${code} message=${message}`
    );
    return;
  }
  if (!/Complete your profile and payment setup before submitting quotes/.test(message)) {
    fail("English message", message);
    return;
  }
  pass("POST quote → 409 PROVIDER_NOT_READY_TO_QUOTE");
  console.log("\nHTTP QA complete.");
}

run().catch((err) => {
  console.error(err?.message || err);
  process.exit(1);
});
