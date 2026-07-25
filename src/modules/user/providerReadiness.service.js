import { ROLES } from "../../constants/domain.js";
import AppError from "../../utils/AppError.js";
import { getEnforceProviderQuoteReadiness } from "../../utils/platformFee.js";
import { isStripePayoutRecipientReady } from "../billing/payoutRecipient.service.js";
import {
  syncCompanyStripeConnectAccount,
  syncMechanicStripeConnectAccount,
  stripeConnectStatusFields,
} from "../billing/stripe.service.js";
import { getProfileCompletionSummary } from "./user.service.js";

/** How long a stored Connect status may be reused before a live Stripe sync. */
export const PROVIDER_CONNECT_SYNC_TTL_MS = 5 * 60 * 1000;

const connectProfileFor = (user) =>
  user?.role === ROLES.COMPANY
    ? user.companyProfile || {}
    : user.mechanicProfile || {};

const hasConnectAccount = (profile) =>
  Boolean(`${profile?.stripeConnectAccountId || ""}`.trim());

/**
 * Local-only payout readiness for GET /users/me (no Stripe sync).
 * Returns null for non-payout-recipient roles.
 */
export const buildLocalPayoutReadinessSummary = (user) => {
  if (![ROLES.MECHANIC, ROLES.COMPANY].includes(user?.role)) {
    return null;
  }
  const profile = connectProfileFor(user);
  const ready = isStripePayoutRecipientReady(user);
  return {
    ready,
    status: mapLocalPayoutStatus(profile, ready),
    hasAccount: hasConnectAccount(profile),
  };
};

/**
 * Safe public payout status from local Connect flags (no Stripe account object).
 * Never returns "ready" unless isStripePayoutRecipientReady would be true.
 */
export const mapLocalPayoutStatus = (profile, payoutReady) => {
  if (payoutReady) return "ready";
  if (!hasConnectAccount(profile)) return "not_started";
  if (!profile.stripeConnectDetailsSubmitted) return "needs_onboarding";
  return "under_review";
};

/**
 * Map a live Stripe Connect account object to the shared status vocabulary.
 * Mirrors billing.service getStripePayoutAccountStatus without exporting it.
 */
export const mapStripeAccountPayoutStatus = (account) => {
  if (!account) return "not_started";
  const transfersEnabled = account.capabilities?.transfers === "active";
  const ready =
    Boolean(account.details_submitted) &&
    Boolean(account.charges_enabled) &&
    transfersEnabled &&
    Boolean(account.payouts_enabled);
  if (ready) return "ready";
  if (!account.details_submitted) return "needs_onboarding";

  const requirements = account.requirements || {};
  const disabledReason = String(requirements.disabled_reason || "");
  if (
    disabledReason.includes("pending_verification") ||
    disabledReason.includes("under_review")
  ) {
    return "under_review";
  }
  if (
    (requirements.currently_due || []).length > 0 ||
    (requirements.past_due || []).length > 0
  ) {
    return "additional_information_required";
  }
  if (disabledReason) return "restricted";
  return "under_review";
};

const isConnectStatusStale = (profile) => {
  const updatedAt = profile?.stripeConnectStatusUpdatedAt;
  if (!updatedAt) return true;
  const ts = new Date(updatedAt).getTime();
  if (!Number.isFinite(ts)) return true;
  return Date.now() - ts > PROVIDER_CONNECT_SYNC_TTL_MS;
};

const applyConnectFieldsToUser = (user, fields) => {
  const profilePath =
    user.role === ROLES.COMPANY ? "companyProfile" : "mechanicProfile";
  const nextProfile = { ...(user[profilePath] || {}), ...fields };
  if (user.role === ROLES.COMPANY) {
    user.companyProfile = nextProfile;
  } else {
    user.mechanicProfile = nextProfile;
  }
  return user;
};

const emptyProfileSummary = () => ({
  isComplete: false,
  percentage: 0,
  missing: [],
});

const resolveDeps = (deps = {}) => ({
  getProfileCompletionSummary:
    deps.getProfileCompletionSummary || getProfileCompletionSummary,
  isStripePayoutRecipientReady:
    deps.isStripePayoutRecipientReady || isStripePayoutRecipientReady,
  syncMechanicStripeConnectAccount:
    deps.syncMechanicStripeConnectAccount || syncMechanicStripeConnectAccount,
  syncCompanyStripeConnectAccount:
    deps.syncCompanyStripeConnectAccount || syncCompanyStripeConnectAccount,
  getEnforceProviderQuoteReadiness:
    deps.getEnforceProviderQuoteReadiness || getEnforceProviderQuoteReadiness,
});

const syncConnectIfNeeded = async (user, deps) => {
  const profile = connectProfileFor(user);
  if (!hasConnectAccount(profile)) {
    return { user, account: null, synced: false };
  }
  if (!isConnectStatusStale(profile)) {
    return { user, account: null, synced: false };
  }

  try {
    const account =
      user.role === ROLES.COMPANY
        ? await deps.syncCompanyStripeConnectAccount(user)
        : await deps.syncMechanicStripeConnectAccount(user);

    if (account) {
      applyConnectFieldsToUser(user, stripeConnectStatusFields(account));
    }
    return { user, account, synced: true };
  } catch {
    // Keep local unready state; never invent readiness on sync failure.
    return { user, account: null, synced: false, syncFailed: true };
  }
};

/**
 * Composite quote readiness for MECHANIC / COMPANY.
 * Does not read the rollout flag — callers that enforce must use assertProviderCanQuote.
 *
 * Optional `deps` overrides exist for unit tests (no production callers).
 */
export const getProviderQuoteReadiness = async (
  user,
  { syncIfStale = true, deps: depsInput } = {}
) => {
  const deps = resolveDeps(depsInput);

  if (![ROLES.MECHANIC, ROLES.COMPANY].includes(user?.role)) {
    return {
      ready: false,
      profile: emptyProfileSummary(),
      payout: {
        ready: false,
        status: "not_started",
        hasAccount: false,
      },
      blockers: ["PROFILE_INCOMPLETE", "PAYMENT_SETUP_INCOMPLETE"],
    };
  }

  const { profileCompletion } = await deps.getProfileCompletionSummary(user);
  const profile = {
    isComplete: Boolean(profileCompletion?.isComplete),
    percentage: Number.isFinite(profileCompletion?.percentage)
      ? profileCompletion.percentage
      : 0,
    missing: Array.isArray(profileCompletion?.missing)
      ? profileCompletion.missing
      : [],
  };

  let workingUser = user;
  let payoutReady = deps.isStripePayoutRecipientReady(workingUser);
  let payoutStatus = mapLocalPayoutStatus(
    connectProfileFor(workingUser),
    payoutReady
  );
  let hasAccount = hasConnectAccount(connectProfileFor(workingUser));

  if (syncIfStale && !payoutReady && hasAccount) {
    const syncResult = await syncConnectIfNeeded(workingUser, deps);
    workingUser = syncResult.user;
    payoutReady = deps.isStripePayoutRecipientReady(workingUser);
    hasAccount = hasConnectAccount(connectProfileFor(workingUser));
    if (syncResult.account) {
      payoutStatus = mapStripeAccountPayoutStatus(syncResult.account);
      if (payoutReady) payoutStatus = "ready";
      if (!payoutReady && payoutStatus === "ready") {
        payoutStatus = "under_review";
      }
    } else {
      payoutStatus = mapLocalPayoutStatus(
        connectProfileFor(workingUser),
        payoutReady
      );
    }
  } else if (payoutReady) {
    payoutStatus = "ready";
  }

  // Final safety: never claim ready status without the payment gate boolean.
  if (payoutReady) {
    payoutStatus = "ready";
  } else if (payoutStatus === "ready") {
    payoutStatus = "under_review";
  }

  const blockers = [];
  if (!profile.isComplete) blockers.push("PROFILE_INCOMPLETE");
  if (!payoutReady) blockers.push("PAYMENT_SETUP_INCOMPLETE");

  return {
    ready: profile.isComplete && payoutReady,
    profile,
    payout: {
      ready: payoutReady,
      status: payoutStatus,
      hasAccount,
    },
    blockers,
  };
};

const providerNotReadyMessage = (audience) =>
  audience === "fleet"
    ? "This provider must complete their profile and payment setup before the quote can be accepted"
    : "Complete your profile and payment setup before submitting quotes";

/**
 * Flag-first gate for quote submit/amend.
 * When enforceProviderQuoteReadiness is false: returns null immediately
 * (no profile queries, no Stripe sync).
 */
export const assertProviderCanQuote = async (
  user,
  { syncIfStale = true, audience = "provider", deps: depsInput } = {}
) => {
  const deps = resolveDeps(depsInput);

  if (!deps.getEnforceProviderQuoteReadiness()) {
    return null;
  }

  const readiness = await getProviderQuoteReadiness(user, {
    syncIfStale,
    deps,
  });
  if (readiness.ready) {
    return readiness;
  }

  throw new AppError(providerNotReadyMessage(audience), 409, {
    code: "PROVIDER_NOT_READY_TO_QUOTE",
    blockers: readiness.blockers,
    profileCompletion:
      audience === "fleet"
        ? {
            isComplete: readiness.profile.isComplete,
          }
        : {
            percentage: readiness.profile.percentage,
            isComplete: readiness.profile.isComplete,
            missing: readiness.profile.missing,
          },
    payoutSetup: {
      ready: readiness.payout.ready,
      status: readiness.payout.status,
    },
  });
};
