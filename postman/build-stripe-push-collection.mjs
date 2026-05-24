/**
 * Generates TruckFix.Stripe-Push.postman_collection.json + environment.
 * Run: node postman/build-stripe-push-collection.mjs
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const DEFAULT_BASE_URL = "http://127.0.0.1:5000";
const RENDER_BASE_URL = "https://kp-backend-1.onrender.com";

const buildUrl = (pathname, queryList = []) => {
  const origin = DEFAULT_BASE_URL.replace(/\/+$/, "");
  const cleanPath = pathname.startsWith("/") ? pathname : `/${pathname}`;
  const pathSegments = ["api", "v1", ...cleanPath.split("/").filter(Boolean)];
  const queryArr = (queryList || [])
    .filter((q) => q?.key)
    .map((q) => ({ key: q.key, value: `${q.value ?? ""}` }));
  const qs =
    queryArr.length > 0
      ? `?${queryArr.map((q) => `${encodeURIComponent(q.key)}=${encodeURIComponent(q.value)}`).join("&")}`
      : "";
  const raw = `${origin}/api/v1${cleanPath}${qs}`;
  let parsed;
  try {
    parsed = new URL(origin);
  } catch {
    parsed = new URL("http://127.0.0.1:5000");
  }
  const out = {
    raw,
    protocol: parsed.protocol.replace(":", ""),
    host: parsed.hostname.includes(".")
      ? parsed.hostname.split(".")
      : [parsed.hostname],
    path: pathSegments,
  };
  if (parsed.port) out.port = parsed.port;
  if (queryArr.length) out.query = queryArr;
  return out;
};

const jsonBody = (obj) => ({
  mode: "raw",
  raw: JSON.stringify(obj, null, 2),
  options: { raw: { language: "json" } },
});

const authBearer = (v) => ({
  type: "bearer",
  bearer: [{ key: "token", value: v, type: "string" }],
});

const setVarScript = [
  "function setVar(key, val) {",
  "  if (val === undefined || val === null || val === '') return;",
  "  try { pm.environment.set(key, val); } catch (e) {}",
  "  try { pm.collectionVariables.set(key, val); } catch (e) {}",
  "}",
].join("\n");

const saveTokens = (access, refresh) =>
  [
    setVarScript,
    "const j = pm.response.json();",
    "const d = j && j.data ? j.data : j;",
    `if (d && d.accessToken) setVar('${access}', d.accessToken);`,
    `if (d && d.refreshToken) setVar('${refresh}', d.refreshToken);`,
  ].join("\n");

const resolveJobsScript = [
  setVarScript,
  "function getVar(k){ try{return pm.environment.get(k)||pm.collectionVariables.get(k);}catch(e){return '';}}",
  "const jobs = (pm.response.json().data || []);",
  "function byCode(code){ return jobs.find(j => j.jobCode === code || j.id === code); }",
  "const codes = { jobIdAwaitingApproval: getVar('jobCodeAwaitingApproval'), jobIdPosted: getVar('jobCodePosted'), jobIdEnRoute: getVar('jobCodeEnRoute') };",
  "Object.entries(codes).forEach(([varName, code]) => { const j = byCode(code); if (j && j._id) setVar(varName, j._id); });",
  "const anyAwaiting = jobs.find(j => j.status === 'AWAITING_APPROVAL');",
  "if (anyAwaiting && anyAwaiting._id) setVar('jobIdAwaitingApproval', anyAwaiting._id);",
].join("\n");

const R = ({
  name,
  method = "GET",
  path: p,
  query,
  body,
  auth,
  desc = "",
  tests = "",
  event = [],
}) => ({
  name,
  request: {
    method,
    header: [{ key: "Accept", value: "application/json" }],
    description: desc,
    url: buildUrl(p, query),
    ...(body !== undefined ? { body: jsonBody(body) } : {}),
    ...(auth ? { auth } : {}),
  },
  event: [
    ...(tests
      ? [{ listen: "test", script: { exec: tests.split("\n"), type: "text/javascript" } }]
      : []),
    ...event,
  ],
});

const collection = {
  info: {
    name: "TruckFix — Stripe + Push (full test)",
    description:
      "Complete Postman pack for Stripe billing/payments and push notifications.\n\n" +
      "**Import:** `TruckFix.Stripe-Push.postman_environment.json` and select it.\n\n" +
      "**Run folder `00 — Setup` first** (logins + resolve job IDs).\n\n" +
      "**Stripe attach:** `paymentMethodId` in body = Stripe `pm_...` (from SetupIntent / Stripe Dashboard / npm run test:stripe).\n\n" +
      "**Job approve:** `paymentMethodId` = Mongo `_id` from attach response (`fleetPaymentMethodDbId`).\n\n" +
      "**Push:** Register a real FCM token from your phone for real pushes; placeholder token only tests the API.\n\n" +
      `Local default: ${DEFAULT_BASE_URL}\nProduction: ${RENDER_BASE_URL}`,
    schema:
      "https://schema.getpostman.com/json/collection/v2.1.0/collection.json",
  },
  variable: [
    { key: "baseUrl", value: DEFAULT_BASE_URL },
    { key: "password", value: "Password123!" },
    { key: "fleetEmail", value: "fleet@truckfix.dev" },
    { key: "companyEmail", value: "company@truckfix.dev" },
    { key: "mechanicEmail", value: "mechanic@truckfix.dev" },
    { key: "jobCodeAwaitingApproval", value: "TF-8823" },
    { key: "jobCodePosted", value: "TF-8819" },
    { key: "stripePmId", value: "" },
    { key: "setupIntentId", value: "" },
    { key: "fleetPaymentMethodDbId", value: "" },
    { key: "companyPaymentMethodDbId", value: "" },
    { key: "paymentIntentId", value: "" },
    { key: "fcmDeviceToken", value: "fcm_test_postman_placeholder_replace_with_real_device_token" },
    { key: "notificationId", value: "" },
  ],
  item: [
    {
      name: "00 — Setup (run first)",
      item: [
        {
          name: "GET /health",
          request: {
            method: "GET",
            header: [{ key: "Accept", value: "application/json" }],
            description: "Root health check (not under /api/v1).",
            url: `${DEFAULT_BASE_URL.replace(/\/$/, "")}/health`,
          },
        },
        R({
          name: "POST /auth/login (Fleet)",
          method: "POST",
          path: "/auth/login",
          body: { email: "{{fleetEmail}}", password: "{{password}}" },
          desc: "Sets fleetAccessToken. Seed: fleet@truckfix.dev / Password123!",
          tests: saveTokens("fleetAccessToken", "fleetRefreshToken"),
        }),
        R({
          name: "POST /auth/login (Company)",
          method: "POST",
          path: "/auth/login",
          body: { email: "{{companyEmail}}", password: "{{password}}" },
          desc: "Sets companyAccessToken. Seed: company@truckfix.dev / Password123!",
          tests: saveTokens("companyAccessToken", "companyRefreshToken"),
        }),
        R({
          name: "POST /auth/login (Mechanic)",
          method: "POST",
          path: "/auth/login",
          body: { email: "{{mechanicEmail}}", password: "{{password}}" },
          tests: saveTokens("mechanicAccessToken", "mechanicRefreshToken"),
        }),
        R({
          name: "GET /jobs (Fleet) — resolve jobIdAwaitingApproval",
          path: "/jobs",
          query: [
            { key: "page", value: "1" },
            { key: "limit", value: "50" },
          ],
          auth: authBearer("{{fleetAccessToken}}"),
          desc: "Fills jobIdAwaitingApproval from jobCode TF-8823 or any AWAITING_APPROVAL job.",
          tests: resolveJobsScript,
        }),
        R({
          name: "GET /company/jobs — resolve company awaiting job",
          path: "/company/jobs",
          query: [
            { key: "page", value: "1" },
            { key: "limit", value: "50" },
          ],
          auth: authBearer("{{companyAccessToken}}"),
          tests: [
            setVarScript,
            "const jobs = pm.response.json().data || [];",
            "const j = jobs.find(x => x.status === 'AWAITING_APPROVAL');",
            "if (j && j._id) setVar('jobIdAwaitingApprovalCompany', j._id);",
          ].join("\n"),
        }),
      ],
    },
    {
      name: "01 — Stripe (Fleet payer)",
      item: [
        R({
          name: "GET /billing/stripe/config",
          path: "/billing/stripe/config",
          auth: authBearer("{{fleetAccessToken}}"),
          desc: "Returns publishableKey + enabled. Expect enabled:true if STRIPE_* env set.",
          tests: [
            "pm.test('Stripe enabled', () => {",
            "  const d = pm.response.json().data;",
            "  pm.expect(d.enabled).to.eql(true);",
            "});",
          ].join("\n"),
        }),
        R({
          name: "POST /billing/stripe/setup-intent",
          method: "POST",
          path: "/billing/stripe/setup-intent",
          body: {},
          auth: authBearer("{{fleetAccessToken}}"),
          desc: "Creates Stripe customer + SetupIntent. Use clientSecret in mobile Stripe SDK to get pm_...",
          tests: [
            setVarScript,
            "const d = pm.response.json().data;",
            "if (d.setupIntentId) setVar('setupIntentId', d.setupIntentId);",
            "if (d.customerId) setVar('stripeCustomerId', d.customerId);",
          ].join("\n"),
        }),
        R({
          name: "POST /billing/stripe/payment-methods/attach",
          method: "POST",
          path: "/billing/stripe/payment-methods/attach",
          body: {
            paymentMethodId: "{{stripePmId}}",
            isDefault: true,
            setupIntentId: "{{setupIntentId}}",
          },
          auth: authBearer("{{fleetAccessToken}}"),
          desc:
            "REQUIRED: Set collection var stripePmId to a REAL Stripe pm_... from your account.\n" +
            "Get one: npm run test:stripe (prints pm_) OR Stripe Dashboard test card.\n" +
            "NOT the Mongo id — that goes on job approve only.\n" +
            "Idempotent: same pm_ returns existing card (200/201).",
          tests: [
            setVarScript,
            "const d = pm.response.json().data;",
            "if (d && d._id) setVar('fleetPaymentMethodDbId', d._id);",
            "if (d && d.providerMethodId) setVar('stripePmId', d.providerMethodId);",
          ].join("\n"),
        }),
        R({
          name: "GET /billing/payment-methods",
          path: "/billing/payment-methods",
          auth: authBearer("{{fleetAccessToken}}"),
        }),
        R({
          name: "PATCH /billing/payment-methods/:methodId/default",
          method: "PATCH",
          path: "/billing/payment-methods/{{fleetPaymentMethodDbId}}/default",
          body: {},
          auth: authBearer("{{fleetAccessToken}}"),
        }),
        R({
          name: "PATCH /jobs/:jobId/complete/approve (Stripe charge)",
          method: "PATCH",
          path: "/jobs/{{jobIdAwaitingApproval}}/complete/approve",
          body: { paymentMethodId: "{{fleetPaymentMethodDbId}}" },
          auth: authBearer("{{fleetAccessToken}}"),
          desc:
            "Uses Mongo payment method _id. Job must be AWAITING_APPROVAL.\n" +
            "Re-seed if no jobs: npm run seed:fake",
          tests: [
            setVarScript,
            "const inv = pm.response.json().data && pm.response.json().data.invoice;",
            "if (inv && inv.payment && inv.payment.stripePaymentIntentId) {",
            "  setVar('paymentIntentId', inv.payment.stripePaymentIntentId);",
            "}",
          ].join("\n"),
        }),
        R({
          name: "PATCH /jobs/:jobId/complete/approve (manual, no Stripe)",
          method: "PATCH",
          path: "/jobs/{{jobIdAwaitingApproval}}/complete/approve",
          body: { finalAmount: 145 },
          auth: authBearer("{{fleetAccessToken}}"),
          desc: "Optional: omit paymentMethodId — marks paid without Stripe. Use a different awaiting job.",
        }),
        R({
          name: "POST /billing/stripe/payment-intents/:id/sync",
          method: "POST",
          path: "/billing/stripe/payment-intents/{{paymentIntentId}}/sync",
          auth: authBearer("{{fleetAccessToken}}"),
          desc: "After 3DS or async payment — refreshes invoice status from Stripe.",
        }),
        R({
          name: "DELETE /billing/payment-methods/:methodId",
          method: "DELETE",
          path: "/billing/payment-methods/{{fleetPaymentMethodDbId}}",
          auth: authBearer("{{fleetAccessToken}}"),
          desc: "Soft-delete in DB only. Optional cleanup.",
        }),
      ],
    },
    {
      name: "02 — Stripe (Company payer)",
      item: [
        R({
          name: "GET /billing/stripe/config",
          path: "/billing/stripe/config",
          auth: authBearer("{{companyAccessToken}}"),
        }),
        R({
          name: "POST /billing/stripe/setup-intent",
          method: "POST",
          path: "/billing/stripe/setup-intent",
          body: {},
          auth: authBearer("{{companyAccessToken}}"),
          tests: [
            setVarScript,
            "const d = pm.response.json().data;",
            "if (d.setupIntentId) setVar('companySetupIntentId', d.setupIntentId);",
          ].join("\n"),
        }),
        R({
          name: "POST /billing/stripe/payment-methods/attach",
          method: "POST",
          path: "/billing/stripe/payment-methods/attach",
          body: {
            paymentMethodId: "{{companyStripePmId}}",
            isDefault: true,
            setupIntentId: "{{companySetupIntentId}}",
          },
          auth: authBearer("{{companyAccessToken}}"),
          desc: "Set companyStripePmId to real pm_... before running.",
          tests: [
            setVarScript,
            "const d = pm.response.json().data;",
            "if (d && d._id) setVar('companyPaymentMethodDbId', d._id);",
          ].join("\n"),
        }),
        R({
          name: "GET /billing/payment-methods",
          path: "/billing/payment-methods",
          auth: authBearer("{{companyAccessToken}}"),
        }),
        R({
          name: "PATCH /company/jobs/:jobId/complete/approve (Stripe required)",
          method: "PATCH",
          path: "/company/jobs/{{jobIdAwaitingApprovalCompany}}/complete/approve",
          body: {
            paymentMethodId: "{{companyPaymentMethodDbId}}",
            invoice: {
              callOutCharge: 50,
              labourHours: 2,
              labourRatePerHour: 45,
              parts: [{ description: "Oil filter", amount: 25 }],
            },
            totalAmount: 165,
          },
          auth: authBearer("{{companyAccessToken}}"),
          desc: "Company MUST pass paymentMethodId (Mongo _id). payment fails → job stays AWAITING_APPROVAL.",
          tests: [
            setVarScript,
            "const pi = pm.response.json().data?.invoice?.payment?.stripePaymentIntentId;",
            "if (pi) setVar('companyPaymentIntentId', pi);",
          ].join("\n"),
        }),
      ],
    },
    {
      name: "03 — Stripe (Mechanic Connect)",
      item: [
        R({
          name: "GET /billing/stripe/mechanic-payout-account",
          path: "/billing/stripe/mechanic-payout-account",
          auth: authBearer("{{mechanicAccessToken}}"),
        }),
        R({
          name: "POST /billing/stripe/mechanic-payout-account/onboarding-link",
          method: "POST",
          path: "/billing/stripe/mechanic-payout-account/onboarding-link",
          body: {
            returnUrl: "https://adminpanelwebsite-eosin.vercel.app/stripe/return",
            refreshUrl: "https://adminpanelwebsite-eosin.vercel.app/stripe/refresh",
          },
          auth: authBearer("{{mechanicAccessToken}}"),
          desc: "Open data.url in browser to complete Stripe Connect KYC.",
        }),
        R({
          name: "POST /billing/stripe/mechanic-payout-account/dashboard-link",
          method: "POST",
          path: "/billing/stripe/mechanic-payout-account/dashboard-link",
          body: {},
          auth: authBearer("{{mechanicAccessToken}}"),
          desc: "400 until onboarding details_submitted.",
        }),
      ],
    },
    {
      name: "04 — Push notifications",
      item: [
        R({
          name: "POST /notifications/device-tokens (register FCM)",
          method: "POST",
          path: "/notifications/device-tokens",
          body: {
            token: "{{fcmDeviceToken}}",
            platform: "android",
            appVersion: "1.0.0",
          },
          auth: authBearer("{{fleetAccessToken}}"),
          desc:
            "Replace fcmDeviceToken with a REAL token from Firebase/Flutter on a device for real push.\n" +
            "Placeholder only registers in DB — FCM will not deliver to fake tokens.",
        }),
        R({
          name: "GET /notifications/device-tokens",
          path: "/notifications/device-tokens",
          auth: authBearer("{{fleetAccessToken}}"),
        }),
        R({
          name: "GET /notifications",
          path: "/notifications",
          query: [
            { key: "page", value: "1" },
            { key: "limit", value: "20" },
          ],
          auth: authBearer("{{fleetAccessToken}}"),
          tests: [
            setVarScript,
            "const items = pm.response.json().data || [];",
            "if (items[0] && items[0]._id) setVar('notificationId', items[0]._id);",
          ].join("\n"),
        }),
        R({
          name: "GET /notifications/:id",
          path: "/notifications/{{notificationId}}",
          auth: authBearer("{{fleetAccessToken}}"),
          desc: "Includes navigation.screen, jobId, etc. for tap handling.",
        }),
        R({
          name: "PATCH /notifications/:id/read",
          method: "PATCH",
          path: "/notifications/{{notificationId}}/read",
          auth: authBearer("{{fleetAccessToken}}"),
        }),
        R({
          name: "GET /users/me (includes preferences)",
          path: "/users/me",
          auth: authBearer("{{fleetAccessToken}}"),
          desc: "Check data.preferences.pushEnabled and notifications.*",
        }),
        R({
          name: "PATCH /users/me/preferences (enable push)",
          method: "PATCH",
          path: "/users/me/preferences",
          body: {
            pushEnabled: true,
            notifications: {
              appAlerts: true,
              systemAlerts: true,
            },
          },
          auth: authBearer("{{fleetAccessToken}}"),
        }),
      ],
    },
    {
      name: "05 — Trigger push (send chat → notification)",
      item: [
        R({
          name: "POST /chat/jobs/:jobId/messages (Mechanic → Fleet push)",
          method: "POST",
          path: "/chat/jobs/{{jobIdPosted}}/messages",
          body: {
            text: "Postman test — this should create CHAT_MESSAGE notification + FCM push to fleet.",
          },
          auth: authBearer("{{mechanicAccessToken}}"),
          desc:
            "Fleet user must have registered device token + pushEnabled.\n" +
            "jobIdPosted resolved in setup (TF-8819) or set manually.",
        }),
        R({
          name: "POST /chat/jobs/:jobId/messages (Fleet → Mechanic push)",
          method: "POST",
          path: "/chat/jobs/{{jobIdPosted}}/messages",
          body: { text: "Reply from fleet — push to mechanic if token registered." },
          auth: authBearer("{{fleetAccessToken}}"),
        }),
      ],
    },
  ],
};

const env = {
  id: "a1b2c3d4-stripe-push-env-0001",
  name: "TruckFix — Stripe + Push",
  values: [
    { key: "baseUrl", value: DEFAULT_BASE_URL, type: "default", enabled: true },
    { key: "baseUrlRender", value: RENDER_BASE_URL, type: "default", enabled: true },
    { key: "password", value: "Password123!", type: "secret", enabled: true },
    { key: "fleetEmail", value: "fleet@truckfix.dev", type: "default", enabled: true },
    { key: "companyEmail", value: "company@truckfix.dev", type: "default", enabled: true },
    { key: "mechanicEmail", value: "mechanic@truckfix.dev", type: "default", enabled: true },
    { key: "fleetAccessToken", value: "", type: "secret", enabled: true },
    { key: "fleetRefreshToken", value: "", type: "secret", enabled: true },
    { key: "companyAccessToken", value: "", type: "secret", enabled: true },
    { key: "companyRefreshToken", value: "", type: "secret", enabled: true },
    { key: "mechanicAccessToken", value: "", type: "secret", enabled: true },
    { key: "mechanicRefreshToken", value: "", type: "secret", enabled: true },
    { key: "jobCodeAwaitingApproval", value: "TF-8823", type: "default", enabled: true },
    { key: "jobCodePosted", value: "TF-8819", type: "default", enabled: true },
    { key: "jobIdAwaitingApproval", value: "", type: "default", enabled: true },
    { key: "jobIdAwaitingApprovalCompany", value: "", type: "default", enabled: true },
    { key: "jobIdPosted", value: "", type: "default", enabled: true },
    { key: "stripePmId", value: "", type: "default", enabled: true },
    { key: "companyStripePmId", value: "", type: "default", enabled: true },
    { key: "setupIntentId", value: "", type: "default", enabled: true },
    { key: "companySetupIntentId", value: "", type: "default", enabled: true },
    { key: "fleetPaymentMethodDbId", value: "", type: "default", enabled: true },
    { key: "companyPaymentMethodDbId", value: "", type: "default", enabled: true },
    { key: "paymentIntentId", value: "", type: "default", enabled: true },
    { key: "fcmDeviceToken", value: "REPLACE_WITH_REAL_FCM_TOKEN_FROM_DEVICE", type: "secret", enabled: true },
    { key: "notificationId", value: "", type: "default", enabled: true },
  ],
  _postman_variable_scope: "environment",
};

fs.writeFileSync(
  path.join(__dirname, "TruckFix.Stripe-Push.postman_collection.json"),
  JSON.stringify(collection, null, 2)
);
fs.writeFileSync(
  path.join(__dirname, "TruckFix.Stripe-Push.postman_environment.json"),
  JSON.stringify(env, null, 2)
);

console.log("Wrote TruckFix.Stripe-Push.postman_collection.json");
console.log("Wrote TruckFix.Stripe-Push.postman_environment.json");
