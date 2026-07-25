/**
 * Group 0.5 — Read-only impact report for provider quote readiness.
 *
 * Counts ACTIVE MECHANIC and COMPANY users who would be blocked when
 * enforceProviderQuoteReadiness is enabled.
 *
 * - No writes
 * - No Stripe API calls (local Connect flags only; syncIfStale: false)
 * - No profile updates
 * - Counts only (no emails, account IDs, or other PII)
 *
 * Usage:
 *   node scripts/reportProviderQuoteReadiness.js
 *
 * Requires MONGODB_URL in the environment / .env.
 */
import dotenv from "dotenv";
import mongoose from "mongoose";
import { ROLES, USER_STATUS } from "../src/constants/domain.js";
import { User } from "../src/modules/user/user.model.js";
import {
  PROVIDER_CONNECT_SYNC_TTL_MS,
  getProviderQuoteReadiness,
} from "../src/modules/user/providerReadiness.service.js";

dotenv.config();

const must = (key) => {
  const v = `${process.env[key] || ""}`.trim();
  if (!v) throw new Error(`Missing ${key} in environment`);
  return v;
};

const emptyBucket = () => ({
  total: 0,
  fullyReady: 0,
  profileIncompleteOnly: 0,
  payoutIncompleteOnly: 0,
  bothIncomplete: 0,
  noConnectAccount: 0,
  hasConnectAccountNotReady: 0,
  potentiallyStaleConnectStatus: 0,
});

const connectProfileFor = (user) =>
  user.role === ROLES.COMPANY
    ? user.companyProfile || {}
    : user.mechanicProfile || {};

const hasConnectAccount = (profile) =>
  Boolean(`${profile?.stripeConnectAccountId || ""}`.trim());

const isConnectStatusStale = (profile) => {
  const updatedAt = profile?.stripeConnectStatusUpdatedAt;
  if (!updatedAt) return true;
  const ts = new Date(updatedAt).getTime();
  if (!Number.isFinite(ts)) return true;
  return Date.now() - ts > PROVIDER_CONNECT_SYNC_TTL_MS;
};

const printBucket = (label, bucket) => {
  const blocked =
    bucket.profileIncompleteOnly +
    bucket.payoutIncompleteOnly +
    bucket.bothIncomplete;
  console.log(`\n=== ${label} ===`);
  console.log(`  total ACTIVE:                      ${bucket.total}`);
  console.log(`  fully ready:                       ${bucket.fullyReady}`);
  console.log(`  would be blocked (flag on):        ${blocked}`);
  console.log(`    profile incomplete only:         ${bucket.profileIncompleteOnly}`);
  console.log(`    payout incomplete only:          ${bucket.payoutIncompleteOnly}`);
  console.log(`    both incomplete:                 ${bucket.bothIncomplete}`);
  console.log(`  no Connect account:                ${bucket.noConnectAccount}`);
  console.log(`  has Connect account, not ready:    ${bucket.hasConnectAccountNotReady}`);
  console.log(
    `  potentially stale Connect status:  ${bucket.potentiallyStaleConnectStatus}`
  );
  console.log(
    `    (stale = account exists, not payout-ready, status older than ${PROVIDER_CONNECT_SYNC_TTL_MS / 60000} min or missing)`
  );
};

async function run() {
  const mongoUrl = must("MONGODB_URL");
  console.log("Provider quote readiness impact report (read-only)");
  console.log("Mode: local flags only — no Stripe sync, no writes");
  console.log(`TTL used for stale Connect status: ${PROVIDER_CONNECT_SYNC_TTL_MS}ms`);

  await mongoose.connect(mongoUrl);

  const filter = {
    status: USER_STATUS.ACTIVE,
    role: { $in: [ROLES.MECHANIC, ROLES.COMPANY] },
  };

  const cursor = User.find(filter)
    .select(
      "role email status mechanicProfile companyProfile"
    )
    .lean()
    .cursor();

  const byRole = {
    [ROLES.MECHANIC]: emptyBucket(),
    [ROLES.COMPANY]: emptyBucket(),
  };
  const overall = emptyBucket();

  for await (const user of cursor) {
    const roleBucket = byRole[user.role];
    if (!roleBucket) continue;

    const readiness = await getProviderQuoteReadiness(user, {
      syncIfStale: false,
    });

    const apply = (bucket) => {
      bucket.total += 1;

      const profileOk = readiness.profile.isComplete;
      const payoutOk = readiness.payout.ready;
      const profile = connectProfileFor(user);
      const hasAccount = hasConnectAccount(profile);

      if (profileOk && payoutOk) {
        bucket.fullyReady += 1;
      } else if (!profileOk && payoutOk) {
        bucket.profileIncompleteOnly += 1;
      } else if (profileOk && !payoutOk) {
        bucket.payoutIncompleteOnly += 1;
      } else {
        bucket.bothIncomplete += 1;
      }

      if (!hasAccount) {
        bucket.noConnectAccount += 1;
      } else if (!payoutOk) {
        bucket.hasConnectAccountNotReady += 1;
        if (isConnectStatusStale(profile)) {
          bucket.potentiallyStaleConnectStatus += 1;
        }
      }
    };

    apply(roleBucket);
    apply(overall);
  }

  printBucket("MECHANIC", byRole[ROLES.MECHANIC]);
  printBucket("COMPANY", byRole[ROLES.COMPANY]);
  printBucket("ALL PROVIDERS (ACTIVE MECHANIC + COMPANY)", overall);

  console.log("\nNotes:");
  console.log(
    "- Counts use existing profileCompletion builders + isStripePayoutRecipientReady (local)."
  );
  console.log(
    "- Stripe was not contacted; stale/has-account counts may change after a live sync."
  );
  console.log(
    "- Review these numbers before enabling enforceProviderQuoteReadiness."
  );
  console.log("- No user identifiers, emails, or Stripe account IDs were printed.");

  await mongoose.disconnect();
}

run().catch(async (err) => {
  console.error("Report failed:", err.message || err);
  try {
    await mongoose.disconnect();
  } catch {
    // ignore
  }
  process.exitCode = 1;
});
