import AppError from "../../utils/AppError.js";
import fs from "fs/promises";
import path from "path";
import crypto from "crypto";
import {
  ROLES,
  JOB_STATUS,
  QUOTE_STATUS,
  ISSUE_TYPES,
  issueTypeValues,
  jobStatusValues,
  MECHANIC_AVAILABILITY,
  mechanicAvailabilityValues,
  JOB_CATEGORY_SUBTYPE_TO_ISSUE_TYPE,
  slugifyJobCategoryKey,
  urgencyValues,
} from "../../constants/domain.js";
import mongoose from "mongoose";
import { resolveCanonicalJobCategory } from "../jobCategory/jobCategory.service.js";
import {
  Job,
  JOB_ATTACHMENT_CATEGORIES,
  JOB_ATTACHMENT_FILE_TYPES,
} from "./job.model.js";
import { Quote } from "../quote/quote.model.js";
import { JobEvent } from "../jobEvent/jobEvent.model.js";
import { JobLocationPing } from "../jobLocationPing/jobLocationPing.model.js";
import { Invoice } from "../invoice/invoice.model.js";
import { EarningTransaction } from "../earning/earningTransaction.model.js";
import { PaymentMethod } from "../billing/paymentMethod.model.js";
import {
  PaymentAttempt,
  stripePaymentAttemptIdempotencyKey,
  stripePaymentCancellationIdempotencyKey,
  stripePaymentConfirmationIdempotencyKey,
} from "../billing/paymentAttempt.model.js";
import {
  buildPaymentAttemptUpsert,
  normalizeApprovalRequestId,
  paymentAttemptId,
  planStripePaymentIntentRetry,
} from "../billing/paymentAttempt.service.js";
import { invoiceStatusFromPaymentIntent } from "../billing/stripePaymentStatus.js";
import { User } from "../user/user.model.js";
import { ChatMessage } from "../chat/chat.model.js";
import { Notification } from "../notification/notification.model.js";
import {
  cancelStripePaymentIntent,
  confirmStripePaymentIntent,
  createStripePaymentIntent,
  getStripePublicConfig,
  retrieveStripePaymentIntent,
} from "../billing/stripe.service.js";
import {
  calculateDestinationChargeAmounts,
  resolvePayoutRecipient,
} from "../billing/payoutRecipient.service.js";
import { getProfileCompletionSummary } from "../user/user.service.js";
import { readMechanicProfileRatingAverage } from "../../utils/mechanicRating.js";
import { calculateJobVat } from "../../utils/vat.js";
import {
  computePlatformFee,
  computePlatformFeeNet,
  getPlatformFeePercent,
} from "../../utils/platformFee.js";
import { assertValidOptionalPhone } from "../../utils/phone.js";
import { resolveQuoteDisplayLifecycle } from "../../utils/quoteDisplayLifecycle.js";
import {
  notifyJobCancelled,
  notifyJobCompleted,
  notifyJobStatusChanged,
} from "../notification/jobQuoteNotification.service.js";
import { createCompanyMechanicReview } from "../review/review.service.js";
import { notifyAdminsSafely } from "../notification/adminNotification.service.js";
import { ADMIN_NOTIFICATION_EVENTS } from "../notification/adminNotificationEvents.js";
import {
  emitJobEvent,
  emitJobLocationPing,
  emitJobPosted,
  emitJobStatusChanged,
} from "../../realtime/socket.js";

const toObjectIdString = (value) => (value?._id || value)?.toString();
const uploadsRoot = path.resolve(process.cwd(), "uploads", "jobs");

const parsePage = (value) => {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 1;
};

const parseLimit = (value) => {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return 20;
  return Math.min(Math.floor(n), 100);
};

const escapeRegex = (s) => `${s || ""}`.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Optional text search across job code, title, description, and vehicle registration. */
const applyListSearchFilter = (filter, query) => {
  const q = `${query.q || query.search || ""}`.trim();
  if (!q) return;
  const rx = new RegExp(escapeRegex(q), "i");
  filter.$and = [
    ...(Array.isArray(filter.$and) ? filter.$and : []),
    {
      $or: [
        { jobCode: rx },
        { title: rx },
        { description: rx },
        { "vehicle.registration": rx },
      ],
    },
  ];
};

/** Strip UI labels and normalize pasted job references before lookup. */
export const normalizeJobRefInput = (jobIdOrCode) => {
  let raw = `${jobIdOrCode || ""}`.trim();
  if (!raw) return "";

  raw = raw.replace(/^job\s*#?\s*/i, "").trim();

  if (mongoose.Types.ObjectId.isValid(raw) && String(new mongoose.Types.ObjectId(raw)) === raw) {
    return raw;
  }

  const codeMatch = raw.match(/\b([A-Z]{2,4}-[A-Z0-9]+)\b/i);
  if (codeMatch) {
    return codeMatch[1].toUpperCase();
  }

  return raw.toUpperCase();
};

/** Resolve Mongo _id or human-readable jobCode (e.g. TF-8823) to ObjectId string. */
export const resolveJobRef = async (jobIdOrCode) => {
  const raw = normalizeJobRefInput(jobIdOrCode);
  if (!raw) throw new AppError("jobId is required", 400);
  if (mongoose.Types.ObjectId.isValid(raw) && String(new mongoose.Types.ObjectId(raw)) === raw) {
    return raw;
  }
  const job = await Job.findOne({
    jobCode: new RegExp(`^${raw.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "i"),
  }).select("_id");
  if (!job) throw new AppError("Job not found", 404);
  return job._id.toString();
};

const milesToMeters = (value) => Math.max(Number(value) || 1, 1) * 1609.34;

/** Earth radius in metres (WGS84 approximation). */
const EARTH_RADIUS_M = 6378137;

/** Mongo `$near` conflicts with `.sort()` on the same find — use `$geoWithin` + haversine for distance text. */
const metersToRadiansForSphere = (meters) => meters / EARTH_RADIUS_M;

const haversineMeters = (lng1, lat1, lng2, lat2) => {
  const toRad = (deg) => (deg * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return EARTH_RADIUS_M * c;
};

/** Circle filter compatible with compound queries + `.sort()` (unlike `$near`). */
const locationWithinRadiusFilter = (lng, lat, radiusMiles) => ({
  $geoWithin: {
    $centerSphere: [[lng, lat], metersToRadiansForSphere(milesToMeters(radiusMiles))],
  },
});

/** Open marketplace jobs for company “Available jobs” (POSTED|QUOTING + optional geo / filters). */
export const buildCompanyFeedJobsFilter = (companyUser, query = {}) => {
  const filter = { status: { $in: [JOB_STATUS.POSTED, JOB_STATUS.QUOTING] } };
  if (query.lat && query.lng) {
    const lat = Number(query.lat);
    const lng = Number(query.lng);
    const radiusMiles = Number(
      query.radiusMiles || query.radius || companyUser.companyProfile?.serviceRadiusMiles || 25
    );
    if (Number.isFinite(lat) && Number.isFinite(lng) && Number.isFinite(radiusMiles)) {
      filter.location = locationWithinRadiusFilter(lng, lat, radiusMiles);
    }
  }
  if (query.issueType) {
    filter.issueType = { $in: `${query.issueType}`.split(",") };
  }
  if (query.minPayout) {
    const min = Number(query.minPayout);
    if (Number.isFinite(min)) {
      filter.estimatedPayout = { $gte: min };
    }
  }
  return filter;
};

/**
 * Company feed: hide marketplace jobs this company (or its employees quoting as that company)
 * already has a **WAITING** quote on. Reappears if quote is withdrawn / declined / expired / accepted.
 */
const applyCompanyFeedExcludeJobsWithWaitingQuote = async (companyUser, filter) => {
  const jobIds = await Quote.distinct("job", {
    company: companyUser._id,
    status: QUOTE_STATUS.WAITING,
  });
  if (!jobIds?.length) return;
  filter._id = { $nin: jobIds };
};

export const resolveCompanyFeedNearPoint = (companyUser, query = {}) => {
  if (!query.lat || !query.lng) return null;
  const lat = Number(query.lat);
  const lng = Number(query.lng);
  const radiusMiles = Number(
    query.radiusMiles || query.radius || companyUser.companyProfile?.serviceRadiusMiles || 25
  );
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || !Number.isFinite(radiusMiles)) return null;
  return { lat, lng };
};

export const countCompanyFeedJobs = async (companyUser, query) => {
  const filter = buildCompanyFeedJobsFilter(companyUser, query);
  await applyCompanyFeedExcludeJobsWithWaitingQuote(companyUser, filter);
  return Job.countDocuments(filter);
};

export const countCompanyFeedJobsPostedSince = async (companyUser, query, hours = 24) => {
  const filter = buildCompanyFeedJobsFilter(companyUser, query);
  await applyCompanyFeedExcludeJobsWithWaitingQuote(companyUser, filter);
  filter.createdAt = { $gte: new Date(Date.now() - Math.max(1, Number(hours) || 24) * 3600000) };
  return Job.countDocuments(filter);
};

const roundMiles = (meters) => {
  if (!Number.isFinite(meters)) return null;
  return Math.round((meters / 1609.34) * 10) / 10;
};

const diffMinutesFromNow = (value) => {
  if (!value) return null;
  const ms = Date.now() - new Date(value).getTime();
  if (!Number.isFinite(ms)) return null;
  return Math.max(Math.round(ms / 60000), 0);
};

const formatRelativeAge = (value) => {
  const minutes = diffMinutesFromNow(value);
  if (minutes === null) return null;
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hr ago`;
  const days = Math.floor(hours / 24);
  return `${days} day${days === 1 ? "" : "s"} ago`;
};

const statusPresentation = (status, job) => {
  const map = {
    [JOB_STATUS.POSTED]: { label: "POSTED", tone: "red" },
    [JOB_STATUS.QUOTING]: { label: "QUOTING", tone: "amber" },
    [JOB_STATUS.ASSIGNED]: {
      label: job?.scheduledFor ? "SCHEDULED" : "ASSIGNED",
      tone: "blue",
    },
    [JOB_STATUS.EN_ROUTE]: { label: "EN ROUTE", tone: "amber" },
    [JOB_STATUS.ON_SITE]: { label: "ON SITE", tone: "green" },
    [JOB_STATUS.IN_PROGRESS]: { label: "IN PROGRESS", tone: "amber" },
    [JOB_STATUS.AWAITING_APPROVAL]: { label: "AWAITING APPROVAL", tone: "yellow" },
    [JOB_STATUS.COMPLETED]: { label: "DONE", tone: "green" },
    [JOB_STATUS.CANCELLED]: { label: "CANCELLED", tone: "red" },
  };
  return map[status] || { label: status, tone: "neutral" };
};

const computeCancellation = (status) => {
  const isFree = [JOB_STATUS.POSTED, JOB_STATUS.QUOTING, JOB_STATUS.ASSIGNED].includes(status);
  return {
    canCancel: ![JOB_STATUS.COMPLETED, JOB_STATUS.CANCELLED].includes(status),
    isFree,
    fee: isFree ? 0 : 35,
    currency: "GBP",
  };
};

const quoteBreakdown = (quote) => {
  const total = Number(quote?.amount) || 0;
  const callOutFee = Number(quote?.breakdown?.callOutFee) || Math.round(total * 0.2);
  const labour = Number(quote?.breakdown?.labour) || Math.max(total - callOutFee, 0);
  const parts = Number(quote?.breakdown?.parts) || 0;
  return {
    labour,
    callOutFee,
    parts,
    total,
    currency: quote?.currency || "GBP",
  };
};

const normalizeTyreSide = (raw) => {
  const s = `${raw || ""}`.trim().toUpperCase();
  if (!s) return undefined;
  if (s === "NEAR_SIDE" || s === "NS") return "NEAR_SIDE";
  if (s === "OFF_SIDE" || s === "OS") return "OFF_SIDE";
  if (s === "BOTH") return "BOTH";
  if (s.includes("BOTH") || (s.includes("NS") && s.includes("OS"))) return "BOTH";
  if (s.includes("NEAR") || s.includes("LEFT") || s.includes("KERB")) return "NEAR_SIDE";
  if (s.includes("OFF") || s.includes("RIGHT") || s.includes("ROAD")) return "OFF_SIDE";
  return undefined;
};

const resolveIssueClassification = async (payload = {}) => {
  const rawInput =
    payload.jobCategoryKey ?? payload.issueSubtype ?? payload.jobCategory ?? "";
  const trimmed = `${rawInput}`.trim();
  const slug = trimmed ? slugifyJobCategoryKey(trimmed) : null;
  const canonicalCategory = trimmed
    ? await resolveCanonicalJobCategory(trimmed)
    : null;

  if (payload.jobCategoryKey !== undefined && !canonicalCategory) {
    throw new AppError("Invalid or inactive job category", 400);
  }

  const mappedFromCategory =
    canonicalCategory?.issueType ??
    (slug && Object.prototype.hasOwnProperty.call(JOB_CATEGORY_SUBTYPE_TO_ISSUE_TYPE, slug)
      ? JOB_CATEGORY_SUBTYPE_TO_ISSUE_TYPE[slug]
      : undefined);

  let issueType = payload.issueType ? `${payload.issueType}`.trim().toUpperCase() : undefined;

  if (mappedFromCategory !== undefined) {
    issueType = mappedFromCategory;
  } else if (!issueType) {
    issueType = ISSUE_TYPES.OTHER;
  }

  if (!issueTypeValues.includes(issueType)) {
    throw new AppError(`Invalid issueType: ${issueType}`, 400);
  }

  let issueSubtype;
  if (canonicalCategory) {
    issueSubtype = canonicalCategory.key;
  } else if (trimmed) {
    issueSubtype =
      mappedFromCategory !== undefined ? slug : (slug || trimmed).slice(0, 120);
  }

  return { issueType, issueSubtype };
};

const buildTyreDetailsFromPayload = (payload = {}) => {
  let td = payload.tyreDetails;
  if (typeof td === "string") {
    try {
      td = JSON.parse(td);
    } catch {
      td = null;
    }
  }
  if (td && typeof td === "object" && !Array.isArray(td)) {
    const size = `${td.size || ""}`.trim();
    const axlePosition = `${td.axlePosition || td.axle || ""}`.trim();
    const side = normalizeTyreSide(td.side);
    const out = {};
    if (size) out.size = size;
    if (axlePosition) out.axlePosition = axlePosition;
    if (side) out.side = side;
    return Object.keys(out).length ? out : undefined;
  }

  const size = `${payload.tyreSize || ""}`.trim();
  const axlePosition = `${payload.tyreAxlePosition || payload.axlePosition || ""}`.trim();
  const side = normalizeTyreSide(payload.tyreSide || payload.side);
  if (!size && !axlePosition && !side) return undefined;
  const out = {};
  if (size) out.size = size;
  if (axlePosition) out.axlePosition = axlePosition;
  if (side) out.side = side;
  return out;
};

const normalizeMechanicAvailabilityStatus = (value) => {
  const raw = value === undefined || value === null ? "" : `${value}`.trim().toUpperCase();
  if (!raw) return null;
  return mechanicAvailabilityValues.includes(raw) ? raw : null;
};

const serializeJobCard = (job, viewer, extra = {}) => {
  const statusUi = statusPresentation(job.status, job);
  const cancellation = computeCancellation(job.status);
  const createdAt = job.postedAt || job.createdAt;
  const mechanicAvailabilityRaw = job.assignedMechanic?.mechanicProfile?.availability;
  let availabilityStatus = null;
  if (job.assignedMechanic) {
    availabilityStatus =
      normalizeMechanicAvailabilityStatus(mechanicAvailabilityRaw) ??
      MECHANIC_AVAILABILITY.OFFLINE;
  } else if ([ROLES.MECHANIC, ROLES.MECHANIC_EMPLOYEE].includes(viewer.role)) {
    /** Feed / open jobs: no assignee yet — surface the viewing mechanic's ONLINE/OFFLINE. */
    const raw = viewer.mechanicProfile?.availability;
    availabilityStatus =
      normalizeMechanicAvailabilityStatus(raw) ?? MECHANIC_AVAILABILITY.OFFLINE;
  }
  return {
    _id: job._id,
    jobCode: job.jobCode,
    title: job.title,
    description: job.description || null,
    completionSummary: job.completionSummary || null,
    issueType: job.issueType,
    issueSubtype: job.issueSubtype || null,
    tyreDetails: job.tyreDetails || null,
    urgency: job.urgency,
    mode: job.mode || null,
    status: job.status,
    statusUi,
    vehicle: job.vehicle || null,
    location: job.location || null,
    photos: job.photos || [],
    attachments: (job.attachments || []).map(serializeJobAttachment),
    currency: job.currency || "GBP",
    estimatedPayout: job.estimatedPayout ?? job.acceptedAmount ?? job.finalAmount ?? null,
    acceptedAmount: job.acceptedAmount ?? null,
    finalAmount: job.finalAmount ?? null,
    quoteCount: job.quoteCount || 0,
    scheduledFor: job.scheduledFor || null,
    availabilityWindow: job.availabilityWindow || null,
    postedAt: createdAt,
    assignedAt: job.assignedAt || null,
    completedAt: job.completedAt || null,
    tracking: job.tracking || null,
    postedAgoLabel: formatRelativeAge(createdAt),
    quoteSummary: {
      count: job.quoteCount || 0,
      label: `${job.quoteCount || 0} quote${job.quoteCount === 1 ? "" : "s"}`,
    },
    /** OPEN/QUOTING: viewer mechanic availability on feed; assigned: that mechanic's status. */
    availabilityStatus,
    fleet: job.fleet
      ? {
          _id: job.fleet._id || job.fleet,
          companyName: job.fleet.fleetProfile?.companyName || null,
          contactName: job.fleet.fleetProfile?.contactName || null,
          phone: job.fleet.fleetProfile?.phone || null,
          rating: job.fleet.fleetProfile?.rating?.average ?? null,
          ratingCount: job.fleet.fleetProfile?.rating?.count ?? null,
        }
      : null,
    assignedMechanic: job.assignedMechanic
      ? {
          _id: job.assignedMechanic._id || job.assignedMechanic,
          displayName: job.assignedMechanic.mechanicProfile?.displayName || null,
          businessName: job.assignedMechanic.mechanicProfile?.businessName || null,
          phone: job.assignedMechanic.mechanicProfile?.phone || null,
          profilePhotoUrl: job.assignedMechanic.mechanicProfile?.profilePhotoUrl || null,
          rating: readMechanicProfileRatingAverage(job.assignedMechanic),
          availabilityStatus,
        }
      : null,
    assignedCompany: job.assignedCompany
      ? {
          _id: job.assignedCompany._id || job.assignedCompany,
          companyName: job.assignedCompany.companyProfile?.companyName || null,
          contactName: job.assignedCompany.companyProfile?.contactName || null,
          phone: job.assignedCompany.companyProfile?.phone || null,
        }
      : null,
    driver: job.driver
      ? {
          name: job.driver.name || null,
          phone: job.driver.phone || null,
        }
      : null,
    actions: {
      canTrack:
        viewer.role === ROLES.FLEET &&
        [JOB_STATUS.ASSIGNED, JOB_STATUS.EN_ROUTE, JOB_STATUS.ON_SITE, JOB_STATUS.IN_PROGRESS, JOB_STATUS.AWAITING_APPROVAL].includes(job.status),
      canApproveCompletion:
        viewer.role === ROLES.FLEET && job.status === JOB_STATUS.AWAITING_APPROVAL,
      canEdit:
        viewer.role === ROLES.FLEET && job.status === JOB_STATUS.POSTED,
      canDelete:
        viewer.role === ROLES.FLEET && job.status === JOB_STATUS.POSTED,
      canStartJourney:
        [ROLES.MECHANIC, ROLES.MECHANIC_EMPLOYEE].includes(viewer.role) &&
        job.status === JOB_STATUS.ASSIGNED,
      canArrive:
        [ROLES.MECHANIC, ROLES.MECHANIC_EMPLOYEE].includes(viewer.role) &&
        job.status === JOB_STATUS.EN_ROUTE,
      canStartWork:
        [ROLES.MECHANIC, ROLES.MECHANIC_EMPLOYEE].includes(viewer.role) &&
        job.status === JOB_STATUS.ON_SITE,
      canCompleteWork:
        [ROLES.MECHANIC, ROLES.MECHANIC_EMPLOYEE].includes(viewer.role) &&
        job.status === JOB_STATUS.IN_PROGRESS,
      canAssignMechanic:
        viewer.role === ROLES.COMPANY &&
        toObjectIdString(job.assignedCompany) === toObjectIdString(viewer._id) &&
        !job.assignedMechanic &&
        [JOB_STATUS.ASSIGNED, JOB_STATUS.EN_ROUTE, JOB_STATUS.ON_SITE, JOB_STATUS.IN_PROGRESS].includes(
          job.status
        ),
      cancellation,
    },
    ...extra,
  };
};

const round2 = (n) => Math.round((Number(n || 0) + Number.EPSILON) * 100) / 100;

/**
 * Company "Review invoice" breakdown → invoice line items + subtotal (ex VAT).
 * Supports nested `payload.invoice`. Server totals lines; optional `totalAmount` is verified.
 */
const buildLineItemsFromCompanyInvoicePayload = (payload, job) => {
  const raw = payload?.invoice;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;

  const callOut = round2(raw.callOutCharge ?? raw.callOutFee ?? 0);
  if (!Number.isFinite(callOut) || callOut < 0) {
    throw new AppError("callOutCharge must be a non-negative number", 400);
  }

  const hours = Number(raw.labourHours ?? raw.labour?.hours ?? 0);
  const rate = Number(raw.labourRatePerHour ?? raw.labour?.ratePerHour ?? raw.hourlyRate ?? 0);
  if (!Number.isFinite(hours) || hours < 0 || hours > 999) {
    throw new AppError("labourHours must be between 0 and 999", 400);
  }
  if (!Number.isFinite(rate) || rate < 0 || rate > 99999) {
    throw new AppError("labourRatePerHour must be a non-negative number", 400);
  }
  if ((hours > 0 && rate <= 0) || (rate > 0 && hours <= 0)) {
    throw new AppError("labourHours and labourRatePerHour must both be set for labour billing", 400);
  }

  const labourTotal = hours > 0 && rate > 0 ? round2(hours * rate) : 0;

  const partsIn = Array.isArray(raw.parts) ? raw.parts : [];
  if (partsIn.length > 50) throw new AppError("At most 50 parts lines are allowed", 400);

  const lineItems = [];
  if (callOut > 0) {
    lineItems.push({
      description: "Call-out charge",
      quantity: 1,
      unitAmount: callOut,
      totalAmount: callOut,
    });
  }
  if (labourTotal > 0) {
    const cur = job?.currency || "GBP";
    const sym = cur === "ZAR" ? "R" : "£";
    lineItems.push({
      description: `Labour (${hours} hrs @ ${sym}${rate}/hr)`,
      quantity: hours,
      unitAmount: rate,
      totalAmount: labourTotal,
    });
  }

  for (let i = 0; i < partsIn.length; i += 1) {
    const p = partsIn[i];
    const desc = `${p?.description ?? p?.name ?? ""}`.trim().slice(0, 240);
    const amount = round2(p?.amount ?? p?.price ?? p?.totalAmount ?? p?.cost ?? 0);
    if (!desc) throw new AppError(`parts[${i}].description is required`, 400);
    if (!Number.isFinite(amount) || amount < 0) {
      throw new AppError(`parts[${i}].amount must be a non-negative number`, 400);
    }
    if (amount > 0) {
      lineItems.push({
        description: desc,
        quantity: 1,
        unitAmount: amount,
        totalAmount: amount,
      });
    }
  }

  if (!lineItems.length) {
    throw new AppError("invoice must include at least one positive line (call-out, labour, or parts)", 400);
  }

  const subtotal = round2(lineItems.reduce((s, row) => s + Number(row.totalAmount || 0), 0));
  if (!Number.isFinite(subtotal) || subtotal <= 0) {
    throw new AppError("Computed invoice subtotal must be greater than zero", 400);
  }

  const clientTotal = payload.totalAmount ?? payload.invoiceTotal ?? raw.totalAmount;
  if (clientTotal !== undefined && clientTotal !== null && `${clientTotal}`.trim() !== "") {
    const expected = round2(Number(clientTotal));
    if (!Number.isFinite(expected)) {
      throw new AppError("totalAmount must be a number when provided", 400);
    }
    if (Math.abs(expected - subtotal) > 0.02) {
      throw new AppError(
        `totalAmount £${expected} does not match computed subtotal £${subtotal}`,
        400
      );
    }
  }

  return { lineItems, subtotal };
};

const maskCardLabel = (method) => {
  if (!method?.card?.last4) return null;
  const brand = method.card.brand || "CARD";
  const last4 = method.card.last4;
  return `${brand} •••• ${last4}`;
};

const computeFleetPaymentBox = ({ job, defaultPaymentMethod, invoice = null }) => {
  const originalQuoteAmount = Number(job.acceptedAmount ?? 0) || 0;
  const isSettled =
    job.status === JOB_STATUS.COMPLETED ||
    `${invoice?.status || ""}`.toUpperCase() === "PAID" ||
    Boolean(invoice?.paidAt);

  const isAwaitingApproval = job.status === JOB_STATUS.AWAITING_APPROVAL;

  /**
   * Pre-settlement (assigned → in progress): estimated approval charge follows accepted quote.
   * Awaiting approval: prefer submitted completion bill so fleet sees Quoted vs Submitted.
   * After complete/pay: canon is completion bill (invoice subtotal / finalAmount).
   */
  let billExVat;
  if (isSettled) {
    billExVat = Number(invoice?.subtotal ?? job.finalAmount ?? job.acceptedAmount ?? 0) || 0;
  } else if (isAwaitingApproval) {
    billExVat =
      Number(
        job.completionInvoice?.subtotal ?? job.finalAmount ?? job.acceptedAmount ?? 0
      ) || 0;
  } else {
    billExVat = Number(job.acceptedAmount ?? job.finalAmount ?? 0) || 0;
  }

  const feePercent = getPlatformFeePercent();
  const platformFee = billExVat > 0 ? computePlatformFee(billExVat, feePercent) : 0;
  const mechanicNet = billExVat > 0 ? round2(billExVat - platformFee) : 0;

  let vatApplied = false;
  let vatRate = 0;
  let vatAmount = null;
  let chargedToFleet = null;

  if (isSettled && invoice && (invoice.totalAmount != null || invoice.subtotal != null)) {
    vatApplied = invoice.vatApplied === true || Number(invoice.vatAmount) > 0;
    vatAmount = vatApplied ? round2(Number(invoice.vatAmount) || 0) : 0;
    vatRate =
      Number(invoice.vatRate) > 0
        ? Number(invoice.vatRate)
        : vatApplied && billExVat > 0
          ? vatAmount / billExVat
          : 0;
    chargedToFleet = round2(
      Number(invoice.totalAmount != null ? invoice.totalAmount : billExVat + (vatAmount || 0)) ||
        billExVat
    );
  } else if (billExVat > 0) {
    const vat = calculateJobVat(job, billExVat);
    vatApplied = Boolean(vat.vatRegistered);
    vatRate = vat.vatRate || 0;
    vatAmount = vat.vatAmount;
    chargedToFleet = vat.totalAmount;
  }

  return {
    /** Accepted quote — historical; shown as “Original quote” after settlement. */
    quoteAmount: originalQuoteAmount || null,
    /** Amount the mechanic/billing uses before VAT (completion or quote). */
    billExVat: billExVat || null,
    platformFee: billExVat > 0 ? platformFee : null,
    mechanicNet: billExVat > 0 ? mechanicNet : null,
    platformFeePercent: billExVat > 0 ? feePercent : null,
    /** @deprecated Prefer chargedToFleet */
    totalPayable: chargedToFleet,
    chargedToFleet,
    /** @deprecated Immediate-capture flow has no pre-authorization hold. */
    preAuthHeld: null,
    vatApplied,
    vatRate,
    vatAmount: billExVat > 0 ? vatAmount : null,
    cardLabel: defaultPaymentMethod ? maskCardLabel(defaultPaymentMethod) : null,
    cardExpMonth: defaultPaymentMethod?.card?.expMonth ?? null,
    cardExpYear: defaultPaymentMethod?.card?.expYear ?? null,
    finalAmount: Number(job.finalAmount ?? billExVat ?? 0) || null,
    isSettled,
    isAwaitingApproval,
    status:
      job.status === JOB_STATUS.COMPLETED || isSettled
        ? "PAID"
        : invoice?.payment?.status ||
          (job.status === JOB_STATUS.AWAITING_APPROVAL
            ? "AWAITING_PAYMENT"
            : "NOT_STARTED"),
    currency: invoice?.currency || job.currency || "GBP",
  };
};

const resolvePayerStripeCustomerId = (payerUser, paymentMethod) => {
  if (paymentMethod?.providerCustomerId) return paymentMethod.providerCustomerId;
  if (payerUser.role === ROLES.FLEET) {
    return payerUser.fleetProfile?.stripeCustomerId || null;
  }
  if (payerUser.role === ROLES.COMPANY) {
    return payerUser.companyProfile?.stripeCustomerId || null;
  }
  return null;
};

/**
 * Bill base (ex VAT) for approve / charge / invoice / earnings.
 * Prefers completion line items → completionInvoice → finalAmount.
 * Accepted quote is last-resort legacy only — never overwrite acceptedAmount.
 */
const sumInvoiceLinesExVat = (lineItems) => {
  if (!Array.isArray(lineItems) || !lineItems.length) return null;
  const sum = round2(
    lineItems.reduce((acc, row) => acc + (Number(row.totalAmount) || 0), 0)
  );
  return sum > 0 ? sum : null;
};

const resolveApprovalBillExVat = (job, lineItems = null) => {
  const fromLines = sumInvoiceLinesExVat(lineItems);
  if (fromLines != null) return fromLines;

  const fromCompletion = Number(job?.completionInvoice?.subtotal);
  if (Number.isFinite(fromCompletion) && fromCompletion > 0) return round2(fromCompletion);

  const fromFinal = Number(job?.finalAmount);
  if (Number.isFinite(fromFinal) && fromFinal > 0) return round2(fromFinal);

  const fromQuote = Number(job?.acceptedAmount ?? job?.estimatedPayout ?? 0);
  if (Number.isFinite(fromQuote) && fromQuote > 0) return round2(fromQuote);

  return 0;
};

const hasCompletionBill = (job, lineItems = null) => {
  if (sumInvoiceLinesExVat(lineItems) != null) return true;
  if (Number(job?.completionInvoice?.subtotal) > 0) return true;
  if (Number(job?.finalAmount) > 0) return true;
  return false;
};

/** Fleet: optional Stripe. Company: Stripe required when configured. */
const buildJobApprovalPaymentContext = async ({
  job,
  payerUser,
  paymentMethodId,
  approvalRequestId: approvalRequestIdInput,
  metadata = {},
  billExVat: billExVatInput = null,
  lineItems = null,
}) => {
  const subtotal =
    billExVatInput != null && Number.isFinite(Number(billExVatInput)) && Number(billExVatInput) > 0
      ? round2(Number(billExVatInput))
      : resolveApprovalBillExVat(job, lineItems);
  const vat = calculateJobVat(job, subtotal);
  const feePercent = getPlatformFeePercent();
  const payoutAmounts = calculateDestinationChargeAmounts({
    subtotal,
    vatAmount: vat.vatAmount,
    platformFeePercent: feePercent,
  });
  const platformFee = payoutAmounts.platformFeeMinor / 100;
  const recipientNetAmount = payoutAmounts.recipientAmountMinor / 100;
  const earningNetAmount =
    (payoutAmounts.subtotalMinor - payoutAmounts.platformFeeMinor) / 100;

  const moneyMeta = {
    billExVat: subtotal,
    chargeTotal: payoutAmounts.chargeAmountMinor / 100,
    vatAmount: vat.vatAmount,
    vatRate: vat.vatRate,
    vatApplied: vat.vatRegistered,
    platformFee,
    platformFeePercent: feePercent,
    recipientNetAmount,
    mechanicNetAmount: earningNetAmount,
  };

  const methodId = `${paymentMethodId || ""}`.trim();
  if (!methodId) {
    throw new AppError(
      "A saved card is required to approve and pay. Add a card under Billing, then approve with that card.",
      400
    );
  }

  if (!getStripePublicConfig().enabled) {
    throw new AppError(
      "Online card payment is unavailable: Stripe is not configured on the server.",
      503
    );
  }

  const paymentMethod = await PaymentMethod.findOne({
    _id: methodId,
    user: payerUser._id,
    isActive: true,
  }).lean();

  if (!paymentMethod) {
    throw new AppError("Payment method not found", 404);
  }

  if (paymentMethod.provider !== "STRIPE") {
    throw new AppError("A Stripe card payment method is required for online payment", 400);
  }

  const totalAmount = payoutAmounts.chargeAmountMinor / 100;
  const payoutRecipient = await resolvePayoutRecipient(job);
  const stripeCustomerId = resolvePayerStripeCustomerId(
    payerUser,
    paymentMethod
  );
  const approvalRequestId = normalizeApprovalRequestId(approvalRequestIdInput);
  if (!approvalRequestId) {
    throw new AppError(
      "approvalAttemptId must be 8-128 letters, numbers, underscores, or hyphens",
      400
    );
  }

  const paidAttempt = await PaymentAttempt.findOne({
    job: job._id,
    paymentStatus: "SUCCEEDED",
  })
    .sort({ createdAt: -1 })
    .lean();
  let existingAttempt =
    paidAttempt ||
    (await PaymentAttempt.findOne({ job: job._id })
    .sort({ createdAt: -1 })
    .lean());

  let paymentIntent = null;
  let attemptId = paymentAttemptId(existingAttempt, approvalRequestId);
  let createIdempotencyKey =
    existingAttempt?.idempotencyKey ||
    stripePaymentAttemptIdempotencyKey(job._id, attemptId);
  let operationIdempotencyKey = createIdempotencyKey;
  let eventType = "PAYMENT_INTENT_CREATED";

  if (existingAttempt?.stripePaymentIntentId) {
    paymentIntent = await retrieveStripePaymentIntent(
      existingAttempt.stripePaymentIntentId
    );
    const retryPlan = planStripePaymentIntentRetry({
      paymentIntent,
      existingAttempt,
      paymentMethodId: paymentMethod.providerMethodId,
      approvalRequestId,
      amountMinor: payoutAmounts.chargeAmountMinor,
      currency: job.currency || "GBP",
      customerId: stripeCustomerId,
      recipientConnectAccountId: payoutRecipient.stripeConnectAccountId,
      platformFeeMinor: payoutAmounts.platformFeeMinor,
    });

    if (retryPlan === "REQUEST_CONFLICT") {
      throw new AppError(
        "approvalAttemptId was already used with different payment parameters",
        409
      );
    }

    if (retryPlan === "CONFLICT") {
      throw new AppError(
        `Stripe payment is ${paymentIntent.status} and cannot be retried safely`,
        409
      );
    }

    if (retryPlan === "CANCEL_THEN_CREATE") {
      const cancellationKey = stripePaymentCancellationIdempotencyKey(
        job._id,
        attemptId,
        approvalRequestId
      );
      const canceledIntent = await cancelStripePaymentIntent({
        paymentIntentId: paymentIntent.id,
        idempotencyKey: cancellationKey,
      });
      if (canceledIntent.status === "succeeded") {
        paymentIntent = canceledIntent;
        eventType = "PAYMENT_INTENT_REUSED";
        operationIdempotencyKey = cancellationKey;
      } else {
        if (canceledIntent.status !== "canceled") {
          throw new AppError(
            "The previous Stripe payment could not be canceled safely",
            409
          );
        }
        await PaymentAttempt.updateOne(
          { stripePaymentIntentId: canceledIntent.id },
          {
            $set: {
              paymentStatus: "CANCELED",
              processorStatus: "canceled",
            },
            $push: {
              events: {
                source: "APPROVAL",
                eventType: "PAYMENT_INTENT_CANCELED_FOR_REPLACEMENT",
                externalEventId: approvalRequestId,
                idempotencyKey: cancellationKey,
                stripePaymentMethodId: paymentMethod.providerMethodId,
                paymentStatus: "CANCELED",
                processorStatus: "canceled",
                occurredAt: new Date(),
              },
            },
          }
        );
        paymentIntent = null;
        existingAttempt = null;
        attemptId = approvalRequestId;
        createIdempotencyKey = stripePaymentAttemptIdempotencyKey(
          job._id,
          attemptId
        );
        operationIdempotencyKey = createIdempotencyKey;
        eventType = "PAYMENT_INTENT_CREATED";
      }
    } else if (retryPlan === "CONFIRM_EXISTING") {
      operationIdempotencyKey = stripePaymentConfirmationIdempotencyKey(
        job._id,
        attemptId,
        approvalRequestId
      );
      paymentIntent = await confirmStripePaymentIntent({
        paymentIntentId: paymentIntent.id,
        paymentMethodId: paymentMethod.providerMethodId,
        idempotencyKey: operationIdempotencyKey,
      });
      eventType = "PAYMENT_INTENT_RECONFIRMED";
    } else {
      eventType = "PAYMENT_INTENT_REUSED";
    }
  }

  if (!paymentIntent) {
    paymentIntent = await createStripePaymentIntent({
        amount: totalAmount,
        currency: job.currency || "GBP",
        customerId: stripeCustomerId,
        paymentMethodId: paymentMethod.providerMethodId,
        recipientConnectAccountId: payoutRecipient.stripeConnectAccountId,
        platformFeeAmount: platformFee,
        idempotencyKey: createIdempotencyKey,
        metadata: {
          jobId: job._id.toString(),
          fleetId: toObjectIdString(job.fleet),
          mechanicId: toObjectIdString(job.assignedMechanic),
          payoutRecipientId: toObjectIdString(payoutRecipient.userId),
          payoutRecipientType: payoutRecipient.recipientType,
          recipientNetAmount: `${recipientNetAmount}`,
          payerUserId: payerUser._id.toString(),
          payerRole: payerUser.role,
          billExVat: `${subtotal}`,
          vatApplied: `${vat.vatRegistered}`,
          vatRate: `${vat.vatRate}`,
          vatAmount: `${vat.vatAmount}`,
          chargeTotal: `${totalAmount}`,
          ...metadata,
        },
      });
  }

  // Off-session confirmation of a 3D Secure card fails with code
  // "authentication_required" and resets the intent to requires_payment_method.
  // Treat that as an actionable 3DS step (not a hard decline) so the client can
  // re-confirm on-session with the same card and complete authentication.
  const needsAuthentication =
    paymentIntent.status === "requires_action" ||
    paymentIntent.next_action != null ||
    paymentIntent.last_payment_error?.code === "authentication_required";
  const statusMap = invoiceStatusFromPaymentIntent(paymentIntent.status);
  const mapped = needsAuthentication
    ? { invoiceStatus: "ISSUED", paymentStatus: "REQUIRES_ACTION", paid: false }
    : { ...statusMap, paid: statusMap.markPaid };

  const intentMethod =
    typeof paymentIntent.payment_method === "string"
      ? paymentIntent.payment_method
      : paymentIntent.payment_method?.id;
  const effectivePaymentMethodId =
    eventType === "PAYMENT_INTENT_REUSED" && intentMethod
      ? intentMethod
      : paymentMethod.providerMethodId;

  await PaymentAttempt.findOneAndUpdate(
    { stripePaymentIntentId: paymentIntent.id },
    buildPaymentAttemptUpsert({
      job: job._id,
      payer: payerUser._id,
      payerRole: payerUser.role,
      amount: totalAmount,
      currency: job.currency || "GBP",
      paymentIntent,
      paymentMethodId: effectivePaymentMethodId,
      attemptId,
      createIdempotencyKey,
      operationIdempotencyKey,
      approvalRequestId,
      paymentStatus: mapped.paymentStatus,
      paid: mapped.paid,
      eventType,
    }),
    { upsert: true, new: true }
  );

  return {
    provider: "STRIPE",
    invoiceStatus: mapped.invoiceStatus,
    paymentStatus: mapped.paymentStatus,
    stripeCustomerId,
    stripePaymentMethodId: effectivePaymentMethodId,
    stripePaymentIntentId: paymentIntent.id,
    stripeClientSecret: paymentIntent.client_secret || null,
    lastError: needsAuthentication
      ? null
      : paymentIntent.last_payment_error?.message || null,
    paidAt: mapped.paid ? new Date() : undefined,
    ...moneyMeta,
  };
};

const assertStripePaymentSucceeded = (paymentContext, { required = false } = {}) => {
  if (paymentContext.provider !== "STRIPE") {
    if (required) {
      throw new AppError(
        "Online card payment is required. Add a card under Billing and pass paymentMethodId.",
        400
      );
    }
    return;
  }
  if (paymentContext.paymentStatus === "SUCCEEDED") return;

  const paymentErrorData = {
    stripePaymentIntentId: paymentContext.stripePaymentIntentId || null,
    stripePaymentMethodId: paymentContext.stripePaymentMethodId || null,
    clientSecret: paymentContext.stripeClientSecret || null,
    paymentStatus: paymentContext.paymentStatus || null,
    invoiceId: paymentContext.invoiceId ? `${paymentContext.invoiceId}` : null,
    requiresAction: paymentContext.paymentStatus === "REQUIRES_ACTION",
  };

  if (paymentContext.paymentStatus === "REQUIRES_ACTION") {
    throw new AppError(
      "Card payment requires authentication (3D Secure). Complete verification, then confirm the payment.",
      402,
      paymentErrorData
    );
  }

  throw new AppError(
    paymentContext.lastError ||
      `Card payment did not complete (status: ${paymentContext.paymentStatus || "unknown"})`,
    402,
    paymentErrorData
  );
};

/**
 * Settle an approval payment.
 * - SUCCEEDED: mark the job completed, write invoice + earning, emit events.
 * - Not yet paid (3DS / processing / failed): persist the invoice attempt row
 *   so the sync/webhook path can reconcile, keep the job AWAITING_APPROVAL,
 *   and throw a structured 402 the client can drive to completion.
 */
const settleApprovalPayment = async ({
  job,
  fromStatus,
  actorUser,
  paymentContext,
  eventExtras = {},
  breakdown = null,
}) => {
  if (paymentContext.paymentStatus === "SUCCEEDED") {
    await markJobCompletedAfterApproval(job, {}, breakdown || null);
    return finalizeApprovedJobCompletion({
      job,
      fromStatus,
      actorUser,
      paymentContext,
      eventExtras,
    });
  }

  // Not paid yet — persist an invoice attempt row so 3DS confirmation / webhook
  // can find and finalize it, then surface the actionable 402 to the client.
  const financials = await upsertFinancialRecordsForCompletedJob(job, paymentContext);
  assertStripePaymentSucceeded(
    { ...paymentContext, invoiceId: financials.invoice?._id || null },
    { required: true }
  );
  return { job, invoice: financials.invoice, earningTransaction: null };
};

const acquireApprovalPaymentLock = async (jobId) => {
  const token = crypto.randomUUID();
  const now = new Date();
  const expiresAt = new Date(now.getTime() + 5 * 60 * 1000);
  const result = await Job.updateOne(
    {
      _id: jobId,
      status: JOB_STATUS.AWAITING_APPROVAL,
      $or: [
        { "approvalPaymentLock.token": { $exists: false } },
        { "approvalPaymentLock.expiresAt": { $lte: now } },
      ],
    },
    { $set: { approvalPaymentLock: { token, expiresAt } } }
  );
  if (result.modifiedCount !== 1) {
    throw new AppError(
      "This job payment is already being processed. Wait for it to finish before retrying.",
      409
    );
  }
  return token;
};

const releaseApprovalPaymentLock = (jobId, token) =>
  Job.updateOne(
    { _id: jobId, "approvalPaymentLock.token": token },
    { $unset: { approvalPaymentLock: 1 } }
  );

/**
 * Recompute the mechanic's cached profile stats after a job completes.
 * - jobsDone: true count of COMPLETED jobs assigned to the mechanic (self-healing).
 * - responseMinutesAvg: avg ASSIGNED → EN_ROUTE time over the last 50 completed jobs.
 * Best-effort: a stats failure must never block job completion/payment.
 */
const refreshMechanicStatsAfterCompletion = async (job) => {
  const mechanicId = job?.assignedMechanic?._id || job?.assignedMechanic;
  if (!mechanicId) return;
  try {
    const [jobsDone, recentJobs] = await Promise.all([
      Job.countDocuments({
        assignedMechanic: mechanicId,
        status: JOB_STATUS.COMPLETED,
      }),
      Job.find({
        assignedMechanic: mechanicId,
        status: JOB_STATUS.COMPLETED,
        assignedAt: { $ne: null },
      })
        .sort({ completedAt: -1 })
        .limit(50)
        .select("_id assignedAt")
        .lean(),
    ]);

    let responseMinutesAvg = null;
    if (recentJobs.length) {
      const events = await JobEvent.find({
        job: { $in: recentJobs.map((j) => j._id) },
        toStatus: JOB_STATUS.EN_ROUTE,
      })
        .sort({ createdAt: 1 })
        .select("job createdAt")
        .lean();
      const firstEnRouteByJob = new Map();
      for (const e of events) {
        const key = e.job.toString();
        if (!firstEnRouteByJob.has(key)) firstEnRouteByJob.set(key, e.createdAt);
      }
      const samples = [];
      for (const j of recentJobs) {
        const enRouteAt = firstEnRouteByJob.get(j._id.toString());
        if (!enRouteAt) continue;
        const minutes =
          (new Date(enRouteAt).getTime() - new Date(j.assignedAt).getTime()) / 60000;
        if (Number.isFinite(minutes) && minutes >= 0) samples.push(minutes);
      }
      if (samples.length) {
        responseMinutesAvg = Math.max(
          1,
          Math.round(samples.reduce((a, b) => a + b, 0) / samples.length)
        );
      }
    }

    const $set = { "mechanicProfile.stats.jobsDone": jobsDone };
    if (responseMinutesAvg != null) {
      $set["mechanicProfile.stats.responseMinutesAvg"] = responseMinutesAvg;
    }
    await User.updateOne({ _id: mechanicId }, { $set });
  } catch (err) {
    console.error("Failed to refresh mechanic stats after job completion", err);
  }
};

/**
 * Finalize a job whose payment was confirmed asynchronously (3DS sync or
 * Stripe webhook). Idempotent: only transitions a job still awaiting approval.
 */
export const completeJobOnConfirmedPayment = async (jobId, { paymentStatus } = {}) => {
  const job = await Job.findById(jobId)
    .populate("fleet", "fleetProfile")
    .populate("assignedCompany", "role companyProfile")
    .populate("assignedMechanic", "role mechanicProfile");
  if (!job || job.status !== JOB_STATUS.AWAITING_APPROVAL) return null;

  const fromStatus = job.status;
  job.status = JOB_STATUS.COMPLETED;
  job.completedAt = new Date();
  job.approvalPaymentLock = undefined;
  job.paymentCollectionState = "RESOLVED";
  job.paymentNextReminderAt = undefined;
  await job.save();

  await createJobEvent({
    jobId: job._id,
    actorId: job.fleet?._id || job.fleet,
    type: "JOB_COMPLETED",
    fromStatus,
    toStatus: JOB_STATUS.COMPLETED,
    payload: { paymentStatus: paymentStatus || "SUCCEEDED", confirmedAsync: true },
  });

  emitJobStatusChanged(job, {
    previousStatus: fromStatus,
    changedBy: toObjectIdString(job.fleet?._id || job.fleet),
    paymentStatus: paymentStatus || "SUCCEEDED",
  });

  await notifyJobCompleted(job, {
    approvedByCompany: Boolean(job.assignedCompany),
  });

  await refreshMechanicStatsAfterCompletion(job);

  return job;
};

const markJobCompletedAfterApproval = async (job, payload = {}, breakdown = null) => {
  if (breakdown) {
    job.finalAmount = breakdown.subtotal;
  } else if (payload.finalAmount !== undefined) {
    job.finalAmount = round2(Number(payload.finalAmount));
  }
  job.status = JOB_STATUS.COMPLETED;
  job.completedAt = new Date();
  job.approvalPaymentLock = undefined;
  job.paymentCollectionState = "RESOLVED";
  job.paymentNextReminderAt = undefined;
  await job.save();
};

const deriveStatusTimes = async (jobId, jobDocOrLean) => {
  const events = await JobEvent.find({
    job: jobId,
    toStatus: { $exists: true, $ne: null },
  })
    .sort({ createdAt: 1 })
    .select("toStatus createdAt")
    .lean();

  const times = {};
  for (const e of events) {
    const key = e?.toStatus;
    if (!key) continue;
    if (!times[key]) times[key] = e.createdAt;
  }

  // Fallbacks from job fields (some are explicitly stored on Job)
  const j = jobDocOrLean || {};
  times[JOB_STATUS.POSTED] = times[JOB_STATUS.POSTED] || j.postedAt || j.createdAt || null;
  times[JOB_STATUS.ASSIGNED] = times[JOB_STATUS.ASSIGNED] || j.assignedAt || null;
  times[JOB_STATUS.COMPLETED] = times[JOB_STATUS.COMPLETED] || j.completedAt || null;
  times[JOB_STATUS.CANCELLED] = times[JOB_STATUS.CANCELLED] || j.cancelledAt || null;

  return {
    postedAt: times[JOB_STATUS.POSTED] || null,
    assignedAt: times[JOB_STATUS.ASSIGNED] || null,
    enRouteAt: times[JOB_STATUS.EN_ROUTE] || null,
    onSiteAt: times[JOB_STATUS.ON_SITE] || null,
    inProgressAt: times[JOB_STATUS.IN_PROGRESS] || null,
    awaitingApprovalAt: times[JOB_STATUS.AWAITING_APPROVAL] || null,
    completedAt: times[JOB_STATUS.COMPLETED] || null,
    cancelledAt: times[JOB_STATUS.CANCELLED] || null,
  };
};

/** Normalized last mechanic GPS fix for job detail + map.origin (GeoJSON point). */
const normalizeMechanicLocationSnapshot = (src) => {
  if (!src?.point?.coordinates || !Array.isArray(src.point.coordinates) || src.point.coordinates.length !== 2) {
    return null;
  }
  const [lng, lat] = src.point.coordinates.map(Number);
  if (!Number.isFinite(lng) || !Number.isFinite(lat)) return null;
  return {
    point: { type: "Point", coordinates: [lng, lat] },
    heading: src.heading ?? null,
    speed: src.speed ?? null,
    accuracy: src.accuracy ?? null,
    updatedAt: src.updatedAt || src.pingedAt || null,
  };
};

/**
 * Resolve mechanic map position for GET /jobs/:id (detail):
 * 1) job.tracking.latestMechanicLocation
 * 2) latest JobLocationPing
 * 3) assignee's mechanicProfile.lastKnownLocation (from profile / seed)
 * 4) deterministic offset from job.location when a mechanic is assigned (map never empty for demos)
 */
const loadLatestMechanicLocationForJob = async (job) => {
  const jobId = job._id;
  const fromTracking = normalizeMechanicLocationSnapshot(job.tracking?.latestMechanicLocation);
  if (fromTracking) return { snapshot: fromTracking, source: "JOB_TRACKING" };

  const ping = await JobLocationPing.findOne({ job: jobId }).sort({ pingedAt: -1 }).lean();
  if (ping) {
    const snapshot = normalizeMechanicLocationSnapshot({
      point: ping.point,
      heading: ping.heading,
      speed: ping.speed,
      accuracy: ping.accuracy,
      pingedAt: ping.pingedAt,
    });
    if (snapshot) return { snapshot, source: "LOCATION_PING" };
  }

  const mechId = job.assignedMechanic?._id || job.assignedMechanic;
  if (mechId) {
    const mech = await User.findById(toObjectIdString(mechId))
      .select("mechanicProfile.lastKnownLocation")
      .lean();
    const lk = mech?.mechanicProfile?.lastKnownLocation;
    if (lk?.coordinates?.length === 2) {
      const snapshot = normalizeMechanicLocationSnapshot({
        point: { type: "Point", coordinates: lk.coordinates },
        updatedAt: lk.updatedAt,
      });
      if (snapshot) return { snapshot, source: "MECHANIC_PROFILE_LAST_KNOWN" };
    }
  }

  const coords = job.location?.coordinates;
  if (mechId && Array.isArray(coords) && coords.length === 2) {
    const [lng, lat] = coords.map(Number);
    if (Number.isFinite(lng) && Number.isFinite(lat)) {
      const snapshot = normalizeMechanicLocationSnapshot({
        point: { type: "Point", coordinates: [lng + 0.02, lat - 0.015] },
        updatedAt: job.assignedAt || job.updatedAt || new Date(),
      });
      if (snapshot) return { snapshot, source: "FALLBACK_NEAR_JOB_SITE" };
    }
  }

  return null;
};

const formatJobCompletedDisplay = (value) => {
  if (!value) return null;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  const s = new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(d);
  return s.includes(",") ? s.replace(",", " -") : s;
};

const formatDurationBetween = (start, end) => {
  if (!start || !end) return null;
  const a = new Date(start).getTime();
  const b = new Date(end).getTime();
  if (!Number.isFinite(a) || !Number.isFinite(b) || b <= a) return null;
  const totalMins = Math.round((b - a) / 60000);
  const h = Math.floor(totalMins / 60);
  const m = totalMins % 60;
  const parts = [];
  if (h > 0) parts.push(`${h} hr${h === 1 ? "" : "s"}`);
  if (m > 0 || h === 0) parts.push(`${m} min`);
  return parts.join(" ");
};

const vehicleLineFromJob = (job) => {
  const v = job.vehicle || {};
  const type = `${v.type || ""}`.trim();
  const reg = `${v.registration || ""}`.trim();
  if (type && reg) return `${type} - ${reg}`;
  const mm = [v.make, v.model].filter(Boolean).join(" ").trim();
  if (mm && reg) return `${mm} - ${reg}`;
  return mm || reg || null;
};

const issueLineFromJob = (job) => {
  const t = `${job.title || ""}`.trim();
  if (t) return t;
  const d = `${job.description || ""}`.trim();
  if (!d) return null;
  return d.length > 160 ? `${d.slice(0, 157)}...` : d;
};

const buildJobSummaryForDetail = (job, statusTimes = {}) => {
  const fleetName = job.fleet?.fleetProfile?.companyName || job.fleet?.companyName || null;
  const completedAt = job.completedAt || null;
  const completedLabel = formatJobCompletedDisplay(completedAt);
  const startForDuration = job.assignedAt || statusTimes.assignedAt || job.postedAt || job.createdAt;
  let durationLabel = null;
  if (job.status === JOB_STATUS.COMPLETED && startForDuration && job.completedAt) {
    durationLabel = formatDurationBetween(startForDuration, job.completedAt);
  } else if (job.status === JOB_STATUS.AWAITING_APPROVAL && startForDuration && statusTimes.awaitingApprovalAt) {
    durationLabel = formatDurationBetween(startForDuration, statusTimes.awaitingApprovalAt);
  }
  const submittedForApprovalLabel = formatJobCompletedDisplay(statusTimes.awaitingApprovalAt);

  return {
    vehicleLine: vehicleLineFromJob(job),
    fleetName,
    issueLine: issueLineFromJob(job),
    completedAt,
    completedLabel,
    submittedForApprovalAt: statusTimes.awaitingApprovalAt || null,
    submittedForApprovalLabel:
      job.status === JOB_STATUS.AWAITING_APPROVAL ? submittedForApprovalLabel : null,
    durationLabel,
  };
};

const completionPhotosForDetail = async (job, statusTimes) => {
  const stored = Array.isArray(job.completionPhotos)
    ? job.completionPhotos.filter(Boolean)
    : [];
  if (stored.length) return [...new Set(stored)];
  if (!statusTimes.inProgressAt || !statusTimes.awaitingApprovalAt) return [];

  // Submissions created before completionPhotos existed still have an immutable
  // mechanic photo-upload event immediately before WORK_COMPLETED.
  const upperBound = new Date(
    new Date(statusTimes.awaitingApprovalAt).getTime() + 5 * 60 * 1000
  );
  const events = await JobEvent.find({
    job: job._id,
    type: "JOB_PHOTOS_ADDED",
    actor: job.assignedMechanic?._id || job.assignedMechanic,
    createdAt: {
      $gte: statusTimes.inProgressAt,
      $lte: upperBound,
    },
  })
    .sort({ createdAt: 1 })
    .select("payload.photos")
    .lean();

  return [
    ...new Set(
      events.flatMap((event) =>
        Array.isArray(event.payload?.photos)
          ? event.payload.photos.filter(Boolean)
          : []
      )
    ),
  ];
};

const buildSubmittedWorkForDetail = async (job, invoiceDoc, statusTimes) => {
  const completionInvoice =
    job.completionInvoice && typeof job.completionInvoice === "object"
      ? job.completionInvoice
      : null;
  const lineItems =
    (Array.isArray(completionInvoice?.lineItems) &&
    completionInvoice.lineItems.length
      ? completionInvoice.lineItems
      : invoiceDoc?.lineItems || []
    ).map((row) => ({
      description: `${row.description || "Service"}`.trim(),
      quantity: Number(row.quantity) || 1,
      unitAmount: round2(row.unitAmount ?? row.totalAmount ?? 0),
      totalAmount: round2(row.totalAmount ?? row.unitAmount ?? 0),
    }));
  const inputs = completionInvoice?.submittedInputs || {};
  const callOutLine = lineItems.find((row) =>
    /call[\s-]?out/i.test(row.description)
  );
  const labourLine = lineItems.find((row) =>
    /labou?r/i.test(row.description)
  );
  const parts = Array.isArray(inputs.parts)
    ? inputs.parts
        .map((part) => ({
          description: `${
            part?.description ?? part?.name ?? "Part"
          }`.trim(),
          amount: round2(
            part?.amount ??
              part?.price ??
              part?.totalAmount ??
              part?.cost ??
              0
          ),
        }))
        .filter((part) => part.description && part.amount >= 0)
    : lineItems
        .filter(
          (row) =>
            !/call[\s-]?out/i.test(row.description) &&
            !/labou?r/i.test(row.description)
        )
        .map((row) => ({
          description: row.description,
          amount: row.totalAmount,
        }));
  const photos = await completionPhotosForDetail(job, statusTimes);
  const notes = job.completionSummary || null;
  const subtotal = round2(
    completionInvoice?.subtotal ??
      invoiceDoc?.subtotal ??
      job.finalAmount ??
      lineItems.reduce((sum, row) => sum + row.totalAmount, 0)
  );
  if (!notes && !lineItems.length && !photos.length && subtotal <= 0) return null;

  const labourHours = Number(
    inputs.labourHours ?? labourLine?.quantity ?? 0
  );
  const labourRatePerHour = round2(
    inputs.labourRatePerHour ?? labourLine?.unitAmount ?? 0
  );

  return {
    submittedAt: statusTimes.awaitingApprovalAt || null,
    notes,
    currency:
      completionInvoice?.currency || invoiceDoc?.currency || job.currency || "GBP",
    subtotal,
    callOutCharge: round2(
      inputs.callOutCharge ?? callOutLine?.totalAmount ?? 0
    ),
    labourHours,
    labourRatePerHour,
    labourTotal: round2(
      labourLine?.totalAmount || labourHours * labourRatePerHour
    ),
    parts,
    lineItems,
    photos,
  };
};

const serializeJobDetail = async (job, viewer) => {
  const base = serializeJobCard(job, viewer);
  const viewerId = toObjectIdString(viewer._id);
  const canViewSubmittedWork =
    viewer.role === ROLES.ADMIN ||
    (viewer.role === ROLES.FLEET &&
      toObjectIdString(job.fleet?._id || job.fleet) === viewerId) ||
    (viewer.role === ROLES.COMPANY &&
      toObjectIdString(job.assignedCompany?._id || job.assignedCompany) ===
        viewerId) ||
    ([ROLES.MECHANIC, ROLES.MECHANIC_EMPLOYEE].includes(viewer.role) &&
      toObjectIdString(job.assignedMechanic?._id || job.assignedMechanic) ===
        viewerId);
  const myQuote =
    viewer.role === ROLES.MECHANIC
      ? await Quote.findOne({ job: job._id, mechanic: viewer._id }).sort({ createdAt: -1 }).lean()
      : viewer.role === ROLES.COMPANY
        ? await Quote.findOne({ job: job._id, company: viewer._id }).sort({ createdAt: -1 }).lean()
        : null;
  const acceptedQuote = job.acceptedQuote
    ? await Quote.findById(job.acceptedQuote?._id || job.acceptedQuote).lean()
    : null;

  const statusTimes = await deriveStatusTimes(job._id, job);
  const mlResult = await loadLatestMechanicLocationForJob(job);
  const mechanicLocation = mlResult ? { ...mlResult.snapshot, source: mlResult.source } : null;
  const mergedTracking =
    mlResult?.snapshot || job.tracking
      ? {
          ...(job.tracking || {}),
          ...(mlResult?.snapshot ? { latestMechanicLocation: mlResult.snapshot } : {}),
        }
      : null;

  const defaultPaymentMethod =
    viewer.role === ROLES.FLEET
      ? await PaymentMethod.findOne({
          user: toObjectIdString(job.fleet),
          isDefault: true,
          isActive: true,
        }).lean()
      : null;

  const invoiceDoc = await Invoice.findOne({ job: job._id })
    .select(
      "invoiceNo status totalAmount subtotal vatAmount vatRate vatApplied currency paidAt issuedAt lineItems billedToSnapshot mechanicSnapshot payment"
    )
    .lean();
  const submittedWork = canViewSubmittedWork
    ? await buildSubmittedWorkForDetail(job, invoiceDoc, statusTimes)
    : null;
  const completionPhotoSet = new Set(job.completionPhotos || []);
  const providerProfile =
    job.assignedCompany?.companyProfile ||
    job.assignedMechanic?.mechanicProfile ||
    {};
  const isEmergency = job.mode === "EMERGENCY";
  const fallbackHourlyRate =
    isEmergency && Number(providerProfile.emergencyRate) > 0
      ? Number(providerProfile.emergencyRate)
      : Number(providerProfile.hourlyRate);
  const commercialTerms =
    canViewSubmittedWork &&
    (acceptedQuote?.pricing || Number.isFinite(fallbackHourlyRate))
      ? {
          source: acceptedQuote?.pricing ? "QUOTE_SNAPSHOT" : "PROFILE_FALLBACK",
          rateType:
            acceptedQuote?.pricing?.rateType ||
            (isEmergency ? "EMERGENCY" : "STANDARD"),
          hourlyRate:
            acceptedQuote?.pricing?.hourlyRate || fallbackHourlyRate || null,
          callOutFee:
            acceptedQuote?.pricing?.callOutFee ??
            Number(providerProfile.callOutFee || 0),
          estimatedLabourHours:
            acceptedQuote?.pricing?.estimatedLabourHours ?? null,
          labourTotal: acceptedQuote?.pricing?.labourTotal ?? null,
          parts: acceptedQuote?.pricing?.parts || [],
          partsTotal: acceptedQuote?.pricing?.partsTotal ?? null,
          quotedSubtotal:
            acceptedQuote?.pricing?.subtotal ??
            acceptedQuote?.amount ??
            job.acceptedAmount ??
            null,
          currency: "GBP",
          capturedAt:
            acceptedQuote?.pricing?.profileRateCapturedAt ||
            acceptedQuote?.createdAt ||
            null,
        }
      : null;

  return {
    ...base,
    completionSummary: canViewSubmittedWork ? base.completionSummary : null,
    photos: canViewSubmittedWork
      ? base.photos
      : base.photos.filter((url) => !completionPhotoSet.has(url)),
    tracking: mergedTracking,
    mechanicLocation,
    summary: {
      postedAgoLabel: formatRelativeAge(job.postedAt || job.createdAt),
      distanceMiles: base.distanceMiles ?? null,
      etaMinutes: job.tracking?.etaMinutes ?? null,
    },
    statusTimeline: statusTimes,
    completionPhotos: submittedWork?.photos || [],
    completionInvoice:
      canViewSubmittedWork && job.completionInvoice
        ? job.completionInvoice
        : null,
    submittedWork,
    commercialTerms,
    map: {
      origin: mechanicLocation?.point || null,
      destination: job.location || null,
      etaMinutes: job.tracking?.etaMinutes ?? null,
    },
    workflow: {
      currentStep: job.status,
      steps: [
        { key: JOB_STATUS.ASSIGNED, label: "Journey", done: [JOB_STATUS.EN_ROUTE, JOB_STATUS.ON_SITE, JOB_STATUS.IN_PROGRESS, JOB_STATUS.AWAITING_APPROVAL, JOB_STATUS.COMPLETED].includes(job.status), active: job.status === JOB_STATUS.ASSIGNED },
        { key: JOB_STATUS.EN_ROUTE, label: "Arrived", done: [JOB_STATUS.ON_SITE, JOB_STATUS.IN_PROGRESS, JOB_STATUS.AWAITING_APPROVAL, JOB_STATUS.COMPLETED].includes(job.status), active: job.status === JOB_STATUS.EN_ROUTE },
        { key: JOB_STATUS.ON_SITE, label: "Work", done: [JOB_STATUS.IN_PROGRESS, JOB_STATUS.AWAITING_APPROVAL, JOB_STATUS.COMPLETED].includes(job.status), active: job.status === JOB_STATUS.ON_SITE },
        { key: JOB_STATUS.IN_PROGRESS, label: "Progress", done: [JOB_STATUS.AWAITING_APPROVAL, JOB_STATUS.COMPLETED].includes(job.status), active: job.status === JOB_STATUS.IN_PROGRESS },
        { key: JOB_STATUS.COMPLETED, label: "Done", done: job.status === JOB_STATUS.COMPLETED, active: job.status === JOB_STATUS.AWAITING_APPROVAL || job.status === JOB_STATUS.COMPLETED },
      ],
    },
    quoteContext: myQuote
      ? (() => {
          const { displayStatus, canOpenActiveJob } = resolveQuoteDisplayLifecycle({
            status: myQuote.status,
            job: { status: job.status },
          });
          return {
            myQuoteId: myQuote._id,
            amount: myQuote.amount,
            status: myQuote.status,
            displayStatus,
            canOpenActiveJob,
            notes: myQuote.notes || null,
            availabilityType: myQuote.availabilityType,
            scheduledAt: myQuote.scheduledAt || null,
            etaMinutes: myQuote.etaMinutes ?? null,
            pricing: myQuote.pricing || null,
          };
        })()
      : null,
    paymentSummary:
      viewer.role === ROLES.FLEET
        ? computeFleetPaymentBox({ job, defaultPaymentMethod, invoice: invoiceDoc })
        : null,
    invoice: canViewSubmittedWork && invoiceDoc
      ? {
          _id: invoiceDoc._id,
          invoiceNo: invoiceDoc.invoiceNo,
          status: invoiceDoc.status,
          totalAmount: invoiceDoc.totalAmount,
          subtotal: invoiceDoc.subtotal,
          vatAmount: invoiceDoc.vatAmount,
          vatRate: invoiceDoc.vatRate,
          vatApplied: invoiceDoc.vatApplied,
          currency: invoiceDoc.currency,
          paidAt: invoiceDoc.paidAt,
          issuedAt: invoiceDoc.issuedAt,
          lineItems: invoiceDoc.lineItems || [],
          billedToSnapshot: invoiceDoc.billedToSnapshot || null,
          mechanicSnapshot: invoiceDoc.mechanicSnapshot || null,
          payment: invoiceDoc.payment
            ? {
                provider: invoiceDoc.payment.provider,
                status: invoiceDoc.payment.status,
                stripePaymentIntentId: invoiceDoc.payment.stripePaymentIntentId,
                disputeStatus: invoiceDoc.payment.disputeStatus,
              }
            : null,
        }
      : null,
    jobSummary: buildJobSummaryForDetail(job, statusTimes),
  };
};

const generateJobCode = async () => {
  for (let i = 0; i < 8; i += 1) {
    const random = Math.floor(1000 + Math.random() * 9000);
    const jobCode = `TF-${random}`;
    const exists = await Job.exists({ jobCode });
    if (!exists) return jobCode;
  }
  throw new AppError("Unable to generate job code", 500);
};

const generateInvoiceNo = async () => {
  for (let i = 0; i < 8; i += 1) {
    const random = Math.floor(1000 + Math.random() * 9000);
    const invoiceNo = `INV-${new Date().getFullYear()}-${random}`;
    const exists = await Invoice.exists({ invoiceNo });
    if (!exists) return invoiceNo;
  }
  throw new AppError("Unable to generate invoice number", 500);
};

const ensureLocation = (payload) => {
  const location = payload.location || {};
  let coordinates = location.coordinates || payload.coordinates;

  // Accept GeoJSON [lng, lat] or plain { lat, lng } / { latitude, longitude }.
  if (!Array.isArray(coordinates) || coordinates.length !== 2) {
    const lng = Number(location.lng ?? location.longitude ?? payload.lng ?? payload.longitude);
    const lat = Number(location.lat ?? location.latitude ?? payload.lat ?? payload.latitude);
    if (Number.isFinite(lng) && Number.isFinite(lat)) {
      coordinates = [lng, lat];
    }
  }

  if (!Array.isArray(coordinates) || coordinates.length !== 2) {
    throw new AppError("location.coordinates must be [lng, lat]", 400);
  }

  const [lng, lat] = coordinates.map(Number);
  if (!Number.isFinite(lng) || !Number.isFinite(lat)) {
    throw new AppError("location.coordinates must be [lng, lat]", 400);
  }

  return {
    type: "Point",
    coordinates: [lng, lat],
    address: location.address || payload.address,
  };
};

const normalizeAvailabilityWindow = (payload = {}) => {
  const rawWindow = payload.availabilityWindow || {};
  const fromValue = rawWindow.from || payload.availabilityFrom || payload.scheduledFor;
  const toValue = rawWindow.to || payload.availabilityTo;
  const from = fromValue ? new Date(fromValue) : null;
  const to = toValue ? new Date(toValue) : null;

  if (fromValue && Number.isNaN(from.getTime())) {
    throw new AppError("availabilityWindow.from must be a valid date", 400);
  }
  if (toValue && Number.isNaN(to.getTime())) {
    throw new AppError("availabilityWindow.to must be a valid date", 400);
  }
  if (from && to && to <= from) {
    throw new AppError("availabilityWindow.to must be after availabilityWindow.from", 400);
  }

  return {
    scheduledFor: from || undefined,
    availabilityWindow: from || to ? { from: from || undefined, to: to || undefined } : undefined,
  };
};

const createJobEvent = async ({
  jobId,
  actorId,
  type,
  fromStatus,
  toStatus,
  note,
  payload,
}) => {
  const event = await JobEvent.create({
    job: jobId,
    actor: actorId,
    type,
    fromStatus,
    toStatus,
    note,
    payload,
  });
  emitJobEvent({
    jobId: toObjectIdString(jobId),
    event: {
      _id: event._id,
      jobId: toObjectIdString(jobId),
      actorId: toObjectIdString(actorId),
      type,
      fromStatus: fromStatus || null,
      toStatus: toStatus || null,
      note: note || null,
      payload: payload || null,
      createdAt: event.createdAt,
    },
  });
  return event;
};

const ensureFleetOwner = (job, fleetUserId) => {
  if (toObjectIdString(job.fleet) !== toObjectIdString(fleetUserId)) {
    throw new AppError("Forbidden", 403);
  }
};

const ensureCompanyAssignedJob = (job, companyUserId) => {
  if (!job.assignedCompany || toObjectIdString(job.assignedCompany) !== toObjectIdString(companyUserId)) {
    throw new AppError("Job is not assigned to your company", 403);
  }
};

const ensureAssignedMechanic = (job, mechanicUserId) => {
  if (toObjectIdString(job.assignedMechanic) !== toObjectIdString(mechanicUserId)) {
    throw new AppError("Forbidden", 403);
  }
};

export const assertJobParticipantAccess = (job, user) => {
  if (user.role === ROLES.ADMIN) return;

  const fleetId = toObjectIdString(job.fleet);
  const mechanicId = toObjectIdString(job.assignedMechanic);
  const companyId = toObjectIdString(job.assignedCompany);
  const userId = toObjectIdString(user._id);

  if (user.role === ROLES.FLEET && fleetId === userId) return;
  if (user.role === ROLES.MECHANIC && mechanicId === userId) return;
  if (user.role === ROLES.MECHANIC_EMPLOYEE && mechanicId === userId) return;
  if (user.role === ROLES.COMPANY && companyId === userId) return;

  throw new AppError("Forbidden", 403);
};

const mimeToExtension = (mime) => {
  const normalized = `${mime || ""}`.trim().toLowerCase();
  const map = {
    "image/jpeg": "jpg",
    "image/jpg": "jpg",
    "image/png": "png",
    "image/webp": "webp",
    "image/gif": "gif",
    "image/heic": "heic",
    "image/heif": "heif",
  };
  return map[normalized] || null;
};

const parseDataUrl = (value) => {
  const match = `${value || ""}`.match(/^data:(image\/[a-z0-9.+-]+);base64,(.+)$/i);
  if (!match) throw new AppError("photo dataUrl must be a valid base64 image data URL", 400);

  const extension = mimeToExtension(match[1]);
  if (!extension) throw new AppError("Unsupported image type", 400);

  return {
    extension,
    buffer: Buffer.from(match[2], "base64"),
  };
};

const mimeToDocExtension = (mime) => {
  const m = `${mime || ""}`.trim().toLowerCase();
  const map = {
    "application/pdf": "pdf",
    "application/msword": "doc",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
    "text/plain": "txt",
  };
  if (map[m]) return map[m];
  return null;
};

const classifyAttachmentFileType = (mime) => {
  const m = `${mime || ""}`.trim().toLowerCase();
  if (m.startsWith("image/")) return "IMAGE";
  if (m === "application/pdf") return "PDF";
  if (m.includes("word") || m.includes("officedocument") || m === "text/plain") {
    return "DOCUMENT";
  }
  return "OTHER";
};

const parseGenericAttachmentDataUrl = (value) => {
  const match = `${value || ""}`.match(/^data:([^;]+);base64,(.+)$/i);
  if (!match) throw new AppError("dataUrl must be a valid base64 data URL", 400);

  const mime = match[1].trim().toLowerCase();
  const buffer = Buffer.from(match[2], "base64");
  const maxBytes = 12 * 1024 * 1024;
  if (buffer.length > maxBytes) {
    throw new AppError("Attachment exceeds size limit (12mb)", 400);
  }

  const fileType = classifyAttachmentFileType(mime);
  let ext;
  if (fileType === "IMAGE") {
    ext = mimeToExtension(mime);
  } else {
    ext = mimeToDocExtension(mime);
  }
  if (!ext) {
    if (fileType === "OTHER") ext = "bin";
    else throw new AppError("Unsupported file type for this upload", 400);
  }

  return { mime, buffer, fileType, ext };
};

const serializeJobAttachment = (a) => ({
  _id: a._id,
  url: a.url,
  fileType: a.fileType,
  category: a.category,
  mimeType: a.mimeType || null,
  originalName: a.originalName || null,
  uploadedBy: a.uploadedBy?._id || a.uploadedBy,
  createdAt: a.createdAt,
  updatedAt: a.updatedAt,
});

const sanitizeFileName = (value) =>
  `${value || ""}`
    .trim()
    .replace(/[^a-zA-Z0-9._-]/g, "-")
    .replace(/-+/g, "-");

const defaultInvoiceLineItems = (job, subtotal) => {
  const amount = round2(Number(subtotal) || 0);
  return [
    {
      description: "Repair service",
      quantity: 1,
      unitAmount: amount,
      totalAmount: amount,
    },
  ];
};

/**
 * Prefer mechanic completion breakdown (call-out / labour / parts) over a single lump line.
 */
const resolveCompletionInvoiceLineItems = async (job) => {
  const fromJob = job?.completionInvoice?.lineItems;
  if (Array.isArray(fromJob) && fromJob.length) {
    return fromJob.map((row) => ({
      description: `${row.description || "Service"}`.trim().slice(0, 240) || "Service",
      quantity: Number(row.quantity) > 0 ? Number(row.quantity) : 1,
      unitAmount: round2(Number(row.unitAmount ?? row.totalAmount ?? 0)),
      totalAmount: round2(Number(row.totalAmount ?? row.unitAmount ?? 0)),
    }));
  }

  const event = await JobEvent.findOne({
    job: job._id,
    type: "WORK_COMPLETED",
  })
    .sort({ createdAt: -1 })
    .select("payload")
    .lean();

  const summaries = event?.payload?.invoiceLineItems || event?.payload?.invoiceLineSummaries;
  if (Array.isArray(summaries) && summaries.length) {
    return summaries.map((row) => {
      const total = round2(Number(row.totalAmount ?? row.amount ?? row.unitAmount ?? 0));
      const qty = Number(row.quantity) > 0 ? Number(row.quantity) : 1;
      const unit = row.unitAmount != null ? round2(Number(row.unitAmount)) : total;
      return {
        description: `${row.description || "Service"}`.trim().slice(0, 240) || "Service",
        quantity: qty,
        unitAmount: unit,
        totalAmount: total,
      };
    });
  }

  return null;
};

const isDegenerateInvoiceLineItems = (lineItems, job) => {
  if (!Array.isArray(lineItems) || lineItems.length === 0) return true;
  if (lineItems.length !== 1) return false;
  const desc = `${lineItems[0]?.description || ""}`.trim();
  const jobDesc = `${job?.description || ""}`.trim();
  const jobSummary = `${job?.completionSummary || ""}`.trim();
  if (!desc) return true;
  if (jobDesc && desc === jobDesc) return true;
  if (jobSummary && desc === jobSummary) return true;
  return false;
};

const upsertFinancialRecordsForCompletedJob = async (job, paymentContext = {}) => {
  if (!job.assignedCompany && !job.assignedMechanic) {
    return { invoice: null, earningTransaction: null };
  }
  const payoutRecipient = await resolvePayoutRecipient(job, {
    requireStripeReady: false,
  });
  const isCompanyPayout = payoutRecipient.recipientType === ROLES.COMPANY;
  const recipientFilter = isCompanyPayout
    ? { company: payoutRecipient.userId }
    : { mechanic: payoutRecipient.userId };

  // Ensure fleet billing fields are available for invoice snapshots.
  if (!job.fleet?.fleetProfile) {
    await job.populate?.(
      "fleet",
      "email fleetProfile.companyName fleetProfile.vatNumber fleetProfile.billingAddress"
    );
  }
  if (!job.fleet?.fleetProfile && job.fleet) {
    const fleetDoc = await User.findById(job.fleet)
      .select("email fleetProfile.companyName fleetProfile.vatNumber fleetProfile.billingAddress")
      .lean();
    if (fleetDoc) job.fleet = fleetDoc;
  }

  const lineItemsFromContext =
    Array.isArray(paymentContext.lineItems) && paymentContext.lineItems.length > 0
      ? paymentContext.lineItems
      : null;
  let customLines = lineItemsFromContext;
  if (!customLines) {
    customLines = await resolveCompletionInvoiceLineItems(job);
  }

  // Same number Stripe/MANUAL charged — do not re-derive from quote after the fact.
  const billExVat = resolveApprovalBillExVat(job, customLines);
  const chargedSubtotal =
    paymentContext.billExVat != null && Number(paymentContext.billExVat) > 0
      ? round2(Number(paymentContext.billExVat))
      : billExVat;

  const vat = calculateJobVat(job, chargedSubtotal);
  const { subtotal, vatAmount, totalAmount } = vat;
  const feePercent =
    paymentContext.platformFeePercent != null
      ? Number(paymentContext.platformFeePercent)
      : getPlatformFeePercent();
  const platformFee =
    paymentContext.platformFee != null
      ? round2(Number(paymentContext.platformFee))
      : computePlatformFee(subtotal, feePercent);
  const netAmount =
    paymentContext.mechanicNetAmount != null
      ? Math.max(round2(Number(paymentContext.mechanicNetAmount)), 0)
      : Math.max(round2(subtotal - platformFee), 0);
  const paidAt = paymentContext.paidAt || job.completedAt || new Date();
  const invoiceStatus = paymentContext.invoiceStatus || "PAID";
  const paymentStatus = paymentContext.paymentStatus || "SUCCEEDED";

  const resolvedLines = customLines?.length
    ? customLines
    : defaultInvoiceLineItems(job, subtotal);

  let invoice = await Invoice.findOne({ job: job._id });
  if (!invoice) {
    invoice = await Invoice.create({
      invoiceNo: await generateInvoiceNo(),
      job: job._id,
      fleet: job.fleet,
      company: isCompanyPayout ? payoutRecipient.userId : undefined,
      mechanic: isCompanyPayout ? undefined : payoutRecipient.userId,
      performedByMechanic: job.assignedMechanic || undefined,
      subtotal,
      vatAmount,
      vatRate: vat.vatRate,
      vatApplied: vat.vatRegistered,
      totalAmount,
      currency: job.currency || "GBP",
      platformFeePercent: feePercent,
      status: invoiceStatus,
      issuedAt: paidAt,
      paidAt: invoiceStatus === "PAID" ? paidAt : undefined,
      dueAt:
        job.paymentDueAt ||
        new Date(new Date(paidAt).getTime() + 24 * 60 * 60 * 1000),
      collections: {
        state: invoiceStatus === "PAID" ? "RESOLVED" : "ACTION_REQUIRED",
        reminderCount: job.paymentReminderCount || 0,
        lastReminderAt: job.paymentLastReminderAt,
        nextReminderAt:
          invoiceStatus === "PAID"
            ? undefined
            : job.paymentNextReminderAt ||
              new Date(Date.now() + 60 * 60 * 1000),
      },
      payment: {
        provider: paymentContext.provider || "MANUAL",
        status: paymentStatus,
        stripeCustomerId: paymentContext.stripeCustomerId,
        stripePaymentMethodId: paymentContext.stripePaymentMethodId,
        stripePaymentIntentId: paymentContext.stripePaymentIntentId,
        lastError: paymentContext.lastError,
        authorizedAmount: totalAmount,
        capturedAmount: invoiceStatus === "PAID" ? totalAmount : undefined,
        updatedAt: new Date(),
      },
      lineItems: resolvedLines,
      billedToSnapshot: {
        companyName: job.fleet?.fleetProfile?.companyName,
        vatNumber: job.fleet?.fleetProfile?.vatNumber,
        address: job.fleet?.fleetProfile?.billingAddress || undefined,
      },
      mechanicSnapshot: {
        displayName: job.assignedMechanic?.mechanicProfile?.displayName,
        businessName: job.assignedMechanic?.mechanicProfile?.businessName,
        rating: readMechanicProfileRatingAverage(job.assignedMechanic),
        profilePhotoUrl: job.assignedMechanic?.mechanicProfile?.profilePhotoUrl || undefined,
      },
      supplierSnapshot: {
        supplierType: vat.supplierType || undefined,
        supplierId: vat.supplierId || undefined,
        name: vat.supplierName || undefined,
        vatRegistered: vat.vatRegistered,
        vatNumber: vat.vatNumber || undefined,
      },
    });
  } else {
    invoice.company = isCompanyPayout ? payoutRecipient.userId : undefined;
    invoice.mechanic = isCompanyPayout ? undefined : payoutRecipient.userId;
    invoice.performedByMechanic = job.assignedMechanic || undefined;
    invoice.subtotal = subtotal;
    invoice.vatAmount = vatAmount;
    invoice.vatRate = vat.vatRate;
    invoice.vatApplied = vat.vatRegistered;
    invoice.totalAmount = totalAmount;
    invoice.currency = job.currency || invoice.currency || "GBP";
    invoice.platformFeePercent = feePercent;
    invoice.status = invoiceStatus;
    invoice.paidAt = invoiceStatus === "PAID" ? paidAt : undefined;
    invoice.issuedAt = invoice.issuedAt || paidAt;
    invoice.dueAt =
      invoice.dueAt ||
      job.paymentDueAt ||
      new Date(new Date(invoice.issuedAt).getTime() + 24 * 60 * 60 * 1000);
    invoice.collections = {
      ...(invoice.collections || {}),
      state:
        invoiceStatus === "PAID"
          ? "RESOLVED"
          : invoice.collections?.state || "ACTION_REQUIRED",
      reminderCount:
        invoice.collections?.reminderCount ?? job.paymentReminderCount ?? 0,
      lastReminderAt:
        invoice.collections?.lastReminderAt || job.paymentLastReminderAt,
      nextReminderAt:
        invoiceStatus === "PAID"
          ? undefined
          : invoice.collections?.nextReminderAt ||
            job.paymentNextReminderAt ||
            new Date(Date.now() + 60 * 60 * 1000),
    };
    invoice.payment = {
      ...(invoice.payment || {}),
      provider: paymentContext.provider || invoice.payment?.provider || "MANUAL",
      status: paymentStatus,
      stripeCustomerId:
        paymentContext.stripeCustomerId || invoice.payment?.stripeCustomerId,
      stripePaymentMethodId:
        paymentContext.stripePaymentMethodId || invoice.payment?.stripePaymentMethodId,
      stripePaymentIntentId:
        paymentContext.stripePaymentIntentId || invoice.payment?.stripePaymentIntentId,
      lastError: paymentContext.lastError || invoice.payment?.lastError,
      authorizedAmount: totalAmount,
      capturedAmount: invoiceStatus === "PAID" ? totalAmount : undefined,
      updatedAt: new Date(),
    };
    if (customLines?.length || isDegenerateInvoiceLineItems(invoice.lineItems, job)) {
      invoice.lineItems = resolvedLines;
    }
    invoice.supplierSnapshot = {
      supplierType: vat.supplierType || undefined,
      supplierId: vat.supplierId || undefined,
      name: vat.supplierName || undefined,
      vatRegistered: vat.vatRegistered,
      vatNumber: vat.vatNumber || undefined,
    };
    const mp = job.assignedMechanic?.mechanicProfile;
    if (mp) {
      const prev = invoice.mechanicSnapshot || {};
      invoice.mechanicSnapshot = {
        ...prev,
        displayName: mp.displayName ?? prev.displayName,
        businessName: mp.businessName ?? prev.businessName,
        rating: readMechanicProfileRatingAverage(job.assignedMechanic) ?? prev.rating,
        profilePhotoUrl: mp.profilePhotoUrl ?? prev.profilePhotoUrl,
      };
    }
    invoice.billedToSnapshot = {
      companyName:
        job.fleet?.fleetProfile?.companyName || invoice.billedToSnapshot?.companyName,
      vatNumber: job.fleet?.fleetProfile?.vatNumber || invoice.billedToSnapshot?.vatNumber,
      address:
        job.fleet?.fleetProfile?.billingAddress || invoice.billedToSnapshot?.address,
    };
    await invoice.save();
  }

  if (paymentContext.stripePaymentIntentId) {
    await PaymentAttempt.updateOne(
      { stripePaymentIntentId: paymentContext.stripePaymentIntentId },
      { $set: { invoice: invoice._id } }
    );
  }

  let earningTransaction = null;
  if (invoiceStatus === "PAID") {
    earningTransaction = await EarningTransaction.findOneAndUpdate(
      {
        job: job._id,
        type: "JOB_PAYMENT",
      },
      {
        $set: {
          ...recipientFilter,
          grossAmount: subtotal,
          platformFee,
          platformFeePercent: feePercent,
          netAmount,
          currency: job.currency || "GBP",
          paidAt,
          notes: job.completionSummary || job.description || "Completed job payout",
        },
        $unset: isCompanyPayout ? { mechanic: 1 } : { company: 1 },
        $setOnInsert: {
          type: "JOB_PAYMENT",
          quote: job.acceptedQuote || undefined,
        },
      },
      { upsert: true, new: true }
    );
  }

  return { invoice, earningTransaction };
};

const finalizeApprovedJobCompletion = async ({
  job,
  fromStatus,
  actorUser,
  paymentContext,
  eventExtras = {},
}) => {
  const financials = await upsertFinancialRecordsForCompletedJob(job, paymentContext);
  await createJobEvent({
    jobId: job._id,
    actorId: actorUser._id,
    type: "JOB_COMPLETED",
    fromStatus,
    toStatus: JOB_STATUS.COMPLETED,
    payload: {
      invoiceId: financials.invoice?._id,
      paymentProvider: paymentContext.provider,
      paymentStatus: paymentContext.paymentStatus,
      stripePaymentIntentId: paymentContext.stripePaymentIntentId,
      ...eventExtras,
    },
  });

  emitJobStatusChanged(job, {
    previousStatus: fromStatus,
    changedBy: toObjectIdString(actorUser._id),
    invoiceId: financials.invoice?._id?.toString?.() || null,
    paymentStatus: paymentContext.paymentStatus,
  });

  await notifyJobCompleted(job, {
    approvedByCompany: Boolean(eventExtras.approvedByCompany),
  });

  await refreshMechanicStatsAfterCompletion(job);

  return {
    job,
    invoice: financials.invoice,
    earningTransaction: financials.earningTransaction,
  };
};

export const createJob = async (payload, fleetUser) => {
  if (!payload.title || !payload.description) {
    throw new AppError("title and description are required", 400);
  }
  const { profileCompletion } = await getProfileCompletionSummary(fleetUser);
  if (!profileCompletion?.isComplete) {
    throw new AppError("Complete your profile before posting a job", 400, {
      code: "PROFILE_INCOMPLETE",
      profileCompletion,
    });
  }

  const scheduling = normalizeAvailabilityWindow(payload);
  const { issueType, issueSubtype } = await resolveIssueClassification(payload);

  const job = await Job.create({
    jobCode: await generateJobCode(),
    fleet: fleetUser._id,
    vehicle: {
      vehicleId: payload.vehicleId,
      registration: payload.registration,
      type: payload.vehicleType,
      make: payload.vehicleMake,
      model: payload.vehicleModel,
      trailerMakeModel:
        `${payload.trailerMakeModel || payload.trailer || ""}`.trim() || undefined,
    },
    issueType,
    issueSubtype: issueSubtype || undefined,
    tyreDetails: buildTyreDetailsFromPayload(payload),
    title: payload.title,
    description: payload.description,
    urgency: payload.urgency,
    location: ensureLocation(payload),
    driver:
      payload.driverName || payload.driverPhone
        ? {
            name: `${payload.driverName || ""}`.trim() || undefined,
            phone:
              assertValidOptionalPhone(payload.driverPhone, "Driver phone") ||
              undefined,
          }
        : undefined,
    photos: payload.photos || [],
    status: JOB_STATUS.POSTED,
    postedAt: new Date(),
    estimatedPayout: payload.estimatedPayout,
    mode: payload.mode || undefined,
    scheduledFor: scheduling.scheduledFor,
    availabilityWindow: scheduling.availabilityWindow,
  });

  await createJobEvent({
    jobId: job._id,
    actorId: fleetUser._id,
    type: "JOB_POSTED",
    toStatus: JOB_STATUS.POSTED,
  });

  emitJobPosted(job);
  emitJobStatusChanged(job, {
    previousStatus: null,
    changedBy: toObjectIdString(fleetUser._id),
  });

  await notifyAdminsSafely({
    eventKey: ADMIN_NOTIFICATION_EVENTS.JOB_POSTED,
    dedupeKey: `job-posted:${job._id}`,
    title: `New job posted: ${job.jobCode}`,
    body: `${fleetUser.fleetProfile?.companyName || fleetUser.email} posted ${job.title}.`,
    data: {
      jobId: job._id.toString(),
      jobCode: job.jobCode,
      fleetId: fleetUser._id.toString(),
      screen: "ADMIN_JOB",
    },
  });

  return job;
};

const assertPostedFleetJob = (job, fleetUser) => {
  ensureFleetOwner(job, fleetUser._id);
  if (job.status !== JOB_STATUS.POSTED) {
    throw new AppError("Only POSTED jobs can be edited or deleted", 400, {
      code: "JOB_NOT_EDITABLE",
      status: job.status,
    });
  }
};

export const updateJob = async (jobId, fleetUser, payload = {}) => {
  jobId = await resolveJobRef(jobId);
  const job = await Job.findById(jobId);
  if (!job) throw new AppError("Job not found", 404);
  assertPostedFleetJob(job, fleetUser);

  const next = { ...(payload || {}) };
  if (typeof next.location === "string") {
    try {
      next.location = JSON.parse(next.location);
    } catch {
      throw new AppError("location must be valid JSON", 400);
    }
  }

  if (next.title !== undefined) {
    const title = `${next.title}`.trim();
    if (!title) throw new AppError("title cannot be empty", 400);
    job.title = title;
  }
  if (next.description !== undefined) {
    const description = `${next.description}`.trim();
    if (!description) throw new AppError("description cannot be empty", 400);
    job.description = description;
  }
  if (next.urgency !== undefined) {
    job.urgency = `${next.urgency}`.trim().toUpperCase();
  }
  if (next.mode !== undefined) {
    job.mode = `${next.mode}`.trim().toUpperCase();
  }

  if (
    next.registration !== undefined ||
    next.vehicleType !== undefined ||
    next.vehicleMake !== undefined ||
    next.vehicleModel !== undefined ||
    next.trailerMakeModel !== undefined ||
    next.trailer !== undefined ||
    next.vehicleId !== undefined
  ) {
    job.vehicle = {
      ...(job.vehicle?.toObject?.() || job.vehicle || {}),
      ...(next.vehicleId !== undefined ? { vehicleId: next.vehicleId } : {}),
      ...(next.registration !== undefined
        ? { registration: `${next.registration}`.trim() }
        : {}),
      ...(next.vehicleType !== undefined ? { type: next.vehicleType } : {}),
      ...(next.vehicleMake !== undefined ? { make: next.vehicleMake } : {}),
      ...(next.vehicleModel !== undefined ? { model: next.vehicleModel } : {}),
      ...(next.trailerMakeModel !== undefined || next.trailer !== undefined
        ? {
            trailerMakeModel:
              `${next.trailerMakeModel || next.trailer || ""}`.trim() || undefined,
          }
        : {}),
    };
  }

  if (
    next.issueType !== undefined ||
    next.issueSubtype !== undefined ||
    next.jobCategory !== undefined ||
    next.jobCategoryKey !== undefined
  ) {
    const { issueType, issueSubtype } = await resolveIssueClassification(next);
    job.issueType = issueType;
    job.issueSubtype = issueSubtype || undefined;
  }

  if (next.tyreDetails !== undefined || next.tyreSize || next.tyreAxlePosition || next.tyreSide) {
    job.tyreDetails = buildTyreDetailsFromPayload(next);
  }

  if (next.location !== undefined || next.coordinates !== undefined || next.address !== undefined || next.lat != null || next.lng != null) {
    const baseLoc =
      next.location && typeof next.location === "object"
        ? { ...next.location }
        : { ...(job.location?.toObject?.() || job.location || {}) };
    if (next.address !== undefined) baseLoc.address = next.address;
    if (next.lat != null) baseLoc.lat = next.lat;
    if (next.lng != null) baseLoc.lng = next.lng;
    job.location = ensureLocation({
      location: baseLoc,
      coordinates: next.coordinates || baseLoc.coordinates,
      address: baseLoc.address,
      lat: baseLoc.lat,
      lng: baseLoc.lng,
    });
  }

  if (next.driverName !== undefined || next.driverPhone !== undefined) {
    const name =
      next.driverName !== undefined
        ? `${next.driverName || ""}`.trim()
        : job.driver?.name;
    const phone =
      next.driverPhone !== undefined
        ? assertValidOptionalPhone(next.driverPhone, "Driver phone")
        : job.driver?.phone;
    job.driver = name || phone ? { name: name || undefined, phone: phone || undefined } : undefined;
  }

  const scheduling = normalizeAvailabilityWindow(next);
  if (next.availabilityWindow || next.availabilityFrom || next.availabilityTo || next.scheduledFor) {
    job.scheduledFor = scheduling.scheduledFor;
    job.availabilityWindow = scheduling.availabilityWindow;
  }

  await job.save();

  await createJobEvent({
    jobId: job._id,
    actorId: fleetUser._id,
    type: "JOB_UPDATED",
    note: "Fleet updated job details",
    payload: { fields: Object.keys(payload || {}) },
  });

  return job;
};

export const deleteJob = async (jobId, fleetUser) => {
  jobId = await resolveJobRef(jobId);
  const job = await Job.findById(jobId);
  if (!job) throw new AppError("Job not found", 404);
  assertPostedFleetJob(job, fleetUser);

  const id = job._id;
  const jobCode = job.jobCode;

  await Promise.all([
    Quote.deleteMany({ job: id }),
    JobEvent.deleteMany({ job: id }),
    JobLocationPing.deleteMany({ job: id }),
    ChatMessage.deleteMany({ job: id }),
    Notification.deleteMany({ "data.jobId": `${id}` }),
    Notification.deleteMany({ "data.jobId": id }),
  ]);

  await Job.deleteOne({ _id: id });

  return { deleted: true, jobId: `${id}`, jobCode };
};

export const addJobPhotos = async (jobId, user, payload = {}) => {
  jobId = await resolveJobRef(jobId);
  const job = await Job.findById(jobId);
  if (!job) throw new AppError("Job not found", 404);
  assertJobParticipantAccess(job, user);

  const incoming = Array.isArray(payload.photos)
    ? payload.photos
    : payload.photo
    ? [payload.photo]
    : payload.dataUrl || payload.url
    ? [payload]
    : [];

  if (!incoming.length) {
    throw new AppError("At least one photo payload is required", 400);
  }

  const savedUrls = [];
  const targetDir = path.join(uploadsRoot, toObjectIdString(job._id));
  await fs.mkdir(targetDir, { recursive: true });

  for (const item of incoming) {
    if (item?.url) {
      savedUrls.push(`${item.url}`.trim());
      continue;
    }

    const { extension, buffer } = parseDataUrl(item?.dataUrl);
    const baseName = sanitizeFileName(item?.filename) || `photo-${crypto.randomUUID()}`;
    const fileName = `${baseName}-${Date.now()}-${crypto.randomUUID().slice(0, 8)}.${extension}`;
    const filePath = path.join(targetDir, fileName);
    await fs.writeFile(filePath, buffer);
    savedUrls.push(`/uploads/jobs/${toObjectIdString(job._id)}/${fileName}`);
  }

  job.photos = [...(job.photos || []), ...savedUrls];
  await job.save();

  await createJobEvent({
    jobId: job._id,
    actorId: user._id,
    type: "JOB_PHOTOS_ADDED",
    note: `Added ${savedUrls.length} photo${savedUrls.length === 1 ? "" : "s"}`,
    payload: {
      count: savedUrls.length,
      photos: savedUrls,
    },
  });

  return {
    jobId: job._id,
    photos: job.photos,
    added: savedUrls,
  };
};

export const removeJobPhoto = async (jobId, user, payload = {}) => {
  jobId = await resolveJobRef(jobId);
  const job = await Job.findById(jobId);
  if (!job) throw new AppError("Job not found", 404);
  assertJobParticipantAccess(job, user);

  const photoUrl = `${payload.photoUrl || ""}`.trim();
  if (!photoUrl) throw new AppError("photoUrl is required", 400);
  if (!(job.photos || []).includes(photoUrl)) {
    throw new AppError("Photo not found on this job", 404);
  }

  job.photos = (job.photos || []).filter((item) => item !== photoUrl);
  await job.save();

  const uploadsPrefix = `/uploads/jobs/${toObjectIdString(job._id)}/`;
  if (photoUrl.startsWith(uploadsPrefix)) {
    const fileName = photoUrl.slice(uploadsPrefix.length);
    const filePath = path.join(uploadsRoot, toObjectIdString(job._id), fileName);
    await fs.unlink(filePath).catch(() => null);
  }

  await createJobEvent({
    jobId: job._id,
    actorId: user._id,
    type: "JOB_PHOTO_REMOVED",
    note: "Removed a job photo",
    payload: {
      photoUrl,
    },
  });

  return {
    jobId: job._id,
    photos: job.photos,
    removed: photoUrl,
  };
};

export const addJobAttachments = async (jobId, user, payload = {}) => {
  jobId = await resolveJobRef(jobId);
  const job = await Job.findById(jobId);
  if (!job) throw new AppError("Job not found", 404);
  assertJobParticipantAccess(job, user);

  const items = Array.isArray(payload.items)
    ? payload.items
    : payload.item
    ? [payload.item]
    : [];
  if (!items.length) {
    throw new AppError("At least one item is required (use { items: [...] })", 400);
  }

  const targetDir = path.join(uploadsRoot, toObjectIdString(job._id));
  await fs.mkdir(targetDir, { recursive: true });
  const added = [];

  for (const item of items) {
    const category = JOB_ATTACHMENT_CATEGORIES.includes(item?.category)
      ? item.category
      : "OTHER";
    const fileTypeOverride = JOB_ATTACHMENT_FILE_TYPES.includes(item?.fileType)
      ? item.fileType
      : null;

    if (item?.url) {
      const url = `${item.url}`.trim();
      job.attachments.push({
        url,
        fileType: fileTypeOverride || "OTHER",
        category,
        mimeType: item.mimeType || null,
        originalName: item.originalName || null,
        uploadedBy: user._id,
      });
      added.push(url);
      continue;
    }

    if (!item?.dataUrl) {
      throw new AppError("Each item needs dataUrl, or url for an external file", 400);
    }
    const { mime, buffer, fileType, ext } = parseGenericAttachmentDataUrl(item.dataUrl);
    const resolvedType = fileTypeOverride || fileType;
    const baseName = sanitizeFileName(item?.filename) || `file-${crypto.randomUUID().slice(0, 8)}`;
    const fileName = `${baseName}-${Date.now()}.${ext}`;
    const filePath = path.join(targetDir, fileName);
    await fs.writeFile(filePath, buffer);
    const publicUrl = `/uploads/jobs/${toObjectIdString(job._id)}/${fileName}`;
    job.attachments.push({
      url: publicUrl,
      fileType: resolvedType,
      category,
      mimeType: mime,
      originalName: item?.originalName || null,
      uploadedBy: user._id,
    });
    added.push(publicUrl);
    if (resolvedType === "IMAGE" && !(job.photos || []).includes(publicUrl)) {
      job.photos = [...(job.photos || []), publicUrl];
    }
  }

  await job.save();

  await createJobEvent({
    jobId: job._id,
    actorId: user._id,
    type: "JOB_ATTACHMENTS_ADDED",
    note: `Added ${added.length} attachment(s)`,
    payload: { count: added.length },
  });

  return {
    jobId: job._id,
    attachments: (job.attachments || []).map(serializeJobAttachment),
    added,
  };
};

export const removeJobAttachment = async (jobId, user, attachmentId) => {
  jobId = await resolveJobRef(jobId);
  if (!mongoose.Types.ObjectId.isValid(attachmentId)) {
    throw new AppError("Invalid attachment id", 400);
  }
  const job = await Job.findById(jobId);
  if (!job) throw new AppError("Job not found", 404);
  assertJobParticipantAccess(job, user);

  const att = job.attachments.id(attachmentId);
  if (!att) throw new AppError("Attachment not found", 404);
  const url = att.url;
  att.deleteOne();
  job.photos = (job.photos || []).filter((p) => p !== url);
  await job.save();

  const uploadsPrefix = `/uploads/jobs/${toObjectIdString(job._id)}/`;
  if (url.startsWith(uploadsPrefix)) {
    const fileName = url.slice(uploadsPrefix.length);
    const filePath = path.join(uploadsRoot, toObjectIdString(job._id), fileName);
    await fs.unlink(filePath).catch(() => null);
  }

  await createJobEvent({
    jobId: job._id,
    actorId: user._id,
    type: "JOB_ATTACHMENT_REMOVED",
    note: "Removed a job attachment",
    payload: { attachmentId, url },
  });

  return {
    jobId: job._id,
    attachments: (job.attachments || []).map(serializeJobAttachment),
    removed: attachmentId,
  };
};

export const listJobs = async (user, query) => {
  const page = parsePage(query.page);
  const limit = parseLimit(query.limit);
  const skip = (page - 1) * limit;
  const filter = {};

  // Express may pass duplicate keys as arrays; clients sometimes vary casing.
  const listTab = (() => {
    const t = query.tab;
    if (Array.isArray(t)) return `${t[0] ?? ""}`.trim().toLowerCase();
    return `${t ?? ""}`.trim().toLowerCase();
  })();
  const listStatusParam = (() => {
    const s = query.status;
    if (Array.isArray(s)) return `${s[0] ?? ""}`.trim().toUpperCase();
    return `${s ?? ""}`.trim().toUpperCase();
  })();

  if (user.role === ROLES.FLEET) {
    filter.fleet = user._id;
    if (listTab === "completed") {
      filter.status = JOB_STATUS.COMPLETED;
      const days = Number(query.days);
      if (Number.isFinite(days) && days > 0) {
        const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
        filter.completedAt = { $gte: since };
      }
    } else if (listTab === "active" || listTab === "tracking") {
      const fleetActiveList = [
        JOB_STATUS.POSTED,
        JOB_STATUS.QUOTING,
        JOB_STATUS.ASSIGNED,
        JOB_STATUS.EN_ROUTE,
        JOB_STATUS.ON_SITE,
        JOB_STATUS.IN_PROGRESS,
        JOB_STATUS.AWAITING_APPROVAL,
      ];
      const narrowed = listStatusParam;
      if (narrowed) {
        if (!jobStatusValues.includes(narrowed)) {
          throw new AppError(`Invalid status: ${narrowed}`, 400);
        }
        if (!fleetActiveList.includes(narrowed)) {
          throw new AppError(`status must be one of: ${fleetActiveList.join(", ")}`, 400);
        }
        filter.status = narrowed;
      } else {
        filter.status = { $in: fleetActiveList };
      }
    }
  }

  let nearPoint = null;
  if ([ROLES.MECHANIC, ROLES.MECHANIC_EMPLOYEE].includes(user.role)) {
    if (`${query.feed}` === "true") {
      if (user.role === ROLES.MECHANIC_EMPLOYEE) {
        return {
          items: [],
          meta: {
            page,
            limit,
            total: 0,
            totalPages: 1,
            activeCount: 0,
            completedCount: 0,
            mode: "feed",
          },
        };
      }
      filter.status = { $in: [JOB_STATUS.POSTED, JOB_STATUS.QUOTING] };
      const radiusMiles = Number(
        query.radiusMiles ||
          query.radius ||
          user.mechanicProfile?.serviceRadiusMiles ||
          25
      );
      let lat = query.lat != null ? Number(query.lat) : NaN;
      let lng = query.lng != null ? Number(query.lng) : NaN;
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
        const lk = user.mechanicProfile?.lastKnownLocation?.coordinates;
        if (Array.isArray(lk) && lk.length === 2) {
          lng = Number(lk[0]);
          lat = Number(lk[1]);
        }
      }
      if (Number.isFinite(lat) && Number.isFinite(lng) && Number.isFinite(radiusMiles)) {
        nearPoint = { lat, lng };
        filter.location = locationWithinRadiusFilter(lng, lat, radiusMiles);
      }
      if (query.issueType) {
        filter.issueType = { $in: `${query.issueType}`.split(",") };
      }
      if (query.minPayout) {
        const min = Number(query.minPayout);
        if (Number.isFinite(min)) {
          filter.estimatedPayout = { $gte: min };
        }
      }
    } else if (listTab === "completed") {
      filter.assignedMechanic = user._id;
      filter.status = JOB_STATUS.COMPLETED;
      filter._id = {
        $in: await Invoice.find({
          status: { $in: ["PAID", "PARTIALLY_REFUNDED", "REFUNDED"] },
        }).distinct("job"),
      };
    } else if (listTab === "active") {
      filter.assignedMechanic = user._id;
      const mechActiveList = [
        JOB_STATUS.ASSIGNED,
        JOB_STATUS.EN_ROUTE,
        JOB_STATUS.ON_SITE,
        JOB_STATUS.IN_PROGRESS,
        JOB_STATUS.AWAITING_APPROVAL,
      ];
      const narrowed = listStatusParam;
      if (narrowed) {
        if (!jobStatusValues.includes(narrowed)) {
          throw new AppError(`Invalid status: ${narrowed}`, 400);
        }
        if (!mechActiveList.includes(narrowed)) {
          throw new AppError(`status must be one of: ${mechActiveList.join(", ")}`, 400);
        }
        filter.status = narrowed;
      } else {
        filter.status = { $in: mechActiveList };
      }
    } else {
      filter.assignedMechanic = user._id;
    }
  }

  if (user.role === ROLES.COMPANY) {
    if (`${query.feed}` === "true") {
      Object.assign(filter, buildCompanyFeedJobsFilter(user, query));
      await applyCompanyFeedExcludeJobsWithWaitingQuote(user, filter);
      nearPoint = resolveCompanyFeedNearPoint(user, query);
    } else if (listTab === "completed") {
      filter.assignedCompany = user._id;
      filter.status = JOB_STATUS.COMPLETED;
    } else if (listTab === "active" || listTab === "tracking") {
      filter.assignedCompany = user._id;
      const companyActiveList = [
        JOB_STATUS.ASSIGNED,
        JOB_STATUS.EN_ROUTE,
        JOB_STATUS.ON_SITE,
        JOB_STATUS.IN_PROGRESS,
        JOB_STATUS.AWAITING_APPROVAL,
      ];
      const narrowed = listStatusParam;
      if (narrowed) {
        if (!jobStatusValues.includes(narrowed)) {
          throw new AppError(`Invalid status: ${narrowed}`, 400);
        }
        if (!companyActiveList.includes(narrowed)) {
          throw new AppError(`status must be one of: ${companyActiveList.join(", ")}`, 400);
        }
        filter.status = narrowed;
      } else {
        filter.status = { $in: companyActiveList };
      }
    } else {
      filter.assignedCompany = user._id;
    }
  }

  const urgencyParam = (() => {
    const value = query.urgency;
    if (Array.isArray(value)) return `${value[0] ?? ""}`.trim().toUpperCase();
    return `${value ?? ""}`.trim().toUpperCase();
  })();
  if (urgencyParam) {
    if (!urgencyValues.includes(urgencyParam)) {
      throw new AppError(`urgency must be one of: ${urgencyValues.join(", ")}`, 400);
    }
    filter.urgency = urgencyParam;
  }

  applyListSearchFilter(filter, query);

  const isFeedRequest =
    query.feed === true ||
    `${Array.isArray(query.feed) ? query.feed[0] : query.feed || ""}`
      .trim()
      .toLowerCase() === "true";
  const newestFirstSort =
    listTab === "completed" || listStatusParam === JOB_STATUS.COMPLETED
      ? { completedAt: -1, updatedAt: -1, createdAt: -1, _id: -1 }
      : isFeedRequest
        ? { postedAt: -1, createdAt: -1, _id: -1 }
        : { updatedAt: -1, createdAt: -1, _id: -1 };

  const queryBuilder = Job.find(filter)
    .sort(newestFirstSort)
    .skip(skip)
    .limit(limit)
    .populate(
      "fleet",
      "email fleetProfile.companyName fleetProfile.contactName fleetProfile.phone fleetProfile.rating"
    )
    .populate(
      "assignedCompany",
      "email role companyProfile.companyName companyProfile.contactName companyProfile.phone companyProfile.hourlyRate companyProfile.emergencyRate companyProfile.callOutFee companyProfile.rateCurrency"
    )
    .populate(
      "assignedMechanic",
      "email role mechanicProfile.displayName mechanicProfile.businessName mechanicProfile.phone mechanicProfile.rating mechanicProfile.profilePhotoUrl mechanicProfile.availability mechanicProfile.hourlyRate mechanicProfile.emergencyRate mechanicProfile.callOutFee mechanicProfile.rateCurrency"
    )
    .lean();

  const [items, total] = await Promise.all([
    queryBuilder,
    Job.countDocuments(filter),
  ]);

  const serializedItems = items.map((job) => {
    let distanceMeters = job.distanceMeters;
    if (
      nearPoint &&
      Array.isArray(job.location?.coordinates) &&
      job.location.coordinates.length === 2
    ) {
      const [jlng, jlat] = job.location.coordinates.map(Number);
      if (Number.isFinite(jlng) && Number.isFinite(jlat)) {
        distanceMeters = haversineMeters(nearPoint.lng, nearPoint.lat, jlng, jlat);
      }
    }
    return serializeJobCard(job, user, {
      distanceMiles: roundMiles(distanceMeters),
    });
  });

  // Attach invoice refs for completed jobs (avoids N+1 on the client).
  if (serializedItems.length) {
    const invoices = await Invoice.find({
      job: { $in: items.map((j) => j._id) },
    })
      .select(
        "_id invoiceNo job totalAmount subtotal vatAmount vatRate vatApplied status paidAt currency"
      )
      .lean();
    const byJob = new Map(invoices.map((inv) => [String(inv.job), inv]));
    for (const card of serializedItems) {
      const inv = byJob.get(String(card._id));
      if (inv) {
        card.invoice = {
          _id: inv._id,
          invoiceNo: inv.invoiceNo,
          totalAmount: inv.totalAmount,
          subtotal: inv.subtotal ?? null,
          vatAmount: inv.vatAmount ?? null,
          vatRate: inv.vatRate ?? null,
          vatApplied: inv.vatApplied === true || Number(inv.vatAmount) > 0,
          status: inv.status,
          paidAt: inv.paidAt || null,
          currency: inv.currency || card.currency,
        };
      }
      // Completed cards: canon = completion bill (ex VAT); charge = invoice total when paid.
      if (card.status === JOB_STATUS.COMPLETED) {
        const billExVat =
          Number(
            inv?.subtotal ?? card.finalAmount ?? card.acceptedAmount ?? card.estimatedPayout ?? 0
          ) || 0;
        card.billExVat = billExVat || null;
        card.chargedToFleet =
          inv?.totalAmount != null
            ? round2(Number(inv.totalAmount))
            : billExVat || null;
      }
    }
  }

  const insightBase = {
    activeCount: serializedItems.filter(
      (job) => ![JOB_STATUS.COMPLETED, JOB_STATUS.CANCELLED].includes(job.status)
    ).length,
    completedCount: serializedItems.filter(
      (job) => job.status === JOB_STATUS.COMPLETED
    ).length,
  };

  return {
    items: serializedItems,
    meta: {
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit) || 1,
      ...insightBase,
      mode:
        [ROLES.MECHANIC, ROLES.COMPANY].includes(user.role) && `${query.feed}` === "true"
          ? "feed"
          : "list",
    },
  };
};

export const getJobByIdForUser = async (jobId, user) => {
  jobId = await resolveJobRef(jobId);
  const job = await Job.findById(jobId)
    .populate(
      "fleet",
      "email role fleetProfile.companyName fleetProfile.contactName fleetProfile.phone fleetProfile.billingAddress fleetProfile.vatNumber fleetProfile.rating"
    )
    .populate(
      "assignedCompany",
      "email role companyProfile.companyName companyProfile.contactName companyProfile.phone"
    )
    .populate(
      "assignedMechanic",
      "email role mechanicProfile.displayName mechanicProfile.businessName mechanicProfile.phone mechanicProfile.rating mechanicProfile.profilePhotoUrl mechanicProfile.availability"
    );

  if (!job) throw new AppError("Job not found", 404);
  if (user.role === ROLES.ADMIN) return await serializeJobDetail(job.toObject(), user);

  const userId = toObjectIdString(user._id);
  const fleetId = toObjectIdString(job.fleet?._id || job.fleet);
  const companyId = toObjectIdString(job.assignedCompany?._id || job.assignedCompany);
  const mechanicId = toObjectIdString(job.assignedMechanic?._id || job.assignedMechanic);

  if (user.role === ROLES.FLEET && fleetId === userId) {
    return await serializeJobDetail(job.toObject(), user);
  }
  if ([ROLES.MECHANIC, ROLES.MECHANIC_EMPLOYEE].includes(user.role) && mechanicId === userId) {
    return await serializeJobDetail(job.toObject(), user);
  }
  if (user.role === ROLES.COMPANY && companyId === userId) {
    return await serializeJobDetail(job.toObject(), user);
  }

  if (
    [ROLES.MECHANIC, ROLES.COMPANY].includes(user.role) &&
    [JOB_STATUS.POSTED, JOB_STATUS.QUOTING].includes(job.status)
  ) {
    return await serializeJobDetail(job.toObject(), user);
  }

  const hasQuote = await Quote.exists({
    job: job._id,
    ...(user.role === ROLES.COMPANY ? { company: user._id } : { mechanic: user._id }),
  });
  if ([ROLES.MECHANIC, ROLES.COMPANY].includes(user.role) && hasQuote) {
    return await serializeJobDetail(job.toObject(), user);
  }

  throw new AppError("Forbidden", 403);
};

const transitionAssignedJob = async ({
  jobId,
  user,
  fromStatuses,
  toStatus,
  eventType,
  note,
  payload,
  extraMutation,
}) => {
  const job = await Job.findById(jobId);
  if (!job) throw new AppError("Job not found", 404);

  ensureAssignedMechanic(job, user._id);
  if (!fromStatuses.includes(job.status)) {
    throw new AppError(`Job must be ${fromStatuses.join(" or ")}`, 400);
  }

  const fromStatus = job.status;
  job.status = toStatus;
  if (extraMutation) extraMutation(job);
  await job.save();

  await createJobEvent({
    jobId: job._id,
    actorId: user._id,
    type: eventType,
    fromStatus,
    toStatus,
    note,
    payload,
  });

  emitJobStatusChanged(job, {
    previousStatus: fromStatus,
    changedBy: toObjectIdString(user._id),
  });

  await notifyJobStatusChanged(job, toStatus);

  return job;
};

export const startJourney = async (jobId, mechanicUser) => {
  jobId = await resolveJobRef(jobId);
  return transitionAssignedJob({
    jobId,
    user: mechanicUser,
    fromStatuses: [JOB_STATUS.ASSIGNED],
    toStatus: JOB_STATUS.EN_ROUTE,
    eventType: "JOURNEY_STARTED",
  });
};

export const arriveAtJob = async (jobId, mechanicUser) => {
  jobId = await resolveJobRef(jobId);
  return transitionAssignedJob({
    jobId,
    user: mechanicUser,
    fromStatuses: [JOB_STATUS.EN_ROUTE],
    toStatus: JOB_STATUS.ON_SITE,
    eventType: "MECHANIC_ARRIVED",
  });
};

export const startJobWork = async (jobId, mechanicUser) => {
  jobId = await resolveJobRef(jobId);
  return transitionAssignedJob({
    jobId,
    user: mechanicUser,
    fromStatuses: [JOB_STATUS.ON_SITE],
    toStatus: JOB_STATUS.IN_PROGRESS,
    eventType: "WORK_STARTED",
  });
};

const countCompletionPhotoPayload = (payload = {}) => {
  if (Array.isArray(payload.photos) && payload.photos.length) return payload.photos.length;
  if (payload.photo) return 1;
  if (payload.dataUrl || payload.url) return 1;
  return 0;
};

const pickCompletionPhotoPayload = (payload = {}) => {
  if (Array.isArray(payload.photos) && payload.photos.length) return { photos: payload.photos };
  if (payload.photo) return { photo: payload.photo };
  if (payload.dataUrl || payload.url) {
    return { dataUrl: payload.dataUrl, url: payload.url, filename: payload.filename };
  }
  return null;
};

const pickCompletionAttachmentItems = (payload = {}) => {
  const fromNested =
    payload.attachments && typeof payload.attachments === "object" && !Array.isArray(payload.attachments)
      ? payload.attachments.items
      : undefined;
  if (Array.isArray(fromNested) && fromNested.length) return fromNested;
  if (Array.isArray(payload.attachmentItems) && payload.attachmentItems.length) {
    return payload.attachmentItems;
  }
  return null;
};

/**
 * Single-call completion: optional completion photos, optional attachments, optional invoice
 * breakdown (same shape as company approve invoice), then IN_PROGRESS → AWAITING_APPROVAL.
 * Backward compatible: { workSummary, finalAmount } only still works.
 * Notes: `repairNotes` / `repair_notes` are aliases for `workSummary` (repair notes / completion text).
 */
export const completeJobWork = async (jobId, mechanicUser, payload = {}) => {
  jobId = await resolveJobRef(jobId);
  const job = await Job.findById(jobId);
  if (!job) throw new AppError("Job not found", 404);
  ensureAssignedMechanic(job, mechanicUser._id);
  if (job.status !== JOB_STATUS.IN_PROGRESS) {
    throw new AppError(`Job must be ${JOB_STATUS.IN_PROGRESS}`, 400);
  }

  if (!payload.workSummary && (payload.repairNotes != null || payload.repair_notes != null)) {
    const rn = `${payload.repairNotes ?? payload.repair_notes ?? ""}`.trim();
    if (rn) payload.workSummary = rn;
  }

  if (Array.isArray(payload.photos)) {
    payload.photos = payload.photos.map((p) => {
      if (typeof p !== "string") return p;
      const s = p.trim();
      if (s.startsWith("data:")) return { dataUrl: s };
      return { url: s };
    });
  }

  const photoCount = countCompletionPhotoPayload(payload);
  if (photoCount > 5) {
    throw new AppError("At most 5 completion photos are allowed in one request", 400);
  }
  const photoPayload = pickCompletionPhotoPayload(payload);
  let completionPhotoUrls = [];
  if (photoPayload) {
    const photoResult = await addJobPhotos(jobId, mechanicUser, photoPayload);
    completionPhotoUrls = photoResult.added || [];
  }

  const attachmentItems = pickCompletionAttachmentItems(payload);
  if (attachmentItems?.length) {
    if (attachmentItems.length > 15) {
      throw new AppError("At most 15 attachments are allowed in one request", 400);
    }
    await addJobAttachments(jobId, mechanicUser, { items: attachmentItems });
  }

  let inv = payload.invoice;
  if (inv && typeof inv === "object" && !Array.isArray(inv) && job.acceptedQuote) {
    const acceptedQuote = await Quote.findById(job.acceptedQuote)
      .select("pricing")
      .lean();
    if (acceptedQuote?.pricing) {
      inv = {
        ...inv,
        callOutCharge: acceptedQuote.pricing.callOutFee,
        labourRatePerHour: acceptedQuote.pricing.hourlyRate,
      };
    }
  }
  let invoiceBreakdown = null;
  let resolvedFinal;

  if (inv && typeof inv === "object" && !Array.isArray(inv)) {
    const { lineItems, subtotal } = buildLineItemsFromCompanyInvoicePayload(
      {
        invoice: inv,
        totalAmount: payload.finalAmount ?? payload.totalAmount ?? payload.invoiceTotal,
      },
      job
    );
    invoiceBreakdown = { lineItems, subtotal };
    resolvedFinal = subtotal;
  } else if (payload.finalAmount !== undefined && payload.finalAmount !== null && `${payload.finalAmount}`.trim() !== "") {
    resolvedFinal = round2(Number(payload.finalAmount));
    if (!Number.isFinite(resolvedFinal)) {
      throw new AppError("finalAmount must be a number", 400);
    }
  } else {
    resolvedFinal = job.finalAmount != null ? round2(Number(job.finalAmount)) : undefined;
  }

  const finalForJob =
    resolvedFinal !== undefined && Number.isFinite(resolvedFinal) ? resolvedFinal : job.finalAmount;

  const jobAfter = await transitionAssignedJob({
    jobId,
    user: mechanicUser,
    fromStatuses: [JOB_STATUS.IN_PROGRESS],
    toStatus: JOB_STATUS.AWAITING_APPROVAL,
    eventType: "WORK_COMPLETED",
    note: payload.workSummary,
    payload: {
      workSummary: payload.workSummary ?? null,
      finalAmount: finalForJob ?? null,
      completionPhotos: completionPhotoUrls,
      ...(invoiceBreakdown
        ? {
            invoiceSubtotal: invoiceBreakdown.subtotal,
            invoiceLineItems: invoiceBreakdown.lineItems,
            invoiceLineSummaries: invoiceBreakdown.lineItems.map((row) => ({
              description: row.description,
              quantity: row.quantity,
              unitAmount: row.unitAmount,
              totalAmount: row.totalAmount,
            })),
          }
        : {}),
    },
    extraMutation: (j) => {
      const submittedAt = new Date();
      j.paymentDueAt = new Date(submittedAt.getTime() + 24 * 60 * 60 * 1000);
      j.paymentNextReminderAt = new Date(
        submittedAt.getTime() + 60 * 60 * 1000
      );
      j.paymentReminderCount = 0;
      j.paymentCollectionState = "ACTION_REQUIRED";
      if (finalForJob !== undefined && finalForJob !== null && Number.isFinite(finalForJob)) {
        j.finalAmount = finalForJob;
      }
      j.completionSummary = payload.workSummary || j.completionSummary;
      if (completionPhotoUrls.length) {
        j.completionPhotos = [
          ...new Set([...(j.completionPhotos || []), ...completionPhotoUrls]),
        ];
      }
      if (invoiceBreakdown) {
        j.completionInvoice = {
          currency: "GBP",
          subtotal: invoiceBreakdown.subtotal,
          lineItems: invoiceBreakdown.lineItems.map((row) => ({
            description: row.description,
            quantity: row.quantity,
            unitAmount: row.unitAmount,
            totalAmount: row.totalAmount,
          })),
          submittedInputs:
            inv && typeof inv === "object" && !Array.isArray(inv)
              ? {
                  callOutCharge: inv.callOutCharge ?? inv.callOutFee ?? 0,
                  labourHours: Number(inv.labourHours ?? inv.labour?.hours ?? 0),
                  labourRatePerHour: Number(
                    inv.labourRatePerHour ?? inv.labour?.ratePerHour ?? inv.hourlyRate ?? 0
                  ),
                  parts: Array.isArray(inv.parts) ? inv.parts : [],
                }
              : undefined,
        };
      }
    },
  });

  const base =
    typeof jobAfter?.toObject === "function"
      ? jobAfter.toObject({ flattenMaps: true })
      : jobAfter && typeof jobAfter === "object"
        ? { ...jobAfter }
        : jobAfter;

  if (invoiceBreakdown && inv && typeof inv === "object" && !Array.isArray(inv)) {
    base.completionInvoice = {
      currency: jobAfter.currency || job.currency || "GBP",
      subtotal: invoiceBreakdown.subtotal,
      lineItems: invoiceBreakdown.lineItems.map((row) => ({
        description: row.description,
        quantity: row.quantity,
        unitAmount: row.unitAmount,
        totalAmount: row.totalAmount,
      })),
      submittedInputs: {
        callOutCharge: inv.callOutCharge ?? inv.callOutFee ?? 0,
        labourHours: Number(inv.labourHours ?? inv.labour?.hours ?? 0),
        labourRatePerHour: Number(
          inv.labourRatePerHour ?? inv.labour?.ratePerHour ?? inv.hourlyRate ?? 0
        ),
        parts: Array.isArray(inv.parts) ? inv.parts : [],
      },
    };
  }

  return base;
};

export const approveJobCompletion = async (jobId, fleetUser, payload = {}) => {
  jobId = await resolveJobRef(jobId);
  const job = await Job.findById(jobId)
    .populate("fleet", "fleetProfile")
    .populate("assignedCompany", "role companyProfile")
    .populate("assignedMechanic", "role mechanicProfile");
  if (!job) throw new AppError("Job not found", 404);

  ensureFleetOwner(job, fleetUser._id);
  if (job.status !== JOB_STATUS.AWAITING_APPROVAL) {
    if (job.status === JOB_STATUS.COMPLETED) {
      throw new AppError("This job has already been paid", 409);
    }
    throw new AppError("Job is not awaiting approval", 400);
  }

  const fromStatus = job.status;
  /** Historical quote — never mutate after accept. */
  const acceptedAmountSnapshot = job.acceptedAmount;

  const completionLines = await resolveCompletionInvoiceLineItems(job);

  // Fleet may only supply finalAmount when mechanic never submitted a completion bill.
  if (payload.finalAmount !== undefined && !hasCompletionBill(job, completionLines)) {
    const override = round2(Number(payload.finalAmount));
    if (!Number.isFinite(override) || override <= 0) {
      throw new AppError("finalAmount must be a positive number", 400);
    }
    job.finalAmount = override;
  }

  const billExVat = resolveApprovalBillExVat(job, completionLines);
  if (!(billExVat > 0)) {
    throw new AppError(
      "Cannot approve: completion amount is missing. Mechanic must submit finalAmount / invoice lines first.",
      400
    );
  }
  job.finalAmount = billExVat;
  if (acceptedAmountSnapshot != null) {
    job.acceptedAmount = acceptedAmountSnapshot;
  }

  const lockToken = await acquireApprovalPaymentLock(job._id);
  try {
    const paymentContext = {
      ...(await buildJobApprovalPaymentContext({
        job,
        payerUser: fleetUser,
        paymentMethodId: payload.paymentMethodId,
        approvalRequestId: payload.approvalAttemptId,
        billExVat,
        lineItems: completionLines,
      })),
      billExVat,
      ...(completionLines?.length ? { lineItems: completionLines } : {}),
    };

    return await settleApprovalPayment({
      job,
      fromStatus,
      actorUser: fleetUser,
      paymentContext,
      eventExtras: { paymentMethodId: payload.paymentMethodId },
    });
  } catch (err) {
    await releaseApprovalPaymentLock(job._id, lockToken);
    throw err;
  }
};

/**
 * Company dispatcher: approve completion and pay online via Stripe (required).
 */
export const approveJobCompletionAsCompany = async (jobId, companyUser, payload = {}) => {
  jobId = await resolveJobRef(jobId);
  const job = await Job.findById(jobId)
    .populate("fleet", "fleetProfile")
    .populate("assignedCompany", "role companyProfile")
    .populate("assignedMechanic", "role mechanicProfile");
  if (!job) throw new AppError("Job not found", 404);

  ensureCompanyAssignedJob(job, companyUser._id);
  if (job.status !== JOB_STATUS.AWAITING_APPROVAL) {
    if (job.status === JOB_STATUS.COMPLETED) {
      throw new AppError("This job has already been paid", 409);
    }
    throw new AppError("Job is not awaiting approval", 400);
  }

  const paymentMethodId = `${payload.paymentMethodId || ""}`.trim();
  if (!paymentMethodId) {
    throw new AppError(
      "paymentMethodId is required — company approval must be paid online with a saved Stripe card",
      400
    );
  }

  // Validate the optional mechanic rating before charging the card.
  const mechanicRating = payload.rating !== undefined ? Number(payload.rating) : null;
  if (
    mechanicRating !== null &&
    (!Number.isFinite(mechanicRating) || mechanicRating < 1 || mechanicRating > 5)
  ) {
    throw new AppError("rating must be between 1 and 5", 400);
  }

  const fromStatus = job.status;
  const acceptedAmountSnapshot = job.acceptedAmount;
  const breakdown = buildLineItemsFromCompanyInvoicePayload(payload, job);
  const completionLines =
    breakdown?.lineItems || (await resolveCompletionInvoiceLineItems(job));

  if (breakdown) {
    job.finalAmount = breakdown.subtotal;
  } else if (payload.finalAmount !== undefined && !hasCompletionBill(job, completionLines)) {
    job.finalAmount = round2(Number(payload.finalAmount));
  }

  const billExVat = resolveApprovalBillExVat(job, completionLines);
  if (!(billExVat > 0)) {
    throw new AppError(
      "Cannot approve: completion amount is missing. Submit invoice lines or finalAmount first.",
      400
    );
  }
  job.finalAmount = billExVat;
  if (acceptedAmountSnapshot != null) {
    job.acceptedAmount = acceptedAmountSnapshot;
  }

  const lockToken = await acquireApprovalPaymentLock(job._id);
  try {
    const paymentContext = {
      ...(await buildJobApprovalPaymentContext({
        job,
        payerUser: companyUser,
        paymentMethodId,
        approvalRequestId: payload.approvalAttemptId,
        billExVat,
        lineItems: completionLines,
        metadata: { companyId: companyUser._id.toString(), approvedByCompany: "true" },
      })),
      billExVat,
      ...(completionLines?.length ? { lineItems: completionLines } : {}),
    };

    const result = await settleApprovalPayment({
      job,
      fromStatus,
      actorUser: companyUser,
      paymentContext,
      eventExtras: { approvedByCompany: true, paymentMethodId },
      breakdown: breakdown || null,
    });

    // Best-effort: the dispatcher's star rating must never undo a settled payment.
    if (mechanicRating !== null) {
      try {
        await createCompanyMechanicReview(companyUser, job, { rating: mechanicRating });
      } catch (err) {
        console.error("Failed to record company mechanic rating on approval", err);
      }
    }

    return result;
  } catch (err) {
    await releaseApprovalPaymentLock(job._id, lockToken);
    throw err;
  }
};

export const cancelJob = async (jobId, fleetUser, payload = {}) => {
  jobId = await resolveJobRef(jobId);
  const job = await Job.findById(jobId);
  if (!job) throw new AppError("Job not found", 404);

  ensureFleetOwner(job, fleetUser._id);
  if ([JOB_STATUS.COMPLETED, JOB_STATUS.CANCELLED].includes(job.status)) {
    throw new AppError("Job cannot be cancelled in current status", 400);
  }

  const fromStatus = job.status;
  const cancellation = computeCancellation(fromStatus);

  job.status = JOB_STATUS.CANCELLED;
  job.cancelledAt = new Date();
  await job.save();

  await Quote.updateMany(
    { job: job._id, status: QUOTE_STATUS.WAITING },
    { $set: { status: QUOTE_STATUS.DECLINED } }
  );

  await createJobEvent({
    jobId: job._id,
    actorId: fleetUser._id,
    type: "JOB_CANCELLED",
    fromStatus,
    toStatus: JOB_STATUS.CANCELLED,
    note: payload.reason,
    payload: {
      reason: payload.reason,
      fee: cancellation.fee,
      currency: cancellation.currency,
    },
  });

  emitJobStatusChanged(job, {
    previousStatus: fromStatus,
    changedBy: toObjectIdString(fleetUser._id),
    cancellation,
  });

  await notifyJobCancelled(job, payload.reason);

  return {
    job,
    cancellation,
  };
};

/** Fleet-only: preview fee/policy before calling PATCH .../cancel */
export const previewJobCancellation = async (jobId, fleetUser) => {
  if (fleetUser.role !== ROLES.FLEET) {
    throw new AppError("Only fleet users can preview cancellation", 403);
  }
  jobId = await resolveJobRef(jobId);
  const job = await Job.findById(jobId).select("status fleet jobCode");
  if (!job) throw new AppError("Job not found", 404);
  ensureFleetOwner(job, fleetUser._id);

  const cancellation = computeCancellation(job.status);
  return {
    jobId: job._id,
    jobCode: job.jobCode || null,
    status: job.status,
    preview: {
      ...cancellation,
      summary: cancellation.isFree
        ? "No cancellation fee at this stage — job has not yet moved to en-route or active work."
        : "A £35 GBP cancellation fee applies when the job is already en route, on site, in progress, or awaiting approval.",
    },
  };
};

export const getJobTimeline = async (jobId, user) => {
  const resolvedId = await resolveJobRef(jobId);
  await getJobByIdForUser(jobId, user);
  const [job, events] = await Promise.all([
    Job.findById(resolvedId)
      .select("fleet assignedCompany assignedMechanic")
      .lean(),
    JobEvent.find({ job: resolvedId }).sort({ createdAt: -1 }).lean(),
  ]);
  if (user.role === ROLES.ADMIN) return events;

  const userId = toObjectIdString(user._id);
  const isParticipant =
    (user.role === ROLES.FLEET &&
      toObjectIdString(job?.fleet) === userId) ||
    (user.role === ROLES.COMPANY &&
      toObjectIdString(job?.assignedCompany) === userId) ||
    ([ROLES.MECHANIC, ROLES.MECHANIC_EMPLOYEE].includes(user.role) &&
      toObjectIdString(job?.assignedMechanic) === userId);

  return events.map((event) => ({
    _id: event._id,
    job: event.job,
    actor: event.actor,
    type: event.type,
    fromStatus: event.fromStatus || null,
    toStatus: event.toStatus || null,
    note: isParticipant ? event.note || null : null,
    createdAt: event.createdAt,
  }));
};

export const getCompletionPhotoForDownload = async (jobId, user, photoIndex) => {
  const resolvedId = await resolveJobRef(jobId);
  const job = await Job.findById(resolvedId);
  if (!job) throw new AppError("Job not found", 404);
  assertJobParticipantAccess(job, user);

  const index = Number(photoIndex);
  if (!Number.isInteger(index) || index < 0) {
    throw new AppError("Invalid completion photo index", 400);
  }
  const statusTimes = await deriveStatusTimes(job._id, job);
  const photos = await completionPhotosForDetail(job.toObject(), statusTimes);
  const url = photos[index];
  if (!url) throw new AppError("Completion photo not found", 404);
  return { url, index, jobId: job._id };
};

export const createJobLocationPing = async (jobId, user, payload) => {
  jobId = await resolveJobRef(jobId);
  const job = await Job.findById(jobId);
  if (!job) throw new AppError("Job not found", 404);
  ensureAssignedMechanic(job, user._id);

  const { lat, lng, heading, speed, accuracy, etaMinutes } = payload || {};
  const latNum = Number(lat);
  const lngNum = Number(lng);
  if (!Number.isFinite(latNum) || !Number.isFinite(lngNum)) {
    throw new AppError("lat and lng are required", 400);
  }

  const point = { type: "Point", coordinates: [lngNum, latNum] };
  const now = new Date();

  await JobLocationPing.create({
    job: job._id,
    mechanic: user._id,
    point,
    heading,
    speed,
    accuracy,
    pingedAt: now,
  });

  job.tracking = {
    ...(job.tracking || {}),
    latestMechanicLocation: {
      point,
      heading,
      speed,
      accuracy,
      updatedAt: now,
    },
    etaMinutes: Number.isFinite(Number(etaMinutes)) ? Number(etaMinutes) : job.tracking?.etaMinutes,
  };

  await job.save();

  await createJobEvent({
    jobId: job._id,
    actorId: user._id,
    type: "LOCATION_PING",
    payload: {
      lat: latNum,
      lng: lngNum,
      heading,
      speed,
      accuracy,
      etaMinutes,
    },
  });

  emitJobLocationPing(job, {
    lat: latNum,
    lng: lngNum,
    heading,
    speed,
    accuracy,
    etaMinutes,
    updatedAt: now,
  });

  return {
    ok: true,
    updatedAt: now,
  };
};
