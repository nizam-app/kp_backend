export const ROLES = Object.freeze({
  FLEET: "FLEET",
  MECHANIC: "MECHANIC",
  COMPANY: "COMPANY",
  MECHANIC_EMPLOYEE: "MECHANIC_EMPLOYEE",
  ADMIN: "ADMIN",
});

export const USER_STATUS = Object.freeze({
  PENDING_REVIEW: "PENDING_REVIEW",
  ACTIVE: "ACTIVE",
  SUSPENDED: "SUSPENDED",
  BLOCKED: "BLOCKED",
});

export const MECHANIC_VERIFICATION_STATUS = Object.freeze({
  NOT_SUBMITTED: "NOT_SUBMITTED",
  SUBMITTED: "SUBMITTED",
  UNDER_REVIEW: "UNDER_REVIEW",
  APPROVED: "APPROVED",
  REJECTED: "REJECTED",
});

export const MECHANIC_AVAILABILITY = Object.freeze({
  ONLINE: "ONLINE",
  OFFLINE: "OFFLINE",
});

export const MECHANIC_BUSINESS_TYPE = Object.freeze({
  SOLE_TRADER: "SOLE_TRADER",
  COMPANY: "COMPANY",
});

export const JOB_STATUS = Object.freeze({
  POSTED: "POSTED",
  QUOTING: "QUOTING",
  ASSIGNED: "ASSIGNED",
  EN_ROUTE: "EN_ROUTE",
  ON_SITE: "ON_SITE",
  IN_PROGRESS: "IN_PROGRESS",
  AWAITING_APPROVAL: "AWAITING_APPROVAL",
  COMPLETED: "COMPLETED",
  CANCELLED: "CANCELLED",
});

export const QUOTE_STATUS = Object.freeze({
  WAITING: "WAITING",
  ACCEPTED: "ACCEPTED",
  DECLINED: "DECLINED",
  EXPIRED: "EXPIRED",
  WITHDRAWN: "WITHDRAWN",
});

export const JOB_URGENCY = Object.freeze({
  LOW: "LOW",
  MEDIUM: "MEDIUM",
  HIGH: "HIGH",
  CRITICAL: "CRITICAL",
});

/**
 * Job `issueType` — legacy coarse buckets plus fleet Post Job categories (granular).
 * New clients should send granular values; legacy coarse values remain valid for existing data.
 */
export const ISSUE_TYPES = Object.freeze({
  FLAT_DAMAGED_TYRE: "FLAT_DAMAGED_TYRE",
  BATTERY_FAILURE_JUMP_START: "BATTERY_FAILURE_JUMP_START",
  ENGINE_WONT_START: "ENGINE_WONT_START",
  BREAKDOWN_UNKNOWN_ISSUE: "BREAKDOWN_UNKNOWN_ISSUE",
  OVERHEATING: "OVERHEATING",
  BRAKE_PROBLEM: "BRAKE_PROBLEM",
  ELECTRICAL_ISSUE: "ELECTRICAL_ISSUE",
  FUEL_ISSUE_WRONG_FUEL_EMPTY: "FUEL_ISSUE_WRONG_FUEL_EMPTY",
  VEHICLE_RECOVERY_TOWING: "VEHICLE_RECOVERY_TOWING",
  DIAGNOSTIC_CHECK: "DIAGNOSTIC_CHECK",
  LOCKED_OUT_OF_VEHICLE: "LOCKED_OUT_OF_VEHICLE",
  OTHER_DESCRIBE_IN_NOTES: "OTHER_DESCRIBE_IN_NOTES",

  /** Legacy coarse buckets — keep in schema enum for existing jobs and fleet APIs. */
  ENGINE: "ENGINE",
  TYRES: "TYRES",
  BRAKES: "BRAKES",
  ELECTRICAL: "ELECTRICAL",
  BATTERY: "BATTERY",
  TOWING: "TOWING",
  OTHER: "OTHER",
});

/**
 * Normalizes fleet app "Job category" labels or keys to a single UPPER_SNAKE key.
 * Example: "Flat / Damaged Tyre" → "FLAT_DAMAGED_TYRE"
 */
export const slugifyJobCategoryKey = (raw) => {
  let s = `${raw ?? ""}`.trim();
  if (!s) return null;
  s = s
    .toUpperCase()
    .replace(/\bWON'T\b/g, "WONT")
    .replace(/\s*\/\s*/g, "_");
  s = s.replace(/[()]/g, " ");
  s = s.replace(/[^A-Z0-9_]+/g, "_");
  s = s.replace(/_+/g, "_").replace(/^_|_$/g, "");
  return s || null;
};

/**
 * Fleet UI job category label/key (slug) → `issueType` stored on Job (granular enum).
 * Also includes legacy coarse keys so `jobCategory: "TYRES"` still resolves.
 */
export const JOB_CATEGORY_SUBTYPE_TO_ISSUE_TYPE = Object.freeze({
  FLAT_DAMAGED_TYRE: ISSUE_TYPES.FLAT_DAMAGED_TYRE,
  BATTERY_FAILURE_JUMP_START: ISSUE_TYPES.BATTERY_FAILURE_JUMP_START,
  ENGINE_WONT_START: ISSUE_TYPES.ENGINE_WONT_START,
  BREAKDOWN_UNKNOWN_ISSUE: ISSUE_TYPES.BREAKDOWN_UNKNOWN_ISSUE,
  OVERHEATING: ISSUE_TYPES.OVERHEATING,
  BRAKE_PROBLEM: ISSUE_TYPES.BRAKE_PROBLEM,
  ELECTRICAL_ISSUE: ISSUE_TYPES.ELECTRICAL_ISSUE,
  FUEL_ISSUE_WRONG_FUEL_EMPTY: ISSUE_TYPES.FUEL_ISSUE_WRONG_FUEL_EMPTY,
  VEHICLE_RECOVERY_TOWING: ISSUE_TYPES.VEHICLE_RECOVERY_TOWING,
  DIAGNOSTIC_CHECK: ISSUE_TYPES.DIAGNOSTIC_CHECK,
  LOCKED_OUT_OF_VEHICLE: ISSUE_TYPES.LOCKED_OUT_OF_VEHICLE,
  OTHER_DESCRIBE_IN_NOTES: ISSUE_TYPES.OTHER_DESCRIBE_IN_NOTES,

  ENGINE: ISSUE_TYPES.ENGINE,
  TYRES: ISSUE_TYPES.TYRES,
  BRAKES: ISSUE_TYPES.BRAKES,
  ELECTRICAL: ISSUE_TYPES.ELECTRICAL,
  BATTERY: ISSUE_TYPES.BATTERY,
  TOWING: ISSUE_TYPES.TOWING,
});

export const jobCategorySubtypeKeys = Object.freeze(
  Object.keys(JOB_CATEGORY_SUBTYPE_TO_ISSUE_TYPE)
);

export const QUOTE_AVAILABILITY = Object.freeze({
  NOW: "NOW",
  IN_30_MIN: "IN_30_MIN",
  IN_1_HOUR: "IN_1_HOUR",
  SCHEDULED: "SCHEDULED",
});

/** Fleet→mechanic vs mechanic→fleet reviews share `Review` with distinct `reviewKind`. */
export const REVIEW_KIND = Object.freeze({
  FLEET_RATES_MECHANIC: "FLEET_RATES_MECHANIC",
  MECHANIC_RATES_FLEET: "MECHANIC_RATES_FLEET",
});

export const roleValues = Object.values(ROLES);
export const userStatusValues = Object.values(USER_STATUS);
export const verificationStatusValues = Object.values(
  MECHANIC_VERIFICATION_STATUS
);
export const mechanicAvailabilityValues = Object.values(MECHANIC_AVAILABILITY);
export const mechanicBusinessTypeValues = Object.values(MECHANIC_BUSINESS_TYPE);
export const jobStatusValues = Object.values(JOB_STATUS);
export const quoteStatusValues = Object.values(QUOTE_STATUS);
export const urgencyValues = Object.values(JOB_URGENCY);
export const issueTypeValues = Object.values(ISSUE_TYPES);
export const quoteAvailabilityValues = Object.values(QUOTE_AVAILABILITY);
export const reviewKindValues = Object.values(REVIEW_KIND);
