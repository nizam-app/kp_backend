/**
 * Group 5 — Live QA against the connected DB (no HTTP server required).
 *
 * Verifies:
 * - Flag is on
 * - An ACTIVE unready MECHANIC/COMPANY gets PROVIDER_NOT_READY_TO_QUOTE
 * - Fleet audience message differs
 * - Ready synthetic user passes when flag is on
 * - Flag-off path still short-circuits (via deps override; does not flip DB)
 *
 * No Stripe mutations. No quote/job writes. No PII printed.
 *
 * Usage:
 *   node scripts/qaProviderQuoteReadiness.js
 */
import dotenv from "dotenv";
import mongoose from "mongoose";
import { ROLES, USER_STATUS } from "../src/constants/domain.js";
import { User } from "../src/modules/user/user.model.js";
import {
  assertProviderCanQuote,
  getProviderQuoteReadiness,
} from "../src/modules/user/providerReadiness.service.js";
import {
  getEnforceProviderQuoteReadiness,
  getOrCreatePlatformSettings,
} from "../src/utils/platformFee.js";
import { isStripePayoutRecipientReady } from "../src/modules/billing/payoutRecipient.service.js";

dotenv.config();

const must = (key) => {
  const v = `${process.env[key] || ""}`.trim();
  if (!v) throw new Error(`Missing ${key} in environment`);
  return v;
};

const readyConnect = {
  stripeConnectAccountId: "acct_qa_ready",
  stripeConnectOnboardingComplete: true,
  stripeConnectDetailsSubmitted: true,
  stripeConnectChargesEnabled: true,
  stripeConnectTransfersEnabled: true,
  stripeConnectPayoutsEnabled: true,
  stripeConnectStatusUpdatedAt: new Date(),
};

const pass = (label) => console.log(`PASS  ${label}`);
const fail = (label, detail) => {
  console.error(`FAIL  ${label}${detail ? `: ${detail}` : ""}`);
  throw new Error(label);
};

async function run() {
  must("MONGODB_URL");
  await mongoose.connect(process.env.MONGODB_URL);
  await getOrCreatePlatformSettings();

  if (!getEnforceProviderQuoteReadiness()) {
    fail(
      "flag enabled",
      "enforceProviderQuoteReadiness is false — run setEnforceProviderQuoteReadiness.js --enable first"
    );
  }
  pass("flag enabled");

  const unready = await User.findOne({
    status: USER_STATUS.ACTIVE,
    role: { $in: [ROLES.MECHANIC, ROLES.COMPANY] },
  })
    .select("role mechanicProfile companyProfile")
    .lean();

  if (!unready) {
    fail("find ACTIVE provider", "none in database");
  }

  const readiness = await getProviderQuoteReadiness(unready, {
    syncIfStale: false,
  });
  if (readiness.ready) {
    console.log(
      "NOTE  sampled provider is already ready; searching for an unready one…"
    );
  }

  let sample = unready;
  if (readiness.ready) {
    const cursor = User.find({
      status: USER_STATUS.ACTIVE,
      role: { $in: [ROLES.MECHANIC, ROLES.COMPANY] },
    })
      .select("role mechanicProfile companyProfile")
      .lean()
      .cursor();
    sample = null;
    for await (const u of cursor) {
      const r = await getProviderQuoteReadiness(u, { syncIfStale: false });
      if (!r.ready) {
        sample = u;
        break;
      }
    }
    if (!sample) {
      fail("find unready provider", "all ACTIVE providers are fully ready");
    }
  }

  pass(`sampled unready ${sample.role}`);

  try {
    await assertProviderCanQuote(sample, { syncIfStale: false });
    fail("unready provider blocked");
  } catch (err) {
    if (err?.statusCode !== 409 || err?.data?.code !== "PROVIDER_NOT_READY_TO_QUOTE") {
      fail(
        "unready provider blocked",
        `expected 409 PROVIDER_NOT_READY_TO_QUOTE, got ${err?.statusCode} ${err?.data?.code}`
      );
    }
    if (
      !/Complete your profile and payment setup before submitting quotes/.test(
        err.message || ""
      )
    ) {
      fail("provider English message", err.message);
    }
    pass("unready submit path → 409 PROVIDER_NOT_READY_TO_QUOTE");
  }

  try {
    await assertProviderCanQuote(sample, {
      syncIfStale: false,
      audience: "fleet",
    });
    fail("fleet audience blocked");
  } catch (err) {
    if (err?.data?.code !== "PROVIDER_NOT_READY_TO_QUOTE") {
      fail("fleet audience code", err?.data?.code);
    }
    if (
      !/This provider must complete their profile and payment setup before the quote can be accepted/.test(
        err.message || ""
      )
    ) {
      fail("fleet English message", err.message);
    }
    if (err?.data?.profileCompletion?.missing !== undefined) {
      fail("fleet omits missing list", "missing was present");
    }
    pass("fleet accept path → 409 + Fleet message (no missing list)");
  }

  const syntheticReady = {
    _id: new mongoose.Types.ObjectId(),
    role: ROLES.MECHANIC,
    mechanicProfile: {
      displayName: "QA Ready",
      phone: "+441111111111",
      ...readyConnect,
    },
  };
  // Bypass real profile completion by injecting deps.
  const allowed = await assertProviderCanQuote(syntheticReady, {
    syncIfStale: false,
    deps: {
      getEnforceProviderQuoteReadiness: () => true,
      getProfileCompletionSummary: async () => ({
        profileCompletion: { isComplete: true, percentage: 100, missing: [] },
      }),
      isStripePayoutRecipientReady,
    },
  });
  if (!allowed?.ready) {
    fail("ready provider allowed", JSON.stringify(allowed));
  }
  pass("ready provider allowed when flag on");

  const shortCircuit = await assertProviderCanQuote(sample, {
    syncIfStale: true,
    deps: {
      getEnforceProviderQuoteReadiness: () => false,
    },
  });
  if (shortCircuit !== null) {
    fail("flag-off short-circuit", "expected null");
  }
  pass("flag-off short-circuit (rollback behaviour)");

  console.log("\nQA matrix complete.");
  await mongoose.disconnect();
}

run().catch(async (err) => {
  console.error(err?.message || err);
  try {
    await mongoose.disconnect();
  } catch {
    /* ignore */
  }
  process.exit(1);
});
