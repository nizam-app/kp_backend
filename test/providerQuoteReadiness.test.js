import test from "node:test";
import assert from "node:assert/strict";
import mongoose from "mongoose";
import { ROLES } from "../src/constants/domain.js";
import { resolvePayoutRecipient } from "../src/modules/billing/payoutRecipient.service.js";
import {
  PROVIDER_CONNECT_SYNC_TTL_MS,
  assertProviderCanQuote,
  getProviderQuoteReadiness,
  mapLocalPayoutStatus,
  mapStripeAccountPayoutStatus,
} from "../src/modules/user/providerReadiness.service.js";
import {
  getEnforceProviderQuoteReadiness,
  _setPlatformSettingsCacheForTests,
} from "../src/utils/platformFee.js";

const readyConnect = (accountId = "acct_ready") => ({
  stripeConnectAccountId: accountId,
  stripeConnectOnboardingComplete: true,
  stripeConnectDetailsSubmitted: true,
  stripeConnectChargesEnabled: true,
  stripeConnectTransfersEnabled: true,
  stripeConnectPayoutsEnabled: true,
  stripeConnectStatusUpdatedAt: new Date(),
});

const incompleteConnect = (accountId = "acct_incomplete") => ({
  stripeConnectAccountId: accountId,
  stripeConnectOnboardingComplete: false,
  stripeConnectDetailsSubmitted: false,
  stripeConnectChargesEnabled: false,
  stripeConnectTransfersEnabled: false,
  stripeConnectPayoutsEnabled: false,
  stripeConnectStatusUpdatedAt: new Date(),
});

const staleTimestamp = () =>
  new Date(Date.now() - PROVIDER_CONNECT_SYNC_TTL_MS - 60_000);

const mechanicUser = (profileOverrides = {}) => ({
  _id: new mongoose.Types.ObjectId(),
  role: ROLES.MECHANIC,
  email: "mechanic@example.com",
  mechanicProfile: {
    displayName: "Alex Mechanic",
    phone: "+441111111111",
    ...incompleteConnect(),
    ...profileOverrides,
  },
});

const companyUser = (profileOverrides = {}) => ({
  _id: new mongoose.Types.ObjectId(),
  role: ROLES.COMPANY,
  email: "company@example.com",
  companyProfile: {
    companyName: "Acme Repairs",
    ...incompleteConnect("acct_company"),
    ...profileOverrides,
  },
});

const completeProfile = {
  isComplete: true,
  percentage: 100,
  missing: [],
};

const incompleteProfile = {
  isComplete: false,
  percentage: 67,
  missing: ["Rates & Coverage"],
};

const depsWith = ({
  profile = completeProfile,
  syncMechanic,
  syncCompany,
  enforce = true,
  profileCalls,
  syncCalls,
} = {}) => ({
  getProfileCompletionSummary: async () => {
    if (profileCalls) profileCalls.count += 1;
    return { profileCompletion: profile };
  },
  syncMechanicStripeConnectAccount: async (user) => {
    if (syncCalls) syncCalls.mechanic += 1;
    if (typeof syncMechanic === "function") return syncMechanic(user);
    return null;
  },
  syncCompanyStripeConnectAccount: async (user) => {
    if (syncCalls) syncCalls.company += 1;
    if (typeof syncCompany === "function") return syncCompany(user);
    return null;
  },
  getEnforceProviderQuoteReadiness: () => enforce === true,
});

test("mapLocalPayoutStatus covers not_started, needs_onboarding, under_review, ready", () => {
  assert.equal(mapLocalPayoutStatus({}, false), "not_started");
  assert.equal(
    mapLocalPayoutStatus(
      { stripeConnectAccountId: "acct_1", stripeConnectDetailsSubmitted: false },
      false
    ),
    "needs_onboarding"
  );
  assert.equal(
    mapLocalPayoutStatus(
      { stripeConnectAccountId: "acct_1", stripeConnectDetailsSubmitted: true },
      false
    ),
    "under_review"
  );
  assert.equal(mapLocalPayoutStatus(readyConnect(), true), "ready");
});

test("mapStripeAccountPayoutStatus never invents ready without full capabilities", () => {
  assert.equal(mapStripeAccountPayoutStatus(null), "not_started");
  assert.equal(
    mapStripeAccountPayoutStatus({ details_submitted: false }),
    "needs_onboarding"
  );
  assert.equal(
    mapStripeAccountPayoutStatus({
      details_submitted: true,
      charges_enabled: true,
      payouts_enabled: true,
      capabilities: { transfers: "active" },
    }),
    "ready"
  );
  assert.equal(
    mapStripeAccountPayoutStatus({
      details_submitted: true,
      charges_enabled: true,
      payouts_enabled: false,
      capabilities: { transfers: "active" },
      requirements: { currently_due: ["external_account"] },
    }),
    "additional_information_required"
  );
});

test("getEnforceProviderQuoteReadiness defaults false when unset", () => {
  _setPlatformSettingsCacheForTests({
    enforceProviderQuoteReadiness: undefined,
  });
  assert.equal(getEnforceProviderQuoteReadiness(), false);

  _setPlatformSettingsCacheForTests({
    enforceProviderQuoteReadiness: false,
  });
  assert.equal(getEnforceProviderQuoteReadiness(), false);

  _setPlatformSettingsCacheForTests({
    enforceProviderQuoteReadiness: true,
  });
  assert.equal(getEnforceProviderQuoteReadiness(), true);

  _setPlatformSettingsCacheForTests({});
});

const runRoleMatrix = (roleLabel, buildUser, profileKey) => {
  test(`${roleLabel}: profile complete + payout ready => ready`, async () => {
    const user = buildUser(readyConnect());
    const result = await getProviderQuoteReadiness(user, {
      deps: depsWith({ profile: completeProfile }),
    });
    assert.equal(result.ready, true);
    assert.deepEqual(result.blockers, []);
    assert.equal(result.payout.status, "ready");
    assert.equal(result.payout.hasAccount, true);
  });

  test(`${roleLabel}: profile complete + payout incomplete => PAYMENT_SETUP_INCOMPLETE`, async () => {
    const user = buildUser(incompleteConnect());
    const result = await getProviderQuoteReadiness(user, {
      syncIfStale: false,
      deps: depsWith({ profile: completeProfile }),
    });
    assert.equal(result.ready, false);
    assert.deepEqual(result.blockers, ["PAYMENT_SETUP_INCOMPLETE"]);
    assert.equal(result.payout.ready, false);
  });

  test(`${roleLabel}: profile incomplete + payout ready => PROFILE_INCOMPLETE`, async () => {
    const user = buildUser(readyConnect());
    const result = await getProviderQuoteReadiness(user, {
      deps: depsWith({ profile: incompleteProfile }),
    });
    assert.equal(result.ready, false);
    assert.deepEqual(result.blockers, ["PROFILE_INCOMPLETE"]);
  });

  test(`${roleLabel}: both incomplete => both blockers`, async () => {
    const user = buildUser({});
    delete user[profileKey].stripeConnectAccountId;
    const result = await getProviderQuoteReadiness(user, {
      deps: depsWith({ profile: incompleteProfile }),
    });
    assert.equal(result.ready, false);
    assert.deepEqual(result.blockers, [
      "PROFILE_INCOMPLETE",
      "PAYMENT_SETUP_INCOMPLETE",
    ]);
    assert.equal(result.payout.status, "not_started");
  });

  test(`${roleLabel}: no Connect account => not_started and no sync`, async () => {
    const syncCalls = { mechanic: 0, company: 0 };
    const user = buildUser({});
    delete user[profileKey].stripeConnectAccountId;
    const result = await getProviderQuoteReadiness(user, {
      deps: depsWith({ profile: completeProfile, syncCalls }),
    });
    assert.equal(result.payout.status, "not_started");
    assert.equal(syncCalls.mechanic, 0);
    assert.equal(syncCalls.company, 0);
  });

  test(`${roleLabel}: stale incomplete account triggers role sync once`, async () => {
    const syncCalls = { mechanic: 0, company: 0 };
    const user = buildUser({
      ...incompleteConnect(),
      stripeConnectStatusUpdatedAt: staleTimestamp(),
    });
    await getProviderQuoteReadiness(user, {
      deps: depsWith({
        profile: completeProfile,
        syncCalls,
        syncMechanic: async () => ({
          details_submitted: false,
          charges_enabled: false,
          payouts_enabled: false,
          capabilities: { transfers: "inactive" },
        }),
        syncCompany: async () => ({
          details_submitted: false,
          charges_enabled: false,
          payouts_enabled: false,
          capabilities: { transfers: "inactive" },
        }),
      }),
    });
    if (roleLabel === "MECHANIC") {
      assert.equal(syncCalls.mechanic, 1);
      assert.equal(syncCalls.company, 0);
    } else {
      assert.equal(syncCalls.company, 1);
      assert.equal(syncCalls.mechanic, 0);
    }
  });

  test(`${roleLabel}: fresh incomplete account does not sync`, async () => {
    const syncCalls = { mechanic: 0, company: 0 };
    const user = buildUser({
      ...incompleteConnect(),
      stripeConnectStatusUpdatedAt: new Date(),
    });
    await getProviderQuoteReadiness(user, {
      deps: depsWith({ profile: completeProfile, syncCalls }),
    });
    assert.equal(syncCalls.mechanic, 0);
    assert.equal(syncCalls.company, 0);
  });

  test(`${roleLabel}: locally ready does not sync`, async () => {
    const syncCalls = { mechanic: 0, company: 0 };
    const user = buildUser({
      ...readyConnect(),
      stripeConnectStatusUpdatedAt: staleTimestamp(),
    });
    await getProviderQuoteReadiness(user, {
      deps: depsWith({ profile: completeProfile, syncCalls }),
    });
    assert.equal(syncCalls.mechanic, 0);
    assert.equal(syncCalls.company, 0);
  });

  test(`${roleLabel}: failed sync does not mark ready`, async () => {
    const user = buildUser({
      ...incompleteConnect(),
      stripeConnectStatusUpdatedAt: staleTimestamp(),
    });
    const result = await getProviderQuoteReadiness(user, {
      deps: depsWith({
        profile: completeProfile,
        syncMechanic: async () => {
          throw new Error("stripe down");
        },
        syncCompany: async () => {
          throw new Error("stripe down");
        },
      }),
    });
    assert.equal(result.ready, false);
    assert.equal(result.payout.ready, false);
    assert.ok(result.blockers.includes("PAYMENT_SETUP_INCOMPLETE"));
  });
};

runRoleMatrix("MECHANIC", mechanicUser, "mechanicProfile");
runRoleMatrix("COMPANY", companyUser, "companyProfile");

test("assertProviderCanQuote returns null immediately when flag is false", async () => {
  const profileCalls = { count: 0 };
  const syncCalls = { mechanic: 0, company: 0 };
  const result = await assertProviderCanQuote(mechanicUser(readyConnect()), {
    deps: depsWith({
      enforce: false,
      profileCalls,
      syncCalls,
      profile: completeProfile,
    }),
  });
  assert.equal(result, null);
  assert.equal(profileCalls.count, 0);
  assert.equal(syncCalls.mechanic, 0);
});

test("assertProviderCanQuote allows ready provider when flag is true", async () => {
  const readiness = await assertProviderCanQuote(
    mechanicUser(readyConnect()),
    {
      deps: depsWith({ enforce: true, profile: completeProfile }),
    }
  );
  assert.equal(readiness.ready, true);
});

test("assertProviderCanQuote throws PROVIDER_NOT_READY_TO_QUOTE when unready", async () => {
  await assert.rejects(
    () =>
      assertProviderCanQuote(mechanicUser(incompleteConnect()), {
        syncIfStale: false,
        deps: depsWith({ enforce: true, profile: incompleteProfile }),
      }),
    (err) => {
      assert.equal(err.statusCode, 409);
      assert.equal(err.message, "Complete your profile and payment setup before submitting quotes");
      assert.equal(err.data.code, "PROVIDER_NOT_READY_TO_QUOTE");
      assert.deepEqual(err.data.blockers, [
        "PROFILE_INCOMPLETE",
        "PAYMENT_SETUP_INCOMPLETE",
      ]);
      assert.equal(err.data.profileCompletion.isComplete, false);
      assert.equal(err.data.payoutSetup.ready, false);
      assert.equal(err.data.payoutSetup.accountId, undefined);
      return true;
    }
  );
});

test("assertProviderCanQuote fleet audience uses Fleet-facing message", async () => {
  await assert.rejects(
    () =>
      assertProviderCanQuote(mechanicUser(incompleteConnect()), {
        syncIfStale: false,
        audience: "fleet",
        deps: depsWith({ enforce: true, profile: completeProfile }),
      }),
    (err) => {
      assert.equal(err.statusCode, 409);
      assert.equal(err.data.code, "PROVIDER_NOT_READY_TO_QUOTE");
      assert.match(
        err.message,
        /This provider must complete their profile and payment setup before the quote can be accepted/
      );
      assert.ok(Array.isArray(err.data.blockers));
      assert.equal(err.data.profileCompletion?.missing, undefined);
      return true;
    }
  );
});

test("assertProviderCanQuote fleet audience is skipped when flag is off", async () => {
  const result = await assertProviderCanQuote(mechanicUser(incompleteConnect()), {
    syncIfStale: true,
    audience: "fleet",
    deps: depsWith({ enforce: false, profile: incompleteProfile }),
  });
  assert.equal(result, null);
});

test("non-provider roles are not ready", async () => {
  for (const role of [ROLES.FLEET, ROLES.ADMIN, ROLES.MECHANIC_EMPLOYEE]) {
    const result = await getProviderQuoteReadiness({ role }, {
      deps: depsWith({ profile: completeProfile }),
    });
    assert.equal(result.ready, false);
  }
});

test("payment-time resolvePayoutRecipient includes PAYOUT_SETUP_INCOMPLETE code", async () => {
  const mechanic = {
    _id: new mongoose.Types.ObjectId(),
    role: ROLES.MECHANIC,
    mechanicProfile: {
      ...incompleteConnect("acct_pay"),
      stripeConnectDetailsSubmitted: true,
    },
  };

  await assert.rejects(
    () => resolvePayoutRecipient({ assignedMechanic: mechanic }),
    (err) => {
      assert.equal(err.statusCode, 409);
      assert.match(
        err.message,
        /Mechanic Stripe Connect onboarding must be completed before payment/
      );
      assert.equal(err.data?.code, "PAYOUT_SETUP_INCOMPLETE");
      return true;
    }
  );
});

test("payment-time ready recipient still succeeds without error code path", async () => {
  const mechanic = {
    _id: new mongoose.Types.ObjectId(),
    role: ROLES.MECHANIC,
    mechanicProfile: readyConnect("acct_ok"),
  };
  const result = await resolvePayoutRecipient({ assignedMechanic: mechanic });
  assert.equal(result.stripeConnectAccountId, "acct_ok");
});

test("buildLocalPayoutReadinessSummary for MECHANIC/COMPANY; null for others", async () => {
  const { buildLocalPayoutReadinessSummary } = await import(
    "../src/modules/user/providerReadiness.service.js"
  );

  const mechanicReady = buildLocalPayoutReadinessSummary(
    mechanicUser(readyConnect())
  );
  assert.equal(mechanicReady.ready, true);
  assert.equal(mechanicReady.status, "ready");
  assert.equal(mechanicReady.hasAccount, true);
  assert.equal(mechanicReady.accountId, undefined);

  const companyIncomplete = buildLocalPayoutReadinessSummary(
    companyUser(incompleteConnect())
  );
  assert.equal(companyIncomplete.ready, false);
  assert.equal(companyIncomplete.hasAccount, true);
  assert.ok(
    ["needs_onboarding", "under_review", "not_started"].includes(
      companyIncomplete.status
    )
  );

  assert.equal(buildLocalPayoutReadinessSummary({ role: ROLES.FLEET }), null);
  assert.equal(
    buildLocalPayoutReadinessSummary({ role: ROLES.MECHANIC_EMPLOYEE }),
    null
  );
  assert.equal(buildLocalPayoutReadinessSummary({ role: ROLES.ADMIN }), null);
});
