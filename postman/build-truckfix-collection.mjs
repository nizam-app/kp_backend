import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const outFile = path.join(__dirname, "TruckFix.kp_backend.v1.postman_collection.json");

/** Default API origin (no trailing slash). Override in Postman via environment variable `baseUrl`. */
const DEFAULT_BASE_URL = "http://192.168.10.251:6000";

const n = (name) => ({ name, item: [] });

/**
 * Postman `url` object that fills the address bar in the desktop app.
 *
 * Using only `{ raw: "{{baseUrl}}/api/v1/..." }` often shows a **blank** URL when
 * "No environment" is selected — some Postman builds do not preview unresolved
 * `{{baseUrl}}`. We emit a **full** Url object (protocol, host, port, path, query)
 * with `raw` built from `DEFAULT_BASE_URL` so the route is always visible. Path
 * segments may still contain `{{jobIdPosted}}` etc.; those stay in `raw`/`path`.
 */
const buildUrl = (pathname, queryList = []) => {
  const origin = DEFAULT_BASE_URL.replace(/\/+$/, "");
  const cleanPath = pathname.startsWith("/") ? pathname : `/${pathname}`;
  const pathSegments = ["api", "v1", ...cleanPath.split("/").filter(Boolean)];

  const queryArr = (queryList || [])
    .filter((q) => q?.key)
    .map((q) => ({ key: q.key, value: `${q.value ?? ""}` }));

  const qs =
    queryArr.length > 0
      ? `?${queryArr
          .map(
            (q) =>
              `${encodeURIComponent(q.key)}=${encodeURIComponent(q.value)}`
          )
          .join("&")}`
      : "";

  const raw = `${origin}/api/v1${cleanPath}${qs}`;

  let parsed;
  try {
    parsed = new URL(origin);
  } catch {
    parsed = new URL("http://127.0.0.1:5000");
  }

  const protocol = parsed.protocol.replace(":", "");
  const hostname = parsed.hostname;
  let host;
  if (/^(\d{1,3}\.){3}\d{1,3}$/.test(hostname)) {
    host = hostname.split(".");
  } else if (hostname === "localhost") {
    host = ["localhost"];
  } else if (hostname.includes(".")) {
    host = hostname.split(".");
  } else {
    host = [hostname];
  }

  const out = {
    raw,
    protocol,
    host,
    path: pathSegments,
  };
  if (parsed.port) out.port = parsed.port;
  if (queryArr.length) out.query = queryArr;
  return out;
};

const jsonBody = (obj) =>
  obj === undefined
    ? undefined
    : {
        mode: "raw",
        raw: JSON.stringify(obj, null, 2),
        options: { raw: { language: "json" } },
      };

const authBearer = (variable) => ({
  type: "bearer",
  bearer: [{ key: "token", value: variable, type: "string" }],
});

const setEnvAndCollection = [
  "function setEnvAndCollection(key, val) {",
  "  if (val === undefined || val === null || val === '') return;",
  "  try { pm.environment.set(key, val); } catch (e) {}",
  "  try { pm.collectionVariables.set(key, val); } catch (e) {}",
  "}",
].join("\n");

const testSaveTokens = (accessVar, refreshVar) =>
  [
    setEnvAndCollection,
    "const j = pm.response.json();",
    "const d = j && j.data ? j.data : j;",
    `if (d && d.accessToken) setEnvAndCollection("${accessVar}", d.accessToken);`,
    `if (d && d.refreshToken) setEnvAndCollection("${refreshVar}", d.refreshToken);`,
  ].join("\n");

const testResolveJobsByCode = () =>
  [
    setEnvAndCollection,
    "function getVar(key) {",
    "  var v = pm.environment.get(key);",
    "  if (v) return v;",
    "  try { v = pm.collectionVariables.get(key); } catch (e) {}",
    "  return v;",
    "}",
    "const j = pm.response.json();",
    "const jobs = (j && j.data) || [];",
    "function matchesCode(job, code){",
    "  const c = `${code || ''}`.trim();",
    "  if (!c) return false;",
    "  if (`${job.jobCode || ''}` === c) return true;",
    "  if (`${job.id || ''}` === c) return true;",
    "  if (job._id && (`${job._id}` === c)) return true;",
    "  return false;",
    "}",
    "function setId(code, envKey){",
    "  const hit = jobs.find(x => matchesCode(x, code));",
    "  if (hit && hit._id) setEnvAndCollection(envKey, hit._id);",
    "}",
    'setId(getVar("jobCodePosted"), "jobIdPosted");',
    'setId(getVar("jobCodeEnRoute"), "jobIdEnRoute");',
    'setId(getVar("jobCodeAwaitingApproval"), "jobIdAwaitingApproval");',
  ].join("\n");

const testResolveQuote145 = () =>
  [
    setEnvAndCollection,
    "const j = pm.response.json();",
    "const quotes = (j && j.data) || [];",
    "const hit = quotes.find(q => Number(q.amount) === 145 && `${q.status}`.toUpperCase() === 'WAITING');",
    "if (hit && hit._id) setEnvAndCollection('quoteIdWaiting145', hit._id);",
  ].join("\n");

const testSavePaymentMethodId = (targetVar) =>
  [
    setEnvAndCollection,
    "const j = pm.response.json();",
    "const d = j && j.data ? j.data : j;",
    `if (d && d._id) setEnvAndCollection("${targetVar}", d._id);`,
  ].join("\n");

const R = ({
  name,
  method,
  path: pathname,
  query,
  body,
  auth,
  desc,
  tests,
  headers,
}) => ({
  name,
  request: {
    method,
    header: [
      { key: "Accept", value: "application/json", type: "text" },
      ...(headers || []),
    ],
    auth: auth || { type: "noauth" },
    description: desc || "",
    body: jsonBody(body),
    url: buildUrl(pathname, query),
  },
  event: tests
    ? [
        {
          listen: "test",
          script: { exec: tests.split("\n"), type: "text/javascript" },
        },
      ]
    : undefined,
});

const collection = {
  info: {
    name: "TruckFix — kp_backend REST v1 (Fleet + Mechanic prototype mapping)",
    description:
      "Maps `kp_backend` `/api/v1` routes to the interactive prototype tabs in `FleetApp.tsx` / `MechanicApp.tsx`.\n\n" +
      "**Seed data** (run `npm run seed:fake` in `kp_backend/`): fleet `fleet@truckfix.dev`, mechanic `mechanic@truckfix.dev`, password `Password123!`. Seeded jobCodes include `TF-8819` (posted + quotes), `TF-8821` (en route), `TF-8823` (awaiting approval).\n\n" +
      "**Auth**: API returns `{ status, message, data }` — tokens live under `data.accessToken` / `data.refreshToken`.\n\n" +
      "**Realtime**: job + chat events are Socket.IO (not represented as REST here).\n\n" +
      "**Admin / Company** endpoints are included as a separate folder with template bodies (not tied to the Fleet/Mechanic prototype nav).\n\n" +
      "**Variables**: Import `TruckFix.local.postman_environment.json` and **select that environment** in the Postman top-right picker (recommended).\n" +
      "If you leave **No environment**, use **collection variables** (collection → Variables): `baseUrl`, emails, password, and token/job ids after running the auth folder.\n\n" +
      "**API origin** baked into each request URL: `" +
      DEFAULT_BASE_URL +
      "` (see `DEFAULT_BASE_URL` in `postman/build-truckfix-collection.mjs`). Change it there and run `node postman/build-truckfix-collection.mjs` to regenerate.\n\n" +
      "**Why the URL bar looked empty before**: requests used only `{{baseUrl}}` in `raw` without a selected environment; some Postman versions show a blank bar until variables resolve.\n\n" +
      "Login requests store tokens in **both** the active environment and **collection variables**.",
    schema:
      "https://schema.getpostman.com/json/collection/v2.1.0/collection.json",
  },
  variable: [
    { key: "baseUrl", value: DEFAULT_BASE_URL },
    { key: "fleetEmail", value: "fleet@truckfix.dev" },
    { key: "mechanicEmail", value: "mechanic@truckfix.dev" },
    { key: "password", value: "Password123!" },
    { key: "fleetAccessToken", value: "" },
    { key: "fleetRefreshToken", value: "" },
    { key: "mechanicAccessToken", value: "" },
    { key: "mechanicRefreshToken", value: "" },
    { key: "jobCodePosted", value: "TF-8819" },
    { key: "jobCodeEnRoute", value: "TF-8821" },
    { key: "jobCodeAwaitingApproval", value: "TF-8823" },
    { key: "jobIdPosted", value: "" },
    { key: "jobIdEnRoute", value: "" },
    { key: "jobIdAwaitingApproval", value: "" },
    { key: "quoteIdWaiting145", value: "" },
    { key: "stripePmId", value: "pm_card_visa" },
    { key: "fleetStripePaymentMethodDbId", value: "" },
  ],
  auth: { type: "noauth" },
  item: [],
};

const prereq = n("00 — Auth + seed context");
prereq.item.push(
  R({
    name: "POST /auth/login (Fleet seed)",
    method: "POST",
    path: "/auth/login",
    body: {
      email: "{{fleetEmail}}",
      password: "{{password}}",
    },
    tests: testSaveTokens("fleetAccessToken", "fleetRefreshToken"),
  }),
  R({
    name: "POST /auth/login (Mechanic seed — James)",
    method: "POST",
    path: "/auth/login",
    body: {
      email: "{{mechanicEmail}}",
      password: "{{password}}",
    },
    tests: testSaveTokens("mechanicAccessToken", "mechanicRefreshToken"),
  }),
  R({
    name: "GET /jobs (Fleet) — resolve job ObjectIds from seeded jobCodes",
    method: "GET",
    path: "/jobs",
    query: [
      { key: "page", value: "1" },
      { key: "limit", value: "50" },
    ],
    auth: authBearer("{{fleetAccessToken}}"),
    desc: "Runs after Fleet login. Saves `jobIdPosted`, `jobIdEnRoute`, `jobIdAwaitingApproval` based on `jobCode*` env vars.",
    tests: testResolveJobsByCode(),
  }),
  R({
    name: "GET /jobs/:jobId/quotes (Fleet) — resolve James £145 quote _id on TF-8819",
    method: "GET",
    path: "/jobs/{{jobIdPosted}}/quotes",
    auth: authBearer("{{fleetAccessToken}}"),
    desc: "Saves `quoteIdWaiting145` for Accept/Decline demos.",
    tests: testResolveQuote145(),
  }),
  R({
    name: "POST /auth/refresh-token",
    method: "POST",
    path: "/auth/refresh-token",
    body: { refreshToken: "{{fleetRefreshToken}}" },
  }),
  R({
    name: "POST /auth/logout (Fleet)",
    method: "POST",
    path: "/auth/logout",
    auth: authBearer("{{fleetAccessToken}}"),
    body: { refreshToken: "{{fleetRefreshToken}}" },
  })
);

const fleet = n("Fleet prototype — by screen/tab");

const fleetDashboard = n("fleet-dashboard — Dashboard");
fleetDashboard.item.push(
  R({
    name: "GET /fleet/dashboard",
    method: "GET",
    path: "/fleet/dashboard",
    auth: authBearer("{{fleetAccessToken}}"),
  }),
  R({
    name: "GET /jobs?tab=active",
    method: "GET",
    path: "/jobs",
    query: [
      { key: "tab", value: "active" },
      { key: "page", value: "1" },
      { key: "limit", value: "20" },
    ],
    auth: authBearer("{{fleetAccessToken}}"),
  }),
  R({
    name: "GET /jobs?tab=completed",
    method: "GET",
    path: "/jobs",
    query: [
      { key: "tab", value: "completed" },
      { key: "page", value: "1" },
      { key: "limit", value: "20" },
    ],
    auth: authBearer("{{fleetAccessToken}}"),
  }),
  R({
    name: "GET /notifications",
    method: "GET",
    path: "/notifications",
    query: [
      { key: "page", value: "1" },
      { key: "limit", value: "20" },
    ],
    auth: authBearer("{{fleetAccessToken}}"),
  }),
  R({
    name: "GET /chat/threads",
    method: "GET",
    path: "/chat/threads",
    auth: authBearer("{{fleetAccessToken}}"),
  }),
  R({
    name: "GET /invoices",
    method: "GET",
    path: "/invoices",
    query: [
      { key: "page", value: "1" },
      { key: "limit", value: "20" },
    ],
    auth: authBearer("{{fleetAccessToken}}"),
  })
);

const fleetPostJob = n("fleet-post-job — Post Job");
fleetPostJob.item.push(
  R({
    name: "GET /users/me (check profile gate)",
    method: "GET",
    path: "/users/me",
    auth: authBearer("{{fleetAccessToken}}"),
  }),
  R({
    name: "GET /fleet/vehicles (pick vehicleId)",
    method: "GET",
    path: "/fleet/vehicles",
    auth: authBearer("{{fleetAccessToken}}"),
  }),
  R({
    name: "POST /jobs (create — uses Birmingham-ish coords like seed TF-8819)",
    method: "POST",
    path: "/jobs",
    auth: authBearer("{{fleetAccessToken}}"),
    body: {
      title: "Tyre damage — off-ramp",
      description: "Off-ramp debris damage — need roadside assessment.",
      driverName: "Alex Driver",
      driverPhone: "+27 82 000 0000",
      issueType: "TYRES",
      issueSubtype: "FLAT_DAMAGED_TYRE",
      tyreDetails: {
        size: "295/80 R22.5",
        side: "NEAR_SIDE",
        axlePosition: "Drive 1",
      },
      urgency: "HIGH",
      mode: "EMERGENCY",
      vehicleId: "REPLACE_WITH_VEHICLE_OBJECT_ID",
      registration: "CA 456-789",
      vehicleType: "Tautliner",
      vehicleMake: "DAF",
      vehicleModel: "XF",
      estimatedPayout: 120,
      location: {
        coordinates: [-1.8904, 52.4862],
        address: "M6 Motorway, Corley Services, Warwickshire",
      },
    },
  }),
  R({
    name: "POST /jobs/:jobId/photos (remote URL passthrough)",
    method: "POST",
    path: "/jobs/{{jobIdPosted}}/photos",
    auth: authBearer("{{fleetAccessToken}}"),
    body: {
      photos: [{ url: "https://images.unsplash.com/photo-1580273916550-e323be2ae537?w=1200" }],
    },
  }),
  R({
    name: "PATCH /jobs/:jobId/photos/remove",
    method: "PATCH",
    path: "/jobs/{{jobIdPosted}}/photos/remove",
    auth: authBearer("{{fleetAccessToken}}"),
    body: {
      photoUrl: "PASTE_URL_FROM_JOB.photos_ARRAY",
    },
  })
);

const fleetTracking = n("fleet-tracking — Tracking");
fleetTracking.item.push(
  R({
    name: "GET /jobs?tab=tracking",
    method: "GET",
    path: "/jobs",
    query: [
      { key: "tab", value: "tracking" },
      { key: "page", value: "1" },
      { key: "limit", value: "20" },
    ],
    auth: authBearer("{{fleetAccessToken}}"),
  }),
  R({
    name: "GET /jobs/:jobId (TF-8821 en route)",
    method: "GET",
    path: "/jobs/{{jobIdEnRoute}}",
    auth: authBearer("{{fleetAccessToken}}"),
  }),
  R({
    name: "GET /jobs/:jobId/timeline",
    method: "GET",
    path: "/jobs/{{jobIdEnRoute}}/timeline",
    auth: authBearer("{{fleetAccessToken}}"),
  }),
  R({
    name: "GET /jobs/:jobId/cancellation-preview (TF-8821)",
    method: "GET",
    path: "/jobs/{{jobIdEnRoute}}/cancellation-preview",
    auth: authBearer("{{fleetAccessToken}}"),
  }),
  R({
    name: "PATCH /jobs/:jobId/cancel (destructive — optional)",
    method: "PATCH",
    path: "/jobs/{{jobIdPosted}}/cancel",
    auth: authBearer("{{fleetAccessToken}}"),
    body: { reason: "Posted job cancelled from Postman test" },
  }),
  R({
    name: "GET /chat/jobs/:jobId/messages",
    method: "GET",
    path: "/chat/jobs/{{jobIdEnRoute}}/messages",
    auth: authBearer("{{fleetAccessToken}}"),
  }),
  R({
    name: "POST /chat/jobs/:jobId/messages",
    method: "POST",
    path: "/chat/jobs/{{jobIdEnRoute}}/messages",
    auth: authBearer("{{fleetAccessToken}}"),
    body: { text: "Fleet: how far out are you?" },
  }),
  R({
    name: "PATCH /chat/jobs/:jobId/read",
    method: "PATCH",
    path: "/chat/jobs/{{jobIdEnRoute}}/read",
    auth: authBearer("{{fleetAccessToken}}"),
    body: {},
  }),
  R({
    name: "PATCH /notifications/:id/read",
    method: "PATCH",
    path: "/notifications/REPLACE_NOTIFICATION_ID/read",
    auth: authBearer("{{fleetAccessToken}}"),
    body: {},
  }),
  R({
    name: "POST /notifications/device-tokens",
    method: "POST",
    path: "/notifications/device-tokens",
    auth: authBearer("{{fleetAccessToken}}"),
    body: {
      token: "fcm-or-apns-device-token-string",
      platform: "ANDROID",
    },
  })
);

const fleetQuote = n("fleet-quote-received — New Quote");
fleetQuote.item.push(
  R({
    name: "GET /jobs/:jobId/quotes (TF-8819)",
    method: "GET",
    path: "/jobs/{{jobIdPosted}}/quotes",
    auth: authBearer("{{fleetAccessToken}}"),
  }),
  R({
    name: "PATCH /quotes/:quoteId/accept (James £145) [destructive]",
    method: "PATCH",
    path: "/quotes/{{quoteIdWaiting145}}/accept",
    auth: authBearer("{{fleetAccessToken}}"),
    body: {},
  }),
  R({
    name: "PATCH /quotes/:quoteId/decline (pick another quoteId) [destructive]",
    method: "PATCH",
    path: "/quotes/REPLACE_QUOTE_ID/decline",
    auth: authBearer("{{fleetAccessToken}}"),
    body: {},
  })
);

const fleetProfile = n("fleet-profile — Profile + admin sheets");
fleetProfile.item.push(
  R({
    name: "GET /users/me",
    method: "GET",
    path: "/users/me",
    auth: authBearer("{{fleetAccessToken}}"),
  }),
  R({
    name: "PATCH /users/me/preferences",
    method: "PATCH",
    path: "/users/me/preferences",
    auth: authBearer("{{fleetAccessToken}}"),
    body: { notifications: { push: true, email: true } },
  }),
  R({
    name: "PATCH /users/me/terms",
    method: "PATCH",
    path: "/users/me/terms",
    auth: authBearer("{{fleetAccessToken}}"),
    body: { accepted: true },
  }),
  R({
    name: "GET /support/tickets",
    method: "GET",
    path: "/support/tickets",
    auth: authBearer("{{fleetAccessToken}}"),
  }),
  R({
    name: "POST /support/tickets",
    method: "POST",
    path: "/support/tickets",
    auth: authBearer("{{fleetAccessToken}}"),
    body: {
      subject: "Billing question",
      category: "BILLING",
      message: "Need help understanding an invoice line.",
    },
  }),
  R({
    name: "GET /fleet/reviews",
    method: "GET",
    path: "/fleet/reviews",
    auth: authBearer("{{fleetAccessToken}}"),
  }),
  R({
    name: "GET /fleet/disputes",
    method: "GET",
    path: "/fleet/disputes",
    auth: authBearer("{{fleetAccessToken}}"),
  }),
  R({
    name: "POST /fleet/reviews [needs completed job context in real flows]",
    method: "POST",
    path: "/fleet/reviews",
    auth: authBearer("{{fleetAccessToken}}"),
    body: {
      jobId: "{{jobIdEnRoute}}",
      rating: 5,
      comment: "Great service (example body — may fail if job not completed)",
    },
  })
);

const fleetEdit = n("fleet-edit-profile — Edit Profile");
fleetEdit.item.push(
  R({
    name: "PATCH /users/me",
    method: "PATCH",
    path: "/users/me",
    auth: authBearer("{{fleetAccessToken}}"),
    body: {
      contactName: "John Khumalo",
      phone: "+44 7712 345 678",
      billingAddress: "123 Logistics Ave, JHB",
    },
  }),
  R({
    name: "POST /media/profile-image (multipart)",
    method: "POST",
    path: "/media/profile-image",
    auth: authBearer("{{fleetAccessToken}}"),
    headers: [{ key: "Content-Type", value: "multipart/form-data", type: "text" }],
    desc: "In Postman set Body → form-data → key `file` (type File). This export can't embed binary; attach any small JPG/PNG.",
  })
);

const fleetPay = n("fleet-profile → payment-methods sheet");
fleetPay.item.push(
  R({
    name: "GET /billing/stripe/config",
    method: "GET",
    path: "/billing/stripe/config",
    auth: authBearer("{{fleetAccessToken}}"),
  }),
  R({
    name: "POST /billing/stripe/setup-intent",
    method: "POST",
    path: "/billing/stripe/setup-intent",
    auth: authBearer("{{fleetAccessToken}}"),
    desc:
      "Creates a Stripe SetupIntent for the Fleet user. Use the returned publishableKey/clientSecret in a frontend to create a real Stripe PaymentMethod (pm_...).",
  }),
  R({
    name: "POST /billing/stripe/payment-methods/attach (Stripe pm_... → save DB paymentMethodId)",
    method: "POST",
    path: "/billing/stripe/payment-methods/attach",
    auth: authBearer("{{fleetAccessToken}}"),
    desc:
      "Attach a Stripe PaymentMethod (pm_...) to the Fleet's Stripe customer, then store it in MongoDB as a PaymentMethod record.\n\n" +
      "Set `stripePmId` (collection/environment variable) to your Stripe PaymentMethod id.\n" +
      "This request saves the created PaymentMethod `_id` into `fleetStripePaymentMethodDbId` for later use in approve-completion.",
    body: {
      paymentMethodId: "{{stripePmId}}",
      isDefault: true,
    },
    tests: testSavePaymentMethodId("fleetStripePaymentMethodDbId"),
  }),
  R({
    name: "GET /billing/payment-methods",
    method: "GET",
    path: "/billing/payment-methods",
    auth: authBearer("{{fleetAccessToken}}"),
  }),
  R({
    name: "POST /billing/payment-methods (manual/test provider ids)",
    method: "POST",
    path: "/billing/payment-methods",
    auth: authBearer("{{fleetAccessToken}}"),
    body: {
      methodType: "CARD",
      provider: "MANUAL",
      providerMethodId: "pm_manual_fleet_demo_001",
      card: { brand: "visa", last4: "4242", expMonth: 12, expYear: 2030 },
    },
  }),
  R({
    name: "PATCH /billing/payment-methods/:methodId/default",
    method: "PATCH",
    path: "/billing/payment-methods/REPLACE_METHOD_ID/default",
    auth: authBearer("{{fleetAccessToken}}"),
    body: {},
  }),
  R({
    name: "DELETE /billing/payment-methods/:methodId",
    method: "DELETE",
    path: "/billing/payment-methods/REPLACE_METHOD_ID",
    auth: authBearer("{{fleetAccessToken}}"),
  })
);

const fleetVehicles = n("fleet-profile → vehicles sheet");
fleetVehicles.item.push(
  R({
    name: "GET /fleet/vehicles",
    method: "GET",
    path: "/fleet/vehicles",
    auth: authBearer("{{fleetAccessToken}}"),
  }),
  R({
    name: "POST /fleet/vehicles",
    method: "POST",
    path: "/fleet/vehicles",
    auth: authBearer("{{fleetAccessToken}}"),
    body: {
      registration: "TEST 001-AA",
      type: "Rigid Truck",
      make: "Scania",
      model: "R450",
      year: 2022,
      vin: "TESTVIN00000000001",
    },
  }),
  R({
    name: "PATCH /fleet/vehicles/:vehicleId",
    method: "PATCH",
    path: "/fleet/vehicles/REPLACE_VEHICLE_ID",
    auth: authBearer("{{fleetAccessToken}}"),
    body: { year: 2023 },
  }),
  R({
    name: "DELETE /fleet/vehicles/:vehicleId [destructive]",
    method: "DELETE",
    path: "/fleet/vehicles/REPLACE_VEHICLE_ID",
    auth: authBearer("{{fleetAccessToken}}"),
  })
);

const fleetTrackingDetail = n("fleet-tracking-detail — Tracking detail + invoice download");
fleetTrackingDetail.item.push(
  R({
    name: "GET /jobs/:jobId (TF-8823 awaiting approval)",
    method: "GET",
    path: "/jobs/{{jobIdAwaitingApproval}}",
    auth: authBearer("{{fleetAccessToken}}"),
  }),
  R({
    name: "GET /jobs/:jobId/timeline",
    method: "GET",
    path: "/jobs/{{jobIdAwaitingApproval}}/timeline",
    auth: authBearer("{{fleetAccessToken}}"),
  }),
  R({
    name: "PATCH /jobs/:jobId/complete/approve (Stripe) [destructive]",
    method: "PATCH",
    path: "/jobs/{{jobIdAwaitingApproval}}/complete/approve",
    auth: authBearer("{{fleetAccessToken}}"),
    body: {
      paymentMethodId: "{{fleetStripePaymentMethodDbId}}",
    },
  }),
  R({
    name: "GET /invoices",
    method: "GET",
    path: "/invoices",
    query: [
      { key: "page", value: "1" },
      { key: "limit", value: "20" },
    ],
    auth: authBearer("{{fleetAccessToken}}"),
  }),
  R({
    name: "GET /invoices/:invoiceId",
    method: "GET",
    path: "/invoices/REPLACE_INVOICE_ID",
    auth: authBearer("{{fleetAccessToken}}"),
  }),
  R({
    name: "GET /invoices/:invoiceId/download",
    method: "GET",
    path: "/invoices/REPLACE_INVOICE_ID/download",
    auth: authBearer("{{fleetAccessToken}}"),
  })
);

fleet.item.push(
  fleetDashboard,
  fleetPostJob,
  fleetTracking,
  fleetQuote,
  fleetProfile,
  fleetEdit,
  fleetPay,
  fleetVehicles,
  fleetTrackingDetail
);

const mech = n("Mechanic prototype — by screen/tab");

const mFeed = n("mechanic-feed — Job Feed");
mFeed.item.push(
  R({
    name: "PATCH /users/me/availability (online/offline)",
    method: "PATCH",
    path: "/users/me/availability",
    auth: authBearer("{{mechanicAccessToken}}"),
    body: {
      availability: "ONLINE",
      lastKnownLocation: { coordinates: [-2.2426, 53.4808] },
    },
  }),
  R({
    name: "GET /jobs?feed=true (Manchester coords, 15mi — matches seed TF-8821 area)",
    method: "GET",
    path: "/jobs",
    query: [
      { key: "feed", value: "true" },
      { key: "lat", value: "53.4808" },
      { key: "lng", value: "-2.2426" },
      { key: "radiusMiles", value: "15" },
      { key: "page", value: "1" },
      { key: "limit", value: "20" },
    ],
    auth: authBearer("{{mechanicAccessToken}}"),
  }),
  R({
    name: "POST /jobs/:jobId/quotes (quote TF-8819) [may 409 if duplicate]",
    method: "POST",
    path: "/jobs/{{jobIdPosted}}/quotes",
    auth: authBearer("{{mechanicAccessToken}}"),
    body: {
      amount: 139,
      notes: "Postman test quote",
      etaMinutes: 14,
      availabilityType: "NOW",
    },
  }),
  R({
    name: "GET /feed-presets",
    method: "GET",
    path: "/feed-presets",
    auth: authBearer("{{mechanicAccessToken}}"),
  }),
  R({
    name: "POST /feed-presets",
    method: "POST",
    path: "/feed-presets",
    auth: authBearer("{{mechanicAccessToken}}"),
    body: { name: "Motorway bursts", radiusMiles: 15, issueTypes: ["ENGINE", "TYRES"] },
  })
);

const mQD = n("mechanic-quote-detail — Quote Detail");
mQD.item.push(
  R({
    name: "GET /quotes/:quoteId",
    method: "GET",
    path: "/quotes/REPLACE_QUOTE_ID",
    auth: authBearer("{{mechanicAccessToken}}"),
  }),
  R({
    name: "PATCH /quotes/:quoteId/amend",
    method: "PATCH",
    path: "/quotes/REPLACE_QUOTE_ID/amend",
    auth: authBearer("{{mechanicAccessToken}}"),
    body: { amount: 141, notes: "Adjusted estimate", etaMinutes: 15 },
  }),
  R({
    name: "PATCH /quotes/:quoteId/withdraw",
    method: "PATCH",
    path: "/quotes/REPLACE_QUOTE_ID/withdraw",
    auth: authBearer("{{mechanicAccessToken}}"),
    body: {},
  })
);

const mMQ = n("mechanic-my-quotes — My Quotes");
mMQ.item.push(
  R({
    name: "GET /quotes/me",
    method: "GET",
    path: "/quotes/me",
    query: [
      { key: "page", value: "1" },
      { key: "limit", value: "20" },
    ],
    auth: authBearer("{{mechanicAccessToken}}"),
  })
);

const mJobs = n("mechanic-active-job — My Jobs");
mJobs.item.push(
  R({
    name: "GET /jobs?tab=active",
    method: "GET",
    path: "/jobs",
    query: [
      { key: "tab", value: "active" },
      { key: "page", value: "1" },
      { key: "limit", value: "20" },
    ],
    auth: authBearer("{{mechanicAccessToken}}"),
  }),
  R({
    name: "GET /jobs (default mechanic assignments)",
    method: "GET",
    path: "/jobs",
    query: [
      { key: "page", value: "1" },
      { key: "limit", value: "20" },
    ],
    auth: authBearer("{{mechanicAccessToken}}"),
  })
);

const mJT = n("mechanic-job-tracker — Job Tracker");
mJT.item.push(
  R({
    name: "PATCH /jobs/:jobId/journey/start (TF-8821)",
    method: "PATCH",
    path: "/jobs/{{jobIdEnRoute}}/journey/start",
    auth: authBearer("{{mechanicAccessToken}}"),
    body: {},
  }),
  R({
    name: "POST /jobs/:jobId/location-pings",
    method: "POST",
    path: "/jobs/{{jobIdEnRoute}}/location-pings",
    auth: authBearer("{{mechanicAccessToken}}"),
    body: { lat: 53.4808, lng: -2.2426, etaMinutes: 17, heading: 90, speed: 42 },
  }),
  R({
    name: "PATCH /jobs/:jobId/arrive",
    method: "PATCH",
    path: "/jobs/{{jobIdEnRoute}}/arrive",
    auth: authBearer("{{mechanicAccessToken}}"),
    body: {},
  }),
  R({
    name: "PATCH /jobs/:jobId/work/start",
    method: "PATCH",
    path: "/jobs/{{jobIdEnRoute}}/work/start",
    auth: authBearer("{{mechanicAccessToken}}"),
    body: {},
  }),
  R({
    name: "PATCH /jobs/:jobId/work/complete (TF-8823)",
    method: "PATCH",
    path: "/jobs/{{jobIdAwaitingApproval}}/work/complete",
    auth: authBearer("{{mechanicAccessToken}}"),
    body: {
      workSummary: "Brake system repair completed — test drive OK.",
      finalAmount: 275,
    },
  }),
  R({
    name: "POST /jobs/:jobId/attachments (manual items)",
    method: "POST",
    path: "/jobs/{{jobIdEnRoute}}/attachments",
    auth: authBearer("{{mechanicAccessToken}}"),
    body: {
      items: [
        {
          category: "OTHER",
          fileType: "IMAGE",
          url: "https://images.unsplash.com/photo-1580273916550-e323be2ae537?w=1200",
        },
      ],
    },
  }),
  R({
    name: "DELETE /jobs/:jobId/attachments/:attachmentId",
    method: "DELETE",
    path: "/jobs/{{jobIdEnRoute}}/attachments/REPLACE_ATTACHMENT_ID",
    auth: authBearer("{{mechanicAccessToken}}"),
  }),
  R({
    name: "PATCH /jobs/:jobId/photos/remove",
    method: "PATCH",
    path: "/jobs/{{jobIdEnRoute}}/photos/remove",
    auth: authBearer("{{mechanicAccessToken}}"),
    body: { photoUrl: "PASTE_URL_FROM_JOB.photos_ARRAY" },
  }),
  R({
    name: "GET /chat/jobs/:jobId/messages",
    method: "GET",
    path: "/chat/jobs/{{jobIdEnRoute}}/messages",
    auth: authBearer("{{mechanicAccessToken}}"),
  }),
  R({
    name: "POST /chat/jobs/:jobId/messages",
    method: "POST",
    path: "/chat/jobs/{{jobIdEnRoute}}/messages",
    auth: authBearer("{{mechanicAccessToken}}"),
    body: { text: "Mechanic: arriving shortly." },
  })
);

const mProf = n("mechanic-profile — Profile");
mProf.item.push(
  R({
    name: "GET /users/me",
    method: "GET",
    path: "/users/me",
    auth: authBearer("{{mechanicAccessToken}}"),
  }),
  R({
    name: "GET /billing/stripe/mechanic-payout-account",
    method: "GET",
    path: "/billing/stripe/mechanic-payout-account",
    auth: authBearer("{{mechanicAccessToken}}"),
  }),
  R({
    name: "POST /billing/stripe/mechanic-payout-account/onboarding-link",
    method: "POST",
    path: "/billing/stripe/mechanic-payout-account/onboarding-link",
    auth: authBearer("{{mechanicAccessToken}}"),
    body: {
      refreshUrl: "{{baseUrl}}/onboarding/refresh",
      returnUrl: "{{baseUrl}}/onboarding/return",
    },
  }),
  R({
    name: "POST /billing/stripe/mechanic-payout-account/dashboard-link",
    method: "POST",
    path: "/billing/stripe/mechanic-payout-account/dashboard-link",
    auth: authBearer("{{mechanicAccessToken}}"),
    body: {},
  }),
  R({
    name: "GET /fleet/reviews/me",
    method: "GET",
    path: "/fleet/reviews/me",
    auth: authBearer("{{mechanicAccessToken}}"),
  }),
  R({
    name: "GET /fleet/disputes/me",
    method: "GET",
    path: "/fleet/disputes/me",
    auth: authBearer("{{mechanicAccessToken}}"),
  }),
  R({
    name: "GET /notifications",
    method: "GET",
    path: "/notifications",
    query: [
      { key: "page", value: "1" },
      { key: "limit", value: "20" },
    ],
    auth: authBearer("{{mechanicAccessToken}}"),
  }),
  R({
    name: "GET /support/tickets",
    method: "GET",
    path: "/support/tickets",
    auth: authBearer("{{mechanicAccessToken}}"),
  })
);

const mEdit = n("mechanic-edit-profile — Edit Profile");
mEdit.item.push(
  R({
    name: "PATCH /users/me",
    method: "PATCH",
    path: "/users/me",
    auth: authBearer("{{mechanicAccessToken}}"),
    body: {
      displayName: "James Mitchell",
      hourlyRate: 76,
      callOutFee: 35,
      serviceRadiusMiles: 25,
      basePostcode: "M1 1AE",
    },
  }),
  R({
    name: "POST /media/profile-image (multipart)",
    method: "POST",
    path: "/media/profile-image",
    auth: authBearer("{{mechanicAccessToken}}"),
    headers: [{ key: "Content-Type", value: "multipart/form-data", type: "text" }],
    desc: "Set Body → form-data → `file` in Postman.",
  })
);

const mEarn = n("mechanic-earnings — Earnings");
mEarn.item.push(
  R({
    name: "GET /earnings/summary",
    method: "GET",
    path: "/earnings/summary",
    auth: authBearer("{{mechanicAccessToken}}"),
  }),
  R({
    name: "GET /earnings/payout-info",
    method: "GET",
    path: "/earnings/payout-info",
    auth: authBearer("{{mechanicAccessToken}}"),
  }),
  R({
    name: "GET /earnings/statement",
    method: "GET",
    path: "/earnings/statement",
    auth: authBearer("{{mechanicAccessToken}}"),
  }),
  R({
    name: "GET /earnings/jobs",
    method: "GET",
    path: "/earnings/jobs",
    query: [
      { key: "page", value: "1" },
      { key: "limit", value: "20" },
    ],
    auth: authBearer("{{mechanicAccessToken}}"),
  }),
  R({
    name: "GET /invoices (mechanic sees assigned invoices per backend rules)",
    method: "GET",
    path: "/invoices",
    query: [
      { key: "page", value: "1" },
      { key: "limit", value: "20" },
    ],
    auth: authBearer("{{mechanicAccessToken}}"),
  })
);

const mPay = n("mechanic-profile → payment-methods sheet");
mPay.item.push(
  R({
    name: "GET /billing/payment-methods",
    method: "GET",
    path: "/billing/payment-methods",
    auth: authBearer("{{mechanicAccessToken}}"),
  }),
  R({
    name: "POST /billing/payment-methods (manual/test)",
    method: "POST",
    path: "/billing/payment-methods",
    auth: authBearer("{{mechanicAccessToken}}"),
    body: {
      methodType: "CARD",
      provider: "MANUAL",
      providerMethodId: "pm_manual_mech_demo_001",
      card: { brand: "visa", last4: "4242", expMonth: 12, expYear: 2030 },
    },
  })
);

mech.item.push(mFeed, mQD, mMQ, mJobs, mJT, mProf, mEdit, mEarn, mPay);

const misc = n("99 — Remaining /api/v1 surface (templates)");

misc.item.push(
  R({
    name: "POST /billing/stripe/webhook (raw Stripe payload — not typical Postman)",
    method: "POST",
    path: "/billing/stripe/webhook",
    desc: "Requires Stripe signature + raw body; leave as documentation only.",
  }),
  R({
    name: "POST /auth/register (Fleet template)",
    method: "POST",
    path: "/auth/register",
    body: {
      email: "new-fleet@example.com",
      password: "Password123!",
      role: "FLEET",
      confirmPassword: "Password123!",
      companyName: "Example Logistics Ltd",
      contactName: "Jane Doe",
      phone: "+44 7700 900000",
    },
  }),
  R({
    name: "POST /auth/register (Mechanic template)",
    method: "POST",
    path: "/auth/register",
    body: {
      email: "new-mech@example.com",
      password: "Password123!",
      role: "MECHANIC",
      confirmPassword: "Password123!",
      displayName: "New Mechanic",
      businessName: "Roadside Ltd",
      phone: "+44 7700 900001",
      baseLocationText: "Manchester",
      basePostcode: "M1 1AE",
      hourlyRate: 70,
      callOutFee: 35,
      serviceRadiusMiles: 25,
    },
  })
);

const companyFolder = n("Company router (/company/*)");
companyFolder.item.push(
  R({
    name: "GET /company/dashboard",
    method: "GET",
    path: "/company/dashboard",
    auth: authBearer("REPLACE_COMPANY_TOKEN"),
  }),
  R({
    name: "GET /company/feed?lat=53.4808&lng=-2.2426",
    method: "GET",
    path: "/company/feed",
    query: [
      { key: "lat", value: "53.4808" },
      { key: "lng", value: "-2.2426" },
      { key: "radiusMiles", value: "25" },
      { key: "page", value: "1" },
      { key: "limit", value: "20" },
    ],
    auth: authBearer("REPLACE_COMPANY_TOKEN"),
  }),
  R({
    name: "GET /company/jobs",
    method: "GET",
    path: "/company/jobs",
    query: [
      { key: "page", value: "1" },
      { key: "limit", value: "20" },
    ],
    auth: authBearer("REPLACE_COMPANY_TOKEN"),
  }),
  R({
    name: "GET /company/jobs/:jobId",
    method: "GET",
    path: "/company/jobs/REPLACE_JOB_ID",
    auth: authBearer("REPLACE_COMPANY_TOKEN"),
  }),
  R({
    name: "POST /company/jobs/:jobId/assign",
    method: "POST",
    path: "/company/jobs/REPLACE_JOB_ID/assign",
    auth: authBearer("REPLACE_COMPANY_TOKEN"),
    body: { mechanicId: "REPLACE_MECHANIC_USER_ID" },
  }),
  R({
    name: "GET /company/team",
    method: "GET",
    path: "/company/team",
    auth: authBearer("REPLACE_COMPANY_TOKEN"),
  }),
  R({
    name: "POST /company/team/invitations",
    method: "POST",
    path: "/company/team/invitations",
    auth: authBearer("REPLACE_COMPANY_TOKEN"),
    body: { email: "employee@example.com", role: "MECHANIC_EMPLOYEE" },
  }),
  R({
    name: "DELETE /company/team/invitations/:inviteId",
    method: "DELETE",
    path: "/company/team/invitations/REPLACE_INVITE_ID",
    auth: authBearer("REPLACE_COMPANY_TOKEN"),
  }),
  R({
    name: "GET /company/earnings/summary",
    method: "GET",
    path: "/company/earnings/summary",
    auth: authBearer("REPLACE_COMPANY_TOKEN"),
  }),
  R({
    name: "GET /company/earnings/jobs",
    method: "GET",
    path: "/company/earnings/jobs",
    query: [
      { key: "page", value: "1" },
      { key: "limit", value: "20" },
    ],
    auth: authBearer("REPLACE_COMPANY_TOKEN"),
  })
);

const adminFolder = n("Admin router (/admin/*) — template stubs");
adminFolder.item.push(
  R({
    name: "GET /admin/dashboard",
    method: "GET",
    path: "/admin/dashboard",
    auth: authBearer("REPLACE_ADMIN_TOKEN"),
  }),
  R({
    name: "GET /admin/users",
    method: "GET",
    path: "/admin/users",
    query: [
      { key: "page", value: "1" },
      { key: "limit", value: "20" },
    ],
    auth: authBearer("REPLACE_ADMIN_TOKEN"),
  }),
  R({
    name: "POST /admin/users",
    method: "POST",
    path: "/admin/users",
    auth: authBearer("REPLACE_ADMIN_TOKEN"),
    body: { email: "admin-created@example.com", role: "FLEET", password: "Password123!" },
  })
);

misc.item.push(companyFolder, adminFolder);

collection.item.push(prereq, fleet, mech, misc);

function stripUndefinedDeep(value) {
  if (Array.isArray(value)) {
    return value.map(stripUndefinedDeep).filter((x) => x !== undefined);
  }
  if (value && typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (v === undefined) continue;
      const nv = stripUndefinedDeep(v);
      if (nv !== undefined) out[k] = nv;
    }
    return out;
  }
  return value;
}

fs.writeFileSync(
  outFile,
  JSON.stringify(stripUndefinedDeep(collection), null, 2),
  "utf8"
);
console.log("Wrote", outFile);
