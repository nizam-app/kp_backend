/**
 * Full Stripe + billing API test suite.
 *
 *   npm run test:stripe          # fleet payer flow
 *   npm run test:stripe:company  # company payer flow
 *   npm run test:stripe:all      # fleet + company + mechanic + extras
 */

import "dotenv/config";

const BASE = (process.argv.find((a) => a.startsWith("--base="))?.split("=")[1] ||
  "http://127.0.0.1:5000/api/v1").replace(/\/$/, "");

const ROLE_ARG = process.argv.find((a) => a.startsWith("--role="))?.split("=")[1];
const RUN_ALL = process.argv.includes("--all") || process.argv.includes("all");

const CREDENTIALS = {
  fleet: { email: "fleet@truckfix.dev", password: "Password123!" },
  company: { email: "company@truckfix.dev", password: "Password123!" },
  mechanic: { email: "mechanic@truckfix.dev", password: "Password123!" },
};

const STRIPE_SECRET = process.env.STRIPE_SECRET_KEY || "";
const results = [];

const log = (label, payload) => {
  console.log(`\n=== ${label} ===`);
  console.log(typeof payload === "string" ? payload : JSON.stringify(payload, null, 2));
};

const track = (name, ok, detail = "") => {
  results.push({ name, ok, detail });
  console.log(ok ? `  ✓ ${name}` : `  ✗ ${name}${detail ? `: ${detail}` : ""}`);
};

const fail = (msg) => {
  console.error(`\nFAILED: ${msg}`);
  printSummary();
  process.exit(1);
};

async function api(method, path, { token, body } = {}) {
  const headers = { Accept: "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers["Content-Type"] = "application/json";

  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

  let json;
  try {
    json = await res.json();
  } catch {
    json = { message: await res.text() };
  }

  return { ok: res.ok, status: res.status, json };
}

async function stripeForm(path, body) {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(body)) {
    if (v !== undefined && v !== null) params.append(k, `${v}`);
  }

  const res = await fetch(`https://api.stripe.com/v1${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${STRIPE_SECRET}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: params.toString(),
  });

  const json = await res.json();
  if (!res.ok) {
    throw new Error(json?.error?.message || `Stripe ${path} failed (${res.status})`);
  }
  return json;
}

async function createStripeTestPaymentMethod() {
  return stripeForm("/payment_methods", {
    type: "card",
    "card[token]": "tok_visa",
  });
}

async function confirmSetupIntent(setupIntentId, paymentMethodId) {
  return stripeForm(`/setup_intents/${setupIntentId}/confirm`, {
    payment_method: paymentMethodId,
  });
}

async function findAwaitingJob(token, role) {
  const path = role === "company" ? "/company/jobs?page=1&limit=50" : "/jobs?page=1&limit=50";
  const jobs = await api("GET", path, { token });
  if (!jobs.ok || !Array.isArray(jobs.json?.data)) return null;
  return jobs.json.data.find((j) => j.status === "AWAITING_APPROVAL") || null;
}

async function runPayerFlow(role) {
  const cred = CREDENTIALS[role];
  if (!cred) fail(`Unknown role: ${role}`);

  log(`PAYER: ${role}`, cred.email);
  const login = await api("POST", "/auth/login", { body: cred });
  track(`${role} login`, login.ok, login.json?.message);
  if (!login.ok) fail(login.json?.message);
  const token = login.json?.data?.accessToken;

  const config = await api("GET", "/billing/stripe/config", { token });
  track(`${role} GET config`, config.ok && config.json?.data?.enabled);

  const setup = await api("POST", "/billing/stripe/setup-intent", { token, body: {} });
  track(`${role} setup-intent`, setup.ok);
  if (!setup.ok) fail(setup.json?.message);
  const { setupIntentId } = setup.json.data || {};

  if (!STRIPE_SECRET) fail("STRIPE_SECRET_KEY missing");

  const pm = await createStripeTestPaymentMethod();
  track(`${role} Stripe pm_ created`, Boolean(pm.id));
  if (setupIntentId) await confirmSetupIntent(setupIntentId, pm.id);

  const attach = await api("POST", "/billing/stripe/payment-methods/attach", {
    token,
    body: { paymentMethodId: pm.id, isDefault: true, setupIntentId },
  });
  track(`${role} attach`, attach.ok, attach.json?.message);
  if (!attach.ok) fail(attach.json?.message);
  const mongoMethodId = attach.json?.data?._id;

  const attachAgain = await api("POST", "/billing/stripe/payment-methods/attach", {
    token,
    body: { paymentMethodId: pm.id, isDefault: true },
  });
  track(`${role} attach idempotent (same pm_)`, attachAgain.ok, attachAgain.json?.message);

  const list = await api("GET", "/billing/payment-methods", { token });
  track(`${role} list methods`, list.ok && (list.json?.data?.length || 0) > 0);

  const def = await api("PATCH", `/billing/payment-methods/${mongoMethodId}/default`, {
    token,
    body: {},
  });
  track(`${role} set default`, def.ok);

  const awaiting = await findAwaitingJob(token, role);
  if (awaiting) {
    const approvePath =
      role === "company"
        ? `/company/jobs/${awaiting._id}/complete/approve`
        : `/jobs/${awaiting._id}/complete/approve`;
    const approve = await api("PATCH", approvePath, {
      token,
      body: { paymentMethodId: mongoMethodId },
    });
    const pi = approve.json?.data?.invoice?.payment?.stripePaymentIntentId;
    track(
      `${role} approve + charge (${awaiting.jobCode})`,
      approve.ok && approve.json?.data?.invoice?.payment?.status === "SUCCEEDED",
      approve.json?.message
    );

    if (pi) {
      const sync = await api("POST", `/billing/stripe/payment-intents/${pi}/sync`, { token });
      track(`${role} PI sync`, sync.ok, sync.json?.data?.paymentStatus);
    }
  } else {
    track(`${role} approve job (skipped)`, true, "no AWAITING_APPROVAL — run npm run seed:fake");
  }

  console.log("\n--- POSTMAN ---");
  console.log("Attach:", JSON.stringify({ paymentMethodId: pm.id, isDefault: true }, null, 2));
  console.log("Approve:", JSON.stringify({ paymentMethodId: mongoMethodId }, null, 2));
}

async function runMechanicFlow() {
  log("MECHANIC Connect", CREDENTIALS.mechanic.email);
  const login = await api("POST", "/auth/login", { body: CREDENTIALS.mechanic });
  track("mechanic login", login.ok);
  if (!login.ok) fail(login.json?.message);
  const token = login.json.data.accessToken;

  const acc = await api("GET", "/billing/stripe/mechanic-payout-account", { token });
  track("mechanic payout account", acc.ok, acc.json?.data?.status);

  const link = await api("POST", "/billing/stripe/mechanic-payout-account/onboarding-link", {
    token,
    body: {
      returnUrl: "http://localhost:5173/stripe/return",
      refreshUrl: "http://localhost:5173/stripe/refresh",
    },
  });
  track("mechanic onboarding link", link.ok);

  const dash = await api("POST", "/billing/stripe/mechanic-payout-account/dashboard-link", {
    token,
    body: {},
  });
  track(
    "mechanic dashboard link",
    dash.ok || dash.status === 400,
    dash.ok ? "ok" : dash.json?.message
  );
}

async function runFleetManualApprove() {
  const login = await api("POST", "/auth/login", { body: CREDENTIALS.fleet });
  if (!login.ok) return;
  const token = login.json.data.accessToken;
  const awaiting = await findAwaitingJob(token, "fleet");
  if (!awaiting) {
    track("fleet manual approve (skipped)", true, "no AWAITING_APPROVAL job left");
    return;
  }
  const approve = await api("PATCH", `/jobs/${awaiting._id}/complete/approve`, {
    token,
    body: { finalAmount: awaiting.acceptedAmount || awaiting.estimatedPayout || 100 },
  });
  track(
    `fleet manual approve (${awaiting.jobCode})`,
    approve.ok,
    approve.json?.message
  );
}

function printSummary() {
  console.log("\n========== SUMMARY ==========");
  const passed = results.filter((r) => r.ok).length;
  console.log(`${passed}/${results.length} checks passed`);
  for (const r of results) {
    console.log(`${r.ok ? "✓" : "✗"} ${r.name}${r.detail ? ` — ${r.detail}` : ""}`);
  }
}

async function main() {
  console.log(`Base: ${BASE}`);

  try {
    await fetch(BASE.replace("/api/v1", "/health"));
  } catch {
    fail(`Cannot reach ${BASE}. Run: npm run dev`);
  }

  if (RUN_ALL || !ROLE_ARG) {
    await runPayerFlow("fleet");
    await runPayerFlow("company");
    await runMechanicFlow();
    await runFleetManualApprove();
  } else if (ROLE_ARG === "mechanic") {
    await runMechanicFlow();
  } else {
    await runPayerFlow(ROLE_ARG);
    if (ROLE_ARG === "fleet") await runMechanicFlow();
  }

  printSummary();
  const failed = results.some((r) => !r.ok);
  if (failed) process.exit(1);
  console.log("\nAll payment API checks completed.");
}

main().catch((e) => fail(e.message));
