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
} from "../../constants/domain.js";
import mongoose from "mongoose";
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
import { User } from "../user/user.model.js";
import { createStripePaymentIntent } from "../billing/stripe.service.js";
import { getProfileCompletionSummary } from "../user/user.service.js";
import { readMechanicProfileRatingAverage } from "../../utils/mechanicRating.js";
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

const resolveIssueClassification = (payload = {}) => {
  const rawInput = payload.issueSubtype ?? payload.jobCategory ?? "";
  const trimmed = `${rawInput}`.trim();
  const slug = trimmed ? slugifyJobCategoryKey(trimmed) : null;
  const mappedFromCategory =
    slug && Object.prototype.hasOwnProperty.call(JOB_CATEGORY_SUBTYPE_TO_ISSUE_TYPE, slug)
      ? JOB_CATEGORY_SUBTYPE_TO_ISSUE_TYPE[slug]
      : undefined;

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
  if (trimmed) {
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
    description: job.completionSummary || job.description,
    issueType: job.issueType,
    issueSubtype: job.issueSubtype || null,
    tyreDetails: job.tyreDetails || null,
    urgency: job.urgency,
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
    actions: {
      canTrack:
        viewer.role === ROLES.FLEET &&
        [JOB_STATUS.ASSIGNED, JOB_STATUS.EN_ROUTE, JOB_STATUS.ON_SITE, JOB_STATUS.IN_PROGRESS, JOB_STATUS.AWAITING_APPROVAL].includes(job.status),
      canApproveCompletion:
        viewer.role === ROLES.FLEET && job.status === JOB_STATUS.AWAITING_APPROVAL,
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
    const amount = round2(p?.amount ?? p?.price ?? p?.totalAmount ?? 0);
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

const computeFleetPaymentBox = ({ job, defaultPaymentMethod }) => {
  // UI meanings:
  // - quoteAmount: base job amount (accepted or estimated)
  // - platformFee: 12% of quote amount
  // - totalPayable: quote + platform fee (ex VAT)
  // - preAuthHeld: totalPayable * 1.2 (incl VAT) (matches earlier Stripe calculation)
  const quoteAmount = Number(job.acceptedAmount ?? job.estimatedPayout ?? 0) || 0;
  const platformFee = quoteAmount > 0 ? round2(quoteAmount * 0.12) : 0;
  const totalPayable = quoteAmount > 0 ? round2(quoteAmount + platformFee) : 0;
  const preAuthHeld = totalPayable > 0 ? round2(totalPayable * 1.2) : 0;

  return {
    quoteAmount: quoteAmount || null,
    platformFee: quoteAmount ? platformFee : null,
    totalPayable: quoteAmount ? totalPayable : null,
    preAuthHeld: quoteAmount ? preAuthHeld : null,
    cardLabel: defaultPaymentMethod ? maskCardLabel(defaultPaymentMethod) : null,
    cardExpMonth: defaultPaymentMethod?.card?.expMonth ?? null,
    cardExpYear: defaultPaymentMethod?.card?.expYear ?? null,
    finalAmount: Number(job.finalAmount ?? job.acceptedAmount ?? 0) || null,
    status:
      job.status === JOB_STATUS.COMPLETED
        ? "PAID"
        : [JOB_STATUS.ASSIGNED, JOB_STATUS.EN_ROUTE, JOB_STATUS.ON_SITE, JOB_STATUS.IN_PROGRESS, JOB_STATUS.AWAITING_APPROVAL].includes(
            job.status
          )
          ? "AUTHORIZED"
          : "PENDING",
    currency: job.currency || "GBP",
  };
};

const mapStripePaymentIntentStatus = (status) => {
  switch (status) {
    case "succeeded":
      return { invoiceStatus: "PAID", paymentStatus: "SUCCEEDED", paid: true };
    case "processing":
      return { invoiceStatus: "ISSUED", paymentStatus: "PROCESSING", paid: false };
    case "requires_payment_method":
      return {
        invoiceStatus: "FAILED",
        paymentStatus: "REQUIRES_PAYMENT_METHOD",
        paid: false,
      };
    case "requires_action":
      return {
        invoiceStatus: "ISSUED",
        paymentStatus: "REQUIRES_ACTION",
        paid: false,
      };
    case "canceled":
      return { invoiceStatus: "FAILED", paymentStatus: "CANCELED", paid: false };
    default:
      return { invoiceStatus: "ISSUED", paymentStatus: "PENDING", paid: false };
  }
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

const serializeJobDetail = async (job, viewer) => {
  const base = serializeJobCard(job, viewer);
  const myQuote =
    viewer.role === ROLES.MECHANIC
      ? await Quote.findOne({ job: job._id, mechanic: viewer._id }).sort({ createdAt: -1 }).lean()
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

  return {
    ...base,
    tracking: mergedTracking,
    mechanicLocation,
    summary: {
      postedAgoLabel: formatRelativeAge(job.postedAt || job.createdAt),
      distanceMiles: base.distanceMiles ?? null,
      etaMinutes: job.tracking?.etaMinutes ?? null,
    },
    statusTimeline: statusTimes,
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
      ? {
          myQuoteId: myQuote._id,
          amount: myQuote.amount,
          status: myQuote.status,
          availabilityType: myQuote.availabilityType,
          scheduledAt: myQuote.scheduledAt || null,
        }
      : null,
    paymentSummary:
      viewer.role === ROLES.FLEET
        ? computeFleetPaymentBox({ job, defaultPaymentMethod })
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
  const coordinates = location.coordinates || payload.coordinates;
  if (!Array.isArray(coordinates) || coordinates.length !== 2) {
    throw new AppError("location.coordinates must be [lng, lat]", 400);
  }
  return {
    type: "Point",
    coordinates,
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

const ensureJobParticipantAccess = (job, user) => {
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

const upsertFinancialRecordsForCompletedJob = async (job, paymentContext = {}) => {
  if (!job.assignedMechanic) return { invoice: null, earningTransaction: null };

  const subtotal = Number(job.finalAmount ?? job.acceptedAmount ?? job.estimatedPayout ?? 0);
  const vatAmount = Math.round(subtotal * 0.2 * 100) / 100;
  const totalAmount = Math.round((subtotal + vatAmount) * 100) / 100;
  const platformFee = Math.round(subtotal * 0.12 * 100) / 100;
  const netAmount = Math.max(Math.round((subtotal - platformFee) * 100) / 100, 0);
  const paidAt = paymentContext.paidAt || job.completedAt || new Date();
  const invoiceStatus = paymentContext.invoiceStatus || "PAID";
  const paymentStatus = paymentContext.paymentStatus || "SUCCEEDED";

  const customLines =
    Array.isArray(paymentContext.lineItems) && paymentContext.lineItems.length > 0
      ? paymentContext.lineItems
      : null;

  let invoice = await Invoice.findOne({ job: job._id });
  if (!invoice) {
    invoice = await Invoice.create({
      invoiceNo: await generateInvoiceNo(),
      job: job._id,
      fleet: job.fleet,
      mechanic: job.assignedMechanic,
      subtotal,
      vatAmount,
      totalAmount,
      currency: job.currency || "GBP",
      status: invoiceStatus,
      issuedAt: paidAt,
      paidAt: invoiceStatus === "PAID" ? paidAt : undefined,
      payment: {
        provider: paymentContext.provider || "MANUAL",
        status: paymentStatus,
        stripeCustomerId: paymentContext.stripeCustomerId,
        stripePaymentMethodId: paymentContext.stripePaymentMethodId,
        stripePaymentIntentId: paymentContext.stripePaymentIntentId,
        stripeClientSecret: paymentContext.stripeClientSecret,
        lastError: paymentContext.lastError,
        authorizedAmount: totalAmount,
        capturedAmount: invoiceStatus === "PAID" ? totalAmount : undefined,
        updatedAt: new Date(),
      },
      lineItems: customLines || [
        {
          description: job.completionSummary || job.description || "Repair service",
          quantity: 1,
          unitAmount: subtotal,
          totalAmount: subtotal,
        },
      ],
      billedToSnapshot: {
        companyName: job.fleet?.fleetProfile?.companyName,
        vatNumber: job.fleet?.fleetProfile?.vatNumber,
        address: job.location?.address,
      },
      mechanicSnapshot: {
        displayName: job.assignedMechanic?.mechanicProfile?.displayName,
        businessName: job.assignedMechanic?.mechanicProfile?.businessName,
        rating: readMechanicProfileRatingAverage(job.assignedMechanic),
        profilePhotoUrl: job.assignedMechanic?.mechanicProfile?.profilePhotoUrl || undefined,
      },
    });
  } else {
    invoice.subtotal = subtotal;
    invoice.vatAmount = vatAmount;
    invoice.totalAmount = totalAmount;
    invoice.currency = job.currency || invoice.currency || "GBP";
    invoice.status = invoiceStatus;
    invoice.paidAt = invoiceStatus === "PAID" ? paidAt : undefined;
    invoice.issuedAt = invoice.issuedAt || paidAt;
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
      stripeClientSecret:
        paymentContext.stripeClientSecret || invoice.payment?.stripeClientSecret,
      lastError: paymentContext.lastError || invoice.payment?.lastError,
      authorizedAmount: totalAmount,
      capturedAmount: invoiceStatus === "PAID" ? totalAmount : undefined,
      updatedAt: new Date(),
    };
    if (customLines) {
      invoice.lineItems = customLines;
    } else if (!invoice.lineItems?.length) {
      invoice.lineItems = [
        {
          description: job.completionSummary || job.description || "Repair service",
          quantity: 1,
          unitAmount: subtotal,
          totalAmount: subtotal,
        },
      ];
    }
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
    await invoice.save();
  }

  let earningTransaction = null;
  if (invoiceStatus === "PAID") {
    earningTransaction = await EarningTransaction.findOneAndUpdate(
      { mechanic: job.assignedMechanic, job: job._id },
      {
        $set: {
          grossAmount: subtotal,
          platformFee,
          netAmount,
          currency: job.currency || "GBP",
          paidAt,
          notes: job.completionSummary || job.description || "Completed job payout",
        },
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
    throw new AppError("Complete your profile before posting a job", 400);
  }

  const scheduling = normalizeAvailabilityWindow(payload);
  const { issueType, issueSubtype } = resolveIssueClassification(payload);

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
            phone: `${payload.driverPhone || ""}`.trim() || undefined,
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

  return job;
};

export const addJobPhotos = async (jobId, user, payload = {}) => {
  const job = await Job.findById(jobId);
  if (!job) throw new AppError("Job not found", 404);
  ensureJobParticipantAccess(job, user);

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
  const job = await Job.findById(jobId);
  if (!job) throw new AppError("Job not found", 404);
  ensureJobParticipantAccess(job, user);

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
  const job = await Job.findById(jobId);
  if (!job) throw new AppError("Job not found", 404);
  ensureJobParticipantAccess(job, user);

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
  if (!mongoose.Types.ObjectId.isValid(attachmentId)) {
    throw new AppError("Invalid attachment id", 400);
  }
  const job = await Job.findById(jobId);
  if (!job) throw new AppError("Job not found", 404);
  ensureJobParticipantAccess(job, user);

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
      filter.status = { $in: [JOB_STATUS.POSTED, JOB_STATUS.QUOTING] };
      if (query.lat && query.lng) {
        const lat = Number(query.lat);
        const lng = Number(query.lng);
        const radiusMiles = Number(query.radiusMiles || query.radius || 15);
        if (Number.isFinite(lat) && Number.isFinite(lng) && Number.isFinite(radiusMiles)) {
          nearPoint = { lat, lng };
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
    } else if (listTab === "completed") {
      filter.assignedMechanic = user._id;
      filter.status = JOB_STATUS.COMPLETED;
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

  const queryBuilder = Job.find(filter)
    .sort({ createdAt: -1 })
    .skip(skip)
    .limit(limit)
    .populate(
      "fleet",
      "email fleetProfile.companyName fleetProfile.contactName fleetProfile.phone fleetProfile.rating"
    )
    .populate(
      "assignedCompany",
      "email role companyProfile.companyName companyProfile.contactName companyProfile.phone"
    )
    .populate(
      "assignedMechanic",
      "email role mechanicProfile.displayName mechanicProfile.phone mechanicProfile.rating mechanicProfile.profilePhotoUrl mechanicProfile.availability"
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
  const job = await Job.findById(jobId)
    .populate(
      "fleet",
      "email role fleetProfile.companyName fleetProfile.contactName fleetProfile.phone fleetProfile.billingAddress fleetProfile.rating"
    )
    .populate(
      "assignedCompany",
      "email role companyProfile.companyName companyProfile.contactName companyProfile.phone"
    )
    .populate(
      "assignedMechanic",
      "email role mechanicProfile.displayName mechanicProfile.phone mechanicProfile.rating mechanicProfile.profilePhotoUrl mechanicProfile.availability"
    );

  if (!job) throw new AppError("Job not found", 404);
  if (user.role === ROLES.ADMIN) return serializeJobDetail(job.toObject(), user);

  const userId = toObjectIdString(user._id);
  const fleetId = toObjectIdString(job.fleet?._id || job.fleet);
  const companyId = toObjectIdString(job.assignedCompany?._id || job.assignedCompany);
  const mechanicId = toObjectIdString(job.assignedMechanic?._id || job.assignedMechanic);

  if (user.role === ROLES.FLEET && fleetId === userId) {
    return serializeJobDetail(job.toObject(), user);
  }
  if ([ROLES.MECHANIC, ROLES.MECHANIC_EMPLOYEE].includes(user.role) && mechanicId === userId) {
    return serializeJobDetail(job.toObject(), user);
  }
  if (user.role === ROLES.COMPANY && companyId === userId) {
    return serializeJobDetail(job.toObject(), user);
  }

  if (
    [ROLES.MECHANIC, ROLES.COMPANY].includes(user.role) &&
    [JOB_STATUS.POSTED, JOB_STATUS.QUOTING].includes(job.status)
  ) {
    return serializeJobDetail(job.toObject(), user);
  }

  const hasQuote = await Quote.exists({
    job: job._id,
    ...(user.role === ROLES.COMPANY ? { company: user._id } : { mechanic: user._id }),
  });
  if ([ROLES.MECHANIC, ROLES.COMPANY].includes(user.role) && hasQuote) {
    return serializeJobDetail(job.toObject(), user);
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

  return job;
};

export const startJourney = async (jobId, mechanicUser) =>
  transitionAssignedJob({
    jobId,
    user: mechanicUser,
    fromStatuses: [JOB_STATUS.ASSIGNED],
    toStatus: JOB_STATUS.EN_ROUTE,
    eventType: "JOURNEY_STARTED",
  });

export const arriveAtJob = async (jobId, mechanicUser) =>
  transitionAssignedJob({
    jobId,
    user: mechanicUser,
    fromStatuses: [JOB_STATUS.EN_ROUTE],
    toStatus: JOB_STATUS.ON_SITE,
    eventType: "MECHANIC_ARRIVED",
  });

export const startJobWork = async (jobId, mechanicUser) =>
  transitionAssignedJob({
    jobId,
    user: mechanicUser,
    fromStatuses: [JOB_STATUS.ON_SITE],
    toStatus: JOB_STATUS.IN_PROGRESS,
    eventType: "WORK_STARTED",
  });

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
  if (photoPayload) {
    await addJobPhotos(jobId, mechanicUser, photoPayload);
  }

  const attachmentItems = pickCompletionAttachmentItems(payload);
  if (attachmentItems?.length) {
    if (attachmentItems.length > 15) {
      throw new AppError("At most 15 attachments are allowed in one request", 400);
    }
    await addJobAttachments(jobId, mechanicUser, { items: attachmentItems });
  }

  const inv = payload.invoice;
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
      ...(invoiceBreakdown
        ? {
            invoiceSubtotal: invoiceBreakdown.subtotal,
            invoiceLineSummaries: invoiceBreakdown.lineItems.map((row) => ({
              description: row.description,
              totalAmount: row.totalAmount,
            })),
          }
        : {}),
    },
    extraMutation: (j) => {
      if (finalForJob !== undefined && finalForJob !== null && Number.isFinite(finalForJob)) {
        j.finalAmount = finalForJob;
      }
      j.completionSummary = payload.workSummary || j.completionSummary;
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

export const approveJobCompletion = async (jobId, fleetUser, payload) => {
  const job = await Job.findById(jobId)
    .populate("fleet", "fleetProfile")
    .populate("assignedCompany", "companyProfile")
    .populate("assignedMechanic", "mechanicProfile");
  if (!job) throw new AppError("Job not found", 404);

  ensureFleetOwner(job, fleetUser._id);
  if (job.status !== JOB_STATUS.AWAITING_APPROVAL) {
    throw new AppError("Job is not awaiting approval", 400);
  }

  const fromStatus = job.status;
  job.status = JOB_STATUS.COMPLETED;
  job.completedAt = new Date();
  if (payload.finalAmount !== undefined) {
    job.finalAmount = Number(payload.finalAmount);
  }
  await job.save();

  let paymentContext = {
    provider: "MANUAL",
    invoiceStatus: "PAID",
    paymentStatus: "SUCCEEDED",
    paidAt: new Date(),
  };

  const paymentMethodId = `${payload.paymentMethodId || ""}`.trim();
  if (paymentMethodId) {
    const paymentMethod = await PaymentMethod.findOne({
      _id: paymentMethodId,
      user: fleetUser._id,
      isActive: true,
    }).lean();

    if (!paymentMethod) {
      throw new AppError("Payment method not found", 404);
    }

    if (paymentMethod.provider === "STRIPE") {
      const totalAmount =
        Math.round(
          ((Number(job.finalAmount ?? job.acceptedAmount ?? job.estimatedPayout ?? 0) || 0) *
            1.2) *
            100
        ) / 100;

      const paymentIntent = await createStripePaymentIntent({
        amount: totalAmount,
        currency: job.currency || "GBP",
        customerId:
          paymentMethod.providerCustomerId || fleetUser.fleetProfile?.stripeCustomerId,
        paymentMethodId: paymentMethod.providerMethodId,
        metadata: {
          jobId: job._id.toString(),
          fleetId: fleetUser._id.toString(),
          mechanicId: toObjectIdString(job.assignedMechanic),
        },
      });

      const mapped = mapStripePaymentIntentStatus(paymentIntent.status);
      paymentContext = {
        provider: "STRIPE",
        invoiceStatus: mapped.invoiceStatus,
        paymentStatus: mapped.paymentStatus,
        stripeCustomerId:
          paymentMethod.providerCustomerId || fleetUser.fleetProfile?.stripeCustomerId,
        stripePaymentMethodId: paymentMethod.providerMethodId,
        stripePaymentIntentId: paymentIntent.id,
        stripeClientSecret: paymentIntent.client_secret || null,
        lastError: paymentIntent.last_payment_error?.message || null,
        paidAt: mapped.paid ? new Date() : undefined,
      };
    }
  }

  return finalizeApprovedJobCompletion({
    job,
    fromStatus,
    actorUser: fleetUser,
    paymentContext,
    eventExtras: { paymentMethodId: payload.paymentMethodId },
  });
};

/**
 * Company dispatcher: approve mechanic-submitted completion (same outcome as fleet approve).
 * Uses manual paid context; fleet card capture (Stripe) remains on PATCH /jobs/:id/complete/approve.
 */
export const approveJobCompletionAsCompany = async (jobId, companyUser, payload = {}) => {
  const job = await Job.findById(jobId)
    .populate("fleet", "fleetProfile")
    .populate("assignedCompany", "companyProfile")
    .populate("assignedMechanic", "mechanicProfile");
  if (!job) throw new AppError("Job not found", 404);

  ensureCompanyAssignedJob(job, companyUser._id);
  if (job.status !== JOB_STATUS.AWAITING_APPROVAL) {
    throw new AppError("Job is not awaiting approval", 400);
  }

  const fromStatus = job.status;
  const breakdown = buildLineItemsFromCompanyInvoicePayload(payload, job);

  if (breakdown) {
    job.finalAmount = breakdown.subtotal;
  } else if (payload.finalAmount !== undefined) {
    job.finalAmount = round2(Number(payload.finalAmount));
  }

  job.status = JOB_STATUS.COMPLETED;
  job.completedAt = new Date();
  await job.save();

  const paymentContext = {
    provider: "MANUAL",
    invoiceStatus: "PAID",
    paymentStatus: "SUCCEEDED",
    paidAt: new Date(),
    ...(breakdown ? { lineItems: breakdown.lineItems } : {}),
  };

  return finalizeApprovedJobCompletion({
    job,
    fromStatus,
    actorUser: companyUser,
    paymentContext,
    eventExtras: { approvedByCompany: true },
  });
};

export const cancelJob = async (jobId, fleetUser, payload = {}) => {
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
  await getJobByIdForUser(jobId, user);
  return JobEvent.find({ job: jobId }).sort({ createdAt: -1 }).lean();
};

export const createJobLocationPing = async (jobId, user, payload) => {
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


