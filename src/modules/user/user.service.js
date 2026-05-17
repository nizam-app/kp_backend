import AppError from "../../utils/AppError.js";
import { User } from "./user.model.js";
import { PaymentMethod } from "../billing/paymentMethod.model.js";
import {
  MECHANIC_AVAILABILITY,
  mechanicAvailabilityValues,
  ROLES,
  JOB_STATUS,
} from "../../constants/domain.js";
import { Job } from "../job/job.model.js";
import { Review } from "../review/review.model.js";

/** Monday 00:00:00.000 local → next Monday 00:00 exclusive (calendar week). */
const getMechanicCalendarWeekBounds = () => {
  const now = new Date();
  const daysFromMonday = (now.getDay() + 6) % 7;
  const start = new Date(now);
  start.setDate(now.getDate() - daysFromMonday);
  start.setHours(0, 0, 0, 0);
  const end = new Date(start);
  end.setDate(start.getDate() + 7);
  return { start, end };
};

const countMechanicJobsCompletedThisCalendarWeek = async (mechanicId) => {
  const { start, end } = getMechanicCalendarWeekBounds();
  return Job.countDocuments({
    assignedMechanic: mechanicId,
    status: JOB_STATUS.COMPLETED,
    completedAt: { $gte: start, $lt: end },
  });
};

const filterObject = (payload, allowedFields) =>
  Object.fromEntries(
    Object.entries(payload).filter(([key, value]) => {
      if (!allowedFields.includes(key)) return false;
      return value !== undefined;
    })
  );

/** Parses booleans from JSON, including string "true" / "false". */
const coerceBoolean = (value) => {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "boolean") return value;
  if (value === "true" || value === 1 || value === "1") return true;
  if (value === "false" || value === 0 || value === "0") return false;
  return undefined;
};

const NOTIFICATION_TOGGLE_KEYS = [
  "newBreakdownJobs",
  "jobAcceptedDeclined",
  "paymentReceived",
  "systemAlerts",
  "appAlerts",
];

const PREFERENCES_TOP_LEVEL_KEYS = new Set([
  "notifications",
  "pushEnabled",
  "alertRadiusMiles",
  "alertRadius",
  ...NOTIFICATION_TOGGLE_KEYS,
  "systemAndAppAlerts",
  "systemAndApp",
]);

const hasPreferencesPayloadKeys = (payload) =>
  payload &&
  typeof payload === "object" &&
  Object.keys(payload).some((k) => PREFERENCES_TOP_LEVEL_KEYS.has(k));

/**
 * Merges `preferences` from a PATCH body (nested `notifications` and/or flat toggle keys).
 * @returns {boolean} true if any preference field was applied
 */
const applyPreferencesFromPayload = (user, payload = {}) => {
  const hasNested =
    payload.notifications !== undefined && typeof payload.notifications === "object";
  const flatToggles = NOTIFICATION_TOGGLE_KEYS.filter((k) => payload[k] !== undefined);
  const combinedRaw =
    payload.systemAndAppAlerts !== undefined ? payload.systemAndAppAlerts : payload.systemAndApp;
  const hasCombined = combinedRaw !== undefined;
  const hasRadius =
    payload.alertRadiusMiles !== undefined || payload.alertRadius !== undefined;
  const hasPush = payload.pushEnabled !== undefined;

  if (!hasNested && !flatToggles.length && !hasCombined && !hasRadius && !hasPush) {
    return false;
  }

  const nextNotifications = {
    ...(user.preferences?.notifications || {}),
  };

  if (hasNested) {
    const partial = filterObject(payload.notifications, NOTIFICATION_TOGGLE_KEYS);
    Object.entries(partial).forEach(([k, v]) => {
      const b = coerceBoolean(v);
      if (b !== undefined) nextNotifications[k] = b;
    });
  }

  flatToggles.forEach((k) => {
    const b = coerceBoolean(payload[k]);
    if (b !== undefined) nextNotifications[k] = b;
  });

  if (hasCombined) {
    const b = coerceBoolean(combinedRaw);
    if (b !== undefined) {
      nextNotifications.systemAlerts = b;
      nextNotifications.appAlerts = b;
    }
  }

  if (nextNotifications.appAlerts === undefined) {
    nextNotifications.appAlerts = user.preferences?.notifications?.appAlerts ?? true;
  }

  const radiusRaw =
    payload.alertRadiusMiles !== undefined
      ? payload.alertRadiusMiles
      : payload.alertRadius !== undefined
        ? payload.alertRadius
        : undefined;

  let alertRadius =
    radiusRaw !== undefined ? Number(radiusRaw) : user.preferences?.alertRadiusMiles ?? 25;

  if (radiusRaw !== undefined && (!Number.isFinite(alertRadius) || alertRadius < 1)) {
    throw new AppError("alertRadiusMiles must be at least 1", 400);
  }
  if (!Number.isFinite(alertRadius) || alertRadius < 1) {
    alertRadius = 25;
  }

  const pushEnabled =
    coerceBoolean(payload.pushEnabled) ?? user.preferences?.pushEnabled ?? true;

  user.preferences = {
    ...(user.preferences || {}),
    pushEnabled,
    alertRadiusMiles: alertRadius,
    notifications: nextNotifications,
  };

  return true;
};

const normalizeBankBillingPatch = (patch) => {
  const out = { ...patch };
  if (out.bankName !== undefined && out.bankDisplayName === undefined) {
    out.bankDisplayName = `${out.bankName || ""}`.trim() || undefined;
  }
  delete out.bankName;
  const acct = out.bankAccount ?? out.bankAccountNumber;
  if (acct !== undefined && out.bankAccountMasked === undefined) {
    out.bankAccountMasked = `${acct || ""}`.trim() || undefined;
  }
  delete out.bankAccount;
  delete out.bankAccountNumber;
  if (out.sortCode !== undefined && out.bankSortCode === undefined) {
    out.bankSortCode = `${out.sortCode || ""}`.trim() || undefined;
  }
  delete out.sortCode;
  return out;
};

/** After bank alias normalisation, coerce vatRegistered from JSON strings. */
const coerceVatRegisteredInPatch = (patch) => {
  if (patch.vatRegistered === undefined) return patch;
  const v = coerceBoolean(patch.vatRegistered);
  if (v !== undefined) return { ...patch, vatRegistered: v };
  return patch;
};

const normalizeEmail = (value) => `${value || ""}`.trim().toLowerCase();

const normalizePoint = (value) => {
  if (!value) return undefined;

  if (Array.isArray(value.coordinates) && value.coordinates.length === 2) {
    const [lng, lat] = value.coordinates.map(Number);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
      throw new AppError("lastKnownLocation.coordinates must be [lng, lat]", 400);
    }

    return {
      type: "Point",
      coordinates: [lng, lat],
      updatedAt: value.updatedAt ? new Date(value.updatedAt) : new Date(),
    };
  }

  const lat = Number(value.lat);
  const lng = Number(value.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    throw new AppError("lastKnownLocation requires lat and lng", 400);
  }

  return {
    type: "Point",
    coordinates: [lng, lat],
    updatedAt: value.updatedAt ? new Date(value.updatedAt) : new Date(),
  };
};

const maskCardLabel = (method) => {
  if (!method?.card?.last4) return null;
  const brand = method.card.brand || "CARD";
  const last4 = method.card.last4;
  return `${brand} •••• ${last4}`;
};

/** One row in a checklist step: stable key for PATCH mapping, label for UI, live value. */
const completionEntry = (key, label, value) => ({
  key,
  label,
  value:
    value === undefined || value === ""
      ? null
      : value,
});

const finiteNumOrNull = (v) => (Number.isFinite(v) ? v : null);

const buildFleetCompletion = (user, defaultPaymentMethod) => {
  const fleetProfile = user.fleetProfile || {};
  const companyDetailsComplete = Boolean(
    fleetProfile.companyName && fleetProfile.regNumber && fleetProfile.vatNumber
  );
  const contactPersonComplete = Boolean(
    fleetProfile.contactName &&
      fleetProfile.contactRole &&
      fleetProfile.phone &&
      user.email
  );
  const billingPaymentComplete = Boolean(
    defaultPaymentMethod && fleetProfile.billingAddress
  );

  const items = [
    {
      key: "companyDetails",
      label: "Company Details",
      complete: companyDetailsComplete,
      entries: [
        completionEntry("companyName", "Company name", fleetProfile.companyName),
        completionEntry("regNumber", "Company registration", fleetProfile.regNumber),
        completionEntry("vatNumber", "VAT number", fleetProfile.vatNumber),
      ],
    },
    {
      key: "contactPerson",
      label: "Contact Person",
      complete: contactPersonComplete,
      entries: [
        completionEntry("contactName", "Contact name", fleetProfile.contactName),
        completionEntry("contactRole", "Contact role", fleetProfile.contactRole),
        completionEntry("phone", "Phone", fleetProfile.phone),
        completionEntry("email", "Email", user.email),
      ],
    },
    {
      key: "billingPayment",
      label: "Billing & Payment",
      complete: billingPaymentComplete,
      entries: [
        completionEntry("billingAddress", "Billing address", fleetProfile.billingAddress),
        completionEntry(
          "defaultPaymentMethod",
          "Default payment method",
          Boolean(defaultPaymentMethod)
        ),
      ],
    },
  ];

  const completeCount = items.filter((item) => item.complete).length;

  return {
    percentage: Math.round((completeCount / items.length) * 100),
    isComplete: completeCount === items.length,
    items,
    missing: items.filter((item) => !item.complete).map((item) => item.label),
  };
};

const buildCompanyCompletion = (user, defaultPaymentMethod) => {
  const companyProfile = user.companyProfile || {};
  const businessIdentityComplete = Boolean(
    companyProfile.companyName &&
      companyProfile.regNumber &&
      companyProfile.vatNumber
  );
  const contactPersonComplete = Boolean(
    companyProfile.contactName &&
      companyProfile.contactRole &&
      companyProfile.phone &&
      user.email
  );
  const operatingProfileComplete = Boolean(
    companyProfile.baseLocationText &&
      Number.isFinite(companyProfile.serviceRadiusMiles)
  );
  const billingComplete = Boolean(defaultPaymentMethod || companyProfile.billingAddress);

  const items = [
    {
      key: "businessIdentity",
      label: "Business Identity",
      complete: businessIdentityComplete,
      entries: [
        completionEntry("companyName", "Company name", companyProfile.companyName),
        completionEntry("regNumber", "Company registration", companyProfile.regNumber),
        completionEntry("vatNumber", "VAT number", companyProfile.vatNumber),
      ],
    },
    {
      key: "contactPerson",
      label: "Primary Contact",
      complete: contactPersonComplete,
      entries: [
        completionEntry("contactName", "Contact name", companyProfile.contactName),
        completionEntry("contactRole", "Contact role", companyProfile.contactRole),
        completionEntry("phone", "Phone", companyProfile.phone),
        completionEntry("email", "Email", user.email),
      ],
    },
    {
      key: "operations",
      label: "Operations Setup",
      complete: operatingProfileComplete,
      entries: [
        completionEntry("baseLocationText", "Base location", companyProfile.baseLocationText),
        completionEntry(
          "serviceRadiusMiles",
          "Service radius (miles)",
          finiteNumOrNull(companyProfile.serviceRadiusMiles)
        ),
      ],
    },
    {
      key: "billing",
      label: "Billing & Payout",
      complete: billingComplete,
      entries: [
        completionEntry("billingAddress", "Billing address", companyProfile.billingAddress),
        completionEntry(
          "defaultPaymentMethod",
          "Default payment method",
          Boolean(defaultPaymentMethod)
        ),
      ],
    },
  ];

  const completeCount = items.filter((item) => item.complete).length;

  return {
    percentage: Math.round((completeCount / items.length) * 100),
    isComplete: completeCount === items.length,
    items,
    missing: items.filter((item) => !item.complete).map((item) => item.label),
  };
};

const buildMechanicCompletion = (user, defaultPaymentMethod) => {
  const mechanicProfile = user.mechanicProfile || {};
  const identityComplete = Boolean(
    mechanicProfile.displayName && mechanicProfile.phone && user.email
  );
  // `emergencyRate` is not always collected at signup; hourly + coverage + call-out are enough
  // for ops. Clients may derive a display emergency rate from hourly when absent.
  const ratesCoverageComplete = Boolean(
    Number.isFinite(mechanicProfile.hourlyRate) &&
      Number.isFinite(mechanicProfile.callOutFee) &&
      Number.isFinite(mechanicProfile.serviceRadiusMiles) &&
      mechanicProfile.baseLocationText
  );
  const profileBankComplete = Boolean(
    mechanicProfile.bankDisplayName &&
      mechanicProfile.bankAccountMasked &&
      mechanicProfile.bankSortCode &&
      mechanicProfile.billingAddress
  );
  const payoutComplete = Boolean(defaultPaymentMethod || profileBankComplete);
  const vatNumTrimmed = `${mechanicProfile.vatNumber || ""}`.trim();
  const vatRegisteredEffective =
    Boolean(mechanicProfile.vatRegistered) || Boolean(vatNumTrimmed);

  const items = [
    {
      key: "identity",
      label: "Personal Details",
      complete: identityComplete,
      entries: [
        completionEntry("displayName", "Display name", mechanicProfile.displayName),
        completionEntry("phone", "Phone", mechanicProfile.phone),
        completionEntry("email", "Email", user.email),
      ],
    },
    {
      key: "ratesCoverage",
      label: "Rates & Coverage",
      complete: ratesCoverageComplete,
      entries: [
        completionEntry(
          "hourlyRate",
          "Hourly rate",
          finiteNumOrNull(mechanicProfile.hourlyRate)
        ),
        completionEntry(
          "emergencyRate",
          "Emergency rate",
          finiteNumOrNull(mechanicProfile.emergencyRate)
        ),
        completionEntry(
          "callOutFee",
          "Call-out fee",
          finiteNumOrNull(mechanicProfile.callOutFee)
        ),
        completionEntry(
          "serviceRadiusMiles",
          "Service radius (miles)",
          finiteNumOrNull(mechanicProfile.serviceRadiusMiles)
        ),
        completionEntry(
          "baseLocationText",
          "Base location",
          mechanicProfile.baseLocationText
        ),
        completionEntry("basePostcode", "Base postcode", mechanicProfile.basePostcode),
        completionEntry("rateCurrency", "Rate currency", mechanicProfile.rateCurrency),
      ],
    },
    {
      key: "payout",
      label: "Bank & Billing",
      complete: payoutComplete,
      entries: [
        completionEntry(
          "defaultPaymentMethod",
          "Default payment method",
          Boolean(defaultPaymentMethod)
        ),
        completionEntry("bankDisplayName", "Bank", mechanicProfile.bankDisplayName),
        completionEntry("bankAccountMasked", "Account", mechanicProfile.bankAccountMasked),
        completionEntry("bankSortCode", "Sort code", mechanicProfile.bankSortCode),
        completionEntry("billingAddress", "Billing address", mechanicProfile.billingAddress),
        completionEntry("vatNumber", "VAT number", vatNumTrimmed || null),
        completionEntry("vatRegistered", "VAT registered", vatRegisteredEffective),
      ],
    },
  ];

  const completeCount = items.filter((item) => item.complete).length;

  return {
    percentage: Math.round((completeCount / items.length) * 100),
    isComplete: completeCount === items.length,
    items,
    missing: items.filter((item) => !item.complete).map((item) => item.label),
  };
};

export const getProfileCompletionSummary = async (user) => {
  const defaultPaymentMethod = await PaymentMethod.findOne({
    user: user._id,
    isDefault: true,
    isActive: true,
  }).lean();

  if (user.role === "FLEET") {
    return {
      defaultPaymentMethod,
      profileCompletion: buildFleetCompletion(user, defaultPaymentMethod),
    };
  }

  if (user.role === "MECHANIC" || user.role === "MECHANIC_EMPLOYEE") {
    return {
      defaultPaymentMethod,
      profileCompletion: buildMechanicCompletion(user, defaultPaymentMethod),
    };
  }

  if (user.role === "COMPANY") {
    return {
      defaultPaymentMethod,
      profileCompletion: buildCompanyCompletion(user, defaultPaymentMethod),
    };
  }

  return {
    defaultPaymentMethod,
    profileCompletion: null,
  };
};

const COMPANY_ACTIVE_JOB_STATUSES = [
  JOB_STATUS.ASSIGNED,
  JOB_STATUS.EN_ROUTE,
  JOB_STATUS.ON_SITE,
  JOB_STATUS.IN_PROGRESS,
];

const fetchCompanyTeamOverviewForProfile = async (companyId) => {
  const [totalMechanics, onlineNow, activeJobs] = await Promise.all([
    User.countDocuments({
      role: ROLES.MECHANIC_EMPLOYEE,
      "companyMembership.company": companyId,
      "companyMembership.status": "ACTIVE",
    }),
    User.countDocuments({
      role: ROLES.MECHANIC_EMPLOYEE,
      "companyMembership.company": companyId,
      "companyMembership.status": "ACTIVE",
      "mechanicProfile.availability": MECHANIC_AVAILABILITY.ONLINE,
    }),
    Job.countDocuments({
      assignedCompany: companyId,
      status: { $in: COMPANY_ACTIVE_JOB_STATUSES },
    }),
  ]);
  return { totalMechanics, onlineNow, activeJobs };
};

const roundRating1 = (n) => {
  const x = Number(n);
  if (!Number.isFinite(x)) return 0;
  return Math.round(x * 10) / 10;
};

const fetchCompanyProfileMetrics = async (companyId) => {
  const [totalJobs, jobDocs, employees] = await Promise.all([
    Job.countDocuments({ assignedCompany: companyId, status: JOB_STATUS.COMPLETED }),
    Job.find({ assignedCompany: companyId }).select("_id").lean(),
    User.find({
      role: ROLES.MECHANIC_EMPLOYEE,
      "companyMembership.company": companyId,
      "companyMembership.status": "ACTIVE",
    })
      .select("mechanicProfile.rating.average mechanicProfile.rating.count mechanicProfile.stats.responseMinutesAvg")
      .lean(),
  ]);

  const jobIds = jobDocs.map((j) => j._id);
  const jobReviews =
    jobIds.length > 0
      ? await Review.find({ job: { $in: jobIds }, status: "PUBLISHED" }).select("rating").lean()
      : [];

  let avgRating = 0;
  if (jobReviews.length) {
    avgRating = jobReviews.reduce((s, r) => s + (Number(r.rating) || 0), 0) / jobReviews.length;
  } else {
    const avs = employees
      .map((e) => e.mechanicProfile?.rating?.average)
      .filter((x) => Number.isFinite(x) && x > 0);
    avgRating = avs.length ? avs.reduce((a, b) => a + b, 0) / avs.length : 0;
  }

  const resp = employees
    .map((e) => e.mechanicProfile?.stats?.responseMinutesAvg)
    .filter((x) => Number.isFinite(x) && x > 0);
  const responseMinutesAvg = resp.length
    ? Math.round(resp.reduce((a, b) => a + b, 0) / resp.length)
    : null;

  return {
    totalJobs,
    avgRating: roundRating1(avgRating),
    responseMinutesAvg,
  };
};

const mergeCompanyProfileMetrics = (computed, override) => {
  if (!override || typeof override !== "object") return computed;
  const totalJobs =
    Number.isFinite(override.totalJobs) && override.totalJobs >= 0
      ? Math.floor(override.totalJobs)
      : computed.totalJobs;
  const avgRating =
    Number.isFinite(override.avgRating) && override.avgRating >= 0
      ? roundRating1(override.avgRating)
      : computed.avgRating;
  const responseMinutesAvg =
    Number.isFinite(override.responseMinutesAvg) && override.responseMinutesAvg >= 0
      ? Math.round(override.responseMinutesAvg)
      : computed.responseMinutesAvg;
  return { totalJobs, avgRating, responseMinutesAvg };
};

const buildProfileResponse = async (user) => {
  const { defaultPaymentMethod, profileCompletion } =
    await getProfileCompletionSummary(user);

  const base = user.toObject();

  let paymentSummary = null;
  if (defaultPaymentMethod) {
    paymentSummary = {
      methodType: defaultPaymentMethod.methodType,
      provider: defaultPaymentMethod.provider,
      cardLabel: maskCardLabel(defaultPaymentMethod),
      expMonth: defaultPaymentMethod.card?.expMonth ?? null,
      expYear: defaultPaymentMethod.card?.expYear ?? null,
      bankName: defaultPaymentMethod.bank?.bankName || null,
      accountMasked: defaultPaymentMethod.bank?.accountMasked || null,
      sortCodeMasked: defaultPaymentMethod.bank?.sortCodeMasked || null,
      billingAddress:
        defaultPaymentMethod.billingAddress ||
        (base.role === "COMPANY" ? base.companyProfile?.billingAddress : null) ||
        base.fleetProfile?.billingAddress ||
        ((base.role === "MECHANIC" || base.role === "MECHANIC_EMPLOYEE") &&
          base.mechanicProfile?.billingAddress) ||
        null,
    };
  } else if (
    base.role === "COMPANY" &&
    (base.companyProfile?.bankDisplayName ||
      base.companyProfile?.bankAccountMasked ||
      base.companyProfile?.bankSortCode)
  ) {
    paymentSummary = {
      methodType: "BANK",
      provider: "PROFILE",
      cardLabel: null,
      expMonth: null,
      expYear: null,
      bankName: base.companyProfile.bankDisplayName || null,
      accountMasked: base.companyProfile.bankAccountMasked || null,
      sortCodeMasked: base.companyProfile.bankSortCode || null,
      billingAddress: base.companyProfile?.billingAddress || null,
    };
  } else if (
    (base.role === "MECHANIC" || base.role === "MECHANIC_EMPLOYEE") &&
    (base.mechanicProfile?.bankDisplayName ||
      base.mechanicProfile?.bankAccountMasked ||
      base.mechanicProfile?.bankSortCode ||
      base.mechanicProfile?.billingAddress)
  ) {
    paymentSummary = {
      methodType: "BANK",
      provider: "PROFILE",
      cardLabel: null,
      expMonth: null,
      expYear: null,
      bankName: base.mechanicProfile.bankDisplayName || null,
      accountMasked: base.mechanicProfile.bankAccountMasked || null,
      sortCodeMasked: base.mechanicProfile.bankSortCode || null,
      billingAddress: base.mechanicProfile?.billingAddress || null,
    };
  }

  if (paymentSummary && base.role === "COMPANY" && base.companyProfile) {
    const cp = base.companyProfile;
    if (!paymentSummary.bankName && cp.bankDisplayName) {
      paymentSummary.bankName = cp.bankDisplayName;
    }
    if (!paymentSummary.accountMasked && cp.bankAccountMasked) {
      paymentSummary.accountMasked = cp.bankAccountMasked;
    }
    if (!paymentSummary.sortCodeMasked && cp.bankSortCode) {
      paymentSummary.sortCodeMasked = cp.bankSortCode;
    }
    if (!paymentSummary.billingAddress && cp.billingAddress) {
      paymentSummary.billingAddress = cp.billingAddress;
    }
  }

  if (
    paymentSummary &&
    (base.role === "MECHANIC" || base.role === "MECHANIC_EMPLOYEE") &&
    base.mechanicProfile
  ) {
    const mp = base.mechanicProfile;
    if (!paymentSummary.bankName && mp.bankDisplayName) {
      paymentSummary.bankName = mp.bankDisplayName;
    }
    if (!paymentSummary.accountMasked && mp.bankAccountMasked) {
      paymentSummary.accountMasked = mp.bankAccountMasked;
    }
    if (!paymentSummary.sortCodeMasked && mp.bankSortCode) {
      paymentSummary.sortCodeMasked = mp.bankSortCode;
    }
    if (!paymentSummary.billingAddress && mp.billingAddress) {
      paymentSummary.billingAddress = mp.billingAddress;
    }
  }

  const response = {
    ...base,
    termsAcceptance: {
      accepted: Boolean(base.termsAcceptance?.acceptedAt),
      acceptedAt: base.termsAcceptance?.acceptedAt || null,
      version: base.termsAcceptance?.version || null,
      source: base.termsAcceptance?.source || null,
    },
    paymentSummary,
  };

  if (profileCompletion) response.profileCompletion = profileCompletion;

  if (base.role === "MECHANIC" || base.role === "MECHANIC_EMPLOYEE") {
    const mp = { ...(response.mechanicProfile || {}) };
    const vatNum = `${mp.vatNumber || ""}`.trim();
    mp.vatNumber = vatNum || null;
    mp.vatRegistered = Boolean(mp.vatRegistered) || Boolean(vatNum);
    response.mechanicProfile = mp;
    const { start: weekStart, end: weekEndExclusive } = getMechanicCalendarWeekBounds();
    const jobsThisWeek = await countMechanicJobsCompletedThisCalendarWeek(base._id);
    response.performance = {
      jobsDone: mp.stats?.jobsDone ?? 0,
      jobsThisWeek,
      thisWeekFrom: weekStart.toISOString(),
      thisWeekToExclusive: weekEndExclusive.toISOString(),
      avgRating: mp.rating?.average ?? 0,
      ratingCount: mp.rating?.count ?? 0,
      responseMinutes: mp.stats?.responseMinutesAvg ?? 0,
    };
  }

  if (base.role === "FLEET") {
    response.companySummary = {
      companyName: base.fleetProfile?.companyName || null,
      fleetSize: base.fleetProfile?.fleetSize || null,
      contactName: base.fleetProfile?.contactName || null,
      contactRole: base.fleetProfile?.contactRole || null,
      phone: base.fleetProfile?.phone || null,
      billingAddress: base.fleetProfile?.billingAddress || null,
    };
  }

  if (base.role === "COMPANY") {
    const teamOverview = await fetchCompanyTeamOverviewForProfile(base._id);
    const computedMetrics = await fetchCompanyProfileMetrics(base._id);
    const profileMetrics = mergeCompanyProfileMetrics(
      computedMetrics,
      base.companyProfile?.profileMetricsOverride
    );
    response.companySummary = {
      companyName: base.companyProfile?.companyName || null,
      contactName: base.companyProfile?.contactName || null,
      contactRole: base.companyProfile?.contactRole || null,
      phone: base.companyProfile?.phone || null,
      regNumber: base.companyProfile?.regNumber || null,
      vatNumber: base.companyProfile?.vatNumber || null,
      billingAddress: base.companyProfile?.billingAddress || null,
      baseLocationText: base.companyProfile?.baseLocationText || null,
      serviceRadiusMiles: base.companyProfile?.serviceRadiusMiles ?? null,
      teamSize: base.companyProfile?.teamSize ?? 0,
      teamOverview: {
        totalMechanics: teamOverview.totalMechanics,
        onlineNow: teamOverview.onlineNow,
        activeJobs: teamOverview.activeJobs,
      },
      /** Flat aliases for profile cards */
      totalMechanics: teamOverview.totalMechanics,
      onlineNow: teamOverview.onlineNow,
      activeJobs: teamOverview.activeJobs,
      /** Company profile hero metrics (Total jobs / Avg rating / Response time). */
      profileMetrics: {
        totalJobs: profileMetrics.totalJobs,
        avgRating: profileMetrics.avgRating,
        responseMinutesAvg: profileMetrics.responseMinutesAvg,
      },
      bankBilling: {
        bankName:
          paymentSummary?.bankName || base.companyProfile?.bankDisplayName || null,
        accountMasked:
          paymentSummary?.accountMasked || base.companyProfile?.bankAccountMasked || null,
        sortCode:
          paymentSummary?.sortCodeMasked || base.companyProfile?.bankSortCode || null,
        billingAddress: base.companyProfile?.billingAddress || paymentSummary?.billingAddress || null,
      },
    };
  }

  return response;
};

export const findUserById = async (userId) => {
  const user = await User.findById(userId);
  if (!user) throw new AppError("User not found", 404);
  return user;
};

export const getOwnProfile = async (userId) => {
  const user = await findUserById(userId);
  return buildProfileResponse(user);
};

/**
 * PATCH /api/v1/users/me — profile update.
 *
 * **Mechanic & mechanic employee** may send in one request:
 * - **Job / feed notifications** (stored under `user.preferences`): flat booleans
 *   `newBreakdownJobs`, `jobAcceptedDeclined`, `paymentReceived`, `systemAlerts`, `appAlerts`,
 *   or combined `systemAndAppAlerts` / `systemAndApp` (sets both system + app alerts);
 *   nested `notifications` with the same keys; `pushEnabled`; `alertRadiusMiles` or `alertRadius`.
 * - **Billing / bank / VAT** (stored under `mechanicProfile`): `billingAddress`, `vatNumber`,
 *   `vatRegistered`, `bankDisplayName`, `bankAccountMasked`, `bankSortCode`, and aliases
 *   `bankName`, `bankAccount`, `bankAccountNumber`, `sortCode`.
 * - Plus existing mechanic profile fields (rates, skills, display name, etc.).
 *
 * Fleet/company users must not send notification/radius keys here; use PATCH /users/me/preferences.
 */
export const updateOwnProfile = async (user, payload) => {
  if (hasPreferencesPayloadKeys(payload)) {
    if (![ROLES.MECHANIC, ROLES.MECHANIC_EMPLOYEE].includes(user.role)) {
      throw new AppError(
        "Notification toggles and alert radius are only accepted on PATCH /users/me for mechanic accounts. Use PATCH /users/me/preferences instead.",
        400
      );
    }
    applyPreferencesFromPayload(user, payload);
  }

  if (payload.email !== undefined) {
    const email = normalizeEmail(payload.email);
    if (!email) throw new AppError("email cannot be empty", 400);

    const duplicate = await User.findOne({
      _id: { $ne: user._id },
      email,
    });
    if (duplicate) throw new AppError("Email already in use", 409);
    user.email = email;
  }

  if (user.role === "FLEET") {
    const patch = filterObject(payload, [
      "profilePhotoUrl",
      "companyName",
      "contactName",
      "contactRole",
      "phone",
      "regNumber",
      "vatNumber",
      "fleetSize",
      "defaultAddress",
      "billingAddress",
      "profileCompleted",
    ]);
    user.fleetProfile = {
      ...(user.fleetProfile || {}),
      ...patch,
    };
  }

  if (user.role === "MECHANIC") {
    let patch = filterObject(payload, [
      "businessType",
      "displayName",
      "businessName",
      "phone",
      "baseLocationText",
      "basePostcode",
      "hourlyRate",
      "emergencyRate",
      "emergencySurcharge",
      "callOutFee",
      "callOutCharge",
      "rateCurrency",
      "serviceRadiusMiles",
      "coverageRadius",
      "skills",
      "availability",
      "lastKnownLocation",
      "profileCompleted",
      "profilePhotoUrl",
      "billingAddress",
      "bankDisplayName",
      "bankAccountMasked",
      "bankSortCode",
      "bankName",
      "bankAccount",
      "bankAccountNumber",
      "sortCode",
      "vatNumber",
      "vatRegistered",
    ]);
    patch = normalizeBankBillingPatch(patch);
    patch = coerceVatRegisteredInPatch(patch);

    const normalizedPatch = {
      ...patch,
      callOutFee: patch.callOutCharge ?? patch.callOutFee,
      serviceRadiusMiles: patch.coverageRadius ?? patch.serviceRadiusMiles,
    };

    if (payload.lastKnownLocation !== undefined) {
      normalizedPatch.lastKnownLocation = normalizePoint(payload.lastKnownLocation);
    }

    delete normalizedPatch.callOutCharge;
    delete normalizedPatch.coverageRadius;

    user.mechanicProfile = {
      ...(user.mechanicProfile || {}),
      ...normalizedPatch,
    };
  }

  if (user.role === "MECHANIC_EMPLOYEE") {
    let patch = filterObject(payload, [
      "displayName",
      "phone",
      "baseLocationText",
      "basePostcode",
      "hourlyRate",
      "emergencyRate",
      "emergencySurcharge",
      "callOutFee",
      "callOutCharge",
      "rateCurrency",
      "serviceRadiusMiles",
      "coverageRadius",
      "skills",
      "availability",
      "lastKnownLocation",
      "profileCompleted",
      "profilePhotoUrl",
      "billingAddress",
      "bankDisplayName",
      "bankAccountMasked",
      "bankSortCode",
      "bankName",
      "bankAccount",
      "bankAccountNumber",
      "sortCode",
      "vatNumber",
      "vatRegistered",
    ]);
    patch = normalizeBankBillingPatch(patch);
    patch = coerceVatRegisteredInPatch(patch);

    const normalizedPatch = {
      ...patch,
      callOutFee: patch.callOutCharge ?? patch.callOutFee,
      serviceRadiusMiles: patch.coverageRadius ?? patch.serviceRadiusMiles,
    };

    if (payload.lastKnownLocation !== undefined) {
      normalizedPatch.lastKnownLocation = normalizePoint(payload.lastKnownLocation);
    }

    delete normalizedPatch.callOutCharge;
    delete normalizedPatch.coverageRadius;

    user.mechanicProfile = {
      ...(user.mechanicProfile || {}),
      ...normalizedPatch,
    };
  }

  if (user.role === "COMPANY") {
    const patch = filterObject(payload, [
      "profilePhotoUrl",
      "companyName",
      "contactName",
      "contactRole",
      "phone",
      "regNumber",
      "vatNumber",
      "billingAddress",
      "baseLocationText",
      "serviceRadiusMiles",
      "coverageRadius",
      "teamSize",
      "profileCompleted",
      "bankDisplayName",
      "bankAccountMasked",
      "bankSortCode",
    ]);

    const nextProfile = {
      ...(user.companyProfile || {}),
      ...patch,
      serviceRadiusMiles: patch.coverageRadius ?? patch.serviceRadiusMiles ?? user.companyProfile?.serviceRadiusMiles,
    };
    delete nextProfile.coverageRadius;

    if (payload.profileMetricsOverride !== undefined) {
      if (payload.profileMetricsOverride === null) {
        nextProfile.profileMetricsOverride = undefined;
      } else if (typeof payload.profileMetricsOverride === "object") {
        nextProfile.profileMetricsOverride = filterObject(payload.profileMetricsOverride, [
          "totalJobs",
          "avgRating",
          "responseMinutesAvg",
        ]);
      }
    }

    user.companyProfile = nextProfile;
  }

  const { profileCompletion } = await getProfileCompletionSummary(user);
  if (user.role === "FLEET") {
    user.fleetProfile = {
      ...(user.fleetProfile || {}),
      profileCompleted: profileCompletion?.isComplete || false,
    };
  }

  if (user.role === "MECHANIC" || user.role === "MECHANIC_EMPLOYEE") {
    user.mechanicProfile = {
      ...(user.mechanicProfile || {}),
      profileCompleted: profileCompletion?.isComplete || false,
    };
  }

  if (user.role === "COMPANY") {
    user.companyProfile = {
      ...(user.companyProfile || {}),
      profileCompleted: profileCompletion?.isComplete || false,
    };
  }

  await user.save();
  return buildProfileResponse(user);
};

export const updateMechanicAvailability = async (user, payload) => {
  if (!["MECHANIC", "MECHANIC_EMPLOYEE"].includes(user.role)) {
    throw new AppError("Only mechanics can update availability", 403);
  }

  const availability =
    payload.availability !== undefined ? `${payload.availability}`.trim() : undefined;
  if (
    availability !== undefined &&
    !mechanicAvailabilityValues.includes(availability)
  ) {
    throw new AppError(
      `availability must be one of ${mechanicAvailabilityValues.join(", ")}`,
      400
    );
  }

  user.mechanicProfile = {
    ...(user.mechanicProfile || {}),
    availability:
      availability || user.mechanicProfile?.availability || MECHANIC_AVAILABILITY.OFFLINE,
    lastKnownLocation:
      payload.lastKnownLocation !== undefined
        ? normalizePoint(payload.lastKnownLocation)
        : user.mechanicProfile?.lastKnownLocation,
  };

  const { profileCompletion } = await getProfileCompletionSummary(user);
  user.mechanicProfile.profileCompleted = profileCompletion?.isComplete || false;

  await user.save();
  return buildProfileResponse(user);
};

export const updateUserPreferences = async (user, payload) => {
  if (!applyPreferencesFromPayload(user, payload)) {
    throw new AppError(
      "Provide at least one of: notifications, newBreakdownJobs, jobAcceptedDeclined, paymentReceived, systemAlerts, appAlerts, systemAndAppAlerts, alertRadiusMiles, alertRadius, pushEnabled",
      400
    );
  }
  await user.save();
  return buildProfileResponse(user);
};

export const acceptUserTerms = async (user, payload = {}) => {
  user.termsAcceptance = {
    acceptedAt: new Date(),
    version: `${payload.version || "2026-03-09"}`,
    source: `${payload.source || "mobile-app"}`,
  };

  await user.save({ validateBeforeSave: false });
  return buildProfileResponse(user);
};
