import { ROLES } from "../constants/domain.js";

const money2 = (value) =>
  Math.round((Number(value || 0) + Number.EPSILON) * 100) / 100;

/** Rate fields controlled by the employer for MECHANIC_EMPLOYEE accounts. */
export const COMPANY_CONTROLLED_RATE_KEYS = Object.freeze([
  "hourlyRate",
  "emergencyRate",
  "emergencySurcharge",
  "callOutFee",
  "callOutCharge",
  "rateCurrency",
]);

/**
 * Source-of-truth rate profile for quoting / commercial terms.
 * Company accounts use companyProfile; independent mechanics use mechanicProfile.
 */
export const getProviderRateProfile = (provider) => {
  if (!provider || typeof provider !== "object") return {};
  if (provider.role === ROLES.COMPANY) {
    return provider.companyProfile || {};
  }
  return provider.mechanicProfile || {};
};

/**
 * Resolve the hourly rate + call-out fee used for billing.
 * Emergency jobs prefer emergencyRate when set and > 0.
 */
export const resolveBillingRates = ({ profile = {}, jobMode } = {}) => {
  const standardRate = Number(profile.hourlyRate);
  const emergencyRate = Number(profile.emergencyRate);
  const isEmergency = `${jobMode || ""}`.toUpperCase() === "EMERGENCY";
  const hourlyRate =
    isEmergency && Number.isFinite(emergencyRate) && emergencyRate > 0
      ? emergencyRate
      : standardRate;
  const callOutFee = money2(profile.callOutFee);

  return {
    rateType: isEmergency ? "EMERGENCY" : "STANDARD",
    standardRate: Number.isFinite(standardRate) ? money2(standardRate) : null,
    emergencyRate: Number.isFinite(emergencyRate) ? money2(emergencyRate) : null,
    hourlyRate: Number.isFinite(hourlyRate) ? money2(hourlyRate) : null,
    callOutFee: Number.isFinite(callOutFee) ? callOutFee : null,
  };
};

/**
 * Prefer accepted-quote snapshot rates; otherwise live provider profile rates.
 * Used when building or locking invoice call-out / labour £/hr.
 */
export const resolveInvoiceCommercialRates = ({
  acceptedQuotePricing,
  provider,
  jobMode,
} = {}) => {
  if (acceptedQuotePricing && typeof acceptedQuotePricing === "object") {
    const hourlyRate = Number(acceptedQuotePricing.hourlyRate);
    const callOutFee = Number(acceptedQuotePricing.callOutFee);
    if (Number.isFinite(hourlyRate) && Number.isFinite(callOutFee)) {
      return {
        source: "QUOTE_SNAPSHOT",
        rateType:
          acceptedQuotePricing.rateType ||
          (`${jobMode || ""}`.toUpperCase() === "EMERGENCY"
            ? "EMERGENCY"
            : "STANDARD"),
        hourlyRate: money2(hourlyRate),
        callOutFee: money2(callOutFee),
      };
    }
  }

  const profile = getProviderRateProfile(provider);
  const resolved = resolveBillingRates({ profile, jobMode });
  return {
    source: "PROFILE_FALLBACK",
    rateType: resolved.rateType,
    hourlyRate: resolved.hourlyRate,
    callOutFee: resolved.callOutFee,
  };
};

/** Overlay company-controlled rates onto an employee mechanicProfile for API display. */
export const applyCompanyRatesToMechanicProfile = (
  mechanicProfile = {},
  companyProfile = {}
) => ({
  ...mechanicProfile,
  hourlyRate: companyProfile.hourlyRate,
  emergencyRate: companyProfile.emergencyRate,
  callOutFee: companyProfile.callOutFee,
  rateCurrency: companyProfile.rateCurrency || "GBP",
});

export const payloadContainsCompanyControlledRates = (payload = {}) => {
  if (!payload || typeof payload !== "object") return false;
  const nested =
    payload.mechanicProfile && typeof payload.mechanicProfile === "object"
      ? payload.mechanicProfile
      : null;
  return COMPANY_CONTROLLED_RATE_KEYS.some(
    (key) => payload[key] !== undefined || (nested && nested[key] !== undefined)
  );
};
