export const ROLES = Object.freeze({
  FLEET: "FLEET",
  MECHANIC: "MECHANIC",
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

export const ISSUE_TYPES = Object.freeze({
  ENGINE: "ENGINE",
  TYRES: "TYRES",
  BRAKES: "BRAKES",
  ELECTRICAL: "ELECTRICAL",
  BATTERY: "BATTERY",
  TOWING: "TOWING",
  OTHER: "OTHER",
});

export const QUOTE_AVAILABILITY = Object.freeze({
  NOW: "NOW",
  IN_30_MIN: "IN_30_MIN",
  IN_1_HOUR: "IN_1_HOUR",
  SCHEDULED: "SCHEDULED",
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
