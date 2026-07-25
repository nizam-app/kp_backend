import { ROLES } from "../../constants/domain.js";
import AppError from "../../utils/AppError.js";
import { User } from "../user/user.model.js";

const populatedRecipient = (value) =>
  value &&
  typeof value === "object" &&
  value._id &&
  (value.role || value.companyProfile || value.mechanicProfile);

const loadRecipient = async (value) => {
  if (!value) return null;
  if (populatedRecipient(value) && value.role) return value;

  const id = value._id || value;
  return User.findById(id)
    .select("role companyProfile mechanicProfile")
    .lean();
};

const connectProfileFor = (recipient) =>
  recipient.role === ROLES.COMPANY
    ? recipient.companyProfile || {}
    : recipient.mechanicProfile || {};

export const isStripePayoutRecipientReady = (recipient) => {
  const profile = connectProfileFor(recipient);
  return Boolean(
    profile.stripeConnectAccountId &&
      profile.stripeConnectOnboardingComplete &&
      profile.stripeConnectDetailsSubmitted &&
      profile.stripeConnectChargesEnabled &&
      profile.stripeConnectTransfersEnabled &&
      profile.stripeConnectPayoutsEnabled
  );
};

/**
 * A company owns every company-job payout. Only a standalone MECHANIC can own
 * an independent-job payout; MECHANIC_EMPLOYEE is never a payout recipient.
 */
export const resolvePayoutRecipient = async (job, { requireStripeReady = true } = {}) => {
  const recipient = await loadRecipient(job?.assignedCompany || job?.assignedMechanic);
  if (!recipient) {
    throw new AppError("This job has no payout recipient", 400);
  }

  const expectedRole = job?.assignedCompany ? ROLES.COMPANY : ROLES.MECHANIC;
  if (recipient.role !== expectedRole) {
    const message =
      recipient.role === ROLES.MECHANIC_EMPLOYEE
        ? "Employee mechanics cannot receive job payouts"
        : "The job payout recipient is invalid";
    throw new AppError(message, 400);
  }

  const profile = connectProfileFor(recipient);
  if (requireStripeReady && !isStripePayoutRecipientReady(recipient)) {
    throw new AppError(
      `${
        expectedRole === ROLES.COMPANY ? "Company" : "Mechanic"
      } Stripe Connect onboarding must be completed before payment`,
      409,
      { code: "PAYOUT_SETUP_INCOMPLETE" }
    );
  }

  return {
    user: recipient,
    userId: recipient._id,
    recipientType: expectedRole,
    stripeConnectAccountId: profile.stripeConnectAccountId || null,
  };
};

const toMinor = (amount) => Math.round(Number(amount || 0) * 100);

/** Integer-only fee and destination amounts used by Stripe destination charges. */
export const calculateDestinationChargeAmounts = ({
  subtotal,
  vatAmount = 0,
  platformFeePercent = 12,
}) => {
  const subtotalMinor = toMinor(subtotal);
  const vatMinor = toMinor(vatAmount);
  const feeBasisPoints = Math.round(Number(platformFeePercent) * 100);

  if (subtotalMinor <= 0 || vatMinor < 0 || !Number.isFinite(feeBasisPoints)) {
    throw new AppError("Invalid payout amounts", 400);
  }

  const platformFeeMinor = Math.round((subtotalMinor * feeBasisPoints) / 10_000);
  const chargeAmountMinor = subtotalMinor + vatMinor;
  const recipientAmountMinor = chargeAmountMinor - platformFeeMinor;

  if (platformFeeMinor < 0 || recipientAmountMinor <= 0) {
    throw new AppError("Invalid payout split", 400);
  }

  return {
    subtotalMinor,
    vatMinor,
    chargeAmountMinor,
    platformFeeMinor,
    recipientAmountMinor,
  };
};
