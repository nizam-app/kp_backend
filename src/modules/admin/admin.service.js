import AppError from "../../utils/AppError.js";
import { AsyncLocalStorage } from "async_hooks";
import mongoose from "mongoose";
import {
  JOB_STATUS,
  MECHANIC_VERIFICATION_STATUS,
  ROLES,
  USER_STATUS,
  userStatusValues,
} from "../../constants/domain.js";
import { User } from "../user/user.model.js";
import { Job } from "../job/job.model.js";
import { Invoice } from "../invoice/invoice.model.js";
import { Vehicle } from "../vehicle/vehicle.model.js";
import { SupportTicket } from "../supportTicket/supportTicket.model.js";
import { JobLocationPing } from "../jobLocationPing/jobLocationPing.model.js";
import { Notification } from "../notification/notification.model.js";
import { createNotification } from "../notification/notification.service.js";
import { Dispute } from "../dispute/dispute.model.js";
import {
  assignDispute as assignCanonicalDispute,
  createParticipantDispute,
  getDisputeDetail,
  listDisputesForUser,
  serializeDispute as serializeCanonicalDispute,
  transitionDispute as transitionCanonicalDispute,
} from "../dispute/dispute.service.js";
import { DisputeMessage } from "../dispute/disputeMessage.model.js";
import { ServiceCatalog } from "../serviceCatalog/serviceCatalog.model.js";
import { Promotion } from "../promotion/promotion.model.js";
import { Review } from "../review/review.model.js";
import { AuditLog } from "../auditLog/auditLog.model.js";
import { JobEvent } from "../jobEvent/jobEvent.model.js";
import { EarningTransaction } from "../earning/earningTransaction.model.js";
import { PaymentAttempt } from "../billing/paymentAttempt.model.js";
import { Refund } from "../billing/refund.model.js";
import {
  createStripeRefund,
  retrieveStripePaymentIntent,
} from "../billing/stripe.service.js";
import {
  applyPaymentIntentToInvoice,
  applyStripeRefundToInvoice,
} from "../billing/stripeWebhook.service.js";
import { paymentAgingBucket } from "../billing/paymentOperations.service.js";
import { ChatMessage } from "../chat/chat.model.js";
import { sendJobMessage } from "../chat/chat.service.js";
import { calculateJobVat } from "../../utils/vat.js";
import { removeUserAccount } from "../user/user.service.js";
import {
  companyEarningsNet,
  companyEarningsPlatformFee,
} from "../../utils/companyEarningsMath.js";
import {
  serializePlatformCommercial,
  updatePlatformCommercialSettings,
  getPlatformFeePercent,
} from "../../utils/platformFee.js";
import { env } from "../../config/env.js";
import {
  ADMIN_NOTIFICATION_EVENTS,
  normalizeAdminNotificationPreferences,
} from "../notification/adminNotificationEvents.js";
import { deriveAdminAuditDescriptor } from "./adminAudit.util.js";

const relativeTimeLabel = (dateValue) => {
  if (!dateValue) return null;
  const ms = Date.now() - new Date(dateValue).getTime();
  if (!Number.isFinite(ms) || ms < 0) return "just now";
  const mins = Math.floor(ms / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs} hour${hrs === 1 ? "" : "s"} ago`;
  const days = Math.floor(hrs / 24);
  return `${days} day${days === 1 ? "" : "s"} ago`;
};

const pctDelta = (current, previous) => {
  const cur = Number(current) || 0;
  const prev = Number(previous) || 0;
  if (prev === 0) return cur > 0 ? 100 : null;
  return Math.round(((cur - prev) / prev) * 1000) / 10;
};

const trendPayload = (current, previous) => ({
  value: Number(current) || 0,
  previous: Number(previous) || 0,
  deltaPct: pctDelta(current, previous),
});

const netCapturedInvoiceAmountExpression = {
  $max: [
    {
      $subtract: [
        "$totalAmount",
        { $ifNull: ["$payment.refundedAmount", 0] },
      ],
    },
    0,
  ],
};

const serviceRequestBucketFromJobStatus = (status) => {
  if ([JOB_STATUS.COMPLETED].includes(status)) return "COMPLETED";
  if ([JOB_STATUS.CANCELLED].includes(status)) return "CANCELLED";
  if (
    [
      JOB_STATUS.ASSIGNED,
      JOB_STATUS.EN_ROUTE,
      JOB_STATUS.ON_SITE,
      JOB_STATUS.IN_PROGRESS,
      JOB_STATUS.AWAITING_APPROVAL,
    ].includes(status)
  ) {
    return "IN_PROGRESS";
  }
  return "PENDING";
};

const serviceRequestToneFromBucket = (bucket) => {
  const map = {
    PENDING: "amber",
    IN_PROGRESS: "blue",
    COMPLETED: "green",
    CANCELLED: "red",
  };
  return map[bucket] || "neutral";
};

const formatMonthLabel = (date) =>
  date.toLocaleString("en-US", { month: "short" });

const safeRegex = (value) =>
  new RegExp(`${`${value || ""}`.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, "i");

const parseRoleFilter = (value) => `${value || ""}`.trim().toUpperCase();
const parsePriority = (value) => `${value || ""}`.trim().toUpperCase();
const parseStatus = (value) => `${value || ""}`.trim().toUpperCase();

const SUPPORT_USER_POPULATE =
  "email role fleetProfile.companyName mechanicProfile.displayName companyProfile.companyName";

const supportStatusTone = (status) => {
  const map = {
    OPEN: "amber",
    IN_PROGRESS: "blue",
    RESOLVED: "green",
    CLOSED: "neutral",
  };
  return map[status] || "neutral";
};

const parsePage = (value) => {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 1;
};

const parseLimit = (value) => {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return 20;
  return Math.min(Math.floor(n), 100);
};

const getAdminActorLabel = (adminUser) =>
  adminUser?.adminProfile?.fullName || adminUser?.email || "Admin";

/** Request-scoped audit metadata (IP) for admin mutation logging. */
export const adminAuditContext = new AsyncLocalStorage();

export const runAdminAuditContext = (ctx, next) => adminAuditContext.run(ctx, next);

export const writeAuditLog = async (adminUser, action, target, category, ipAddress) => {
  try {
    const store = adminAuditContext.getStore();
    const storeIp = store?.ipAddress;
    const ip = ipAddress || storeIp;
    await AuditLog.create({
      userLabel: getAdminActorLabel(adminUser),
      action,
      target,
      category,
      ...(ip ? { ipAddress: `${ip}`.split(",")[0].trim() } : {}),
    });
    if (store) store.auditWritten = true;
  } catch {
    // Audit logging should not block primary admin actions.
  }
};

export const installAdminAuditFallback = (req, res, next) => {
  const context = adminAuditContext.getStore() || {};
  res.once("finish", () => {
    if (res.statusCode >= 400 || context.auditWritten) return;
    const descriptor = deriveAdminAuditDescriptor({
      method: req.method,
      routePath: req.route?.path || req.path,
      params: req.params,
      body: req.body,
    });
    if (!descriptor) return;
    context.auditWritten = true;
    void writeAuditLog(
      req.user,
      descriptor.action,
      descriptor.target,
      descriptor.category,
      context.ipAddress
    );
  });
  next();
};

const normalizeRegistration = (value) => `${value || ""}`.trim().toUpperCase();
const normalizeAdminEmail = (value) => `${value || ""}`.trim().toLowerCase();

const mapAdminRole = (value) => {
  const normalized = `${value || ""}`.trim().toUpperCase();
  if (["FLEET", "FLEETS"].includes(normalized)) return ROLES.FLEET;
  if (["COMPANY", "COMPANIES"].includes(normalized)) return ROLES.COMPANY;
  if (["TECHNICIAN", "TECHNICIANS", "MECHANIC", "MECHANICS"].includes(normalized))
    return ROLES.MECHANIC;
  if (["ADMIN", "ADMINS"].includes(normalized)) return ROLES.ADMIN;
  if ([ROLES.FLEET, ROLES.COMPANY, ROLES.MECHANIC, ROLES.ADMIN].includes(normalized)) {
    return normalized;
  }
  return normalized;
};

const generateAdminInvoiceNo = async () => {
  for (let i = 0; i < 8; i += 1) {
    const random = Math.floor(1000 + Math.random() * 9000);
    const invoiceNo = `INV-${new Date().getFullYear()}-${random}`;
    const exists = await Invoice.exists({ invoiceNo });
    if (!exists) return invoiceNo;
  }
  throw new AppError("Unable to generate invoice number", 500);
};

const serializeMechanicReviewItem = (user) => ({
  _id: user._id,
  email: user.email,
  status: user.status,
  profilePhotoUrl: user.mechanicProfile?.profilePhotoUrl || null,
  displayName: user.mechanicProfile?.displayName || null,
  businessName: user.mechanicProfile?.businessName || null,
  businessType: user.mechanicProfile?.businessType || null,
  phone: user.mechanicProfile?.phone || null,
  baseLocationText: user.mechanicProfile?.baseLocationText || null,
  basePostcode: user.mechanicProfile?.basePostcode || null,
  hourlyRate: user.mechanicProfile?.hourlyRate ?? null,
  emergencyRate: user.mechanicProfile?.emergencyRate ?? null,
  callOutFee: user.mechanicProfile?.callOutFee ?? null,
  serviceRadiusMiles: user.mechanicProfile?.serviceRadiusMiles ?? null,
  skills: user.mechanicProfile?.skills || [],
  verification: {
    status: user.mechanicProfile?.verification?.status || null,
    submittedAt: user.mechanicProfile?.verification?.submittedAt || null,
    reviewedAt: user.mechanicProfile?.verification?.reviewedAt || null,
    reviewNotes: user.mechanicProfile?.verification?.reviewNotes || null,
  },
  createdAt: user.createdAt,
  updatedAt: user.updatedAt,
});

const serializeDashboardJob = (job) => {
  const activityAt = job.updatedAt || job.createdAt || job.postedAt;
  return {
    _id: job._id,
    requestId: job.jobCode,
    jobCode: job.jobCode,
    companyName: job.fleet?.fleetProfile?.companyName || null,
    mechanicName:
      job.assignedMechanic?.mechanicProfile?.displayName ||
      job.assignedMechanic?.email ||
      null,
    locationText: job.location?.address || null,
    issueCategory: job.issueSubtype || job.issueType || null,
    issueType: job.issueType || null,
    amount: job.finalAmount ?? job.acceptedAmount ?? job.estimatedPayout ?? null,
    currency: job.currency || "GBP",
    truck:
      [job.vehicle?.make, job.vehicle?.model, job.vehicle?.registration]
        .filter(Boolean)
        .join(" - ") || job.title,
    issue: job.completionSummary || job.description || job.title,
    status: serviceRequestBucketFromJobStatus(job.status),
    rawStatus: job.status,
    time: relativeTimeLabel(activityAt),
    postedAt: job.postedAt || job.createdAt || null,
    updatedAt: job.updatedAt || null,
  };
};

const serializeDashboardActivity = (event) => {
  const jobCode = event.job?.jobCode || null;
  const title = event.job?.title || null;
  const actorName =
    event.actor?.fleetProfile?.companyName ||
    event.actor?.mechanicProfile?.displayName ||
    event.actor?.email ||
    null;
  const type = `${event.type || "EVENT"}`.replace(/_/g, " ");
  const statusBit =
    event.fromStatus || event.toStatus
      ? `${event.fromStatus || "—"}${event.toStatus ? ` → ${event.toStatus}` : ""}`
      : null;
  const msg = [jobCode, event.note || type].filter(Boolean).join(" — ");
  return {
    id: String(event._id),
    type: event.type || "EVENT",
    msg: msg || type,
    sub: [actorName, title, statusBit].filter(Boolean).join(" · ") || "Platform",
    time: relativeTimeLabel(event.createdAt),
    createdAt: event.createdAt || null,
    jobId: event.job?._id ? String(event.job._id) : null,
    jobCode,
    to: jobCode ? `/admin/jobs?job=${encodeURIComponent(jobCode)}` : "/admin/jobs",
  };
};

const serializeServiceRequest = (job) => {
  const bucket = serviceRequestBucketFromJobStatus(job.status);
  return {
    _id: job._id,
    requestId: job.jobCode,
    truckDetails: {
      registration: job.vehicle?.registration || null,
      label:
        [job.vehicle?.make, job.vehicle?.model, job.vehicle?.registration]
          .filter(Boolean)
          .join(" ") || job.title,
      type: job.vehicle?.type || null,
    },
    driver: {
      name: job.fleet?.fleetProfile?.contactName || null,
      phone: job.fleet?.fleetProfile?.phone || null,
      companyName: job.fleet?.fleetProfile?.companyName || null,
    },
    issue: {
      title: job.title,
      description: job.completionSummary || job.description,
      type: job.issueType,
    },
    priority: {
      value: job.urgency,
      label: `${job.urgency || "MEDIUM"}`.replace("_", " "),
    },
    status: {
      value: bucket,
      label: bucket.replace("_", " "),
      tone: serviceRequestToneFromBucket(bucket),
      raw: job.status,
    },
    fleetId: job.fleet?._id || job.fleet || null,
    assignedTo: job.assignedMechanic
      ? {
          _id: job.assignedMechanic._id || job.assignedMechanic,
          name: job.assignedMechanic.mechanicProfile?.displayName || null,
          phone: job.assignedMechanic.mechanicProfile?.phone || null,
        }
      : null,
    amount: job.finalAmount ?? job.acceptedAmount ?? job.estimatedPayout ?? null,
    currency: job.currency || "GBP",
    preAuthAmount: job.preAuthAmount ?? null,
    quoteCount: job.quoteCount || 0,
    postedAt: job.postedAt || job.createdAt,
    completedAt: job.completedAt || null,
    updatedAt: job.updatedAt,
  };
};

const serializeServiceRequestDetail = (job) => ({
  ...serializeServiceRequest(job),
  fleet: job.fleet
    ? {
        _id: job.fleet._id || job.fleet,
        email: job.fleet.email || null,
        companyName: job.fleet.fleetProfile?.companyName || null,
        contactName: job.fleet.fleetProfile?.contactName || null,
        phone: job.fleet.fleetProfile?.phone || null,
      }
    : null,
  mode: job.mode || "EMERGENCY",
  scheduledFor: job.scheduledFor || null,
  availabilityWindow: job.availabilityWindow || null,
  location: job.location || null,
  photos: job.photos || [],
  completionSummary: job.completionSummary || null,
});

const serializeAdminUser = (user) => {
  const isFleet = user.role === ROLES.FLEET;
  const isMechanic = user.role === ROLES.MECHANIC;
  const isMechanicEmployee = user.role === ROLES.MECHANIC_EMPLOYEE;
  const isMechanicLike = isMechanic || isMechanicEmployee;
  const isCompany = user.role === ROLES.COMPANY;
  const mp = user.mechanicProfile || {};
  const cp = user.companyProfile || {};
  const fp = user.fleetProfile || {};
  return {
    _id: user._id,
    name:
      fp.companyName ||
      cp.companyName ||
      mp.displayName ||
      user.adminProfile?.fullName ||
      user.email,
    email: user.email,
    phone: fp.phone || cp.phone || mp.phone || user.adminProfile?.phoneNumber || null,
    role: isFleet
      ? "FLEET"
      : isMechanicEmployee
      ? "MECHANIC_EMPLOYEE"
      : isMechanic
      ? "MECHANIC"
      : isCompany
      ? "COMPANY"
      : user.role,
    mechanicType: isMechanicEmployee
      ? "EMPLOYEE"
      : isMechanic
      ? "INDEPENDENT"
      : null,
    status: user.status,
    joinDate: user.createdAt,
    company: fp.companyName || cp.companyName || mp.businessName || null,
    employerCompanyId: user.companyMembership?.company || null,
    employerCompanyName: null,
    jobTitle: user.companyMembership?.jobTitle || null,
    employeeDisplayRef: user.companyMembership?.employeeDisplayRef || null,
    membershipStatus: user.companyMembership?.status || null,
    membershipJoinedAt: user.companyMembership?.joinedAt || null,
    location:
      mp.baseLocationText ||
      cp.baseLocationText ||
      fp.billingAddress ||
      null,
    billingAddress: cp.billingAddress || fp.billingAddress || null,
    basePostcode: mp.basePostcode || null,
    contactRole: cp.contactRole || fp.contactRole || null,
    regNumber: cp.regNumber || fp.regNumber || null,
    vatNumber: cp.vatNumber || fp.vatNumber || mp.vatNumber || null,
    teamSize: cp.teamSize ?? fp.fleetSize ?? null,
    profileCompleted: cp.profileCompleted ?? mp.profileCompleted ?? null,
    profileMetrics: cp.profileMetricsOverride || null,
    verificationStatus: mp.verification?.status || null,
    availability: mp.availability || null,
    businessType: mp.businessType || null,
    businessName: mp.businessName || null,
    hourlyRate: mp.hourlyRate ?? null,
    emergencyRate: mp.emergencyRate ?? null,
    callOutFee: mp.callOutFee ?? null,
    serviceRadiusMiles: mp.serviceRadiusMiles ?? cp.serviceRadiusMiles ?? null,
    rating: mp.rating?.average ?? cp.profileMetricsOverride?.avgRating ?? null,
    ratingCount: mp.rating?.count ?? 0,
    skills: mp.skills || [],
    earnings: null,
    currency: "GBP",
    contactName: fp.contactName || cp.contactName || null,
    memberCount: 0,
    activity: isFleet
      ? {
          kind: "trucks",
          value: 0,
        }
      : isMechanicLike
      ? {
          kind: "jobs",
          value: mp.stats?.jobsDone ?? 0,
        }
      : isCompany
      ? {
          kind: "members",
          value: 0,
        }
      : null,
  };
};

const serializeFleetManagementItem = (fleet, vehicles = [], metrics = {}) => ({
  _id: fleet._id,
  companyName: fleet.fleetProfile?.companyName || fleet.email,
  companyStatus: fleet.status,
  contact: {
    name: fleet.fleetProfile?.contactName || null,
    email: fleet.email,
    phone: fleet.fleetProfile?.phone || null,
  },
  locationText: fleet.fleetProfile?.billingAddress || null,
  createdAt: fleet.createdAt || null,
  joinedAt: fleet.createdAt || null,
  jobCount: Number(metrics.jobCount) || 0,
  paidSpend: Number(metrics.paidSpend) || 0,
  lastJobAt: metrics.lastJobAt || null,
  currency: metrics.currency || "GBP",
  counts: {
    totalTrucks: vehicles.length,
    activeTrucks: vehicles.filter((vehicle) => vehicle.isActive).length,
  },
  vehicles: vehicles.map((vehicle) => ({
    _id: vehicle._id,
    registration: vehicle.registration,
    make: vehicle.make || null,
    model: vehicle.model || null,
    year: vehicle.year || null,
    status: vehicle.isActive ? "ACTIVE" : "INACTIVE",
  })),
});

const serializeSupportTicketForAdmin = (ticket) => {
  const replies =
    ticket.replies?.map((reply) => ({
      _id: reply._id,
      message: reply.message,
      internal: Boolean(reply.internal),
      role: reply.role || reply.sender?.role || null,
      createdAt: reply.createdAt,
      sender: reply.sender
        ? {
            _id: reply.sender._id || reply.sender,
            email: reply.sender.email || null,
            displayName:
              reply.sender.fleetProfile?.companyName ||
              reply.sender.companyProfile?.companyName ||
              reply.sender.mechanicProfile?.displayName ||
              reply.sender.adminProfile?.displayName ||
              null,
          }
        : null,
    })) || [];

  return {
    _id: ticket._id,
    ticketRef: ticket.ticketRef || null,
    subject: ticket.subject,
    message: ticket.message,
    category: ticket.category,
    jobCode: ticket.jobCode || null,
    status: {
      value: ticket.status,
      label: ticket.status.replace(/_/g, " "),
      tone: supportStatusTone(ticket.status),
    },
    user: ticket.user
      ? {
          _id: ticket.user._id || ticket.user,
          email: ticket.user.email || null,
          role: ticket.user.role || null,
          companyName:
            ticket.user.fleetProfile?.companyName ||
            ticket.user.companyProfile?.companyName ||
            null,
          displayName: ticket.user.mechanicProfile?.displayName || null,
        }
      : null,
    assignedTo: ticket.assignedTo
      ? {
          _id: ticket.assignedTo._id || ticket.assignedTo,
          email: ticket.assignedTo.email || null,
        }
      : null,
    resolution: ticket.resolution || null,
    resolvedAt: ticket.resolvedAt || null,
    replies,
    repliesCount: replies.length,
    createdAt: ticket.createdAt,
    updatedAt: ticket.updatedAt,
  };
};

const serializeDispute = (dispute) => ({
  _id: dispute._id,
  title: dispute.title,
  description: dispute.description || null,
  priority: dispute.priority,
  status: dispute.status,
  amount: dispute.amount,
  currency: dispute.currency || "GBP",
  company: dispute.company
    ? {
        _id: dispute.company._id || dispute.company,
        companyName: dispute.company.fleetProfile?.companyName || null,
        email: dispute.company.email || null,
      }
    : null,
  customerName: dispute.customerName || null,
  mechanic: dispute.mechanic
    ? {
        _id: dispute.mechanic._id || dispute.mechanic,
        displayName: dispute.mechanic.mechanicProfile?.displayName || null,
        email: dispute.mechanic.email || null,
      }
    : null,
  serviceLabel: dispute.serviceLabel || null,
  reason: dispute.reason || null,
  createdAt: dispute.createdAt,
  updatedAt: dispute.updatedAt,
});

const findMechanicById = async (userId) => {
  const user = await User.findOne({
    _id: userId,
    role: { $in: [ROLES.MECHANIC, ROLES.MECHANIC_EMPLOYEE] },
  });
  if (!user) throw new AppError("Mechanic not found", 404);
  return user;
};

export const listMechanicReviewQueue = async (query = {}) => {
  const page = parsePage(query.page);
  const limit = parseLimit(query.limit);
  const skip = (page - 1) * limit;

  const filter = {
    role: ROLES.MECHANIC,
    status: USER_STATUS.PENDING_REVIEW,
  };

  if (query.status) {
    filter["mechanicProfile.verification.status"] = `${query.status}`
      .trim()
      .toUpperCase();
  } else {
    filter["mechanicProfile.verification.status"] = {
      $in: [
        MECHANIC_VERIFICATION_STATUS.SUBMITTED,
        MECHANIC_VERIFICATION_STATUS.UNDER_REVIEW,
        MECHANIC_VERIFICATION_STATUS.REJECTED,
      ],
    };
  }

  const [items, total] = await Promise.all([
    User.find(filter)
      .sort({
        "mechanicProfile.verification.submittedAt": 1,
        createdAt: 1,
      })
      .skip(skip)
      .limit(limit)
      .lean(),
    User.countDocuments(filter),
  ]);

  return {
    items: items.map(serializeMechanicReviewItem),
    meta: {
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit) || 1,
    },
  };
};

export const getAdminDashboard = async () => {
  const now = new Date();
  const generatedAt = now.toISOString();
  const seriesStart = new Date(now.getFullYear(), now.getMonth() - 5, 1);
  const months = Array.from({ length: 6 }, (_, index) => {
    const date = new Date(now.getFullYear(), now.getMonth() - (5 - index), 1);
    return {
      year: date.getFullYear(),
      month: date.getMonth() + 1,
      label: formatMonthLabel(date),
    };
  });

  const dayMs = 24 * 60 * 60 * 1000;
  const periodStart = new Date(now.getTime() - 30 * dayMs);
  const prevStart = new Date(now.getTime() - 60 * dayMs);

  const [
    paidInvoicesAgg,
    platformFeeAgg,
    fleetActive,
    mechanicActive,
    companyActive,
    serviceRequestsCount,
    fleetVehicleCount,
    jobStatusAgg,
    revenueAgg,
    recentJobs,
    openSupportCount,
    openDisputeCount,
    pendingReviewCount,
    recentEvents,
    gmvCurrentAgg,
    gmvPreviousAgg,
    feeCurrentAgg,
    feePreviousAgg,
    jobsCreatedCurrent,
    jobsCreatedPrevious,
    jobsCompletedCurrent,
    jobsCompletedPrevious,
  ] = await Promise.all([
    Invoice.aggregate([
      {
        $match: {
          status: { $in: ["PAID", "PARTIALLY_REFUNDED", "REFUNDED"] },
        },
      },
      {
        $group: {
          _id: null,
          totalRevenue: { $sum: netCapturedInvoiceAmountExpression },
        },
      },
    ]),
    EarningTransaction.aggregate([
      { $group: { _id: null, platformCommission: { $sum: "$platformFee" } } },
    ]),
    User.countDocuments({ role: ROLES.FLEET, status: USER_STATUS.ACTIVE }),
    User.countDocuments({ role: ROLES.MECHANIC, status: USER_STATUS.ACTIVE }),
    User.countDocuments({ role: ROLES.COMPANY, status: USER_STATUS.ACTIVE }),
    Job.countDocuments({}),
    Vehicle.countDocuments({ isActive: true }),
    Job.aggregate([
      {
        $group: {
          _id: "$status",
          count: { $sum: 1 },
        },
      },
    ]),
    Invoice.aggregate([
      {
        $match: {
          paidAt: { $gte: seriesStart },
          status: { $in: ["PAID", "PARTIALLY_REFUNDED", "REFUNDED"] },
        },
      },
      {
        $group: {
          _id: {
            year: { $year: "$paidAt" },
            month: { $month: "$paidAt" },
          },
          total: { $sum: netCapturedInvoiceAmountExpression },
        },
      },
    ]),
    Job.find({})
      .sort({ updatedAt: -1, createdAt: -1, _id: -1 })
      .limit(8)
      .populate("fleet", "email fleetProfile.companyName fleetProfile.contactName fleetProfile.phone")
      .populate("assignedMechanic", "email mechanicProfile.displayName mechanicProfile.phone")
      .lean(),
    SupportTicket.countDocuments({ status: "OPEN" }),
    Dispute.countDocuments({ status: { $in: ["OPEN", "IN_REVIEW"] } }),
    User.countDocuments({
      role: ROLES.MECHANIC,
      status: USER_STATUS.PENDING_REVIEW,
    }),
    JobEvent.find({})
      .sort({ createdAt: -1 })
      .limit(12)
      .populate("job", "jobCode title")
      .populate(
        "actor",
        "email fleetProfile.companyName mechanicProfile.displayName"
      )
      .lean(),
    Invoice.aggregate([
      {
        $match: {
          status: { $in: ["PAID", "PARTIALLY_REFUNDED", "REFUNDED"] },
          paidAt: { $gte: periodStart, $lte: now },
        },
      },
      {
        $group: {
          _id: null,
          total: { $sum: netCapturedInvoiceAmountExpression },
        },
      },
    ]),
    Invoice.aggregate([
      {
        $match: {
          status: { $in: ["PAID", "PARTIALLY_REFUNDED", "REFUNDED"] },
          paidAt: { $gte: prevStart, $lt: periodStart },
        },
      },
      {
        $group: {
          _id: null,
          total: { $sum: netCapturedInvoiceAmountExpression },
        },
      },
    ]),
    EarningTransaction.aggregate([
      {
        $match: { paidAt: { $gte: periodStart, $lte: now } },
      },
      { $group: { _id: null, total: { $sum: "$platformFee" } } },
    ]),
    EarningTransaction.aggregate([
      {
        $match: { paidAt: { $gte: prevStart, $lt: periodStart } },
      },
      { $group: { _id: null, total: { $sum: "$platformFee" } } },
    ]),
    Job.countDocuments({ createdAt: { $gte: periodStart, $lte: now } }),
    Job.countDocuments({ createdAt: { $gte: prevStart, $lt: periodStart } }),
    Job.countDocuments({
      status: JOB_STATUS.COMPLETED,
      updatedAt: { $gte: periodStart, $lte: now },
    }),
    Job.countDocuments({
      status: JOB_STATUS.COMPLETED,
      updatedAt: { $gte: prevStart, $lt: periodStart },
    }),
  ]);

  const revenueMap = new Map(
    revenueAgg.map((entry) => [`${entry._id.year}-${entry._id.month}`, entry.total])
  );

  const overview = months.map((month) => ({
    month: month.label,
    revenue: revenueMap.get(`${month.year}-${month.month}`) || 0,
  }));

  const statusDistributionBase = {
    PENDING: 0,
    IN_PROGRESS: 0,
    COMPLETED: 0,
    CANCELLED: 0,
  };

  for (const item of jobStatusAgg) {
    const bucket = serviceRequestBucketFromJobStatus(item._id);
    statusDistributionBase[bucket] += item.count;
  }

  const gmvPaid = paidInvoicesAgg[0]?.totalRevenue || 0;
  const platformCommission = platformFeeAgg[0]?.platformCommission || 0;
  const activeUsersByRole = {
    fleet: fleetActive,
    mechanic: mechanicActive,
    company: companyActive,
  };
  const activeUsers =
    activeUsersByRole.fleet + activeUsersByRole.mechanic + activeUsersByRole.company;

  const awaitingAction = statusDistributionBase.PENDING;
  const activeJobs = statusDistributionBase.IN_PROGRESS;

  const attention = [];
  if (awaitingAction > 0) {
    attention.push({
      id: "pending-jobs",
      priority: awaitingAction > 5 ? "HIGH" : "MEDIUM",
      msg: `${awaitingAction} jobs awaiting action`,
      desc: "Review posted and quoting jobs on the platform.",
      action: "View Jobs",
      to: "/admin/jobs?status=PENDING",
    });
  }
  if (openSupportCount > 0) {
    attention.push({
      id: "open-support",
      priority: openSupportCount > 3 ? "HIGH" : "MEDIUM",
      msg: `${openSupportCount} open support ticket${openSupportCount === 1 ? "" : "s"}`,
      desc: "Respond to fleet and mechanic support requests.",
      action: "Support Inbox",
      to: "/admin/support",
    });
  }
  if (openDisputeCount > 0) {
    attention.push({
      id: "open-disputes",
      priority: "HIGH",
      msg: `${openDisputeCount} open dispute${openDisputeCount === 1 ? "" : "s"}`,
      desc: "Investigate and resolve payment or job disputes.",
      action: "View Disputes",
      to: "/admin/disputes",
    });
  }
  if (pendingReviewCount > 0) {
    attention.push({
      id: "mechanic-review",
      priority: pendingReviewCount > 5 ? "HIGH" : "MEDIUM",
      msg: `${pendingReviewCount} mechanic${pendingReviewCount === 1 ? "" : "s"} pending review`,
      desc: "Approve or reject mechanic verification submissions.",
      action: "Review Mechanics",
      to: "/admin/mechanics",
    });
  }

  return {
    generatedAt,
    cards: {
      gmvPaid,
      totalRevenue: gmvPaid,
      platformCommission,
      platformFeePercent: getPlatformFeePercent(),
      activeUsers,
      activeUsersByRole,
      serviceRequests: serviceRequestsCount,
      fleetSize: fleetVehicleCount,
      activeJobs,
      awaitingAction,
      completedJobs: statusDistributionBase.COMPLETED,
    },
    trends: {
      gmvPaid: trendPayload(gmvCurrentAgg[0]?.total || 0, gmvPreviousAgg[0]?.total || 0),
      platformCommission: trendPayload(
        feeCurrentAgg[0]?.total || 0,
        feePreviousAgg[0]?.total || 0
      ),
      serviceRequests: trendPayload(jobsCreatedCurrent, jobsCreatedPrevious),
      completedJobs: trendPayload(jobsCompletedCurrent, jobsCompletedPrevious),
    },
    revenueOverview: overview,
    serviceStatusDistribution: [
      { label: "Pending", value: statusDistributionBase.PENDING },
      { label: "In Progress", value: statusDistributionBase.IN_PROGRESS },
      { label: "Completed", value: statusDistributionBase.COMPLETED },
      { label: "Cancelled", value: statusDistributionBase.CANCELLED },
    ],
    recentServiceRequests: recentJobs.map(serializeDashboardJob),
    attention,
    activity: recentEvents.map(serializeDashboardActivity),
  };
};

export const listAdminServiceRequests = async (query = {}) => {
  const page = parsePage(query.page);
  const limit = parseLimit(query.limit);
  const skip = (page - 1) * limit;

  const filter = {};

  const requestedStatus = `${query.status || ""}`.trim().toUpperCase();
  if (requestedStatus) {
    const status = requestedStatus;
    if (status === "PENDING") {
      filter.status = { $in: [JOB_STATUS.POSTED, JOB_STATUS.QUOTING] };
    } else if (status === "IN_PROGRESS") {
      filter.status = {
        $in: [
          JOB_STATUS.ASSIGNED,
          JOB_STATUS.EN_ROUTE,
          JOB_STATUS.ON_SITE,
          JOB_STATUS.IN_PROGRESS,
        ],
      };
    } else if (status === "AWAITING_APPROVAL") {
      filter.status = JOB_STATUS.AWAITING_APPROVAL;
    } else if (status === "COMPLETED") {
      filter.status = JOB_STATUS.COMPLETED;
    } else if (status === "CANCELLED") {
      filter.status = JOB_STATUS.CANCELLED;
    } else if (status === "DISPUTED") {
      // No JOB_STATUS.DISPUTED yet — force empty until disputes are joined to jobs
      filter._id = { $in: [] };
    }
  }

  if (query.priority) {
    filter.urgency = `${query.priority}`.trim().toUpperCase();
  }

  if (query.search) {
    const searchRegex = safeRegex(query.search);
    filter.$or = [
      { jobCode: searchRegex },
      { title: searchRegex },
      { description: searchRegex },
      { "vehicle.registration": searchRegex },
      { "vehicle.make": searchRegex },
      { "vehicle.model": searchRegex },
    ];
  }

  if (query.fleetId) {
    filter.fleet = `${query.fleetId}`.trim();
  }

  if (query.mechanicId) {
    filter.assignedMechanic = `${query.mechanicId}`.trim();
  }

  if (query.companyId) {
    filter.assignedCompany = `${query.companyId}`.trim();
  }

  const invoiceEligible =
    query.invoiceEligible === true ||
    `${query.invoiceEligible || ""}`.trim().toLowerCase() === "true";
  if (invoiceEligible) {
    filter.assignedMechanic = filter.assignedMechanic || { $exists: true, $ne: null };
    filter.status = {
      $in: [
        JOB_STATUS.AWAITING_APPROVAL,
        JOB_STATUS.COMPLETED,
        JOB_STATUS.IN_PROGRESS,
        JOB_STATUS.ON_SITE,
        JOB_STATUS.EN_ROUTE,
        JOB_STATUS.ASSIGNED,
      ],
    };
    const invoicedJobIds = await Invoice.distinct("job");
    if (invoicedJobIds.length) {
      filter._id = { ...(filter._id || {}), $nin: invoicedJobIds };
    }
  }

  const newestFirstSort =
    requestedStatus === "COMPLETED"
      ? { completedAt: -1, updatedAt: -1, createdAt: -1, _id: -1 }
      : requestedStatus === "PENDING"
        ? { postedAt: -1, createdAt: -1, _id: -1 }
        : { updatedAt: -1, createdAt: -1, _id: -1 };

  const [items, total, allStatusAgg] = await Promise.all([
    Job.find(filter)
      .sort(newestFirstSort)
      .skip(skip)
      .limit(limit)
      .populate("fleet", "email fleetProfile.companyName fleetProfile.contactName fleetProfile.phone")
      .populate("assignedMechanic", "email mechanicProfile.displayName mechanicProfile.phone")
      .lean(),
    Job.countDocuments(filter),
    Job.aggregate([
      {
        $group: {
          _id: "$status",
          count: { $sum: 1 },
        },
      },
    ]),
  ]);

  const counters = {
    totalRequests: allStatusAgg.reduce((sum, item) => sum + item.count, 0),
    pending: 0,
    inProgress: 0,
    completed: 0,
    awaitingApproval: 0,
  };

  for (const item of allStatusAgg) {
    if (item._id === JOB_STATUS.AWAITING_APPROVAL) {
      counters.awaitingApproval += item.count;
    }
    const bucket = serviceRequestBucketFromJobStatus(item._id);
    if (bucket === "PENDING") counters.pending += item.count;
    // Active excludes awaiting-approval so it matches the Active tab filter
    if (
      bucket === "IN_PROGRESS" &&
      item._id !== JOB_STATUS.AWAITING_APPROVAL
    ) {
      counters.inProgress += item.count;
    }
    if (bucket === "COMPLETED") counters.completed += item.count;
  }

  return {
    items: items.map(serializeServiceRequest),
    meta: {
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit) || 1,
    },
    stats: counters,
  };
};

export const updateAdminServiceRequest = async (jobId, payload = {}, adminUser) => {
  const job = await Job.findById(jobId)
    .populate("assignedMechanic", "email mechanicProfile.displayName mechanicProfile.phone")
    .populate("fleet", "email fleetProfile.companyName fleetProfile.contactName fleetProfile.phone");
  if (!job) throw new AppError("Service request not found", 404);

  if (payload.priority) {
    job.urgency = parsePriority(payload.priority);
  }

  if (payload.title !== undefined) {
    const nextTitle = `${payload.title || ""}`.trim();
    if (!nextTitle) throw new AppError("title cannot be empty", 400);
    job.title = nextTitle;
  }

  if (payload.description !== undefined) {
    const nextDescription = `${payload.description || ""}`.trim();
    if (!nextDescription) throw new AppError("description cannot be empty", 400);
    job.description = nextDescription;
  }

  if (payload.issueType !== undefined) {
    job.issueType = `${payload.issueType || ""}`.trim().toUpperCase() || job.issueType;
  }

  if (payload.mode !== undefined) {
    const nextMode = `${payload.mode || ""}`.trim().toUpperCase();
    if (!["EMERGENCY", "SCHEDULABLE"].includes(nextMode)) {
      throw new AppError("mode must be EMERGENCY or SCHEDULABLE", 400);
    }
    job.mode = nextMode;
  }

  if (payload.vehicle && typeof payload.vehicle === "object") {
    job.vehicle = {
      ...(job.vehicle?.toObject?.() || job.vehicle || {}),
      ...payload.vehicle,
    };
  }

  if (payload.location && typeof payload.location === "object") {
    const nextLocation = {
      ...(job.location?.toObject?.() || job.location || {}),
      ...payload.location,
    };

    if (
      nextLocation.coordinates &&
      (!Array.isArray(nextLocation.coordinates) || nextLocation.coordinates.length !== 2)
    ) {
      throw new AppError("location.coordinates must be [lng, lat]", 400);
    }

    job.location = nextLocation;
  }

  if (payload.scheduledFor !== undefined) {
    job.scheduledFor = payload.scheduledFor ? new Date(payload.scheduledFor) : undefined;
  }

  if (payload.availabilityWindow !== undefined) {
    const nextWindow = payload.availabilityWindow || {};
    job.availabilityWindow = {
      from: nextWindow.from ? new Date(nextWindow.from) : undefined,
      to: nextWindow.to ? new Date(nextWindow.to) : undefined,
    };
  }

  if (payload.status) {
    const nextStatus = parseStatus(payload.status);
    if (!jobStatusValues.includes(nextStatus)) {
      throw new AppError(`status must be one of ${jobStatusValues.join(", ")}`, 400);
    }
    job.status = nextStatus;
    if (nextStatus === JOB_STATUS.COMPLETED && !job.completedAt) {
      job.completedAt = new Date();
    }
    if (nextStatus === JOB_STATUS.CANCELLED && !job.cancelledAt) {
      job.cancelledAt = new Date();
    }
  }

  if (payload.assignedMechanicId !== undefined) {
    if (!payload.assignedMechanicId) {
      job.assignedMechanic = undefined;
      job.assignedAt = undefined;
      if ([JOB_STATUS.ASSIGNED, JOB_STATUS.EN_ROUTE, JOB_STATUS.ON_SITE, JOB_STATUS.IN_PROGRESS].includes(job.status)) {
        job.status = JOB_STATUS.POSTED;
      }
    } else {
      const mechanic = await User.findOne({
        _id: payload.assignedMechanicId,
        role: ROLES.MECHANIC,
      }).select("email mechanicProfile.displayName mechanicProfile.phone");
      if (!mechanic) throw new AppError("Assigned mechanic not found", 404);
      job.assignedMechanic = mechanic._id;
      job.assignedAt = job.assignedAt || new Date();
      if ([JOB_STATUS.POSTED, JOB_STATUS.QUOTING].includes(job.status)) {
        job.status = JOB_STATUS.ASSIGNED;
      }
    }
  }

  if (payload.etaMinutes !== undefined) {
    job.tracking = {
      ...(job.tracking || {}),
      etaMinutes: payload.etaMinutes === null ? undefined : payload.etaMinutes,
    };
  }

  if (payload.completionSummary !== undefined) {
    job.completionSummary = `${payload.completionSummary || ""}`.trim() || undefined;
  }

  await job.save();
  await writeAuditLog(
    adminUser,
    "Updated Service Request",
    job.jobCode || job._id.toString(),
    "Service Management"
  );

  const refreshedJob = await Job.findById(job._id)
    .populate("fleet", "email fleetProfile.companyName fleetProfile.contactName fleetProfile.phone")
    .populate("assignedMechanic", "email mechanicProfile.displayName mechanicProfile.phone")
    .lean();

  return serializeServiceRequest(refreshedJob);
};

export const getAdminServiceRequestById = async (jobId) => {
  const job = await Job.findById(jobId)
    .populate("fleet", "email fleetProfile.companyName fleetProfile.contactName fleetProfile.phone")
    .populate("assignedMechanic", "email mechanicProfile.displayName mechanicProfile.phone")
    .lean();

  if (!job) throw new AppError("Service request not found", 404);

  return serializeServiceRequestDetail(job);
};

export const sendAdminServiceRequestMessage = async (jobId, payload = {}, adminUser) => {
  const message = await sendJobMessage(jobId, adminUser, payload);

  await writeAuditLog(
    adminUser,
    "Sent Service Request Message",
    `${jobId}`,
    "Service Management"
  );

  return message;
};

export const createAdminServiceRequestInvoice = async (jobId, payload = {}, adminUser) => {
  const job = await Job.findById(jobId)
    .populate("fleet", "email fleetProfile.companyName fleetProfile.contactName")
    .populate("assignedCompany", "email companyProfile")
    .populate(
      "assignedMechanic",
      "email mechanicProfile"
    );

  if (!job) throw new AppError("Service request not found", 404);
  if (!job.fleet) throw new AppError("Fleet account missing on service request", 400);
  if (!job.assignedMechanic) {
    throw new AppError("Assign a mechanic before generating an invoice", 400);
  }

  const existingInvoice = await Invoice.findOne({ job: job._id }).select("_id invoiceNo");
  if (existingInvoice) {
    throw new AppError(`Invoice already exists for this request: ${existingInvoice.invoiceNo}`, 409);
  }

  const subtotal = Number(payload.subtotal ?? job.finalAmount ?? job.acceptedAmount ?? job.estimatedPayout);
  if (!Number.isFinite(subtotal) || subtotal <= 0) {
    throw new AppError("A valid subtotal is required to generate an invoice", 400);
  }

  return createAdminFinancialInvoice(
    {
      jobId: job._id,
      fleetId: job.fleet._id,
      mechanicId: job.assignedMechanic._id,
      subtotal,
      totalAmount: payload.totalAmount,
      vatAmount: payload.vatAmount,
      currency: payload.currency || job.currency || "GBP",
      description: payload.description || `${job.jobCode} - ${job.title}`,
      companyName: job.fleet.fleetProfile?.companyName || undefined,
      mechanicName: job.assignedMechanic.mechanicProfile?.displayName || undefined,
      mechanicBusinessName:
        job.assignedMechanic.mechanicProfile?.businessName || undefined,
      mechanicRating: job.assignedMechanic.mechanicProfile?.rating?.average || undefined,
    },
    adminUser
  );
};

export const deleteAdminServiceRequest = async (jobId, adminUser) => {
  const job = await Job.findById(jobId);
  if (!job) throw new AppError("Service request not found", 404);

  if (
    [
      JOB_STATUS.ASSIGNED,
      JOB_STATUS.EN_ROUTE,
      JOB_STATUS.ON_SITE,
      JOB_STATUS.IN_PROGRESS,
      JOB_STATUS.AWAITING_APPROVAL,
      JOB_STATUS.COMPLETED,
    ].includes(job.status)
  ) {
    throw new AppError(
      "Only posted, quoting, or cancelled requests can be deleted. Cancel the live request first if needed.",
      400
    );
  }

  const hasInvoice = await Invoice.exists({ job: job._id });
  if (hasInvoice) {
    throw new AppError("Cannot delete a service request that already has an invoice", 400);
  }

  await Promise.all([
    ChatMessage.deleteMany({ job: job._id }),
    JobEvent.deleteMany({ job: job._id }),
    JobLocationPing.deleteMany({ job: job._id }),
    Notification.deleteMany({ "data.jobId": `${job._id}` }),
    Job.deleteOne({ _id: job._id }),
  ]);

  await writeAuditLog(
    adminUser,
    "Deleted Service Request",
    job.jobCode || job._id.toString(),
    "Service Management"
  );

  return {
    _id: job._id,
    requestId: job.jobCode,
    deleted: true,
  };
};

const serializeAdminUserDetail = (user, extras = {}) => ({
  ...serializeAdminUser(user),
  fleetProfile: user.fleetProfile || null,
  mechanicProfile: user.mechanicProfile || null,
  companyProfile: user.companyProfile || null,
  adminProfile: user.adminProfile || null,
  companyMembership: user.companyMembership || null,
  ...extras,
});

const serializeAdminUserMember = (user) => ({
  _id: user._id,
  name:
    user.mechanicProfile?.displayName ||
    user.adminProfile?.fullName ||
    user.email,
  email: user.email,
  phone:
    user.mechanicProfile?.phone ||
    user.fleetProfile?.phone ||
    user.adminProfile?.phoneNumber ||
    null,
  role: user.role === ROLES.MECHANIC ? "TECHNICIAN" : user.role,
  status: user.status,
  jobTitle: user.companyMembership?.jobTitle || null,
  membershipStatus: user.companyMembership?.status || null,
  joinedAt: user.companyMembership?.joinedAt || user.createdAt,
});

export const listAdminUsers = async (query = {}) => {
  const page = parsePage(query.page);
  const limit = parseLimit(query.limit);
  const skip = (page - 1) * limit;
  const filter = {};
  const roleFilter = parseRoleFilter(query.role);
  const statusFilter = parseStatus(query.status);

  if (roleFilter === "FLEETS" || roleFilter === "FLEET") {
    filter.role = ROLES.FLEET;
  } else if (roleFilter === "COMPANIES" || roleFilter === "COMPANY") {
    filter.role = ROLES.COMPANY;
  } else if (
    roleFilter === "TECHNICIANS" ||
    roleFilter === "TECHNICIAN" ||
    roleFilter === "MECHANICS" ||
    roleFilter === "MECHANIC"
  ) {
    filter.role = { $in: [ROLES.MECHANIC, ROLES.MECHANIC_EMPLOYEE] };
  } else if (roleFilter === "ADMINS" || roleFilter === "ADMIN") {
    filter.role = ROLES.ADMIN;
  } else if (roleFilter === "DRIVERS" || roleFilter === "DRIVER") {
    filter.role = "__NO_DRIVER_ROLE__";
  }

  if (statusFilter === "PENDING" || statusFilter === "PENDING_REVIEW") {
    filter.status = USER_STATUS.PENDING_REVIEW;
  } else if (statusFilter && statusFilter !== "ALL") {
    filter.status = statusFilter;
  }

  const employerId = `${query.employerId || query.employer || ""}`.trim();
  if (employerId) {
    filter["companyMembership.company"] = employerId;
  }

  const exactUserId = `${query.id || query.userId || query.companyId || ""}`.trim();
  if (exactUserId) {
    filter._id = exactUserId;
  }

  if (query.search) {
    const searchRegex = safeRegex(query.search);
    filter.$or = [
      { email: searchRegex },
      { "fleetProfile.companyName": searchRegex },
      { "fleetProfile.contactName": searchRegex },
      { "companyProfile.companyName": searchRegex },
      { "companyProfile.contactName": searchRegex },
      { "mechanicProfile.displayName": searchRegex },
      { "mechanicProfile.businessName": searchRegex },
      { "adminProfile.fullName": searchRegex },
      { "fleetProfile.phone": searchRegex },
      { "companyProfile.phone": searchRegex },
      { "mechanicProfile.phone": searchRegex },
    ];
  }

  const mechanicRoleFilter = { $in: [ROLES.MECHANIC, ROLES.MECHANIC_EMPLOYEE] };
  const isMechanicList =
    filter.role &&
    typeof filter.role === "object" &&
    Array.isArray(filter.role.$in) &&
    filter.role.$in.includes(ROLES.MECHANIC);

  const [
    users,
    total,
    totalFleets,
    totalCompanies,
    totalMembers,
    activeTechnicians,
    mechanicTotal,
    mechanicActive,
    mechanicPending,
    mechanicSuspended,
    mechanicBlocked,
    companyActive,
    companyPending,
    companySuspended,
    companyBlocked,
  ] = await Promise.all([
    User.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
    User.countDocuments(filter),
    User.countDocuments({ role: ROLES.FLEET }),
    User.countDocuments({ role: ROLES.COMPANY }),
    User.countDocuments({
      role: { $in: [ROLES.FLEET, ROLES.MECHANIC, ROLES.MECHANIC_EMPLOYEE, ROLES.COMPANY] },
    }),
    User.countDocuments({ role: mechanicRoleFilter, status: USER_STATUS.ACTIVE }),
    User.countDocuments({ role: mechanicRoleFilter }),
    User.countDocuments({ role: mechanicRoleFilter, status: USER_STATUS.ACTIVE }),
    User.countDocuments({ role: mechanicRoleFilter, status: USER_STATUS.PENDING_REVIEW }),
    User.countDocuments({ role: mechanicRoleFilter, status: USER_STATUS.SUSPENDED }),
    User.countDocuments({ role: mechanicRoleFilter, status: USER_STATUS.BLOCKED }),
    User.countDocuments({ role: ROLES.COMPANY, status: USER_STATUS.ACTIVE }),
    User.countDocuments({ role: ROLES.COMPANY, status: USER_STATUS.PENDING_REVIEW }),
    User.countDocuments({ role: ROLES.COMPANY, status: USER_STATUS.SUSPENDED }),
    User.countDocuments({ role: ROLES.COMPANY, status: USER_STATUS.BLOCKED }),
  ]);

  const fleetIds = users
    .filter((user) => user.role === ROLES.FLEET)
    .map((user) => user._id);

  const companyIds = users
    .filter((user) => user.role === ROLES.COMPANY)
    .map((user) => user._id);

  const mechanicIds = users
    .filter(
      (user) =>
        user.role === ROLES.MECHANIC || user.role === ROLES.MECHANIC_EMPLOYEE
    )
    .map((user) => user._id);

  const employerIds = [
    ...new Set(
      users
        .map((user) => user.companyMembership?.company)
        .filter(Boolean)
        .map((id) => id.toString())
    ),
  ];

  const employers = employerIds.length
    ? await User.find({ _id: { $in: employerIds } })
        .select("email companyProfile.companyName")
        .lean()
    : [];

  const employerNameMap = new Map(
    employers.map((org) => [
      org._id.toString(),
      org.companyProfile?.companyName || org.email || null,
    ])
  );

  const vehicleCountsAgg = fleetIds.length
    ? await Vehicle.aggregate([
        {
          $match: {
            fleet: { $in: fleetIds },
          },
        },
        {
          $group: {
            _id: "$fleet",
            count: { $sum: 1 },
          },
        },
      ])
    : [];

  const vehicleCountMap = new Map(
    vehicleCountsAgg.map((entry) => [entry._id.toString(), entry.count])
  );

  const memberCountsAgg = [...fleetIds, ...companyIds].length
    ? await User.aggregate([
        {
          $match: {
            "companyMembership.company": { $in: [...fleetIds, ...companyIds] },
            "companyMembership.status": "ACTIVE",
          },
        },
        {
          $group: {
            _id: "$companyMembership.company",
            count: { $sum: 1 },
          },
        },
      ])
    : [];

  const memberCountMap = new Map(
    memberCountsAgg.map((entry) => [entry._id.toString(), entry.count])
  );

  const earningsAgg = mechanicIds.length
    ? await EarningTransaction.aggregate([
        { $match: { mechanic: { $in: mechanicIds } } },
        {
          $group: {
            _id: "$mechanic",
            netAmount: { $sum: "$netAmount" },
            currency: { $first: "$currency" },
          },
        },
      ])
    : [];

  const earningsMap = new Map(
    earningsAgg.map((entry) => [
      entry._id.toString(),
      { netAmount: entry.netAmount, currency: entry.currency || "GBP" },
    ])
  );

  const items = users.map((user) => {
    const item = serializeAdminUser(user);
    if (user.role === ROLES.FLEET) {
      item.memberCount = memberCountMap.get(user._id.toString()) || 0;
      item.activity = {
        kind: "trucks",
        value: vehicleCountMap.get(user._id.toString()) || 0,
      };
    }
    if (user.role === ROLES.COMPANY) {
      item.memberCount = memberCountMap.get(user._id.toString()) || 0;
      item.activity = {
        kind: "members",
        value: item.memberCount,
      };
    }
    if (
      user.role === ROLES.MECHANIC ||
      user.role === ROLES.MECHANIC_EMPLOYEE
    ) {
      const earn = earningsMap.get(user._id.toString());
      item.earnings = earn ? Number(earn.netAmount) || 0 : 0;
      item.currency = earn?.currency || "GBP";
      const employerId = user.companyMembership?.company?.toString?.() ||
        (user.companyMembership?.company
          ? String(user.companyMembership.company)
          : null);
      if (employerId) {
        item.employerCompanyName = employerNameMap.get(employerId) || null;
        if (!item.company || item.company === item.businessName) {
          item.company = item.employerCompanyName || item.company;
        }
      }
    }
    return item;
  });

  const mechanicStats = isMechanicList
    ? {
        total: mechanicTotal,
        active: mechanicActive,
        pendingReview: mechanicPending,
        suspended: mechanicSuspended,
        blocked: mechanicBlocked,
      }
    : null;

  const companyStats =
    filter.role === ROLES.COMPANY
      ? {
          total: totalCompanies,
          active: companyActive,
          pendingReview: companyPending,
          suspended: companySuspended,
          blocked: companyBlocked,
        }
      : null;

  return {
    items,
    meta: {
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit) || 1,
    },
    stats: {
      totalCompanies: totalFleets,
      totalServiceCompanies: totalCompanies,
      totalMembers,
      activeTechnicians,
      activeDrivers: 0,
      total: isMechanicList
        ? mechanicStats.total
        : filter.role === ROLES.COMPANY
        ? companyStats.total
        : total,
      active: mechanicStats?.active ?? companyStats?.active,
      pendingReview: mechanicStats?.pendingReview ?? companyStats?.pendingReview,
      suspended: mechanicStats?.suspended ?? companyStats?.suspended,
      blocked: mechanicStats?.blocked ?? companyStats?.blocked,
      ...(mechanicStats || {}),
      ...(companyStats || {}),
    },
  };
};

export const getAdminUserById = async (userId) => {
  const user = await User.findById(userId).lean();
  if (!user) throw new AppError("User not found", 404);

  let memberCount = 0;
  if (user.role === ROLES.FLEET || user.role === ROLES.COMPANY) {
    memberCount = await User.countDocuments({
      "companyMembership.company": user._id,
      "companyMembership.status": "ACTIVE",
    });
  }

  return serializeAdminUserDetail(user, { memberCount });
};

export const listAdminUserMembers = async (userId) => {
  const org = await User.findById(userId).lean();
  if (!org) throw new AppError("User not found", 404);
  if (![ROLES.FLEET, ROLES.COMPANY].includes(org.role)) {
    throw new AppError("Members are only available for fleet or company accounts", 400);
  }

  const members = await User.find({
    "companyMembership.company": org._id,
  })
    .sort({ "companyMembership.joinedAt": -1, createdAt: -1 })
    .lean();

  return {
    company: {
      _id: org._id,
      companyName:
        org.companyProfile?.companyName ||
        org.fleetProfile?.companyName ||
        org.email,
      email: org.email,
      role: org.role,
    },
    items: members.map(serializeAdminUserMember),
    stats: {
      total: members.length,
      active: members.filter(
        (member) => member.companyMembership?.status === "ACTIVE"
      ).length,
      pending: members.filter(
        (member) => member.companyMembership?.status === "PENDING"
      ).length,
    },
  };
};

export const createAdminUserOrCompany = async (payload = {}, adminUser) => {
  const role = mapAdminRole(payload.role || payload.entityType);
  if (![ROLES.FLEET, ROLES.MECHANIC, ROLES.ADMIN, ROLES.COMPANY].includes(role)) {
    throw new AppError("role must be FLEET, MECHANIC, COMPANY, or ADMIN", 400);
  }

  const email = normalizeAdminEmail(payload.email);
  if (!email) throw new AppError("email is required", 400);
  if (!payload.password) throw new AppError("password is required", 400);

  const exists = await User.findOne({ email });
  if (exists) throw new AppError("Email already in use", 409);

  const userData = {
    email,
    password: payload.password,
    role,
    status: payload.status ? `${payload.status}`.trim().toUpperCase() : USER_STATUS.ACTIVE,
  };

  if (role === ROLES.FLEET) {
    userData.fleetProfile = {
      companyName: payload.companyName,
      contactName: payload.contactName || payload.fullName,
      contactRole: payload.contactRole,
      phone: payload.phone,
      regNumber: payload.regNumber,
      vatNumber: payload.vatNumber,
      fleetSize: payload.fleetSize,
      billingAddress: payload.billingAddress,
    };
  }

  if (role === ROLES.COMPANY) {
    userData.companyProfile = {
      companyName: payload.companyName,
      contactName: payload.contactName || payload.fullName,
      contactRole: payload.contactRole,
      phone: payload.phone,
      regNumber: payload.regNumber,
      vatNumber: payload.vatNumber,
      billingAddress: payload.billingAddress,
      baseLocationText: payload.baseLocationText || payload.billingAddress,
      serviceRadiusMiles: payload.serviceRadiusMiles,
      teamSize: payload.teamSize,
      profileCompleted: true,
    };
  }

  if (role === ROLES.MECHANIC) {
    userData.mechanicProfile = {
      displayName: payload.displayName || payload.fullName,
      businessName: payload.businessName,
      businessType: payload.businessType,
      phone: payload.phone,
      baseLocationText: payload.baseLocationText,
      basePostcode: payload.basePostcode,
      hourlyRate: payload.hourlyRate,
      emergencyRate: payload.emergencyRate,
      callOutFee: payload.callOutFee,
      vatNumber: payload.vatNumber,
      vatRegistered:
        payload.vatRegistered === true ||
        `${payload.vatRegistered || ""}`.trim().toLowerCase() === "true",
      serviceRadiusMiles: payload.serviceRadiusMiles,
      skills: payload.skills || [],
      verification: {
        status:
          userData.status === USER_STATUS.ACTIVE
            ? MECHANIC_VERIFICATION_STATUS.APPROVED
            : MECHANIC_VERIFICATION_STATUS.SUBMITTED,
        reviewedAt:
          userData.status === USER_STATUS.ACTIVE ? new Date() : undefined,
      },
    };
  }

  if (role === ROLES.ADMIN) {
    userData.adminProfile = {
      fullName: payload.fullName || email.split("@")[0],
      phoneNumber: payload.phoneNumber || payload.phone,
      profilePhotoUrl: payload.profilePhotoUrl,
    };
    userData.adminSettings = {
      timeZone: payload.timeZone || "GMT",
      language: payload.language || "English",
      billingEmail: payload.billingEmail || email,
    };
  }

  const user = await User.create(userData);
  await writeAuditLog(
    adminUser,
    "Created User",
    `${role}:${email}`,
    "User Management"
  );

  return serializeAdminUser(user.toObject());
};

export const updateAdminUser = async (userId, payload = {}, adminUser) => {
  const user = await User.findById(userId);
  if (!user) throw new AppError("User not found", 404);

  if (payload.email !== undefined) {
    const email = normalizeAdminEmail(payload.email);
    if (!email) throw new AppError("email cannot be empty", 400);
    const duplicate = await User.findOne({ _id: { $ne: user._id }, email });
    if (duplicate) throw new AppError("Email already in use", 409);
    user.email = email;
  }

  if (payload.status !== undefined) {
    const nextStatus = `${payload.status}`.trim().toUpperCase();
    if (!userStatusValues.includes(nextStatus)) {
      throw new AppError(`status must be one of ${userStatusValues.join(", ")}`, 400);
    }
    user.status = nextStatus;
  }

  if (user.role === ROLES.FLEET) {
    user.fleetProfile = {
      ...(user.fleetProfile || {}),
      ...Object.fromEntries(
        Object.entries({
          companyName: payload.companyName,
          contactName: payload.contactName,
          contactRole: payload.contactRole,
          phone: payload.phone,
          regNumber: payload.regNumber,
          vatNumber: payload.vatNumber,
          fleetSize: payload.fleetSize,
          billingAddress: payload.billingAddress,
        }).filter(([, value]) => value !== undefined)
      ),
    };
  }

  if (user.role === ROLES.COMPANY) {
    user.companyProfile = {
      ...(user.companyProfile || {}),
      ...Object.fromEntries(
        Object.entries({
          companyName: payload.companyName,
          contactName: payload.contactName,
          contactRole: payload.contactRole,
          phone: payload.phone,
          regNumber: payload.regNumber,
          vatNumber: payload.vatNumber,
          billingAddress: payload.billingAddress,
          baseLocationText: payload.baseLocationText,
          serviceRadiusMiles: payload.serviceRadiusMiles,
          teamSize: payload.teamSize,
        }).filter(([, value]) => value !== undefined)
      ),
    };
  }

  if (user.role === ROLES.MECHANIC) {
    user.mechanicProfile = {
      ...(user.mechanicProfile || {}),
      ...Object.fromEntries(
        Object.entries({
          displayName: payload.displayName,
          businessName: payload.businessName,
          phone: payload.phone,
          baseLocationText: payload.baseLocationText,
          basePostcode: payload.basePostcode,
          hourlyRate: payload.hourlyRate,
          emergencyRate: payload.emergencyRate,
          callOutFee: payload.callOutFee,
          vatNumber: payload.vatNumber,
          vatRegistered:
            payload.vatRegistered === undefined
              ? undefined
              : payload.vatRegistered === true ||
                `${payload.vatRegistered || ""}`.trim().toLowerCase() === "true",
          serviceRadiusMiles: payload.serviceRadiusMiles,
          skills: payload.skills,
        }).filter(([, value]) => value !== undefined)
      ),
    };
  }

  if (user.role === ROLES.ADMIN) {
    user.adminProfile = {
      ...(user.adminProfile || {}),
      ...Object.fromEntries(
        Object.entries({
          fullName: payload.fullName,
          phoneNumber: payload.phoneNumber,
          profilePhotoUrl: payload.profilePhotoUrl,
        }).filter(([, value]) => value !== undefined)
      ),
    };
  }

  await user.save();
  await writeAuditLog(
    adminUser,
    "Updated User",
    `${user.role}:${user.email}`,
    "User Management"
  );

  return serializeAdminUser(user.toObject());
};

export const resetAdminUserPassword = async (userId, payload = {}, adminUser) => {
  const user = await User.findById(userId);
  if (!user) throw new AppError("User not found", 404);

  const nextPassword = `${payload.newPassword || payload.password || ""}`.trim();
  if (nextPassword.length < 8) {
    throw new AppError("newPassword must be at least 8 characters", 400);
  }

  user.password = nextPassword;
  user.passwordChangedAt = new Date();
  await user.save();

  await writeAuditLog(
    adminUser,
    "Reset User Password",
    `${user.role}:${user.email}`,
    "User Management"
  );

  return {
    _id: user._id,
    email: user.email,
    passwordReset: true,
  };
};

export const sendAdminUserMessage = async (userId, payload = {}, adminUser) => {
  const user = await User.findById(userId).lean();
  if (!user) throw new AppError("User not found", 404);

  const body = `${payload.body || payload.message || payload.text || ""}`.trim();
  if (!body) throw new AppError("message body is required", 400);

  const title =
    `${payload.title || ""}`.trim() ||
    `Message from ${getAdminActorLabel(adminUser)}`;

  const notification = await createNotification({
    user: user._id,
    type: "ADMIN_DIRECT_MESSAGE",
    title,
    body,
    data: {
      fromAdminId: adminUser?._id ? String(adminUser._id) : "",
      fromAdminLabel: getAdminActorLabel(adminUser),
    },
    isRead: false,
  });

  await writeAuditLog(
    adminUser,
    "Sent User Message",
    `${user.role}:${user.email}`,
    "User Management"
  );

  return {
    _id: notification._id,
    userId: user._id,
    title: notification.title,
    body: notification.body,
    createdAt: notification.createdAt,
  };
};

export const deleteAdminUser = async (userId, adminUser) => {
  const user = await User.findById(userId);
  if (!user) throw new AppError("User not found", 404);

  if (`${user._id}` === `${adminUser?._id || ""}`) {
    throw new AppError("You cannot remove your own admin account", 400);
  }

  const result = await removeUserAccount(user);

  await writeAuditLog(
    adminUser,
    "Removed User",
    `${user.role}:${user.email}`,
    "User Management"
  );

  return result;
};

export const listAdminFleet = async (query = {}) => {
  const page = parsePage(query.page);
  const limit = parseLimit(query.limit);
  const skip = (page - 1) * limit;
  const companyFilter = { role: ROLES.FLEET };

  if (query.status) {
    let status = `${query.status}`.trim().toUpperCase();
    if (status === "PENDING") status = USER_STATUS.PENDING_REVIEW;
    if (status === "INACTIVE") status = USER_STATUS.BLOCKED;
    companyFilter.status = status;
  }

  if (query.search) {
    const searchRegex = safeRegex(query.search);
    companyFilter.$or = [
      { email: searchRegex },
      { "fleetProfile.companyName": searchRegex },
      { "fleetProfile.contactName": searchRegex },
      { "fleetProfile.phone": searchRegex },
    ];
  }

  const [fleets, total, statsRows] = await Promise.all([
    User.find(companyFilter)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .lean(),
    User.countDocuments(companyFilter),
    Promise.all([
      User.countDocuments({ role: ROLES.FLEET }),
      User.countDocuments({ role: ROLES.FLEET, status: USER_STATUS.ACTIVE }),
      User.countDocuments({ role: ROLES.FLEET, status: USER_STATUS.PENDING_REVIEW }),
      User.countDocuments({ role: ROLES.FLEET, status: USER_STATUS.SUSPENDED }),
      User.countDocuments({ role: ROLES.FLEET, status: USER_STATUS.BLOCKED }),
      Vehicle.countDocuments(),
      Vehicle.countDocuments({ isActive: true }),
    ]),
  ]);

  const fleetIds = fleets.map((fleet) => fleet._id);

  const [vehicles, jobAgg, spendAgg] = await Promise.all([
    fleetIds.length
      ? Vehicle.find({ fleet: { $in: fleetIds } })
          .sort({ createdAt: -1 })
          .lean()
      : Promise.resolve([]),
    fleetIds.length
      ? Job.aggregate([
          { $match: { fleet: { $in: fleetIds } } },
          {
            $group: {
              _id: "$fleet",
              jobCount: { $sum: 1 },
              lastJobAt: { $max: { $ifNull: ["$postedAt", "$createdAt"] } },
            },
          },
        ])
      : Promise.resolve([]),
    fleetIds.length
      ? Invoice.aggregate([
          {
            $match: {
              fleet: { $in: fleetIds },
              status: { $in: ["PAID", "PARTIALLY_REFUNDED", "REFUNDED"] },
            },
          },
          {
            $group: {
              _id: "$fleet",
              paidSpend: { $sum: netCapturedInvoiceAmountExpression },
            },
          },
        ])
      : Promise.resolve([]),
  ]);

  const vehiclesByFleet = new Map();
  for (const vehicle of vehicles) {
    const key = vehicle.fleet.toString();
    const list = vehiclesByFleet.get(key) || [];
    list.push(vehicle);
    vehiclesByFleet.set(key, list);
  }

  const jobMetricsByFleet = new Map(
    jobAgg.map((row) => [
      row._id.toString(),
      { jobCount: row.jobCount, lastJobAt: row.lastJobAt },
    ])
  );
  const spendByFleet = new Map(
    spendAgg.map((row) => [row._id.toString(), row.paidSpend])
  );

  const items = fleets.map((fleet) => {
    const id = fleet._id.toString();
    const jobMeta = jobMetricsByFleet.get(id) || {};
    return serializeFleetManagementItem(
      fleet,
      vehiclesByFleet.get(id) || [],
      {
        jobCount: jobMeta.jobCount || 0,
        lastJobAt: jobMeta.lastJobAt || null,
        paidSpend: spendByFleet.get(id) || 0,
      }
    );
  });

  const [
    totalCompanies,
    activeCompanies,
    pendingCompanies,
    suspendedCompanies,
    blockedCompanies,
    totalFleet,
    activeTrucks,
  ] = statsRows;

  return {
    items,
    stats: {
      totalCompanies,
      activeCompanies,
      pendingCompanies,
      suspendedCompanies,
      blockedCompanies,
      totalFleet,
      activeTrucks,
    },
    meta: {
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit) || 1,
    },
  };
};

export const createAdminFleetCompany = async (payload = {}, adminUser) =>
  createAdminUserOrCompany(
    {
      role: ROLES.FLEET,
      email: payload.email,
      password: payload.password,
      status: payload.status,
      companyName: payload.companyName,
      contactName: payload.contactName,
      contactRole: payload.contactRole,
      phone: payload.phone,
      regNumber: payload.regNumber,
      vatNumber: payload.vatNumber,
      fleetSize: payload.fleetSize,
      billingAddress: payload.billingAddress,
    },
    adminUser
  );

export const updateAdminFleetCompany = async (fleetId, payload = {}, adminUser) => {
  const fleet = await User.findOne({ _id: fleetId, role: ROLES.FLEET });
  if (!fleet) throw new AppError("Fleet company not found", 404);

  fleet.fleetProfile = {
    ...(fleet.fleetProfile || {}),
    ...Object.fromEntries(
      Object.entries({
        companyName: payload.companyName,
        contactName: payload.contactName,
        contactRole: payload.contactRole,
        phone: payload.phone,
        regNumber: payload.regNumber,
        vatNumber: payload.vatNumber,
        fleetSize: payload.fleetSize,
        billingAddress: payload.billingAddress,
      }).filter(([, value]) => value !== undefined)
    ),
  };

  if (payload.status !== undefined) {
    const nextStatus = `${payload.status}`.trim().toUpperCase();
    if (!userStatusValues.includes(nextStatus)) {
      throw new AppError(`status must be one of ${userStatusValues.join(", ")}`, 400);
    }
    fleet.status = nextStatus;
  }

  await fleet.save();
  await writeAuditLog(
    adminUser,
    "Updated Fleet",
    fleet.fleetProfile?.companyName || fleet.email,
    "Fleet Management"
  );

  const vehicles = await Vehicle.find({ fleet: fleet._id }).sort({ createdAt: -1 }).lean();
  return serializeFleetManagementItem(fleet.toObject(), vehicles);
};

export const deleteAdminFleetCompany = async (fleetId, adminUser) => {
  const fleet = await User.findOne({ _id: fleetId, role: ROLES.FLEET });
  if (!fleet) throw new AppError("Fleet company not found", 404);

  // Reuse the existing admin user deletion rules (no linked jobs/vehicles/members).
  return deleteAdminUser(fleet._id, adminUser);
};

export const createAdminFleetVehicle = async (fleetId, payload = {}, adminUser) => {
  const fleet = await User.findOne({ _id: fleetId, role: ROLES.FLEET }).lean();
  if (!fleet) throw new AppError("Fleet company not found", 404);

  const registration = normalizeRegistration(payload.registration);
  if (!registration) throw new AppError("registration is required", 400);

  const duplicate = await Vehicle.findOne({ fleet: fleetId, registration });
  if (duplicate) throw new AppError("Vehicle registration already exists", 409);

  const vehicle = await Vehicle.create({
    fleet: fleetId,
    registration,
    type: payload.type,
    make: payload.make,
    model: payload.model,
    year: payload.year,
    vin: payload.vin,
    currentMileageKm: payload.currentMileageKm,
    isActive: payload.isActive ?? true,
  });

  await writeAuditLog(
    adminUser,
    "Added Fleet Vehicle",
    `${fleet.fleetProfile?.companyName || fleet.email}:${registration}`,
    "Fleet Management"
  );

  return vehicle.toObject();
};

export const updateAdminFleetVehicle = async (
  fleetId,
  vehicleId,
  payload = {},
  adminUser
) => {
  const vehicle = await Vehicle.findOne({ _id: vehicleId, fleet: fleetId });
  if (!vehicle) throw new AppError("Vehicle not found", 404);

  if (payload.registration !== undefined) {
    const registration = normalizeRegistration(payload.registration);
    if (!registration) throw new AppError("registration cannot be empty", 400);
    const duplicate = await Vehicle.findOne({
      _id: { $ne: vehicle._id },
      fleet: fleetId,
      registration,
    });
    if (duplicate) throw new AppError("Vehicle registration already exists", 409);
    vehicle.registration = registration;
  }

  for (const field of ["type", "make", "model", "year", "vin", "currentMileageKm", "isActive"]) {
    if (payload[field] !== undefined) vehicle[field] = payload[field];
  }

  await vehicle.save();
  await writeAuditLog(
    adminUser,
    "Updated Fleet Vehicle",
    vehicle.registration,
    "Fleet Management"
  );

  return vehicle.toObject();
};

const getAwaitingPaymentNoAttemptQueue = async ({
  page,
  limit,
  search,
  fleetId,
}) => {
  const match = { status: JOB_STATUS.AWAITING_APPROVAL };
  if (fleetId && mongoose.Types.ObjectId.isValid(fleetId)) {
    match.fleet = new mongoose.Types.ObjectId(fleetId);
  }

  const pipeline = [
    { $match: match },
    {
      $lookup: {
        from: Invoice.collection.name,
        localField: "_id",
        foreignField: "job",
        as: "invoices",
      },
    },
    { $match: { "invoices.0": { $exists: false } } },
    {
      $lookup: {
        from: User.collection.name,
        localField: "fleet",
        foreignField: "_id",
        as: "fleetUser",
      },
    },
    { $unwind: { path: "$fleetUser", preserveNullAndEmptyArrays: true } },
    {
      $lookup: {
        from: User.collection.name,
        localField: "assignedMechanic",
        foreignField: "_id",
        as: "mechanicUser",
      },
    },
    { $unwind: { path: "$mechanicUser", preserveNullAndEmptyArrays: true } },
  ];

  if (search) {
    const regex = safeRegex(search);
    pipeline.push({
      $match: {
        $or: [
          { jobCode: regex },
          { title: regex },
          { "fleetUser.email": regex },
          { "fleetUser.fleetProfile.companyName": regex },
          { "mechanicUser.email": regex },
          { "mechanicUser.mechanicProfile.displayName": regex },
        ],
      },
    });
  }

  pipeline.push({
    $facet: {
      items: [
        { $sort: { paymentDueAt: 1, updatedAt: 1 } },
        { $skip: (page - 1) * limit },
        { $limit: limit },
      ],
      summary: [
        {
          $group: {
            _id: null,
            total: { $sum: 1 },
            amount: {
              $sum: {
                $ifNull: ["$finalAmount", { $ifNull: ["$acceptedAmount", 0] }],
              },
            },
            overdueCount: {
              $sum: {
                $cond: [{ $lt: ["$paymentDueAt", new Date()] }, 1, 0],
              },
            },
            overdueAmount: {
              $sum: {
                $cond: [
                  { $lt: ["$paymentDueAt", new Date()] },
                  {
                    $ifNull: [
                      "$finalAmount",
                      { $ifNull: ["$acceptedAmount", 0] },
                    ],
                  },
                  0,
                ],
              },
            },
          },
        },
      ],
    },
  });

  const [result] = await Job.aggregate(pipeline);
  const total = result?.summary?.[0]?.total || 0;
  const amount = result?.summary?.[0]?.amount || 0;
  const overdueCount = result?.summary?.[0]?.overdueCount || 0;
  const overdueAmount = result?.summary?.[0]?.overdueAmount || 0;
  const items = (result?.items || []).map((job) => ({
    _id: `job:${job._id}`,
    invoiceNo: null,
    jobId: job._id,
    company:
      job.fleetUser?.fleetProfile?.companyName || job.fleetUser?.email || null,
    service: job.title || job.jobCode || null,
    jobCode: job.jobCode || null,
    mechanic:
      job.mechanicUser?.mechanicProfile?.displayName ||
      job.mechanicUser?.email ||
      null,
    amount: Number(job.finalAmount ?? job.acceptedAmount ?? 0) || 0,
    subtotal: Number(job.finalAmount ?? job.acceptedAmount ?? 0) || 0,
    platformFee: 0,
    mechanicPayout: 0,
    currency: job.currency || "GBP",
    stripeRef: null,
    paymentMethod: null,
    status: "AWAITING_PAYMENT",
    paymentStatus: "NOT_STARTED",
    date: job.updatedAt,
    ageMinutes: Math.max(
      0,
      Math.floor(
        (Date.now() - new Date(job.updatedAt).getTime()) /
          60000
      )
    ),
    dueAt: job.paymentDueAt || null,
    collectionState: job.paymentCollectionState || "ACTION_REQUIRED",
    reminderCount: job.paymentReminderCount || 0,
    nextReminderAt: job.paymentNextReminderAt || null,
    agingBucket: paymentAgingBucket(job.paymentDueAt || job.updatedAt),
    recommendedAction: "PAYER_APPROVAL_REQUIRED",
  }));

  return { items, total, amount, overdueCount, overdueAmount };
};

export const getAdminFinancialOverview = async (query = {}) => {
  const page = parsePage(query.page);
  const exportAll =
    query.exportAll === true ||
    `${query.exportAll || ""}`.trim().toLowerCase() === "true";
  const limit = exportAll
    ? Math.min(Math.max(Math.floor(Number(query.limit) || 5000), 1), 5000)
    : parseLimit(query.limit);
  const skip = (page - 1) * limit;
  let statusFilter = `${query.status || ""}`.trim().toUpperCase();
  // UI aliases → invoice enum
  if (statusFilter === "PENDING") statusFilter = "ISSUED";
  const awaitingPaymentNoAttempt = statusFilter === "AWAITING_PAYMENT";
  const paymentStatusFilter = ["REQUIRES_ACTION", "PROCESSING"].includes(
    statusFilter
  )
    ? statusFilter
    : null;

  const search = `${query.search || ""}`.trim();
  const fleetId = `${query.fleetId || query.fleet || ""}`.trim();
  const invoiceFilter = {};

  if (paymentStatusFilter) {
    invoiceFilter["payment.status"] = paymentStatusFilter;
  } else if (statusFilter === "REFUNDED") {
    invoiceFilter.status = { $in: ["PARTIALLY_REFUNDED", "REFUNDED"] };
  } else if (statusFilter && !awaitingPaymentNoAttempt) {
    invoiceFilter.status = statusFilter;
  }

  if (fleetId) {
    invoiceFilter.fleet = fleetId;
  }

  if (search) {
    const searchRegex = safeRegex(search);
    const matchingFleetIds = await User.find({
      role: ROLES.FLEET,
      $or: [
        { email: searchRegex },
        { "fleetProfile.companyName": searchRegex },
      ],
    }).distinct("_id");
    const searchOr = [
      { invoiceNo: searchRegex },
      { "billedToSnapshot.companyName": searchRegex },
      ...(matchingFleetIds.length ? [{ fleet: { $in: matchingFleetIds } }] : []),
    ];
    if (invoiceFilter.fleet) {
      invoiceFilter.$and = [{ fleet: invoiceFilter.fleet }, { $or: searchOr }];
      delete invoiceFilter.fleet;
    } else {
      invoiceFilter.$or = searchOr;
    }
  }

  const awaitingQueue = await getAwaitingPaymentNoAttemptQueue({
    page: awaitingPaymentNoAttempt ? page : 1,
    limit: awaitingPaymentNoAttempt ? limit : 1,
    search,
    fleetId,
  });

  const [invoices, total, summaryAgg] = await Promise.all([
    awaitingPaymentNoAttempt
      ? Promise.resolve([])
      : Invoice.find(invoiceFilter)
      .sort({ issuedAt: -1, createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .populate("fleet", "email fleetProfile.companyName")
      .populate("job", "title jobCode")
      .populate("mechanic", "email mechanicProfile.displayName")
      .lean(),
    awaitingPaymentNoAttempt
      ? Promise.resolve(awaitingQueue.total)
      : Invoice.countDocuments(invoiceFilter),
    Invoice.aggregate([
      {
        $group: {
          _id: null,
          totalRevenue: {
            $sum: {
              $cond: [
                {
                  $in: [
                    "$status",
                    ["PAID", "PARTIALLY_REFUNDED", "REFUNDED"],
                  ],
                },
                {
                  $max: [
                    {
                      $subtract: [
                        "$totalAmount",
                        { $ifNull: ["$payment.refundedAmount", 0] },
                      ],
                    },
                    0,
                  ],
                },
                0,
              ],
            },
          },
          paidSubtotal: {
            $sum: {
              $cond: [
                {
                  $in: [
                    "$status",
                    ["PAID", "PARTIALLY_REFUNDED", "REFUNDED"],
                  ],
                },
                {
                  $multiply: [
                    "$subtotal",
                    {
                      $max: [
                        {
                          $subtract: [
                            1,
                            {
                              $divide: [
                                { $ifNull: ["$payment.refundedAmount", 0] },
                                { $max: ["$totalAmount", 0.01] },
                              ],
                            },
                          ],
                        },
                        0,
                      ],
                    },
                  ],
                },
                0,
              ],
            },
          },
          pendingPayments: {
            $sum: {
              $cond: [{ $eq: ["$status", "ISSUED"] }, "$totalAmount", 0],
            },
          },
          failedPayments: {
            $sum: {
              $cond: [{ $eq: ["$status", "FAILED"] }, "$totalAmount", 0],
            },
          },
          overdueAmount: {
            $sum: {
              $cond: [
                {
                  $and: [
                    { $in: ["$status", ["ISSUED", "FAILED"]] },
                    { $lt: ["$dueAt", new Date()] },
                  ],
                },
                "$totalAmount",
                0,
              ],
            },
          },
          overdueCount: {
            $sum: {
              $cond: [
                {
                  $and: [
                    { $in: ["$status", ["ISSUED", "FAILED"]] },
                    { $lt: ["$dueAt", new Date()] },
                  ],
                },
                1,
                0,
              ],
            },
          },
          totalInvoices: { $sum: 1 },
        },
      },
    ]),
  ]);

  const paidSubtotal = summaryAgg[0]?.paidSubtotal || 0;
  const platformCommission = companyEarningsPlatformFee(paidSubtotal);

  return {
    cards: {
      totalRevenue: summaryAgg[0]?.totalRevenue || 0,
      platformCommission,
      pendingPayments: summaryAgg[0]?.pendingPayments || 0,
      failedPayments: summaryAgg[0]?.failedPayments || 0,
      awaitingPaymentNoAttempt: awaitingQueue.amount,
      awaitingPaymentNoAttemptCount: awaitingQueue.total,
      overdueAmount:
        (summaryAgg[0]?.overdueAmount || 0) + awaitingQueue.overdueAmount,
      overdueCount:
        (summaryAgg[0]?.overdueCount || 0) + awaitingQueue.overdueCount,
      totalInvoices: summaryAgg[0]?.totalInvoices || 0,
      platformFeePercent: getPlatformFeePercent(),
    },
    items: awaitingPaymentNoAttempt
      ? awaitingQueue.items
      : invoices.map((invoice) => {
      const subtotal = Number(invoice.subtotal) || 0;
      const platformFee = companyEarningsPlatformFee(subtotal);
      const mechanicPayout = companyEarningsNet(subtotal);
      const mechanicName =
        invoice.mechanic?.mechanicProfile?.displayName ||
        invoice.mechanicSnapshot?.displayName ||
        invoice.mechanic?.email ||
        null;
      const displayStatus =
        invoice.status === "PAID"
          ? "PAID"
          : invoice.payment?.status === "REQUIRES_ACTION"
            ? "REQUIRES_ACTION"
            : invoice.payment?.status === "PROCESSING"
              ? "PROCESSING"
          : invoice.status === "ISSUED"
            ? "PENDING"
            : invoice.status;

      return {
        _id: invoice._id,
        invoiceNo: invoice.invoiceNo,
        company: invoice.fleet?.fleetProfile?.companyName || invoice.fleet?.email || null,
        service: invoice.job?.title || invoice.job?.jobCode || null,
        jobCode: invoice.job?.jobCode || null,
        mechanic: mechanicName,
        amount: invoice.totalAmount,
        subtotal,
        platformFee,
        mechanicPayout,
        currency: invoice.currency,
        stripeRef: invoice.payment?.stripePaymentIntentId || null,
        paymentMethod: invoice.payment?.provider || null,
        status: displayStatus,
        paymentStatus: invoice.payment?.status || null,
        date: invoice.paidAt || invoice.issuedAt,
        ageMinutes: Math.max(
          0,
          Math.floor(
            (Date.now() - new Date(invoice.paidAt || invoice.issuedAt).getTime()) /
              60000
          )
        ),
        dueAt: invoice.dueAt || null,
        collectionState: invoice.collections?.state || null,
        reminderCount: invoice.collections?.reminderCount || 0,
        nextReminderAt: invoice.collections?.nextReminderAt || null,
        agingBucket: paymentAgingBucket(invoice.dueAt || invoice.issuedAt),
        lastError: invoice.payment?.lastError || null,
        recommendedAction:
          invoice.payment?.status === "REQUIRES_ACTION"
            ? "PAYER_AUTHENTICATION_REQUIRED"
            : invoice.payment?.status === "PROCESSING"
              ? "SYNC_STATUS"
              : invoice.status === "FAILED"
                ? "PAYER_RETRY_REQUIRED"
                : null,
      };
    }),
    meta: {
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit) || 1,
    },
  };
};

export const getAdminFinancialPaymentDetail = async (invoiceId) => {
  if (!mongoose.Types.ObjectId.isValid(invoiceId)) {
    throw new AppError("Invalid invoice id", 400);
  }

  const invoice = await Invoice.findById(invoiceId)
    .populate("fleet", "email fleetProfile.companyName fleetProfile.contactName")
    .populate("mechanic", "email mechanicProfile.displayName")
    .populate("job", "jobCode title status completedAt updatedAt")
    .lean();
  if (!invoice) throw new AppError("Invoice not found", 404);

  const [attempts, refunds, paymentEvents, disputes] = await Promise.all([
    PaymentAttempt.find({ invoice: invoice._id })
      .sort({ createdAt: -1 })
      .populate("payer", "email role fleetProfile.companyName companyProfile.companyName")
      .lean(),
    Refund.find({ invoice: invoice._id })
      .sort({ createdAt: -1 })
      .populate("initiatedBy", "email role")
      .lean(),
    JobEvent.find({
      job: invoice.job?._id || invoice.job,
      type: { $in: ["PAYMENT_UPDATED", "PAYMENT_REFUNDED", "PAYMENT_DISPUTED"] },
    })
      .sort({ createdAt: -1 })
      .select("type note payload createdAt")
      .lean(),
    Dispute.find({ invoice: invoice._id })
      .sort({ createdAt: -1 })
      .select("caseNo caseType title status processorStatus financialState amountMinor currency createdAt")
      .lean(),
  ]);

  return {
    invoice: {
      _id: invoice._id,
      invoiceNo: invoice.invoiceNo,
      status: invoice.status,
      subtotal: invoice.subtotal,
      vatAmount: invoice.vatAmount,
      totalAmount: invoice.totalAmount,
      currency: invoice.currency,
      issuedAt: invoice.issuedAt,
      paidAt: invoice.paidAt || null,
      dueAt: invoice.dueAt || null,
      agingBucket: paymentAgingBucket(invoice.dueAt || invoice.issuedAt),
      collections: invoice.collections || null,
      payment: {
        provider: invoice.payment?.provider || null,
        status: invoice.payment?.status || "PENDING",
        stripePaymentIntentId: invoice.payment?.stripePaymentIntentId || null,
        stripeChargeId: invoice.payment?.stripeChargeId || null,
        stripeTransferId: invoice.payment?.stripeTransferId || null,
        transferStatus: invoice.payment?.transferStatus || null,
        transferFailureCode: invoice.payment?.transferFailureCode || null,
        transferFailureMessage: invoice.payment?.transferFailureMessage || null,
        transferUpdatedAt: invoice.payment?.transferUpdatedAt || null,
        lastError: invoice.payment?.lastError || null,
        authorizedAmount: invoice.payment?.authorizedAmount ?? null,
        capturedAmount: invoice.payment?.capturedAmount ?? null,
        refundedAmount: invoice.payment?.refundedAmount ?? 0,
        updatedAt: invoice.payment?.updatedAt || null,
      },
    },
    job: invoice.job
      ? {
          _id: invoice.job._id || invoice.job,
          jobCode: invoice.job.jobCode || null,
          title: invoice.job.title || null,
          status: invoice.job.status || null,
          updatedAt: invoice.job.updatedAt || null,
        }
      : null,
    fleet: invoice.fleet
      ? {
          _id: invoice.fleet._id || invoice.fleet,
          name:
            invoice.fleet.fleetProfile?.companyName || invoice.fleet.email || null,
          email: invoice.fleet.email || null,
        }
      : null,
    mechanic: invoice.mechanic
      ? {
          _id: invoice.mechanic._id || invoice.mechanic,
          name:
            invoice.mechanic.mechanicProfile?.displayName ||
            invoice.mechanic.email ||
            null,
          email: invoice.mechanic.email || null,
        }
      : null,
    attempts: attempts.map((attempt) => ({
      _id: attempt._id,
      paymentStatus: attempt.paymentStatus,
      processorStatus: attempt.processorStatus || null,
      amount: attempt.amount,
      currency: attempt.currency,
      stripePaymentIntentId: attempt.stripePaymentIntentId,
      declineCode: attempt.declineCode || null,
      failureMessage: attempt.failureMessage || null,
      payer: attempt.payer
        ? {
            _id: attempt.payer._id || attempt.payer,
            email: attempt.payer.email || null,
            role: attempt.payer.role || attempt.payerRole,
          }
        : null,
      createdAt: attempt.createdAt,
      completedAt: attempt.completedAt || null,
      events: [...(attempt.events || [])].reverse(),
    })),
    refunds: refunds.map((refund) => ({
      _id: refund._id,
      stripeRefundId: refund.stripeRefundId,
      amount: refund.amount,
      currency: refund.currency,
      reason: refund.reason,
      status: refund.status,
      source: refund.source,
      initiatedBy: refund.initiatedBy
        ? {
            email: refund.initiatedBy.email || null,
            role: refund.initiatedBy.role || null,
          }
        : null,
      processedAt: refund.processedAt || null,
      createdAt: refund.createdAt,
    })),
    paymentEvents,
    disputes: disputes.map((item) => ({
      _id: item._id,
      caseNo: item.caseNo,
      caseType: item.caseType,
      title: item.title,
      status: item.status,
      processorStatus: item.processorStatus,
      financialState: item.financialState,
      amount: Number(item.amountMinor || 0) / 100,
      currency: item.currency,
      createdAt: item.createdAt,
    })),
    actions: {
      canSync: Boolean(invoice.payment?.stripePaymentIntentId),
      canRetry: false,
      canRefund:
        Boolean(invoice.payment?.stripePaymentIntentId) &&
        ["PAID", "PARTIALLY_REFUNDED"].includes(invoice.status) &&
        Number(invoice.payment?.refundedAmount || 0) <
          Number(invoice.payment?.capturedAmount || invoice.totalAmount || 0),
      refundableAmount: Math.max(
        Number(invoice.payment?.capturedAmount || invoice.totalAmount || 0) -
          Number(invoice.payment?.refundedAmount || 0),
        0
      ),
      retryReason:
        invoice.status === "FAILED" ||
        invoice.payment?.status === "REQUIRES_PAYMENT_METHOD"
          ? "The payer must choose or add a card and retry from the job approval screen."
          : null,
    },
  };
};

export const syncAdminFinancialPayment = async (invoiceId) => {
  const invoice = await Invoice.findById(invoiceId);
  if (!invoice) throw new AppError("Invoice not found", 404);

  const paymentIntentId = invoice.payment?.stripePaymentIntentId;
  if (!paymentIntentId) {
    throw new AppError("This invoice has no Stripe payment to synchronize", 400);
  }

  const paymentIntent = await retrieveStripePaymentIntent(paymentIntentId);
  const result = await applyPaymentIntentToInvoice(paymentIntent, {
    source: "ADMIN",
    eventType: "ADMIN_PAYMENT_SYNC",
  });
  return {
    paymentIntentId,
    processorStatus: paymentIntent.status,
    invoiceStatus: result.invoiceStatus,
    paymentStatus: result.paymentStatus,
  };
};

export const refundAdminFinancialPayment = async (
  invoiceId,
  payload = {},
  adminUser
) => {
  const invoice = await Invoice.findById(invoiceId);
  if (!invoice) throw new AppError("Invoice not found", 404);
  if (!["PAID", "PARTIALLY_REFUNDED"].includes(invoice.status)) {
    throw new AppError("Only paid invoices can be refunded", 400);
  }

  const paymentIntentId = invoice.payment?.stripePaymentIntentId;
  if (!paymentIntentId) {
    throw new AppError("This invoice has no Stripe payment to refund", 400);
  }

  const reason = `${payload.reason || ""}`.trim();
  if (reason.length < 5) {
    throw new AppError("Provide a refund reason of at least 5 characters", 400);
  }

  const capturedAmount = Number(
    invoice.payment?.capturedAmount || invoice.totalAmount || 0
  );
  const refundedAmount = Number(invoice.payment?.refundedAmount || 0);
  const refundableAmount = Math.max(capturedAmount - refundedAmount, 0);
  const requestedAmount =
    payload.amount === undefined || payload.amount === null || payload.amount === ""
      ? refundableAmount
      : Number(payload.amount);

  if (
    !Number.isFinite(requestedAmount) ||
    requestedAmount <= 0 ||
    requestedAmount > refundableAmount + 0.001
  ) {
    throw new AppError(
      `Refund amount must be between 0.01 and ${refundableAmount.toFixed(2)}`,
      400
    );
  }

  const amount = Math.round(requestedAmount * 100) / 100;
  const idempotencyKey = `invoice:${invoice._id}:refund:${refundedAmount.toFixed(
    2
  )}:${amount.toFixed(2)}`;
  const stripeRefund = await createStripeRefund({
    paymentIntentId,
    amount,
    reason: "requested_by_customer",
    idempotencyKey,
    metadata: {
      invoiceId: invoice._id.toString(),
      jobId: invoice.job.toString(),
      adminId: adminUser._id.toString(),
      adminReason: reason,
    },
  });

  return applyStripeRefundToInvoice(stripeRefund, {
    source: "ADMIN",
    initiatedBy: adminUser._id,
    reason,
  });
};

const toIdString = (value) => {
  if (!value) return "";
  if (typeof value === "string") return value.trim();
  if (value._id) return `${value._id}`.trim();
  return `${value}`.trim();
};

export const createAdminFinancialInvoice = async (payload = {}, adminUser) => {
  if (!payload.fleetId || !payload.mechanicId) {
    throw new AppError("fleetId and mechanicId are required", 400);
  }

  const jobId = `${payload.jobId || ""}`.trim();
  if (!jobId) {
    throw new AppError("jobId is required — link the invoice to a service request", 400);
  }

  const job = await Job.findById(jobId)
    .populate("fleet", "email fleetProfile.companyName fleetProfile.vatNumber fleetProfile.billingAddress")
    .populate("assignedCompany", "email companyProfile")
    .populate(
      "assignedMechanic",
      "email mechanicProfile"
    )
    .lean();
  if (!job) {
    throw new AppError("Service request not found", 404);
  }

  const fleetId = toIdString(payload.fleetId);
  const mechanicId = toIdString(payload.mechanicId);
  const jobFleetId = toIdString(job.fleet);
  const jobMechanicId = toIdString(job.assignedMechanic);

  if (jobFleetId !== fleetId) {
    throw new AppError("Selected service request does not belong to the chosen fleet company", 400);
  }
  if (!jobMechanicId) {
    throw new AppError("Assign a mechanic to this service request before creating an invoice", 400);
  }
  if (jobMechanicId !== mechanicId) {
    throw new AppError("Selected service request is not assigned to the chosen technician", 400);
  }

  const existingInvoice = await Invoice.findOne({ job: job._id }).select("_id invoiceNo").lean();
  if (existingInvoice) {
    throw new AppError(
      `Invoice already exists for this service request: ${existingInvoice.invoiceNo}`,
      409
    );
  }

  const subtotal = Number(payload.subtotal ?? payload.totalAmount);
  if (!Number.isFinite(subtotal) || subtotal <= 0) {
    throw new AppError("subtotal or totalAmount must be greater than zero", 400);
  }

  const vat = calculateJobVat(job, subtotal);
  const optionalNumber = (value) =>
    value === undefined || value === null || `${value}`.trim() === ""
      ? Number.NaN
      : Number(value);
  const requestedVat = optionalNumber(payload.vatAmount);
  if (!vat.vatRegistered && Number.isFinite(requestedVat) && requestedVat !== 0) {
    throw new AppError("VAT cannot be charged because the assigned supplier is not VAT registered", 400);
  }
  if (
    vat.vatRegistered &&
    Number.isFinite(requestedVat) &&
    Math.abs(requestedVat - vat.vatAmount) > 0.01
  ) {
    throw new AppError("vatAmount does not match the supplier VAT rate", 400);
  }
  const vatAmount = vat.vatAmount;
  const expectedTotal = Math.round((subtotal + vatAmount) * 100) / 100;
  const requestedTotal = optionalNumber(payload.totalAmount);
  if (Number.isFinite(requestedTotal) && Math.abs(requestedTotal - expectedTotal) > 0.01) {
    throw new AppError("totalAmount must equal subtotal plus VAT", 400);
  }
  const totalAmount = Number.isFinite(requestedTotal) ? requestedTotal : expectedTotal;

  const invoice = await Invoice.create({
    invoiceNo: await generateAdminInvoiceNo(),
    job: job._id,
    fleet: fleetId,
    mechanic: mechanicId,
    subtotal,
    vatAmount,
    vatRate: vat.vatRate,
    vatApplied: vat.vatRegistered,
    totalAmount,
    currency: payload.currency || "GBP",
    status: `${payload.status || "ISSUED"}`.trim().toUpperCase(),
    issuedAt: payload.issuedAt ? new Date(payload.issuedAt) : new Date(),
    paidAt: payload.paidAt ? new Date(payload.paidAt) : undefined,
    payment: {
      provider: payload.provider || "MANUAL",
      status: `${payload.paymentStatus || "PENDING"}`.trim().toUpperCase(),
      updatedAt: new Date(),
    },
    lineItems:
      payload.lineItems?.length
        ? payload.lineItems
        : [
            {
              description: payload.description || "Admin created invoice",
              quantity: 1,
              unitAmount: subtotal,
              totalAmount: subtotal,
            },
          ],
    billedToSnapshot: {
      companyName:
        payload.companyName || job.fleet?.fleetProfile?.companyName || undefined,
      vatNumber: payload.vatNumber || job.fleet?.fleetProfile?.vatNumber || undefined,
      address: payload.billingAddress || job.fleet?.fleetProfile?.billingAddress || undefined,
    },
    mechanicSnapshot: {
      displayName:
        payload.mechanicName || job.assignedMechanic?.mechanicProfile?.displayName || undefined,
      businessName:
        payload.mechanicBusinessName ||
        job.assignedMechanic?.mechanicProfile?.businessName ||
        undefined,
      rating:
        payload.mechanicRating ||
        job.assignedMechanic?.mechanicProfile?.rating?.average ||
        undefined,
    },
    supplierSnapshot: {
      supplierType: vat.supplierType || undefined,
      supplierId: vat.supplierId || undefined,
      name: vat.supplierName || undefined,
      vatRegistered: vat.vatRegistered,
      vatNumber: vat.vatNumber || undefined,
    },
  });

  await writeAuditLog(
    adminUser,
    "Created Invoice",
    `${invoice.invoiceNo} (${invoice.totalAmount})`,
    "Financial"
  );

  return invoice.toObject();
};

export const exportAdminFinancialOverview = async (query = {}) => {
  const format = `${query.format || "CSV"}`.trim().toUpperCase();
  // Export all matching rows (capped), not just the current UI page
  const overview = await getAdminFinancialOverview({
    ...query,
    page: 1,
    limit: 5000,
    exportAll: true,
  });
  return {
    format,
    generatedAt: new Date(),
    filters: {
      status: query.status || null,
      search: query.search || null,
    },
    cards: overview.cards,
    count: overview.items.length,
    items: overview.items,
    downloadUrl: null,
  };
};

export const getAdminLiveTracking = async () => {
  const mechanics = await User.find({ role: ROLES.MECHANIC, status: USER_STATUS.ACTIVE })
    .sort({ createdAt: -1 })
    .lean();

  const mechanicIds = mechanics.map((mechanic) => mechanic._id);
  const [activeJobs, latestPings] = await Promise.all([
    Job.find({
      assignedMechanic: { $in: mechanicIds },
      status: {
        $in: [
          JOB_STATUS.ASSIGNED,
          JOB_STATUS.EN_ROUTE,
          JOB_STATUS.ON_SITE,
          JOB_STATUS.IN_PROGRESS,
          JOB_STATUS.AWAITING_APPROVAL,
        ],
      },
    })
      .sort({ updatedAt: -1, createdAt: -1, _id: -1 })
      .populate("fleet", "fleetProfile.companyName")
      .lean(),
    JobLocationPing.aggregate([
      { $sort: { pingedAt: -1 } },
      {
        $group: {
          _id: "$mechanic",
          point: { $first: "$point" },
          pingedAt: { $first: "$pingedAt" },
          job: { $first: "$job" },
        },
      },
    ]),
  ]);

  const latestPingMap = new Map(
    latestPings.map((entry) => [entry._id.toString(), entry])
  );
  const activeJobMap = new Map(
    activeJobs.map((job) => [job.assignedMechanic.toString(), job])
  );

  const readPoint = (src) => {
    const coords = src?.coordinates || src?.point?.coordinates;
    if (!Array.isArray(coords) || coords.length !== 2) return null;
    const [lng, lat] = coords.map(Number);
    if (!Number.isFinite(lng) || !Number.isFinite(lat)) return null;
    return { lat, lng };
  };

  const items = mechanics.map((mechanic) => {
    const job = activeJobMap.get(mechanic._id.toString()) || null;
    const ping = latestPingMap.get(mechanic._id.toString()) || null;
    const fromTracking = readPoint(job?.tracking?.latestMechanicLocation?.point);
    const fromPing = readPoint(ping?.point);
    const fromProfile = readPoint(mechanic.mechanicProfile?.lastKnownLocation);
    const jobSite = readPoint(job?.location);

    const state =
      job?.status === JOB_STATUS.EN_ROUTE
        ? "EN_ROUTE"
        : job
        ? "ON_JOB"
        : mechanic.mechanicProfile?.availability === "ONLINE"
        ? "AVAILABLE"
        : "OFFLINE";

    const mechanicPos = fromTracking || fromPing || fromProfile || null;

    return {
      _id: mechanic._id,
      displayName: mechanic.mechanicProfile?.displayName || mechanic.email,
      businessName: mechanic.mechanicProfile?.businessName || null,
      baseLocationText: mechanic.mechanicProfile?.baseLocationText || null,
      state,
      currentJob: job
        ? {
            _id: job._id,
            jobCode: job.jobCode,
            title: job.title,
            status: job.status,
            fleetCompanyName: job.fleet?.fleetProfile?.companyName || null,
            etaMinutes: job.tracking?.etaMinutes ?? null,
            address: job.location?.address || null,
            site: jobSite,
            vehicle: job.vehicle
              ? {
                  registration: job.vehicle.registration || null,
                  type: job.vehicle.type || null,
                }
              : null,
          }
        : null,
      latestLocation: mechanicPos
        ? {
            lat: mechanicPos.lat,
            lng: mechanicPos.lng,
            point: { type: "Point", coordinates: [mechanicPos.lng, mechanicPos.lat] },
            pingedAt: ping?.pingedAt || job?.tracking?.latestMechanicLocation?.updatedAt || null,
          }
        : null,
    };
  });

  // Also expose open/posted jobs (no mechanic yet) for admin overview pins
  const openJobs = await Job.find({
    status: { $in: [JOB_STATUS.POSTED, JOB_STATUS.QUOTING] },
  })
    .sort({ postedAt: -1, createdAt: -1, _id: -1 })
    .limit(40)
    .populate("fleet", "fleetProfile.companyName")
    .lean();

  const openJobPins = openJobs
    .map((job) => {
      const site = readPoint(job.location);
      if (!site) return null;
      return {
        _id: job._id,
        jobCode: job.jobCode,
        title: job.title,
        status: job.status,
        fleetCompanyName: job.fleet?.fleetProfile?.companyName || null,
        address: job.location?.address || null,
        site,
        vehicle: job.vehicle
          ? { registration: job.vehicle.registration || null, type: job.vehicle.type || null }
          : null,
      };
    })
    .filter(Boolean);

  return {
    cards: {
      activeMechanics: items.filter((item) => item.state !== "OFFLINE").length,
      onJob: items.filter((item) => item.state === "ON_JOB").length,
      enRoute: items.filter((item) => item.state === "EN_ROUTE").length,
      available: items.filter((item) => item.state === "AVAILABLE").length,
      openJobs: openJobPins.length,
    },
    items,
    openJobs: openJobPins,
  };
};

export const listAdminSupportTickets = async (query = {}) => {
  const { reconcileMisfiledSupportTickets, reconcileSupportTicketIfNeeded } =
    await import("../supportTicket/supportTicket.service.js");
  await reconcileMisfiledSupportTickets();

  const page = parsePage(query.page);
  const limit = parseLimit(query.limit);
  const skip = (page - 1) * limit;
  const filter = {};

  if (query.status) {
    filter.status = `${query.status}`.trim().toUpperCase();
  }

  const search = `${query.search || ""}`.trim();
  if (search) {
    const searchRegex = safeRegex(search);
    const matchingUserIds = await User.find({
      $or: [
        { email: searchRegex },
        { "fleetProfile.companyName": searchRegex },
        { "mechanicProfile.displayName": searchRegex },
        { "companyProfile.companyName": searchRegex },
      ],
    }).distinct("_id");
    const searchOr = [
      { subject: searchRegex },
      { message: searchRegex },
      { ticketRef: searchRegex },
      ...(matchingUserIds.length ? [{ user: { $in: matchingUserIds } }] : []),
    ];
    if (filter.status) {
      filter.$and = [{ status: filter.status }, { $or: searchOr }];
      delete filter.status;
    } else {
      filter.$or = searchOr;
    }
  }

  const [tickets, total, statusAgg] = await Promise.all([
    SupportTicket.find(filter)
      .sort({ updatedAt: -1, createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .populate("user", SUPPORT_USER_POPULATE)
      .populate("assignedTo", "email")
      .populate(
        "replies.sender",
        "email role fleetProfile.companyName companyProfile.companyName mechanicProfile.displayName adminProfile.displayName"
      )
      .lean(),
    SupportTicket.countDocuments(filter),
    SupportTicket.aggregate([
      {
        $group: {
          _id: "$status",
          count: { $sum: 1 },
        },
      },
    ]),
  ]);

  const items = await Promise.all(
    tickets.map((ticket) => reconcileSupportTicketIfNeeded(ticket))
  );

  const statusCounts = Object.fromEntries(
    statusAgg.map((row) => [row._id, row.count])
  );

  const stats = {
    open: statusCounts.OPEN || 0,
    inProgress: statusCounts.IN_PROGRESS || 0,
    resolved: statusCounts.RESOLVED || 0,
  };

  return {
    items: items.map(serializeSupportTicketForAdmin),
    meta: {
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit) || 1,
    },
    stats,
  };
};

export const getAdminSupportTicketById = async (ticketId) => {
  const { reconcileSupportTicketIfNeeded } = await import(
    "../supportTicket/supportTicket.service.js"
  );
  let ticket = await SupportTicket.findById(ticketId)
    .populate("user", SUPPORT_USER_POPULATE)
    .populate("assignedTo", "email")
    .populate(
      "replies.sender",
      "email role fleetProfile.companyName companyProfile.companyName mechanicProfile.displayName adminProfile.displayName"
    )
    .lean();
  if (!ticket) throw new AppError("Support ticket not found", 404);
  ticket = await reconcileSupportTicketIfNeeded(ticket);
  return serializeSupportTicketForAdmin(ticket);
};

export const updateAdminSupportTicket = async (ticketId, payload = {}, adminUser) => {
  if (!adminUser) throw new AppError("Admin user required", 401);
  const { updateSupportTicket } = await import("../supportTicket/supportTicket.service.js");
  return updateSupportTicket(adminUser, ticketId, payload);
};

export const listAdminDisputes = async (adminUser, query = {}) => {
  const result = await listDisputesForUser(adminUser, query);
  const now = new Date();
  const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
  const [
    unassigned,
    mine,
    slaRisk,
    awaitingEvidence,
    decisionPending,
    stripeDeadline,
    resolved30d,
    amountRows,
  ] = await Promise.all([
    Dispute.countDocuments({ status: { $nin: ["RESOLVED", "CLOSED"] }, assignedTo: { $exists: false } }),
    Dispute.countDocuments({ status: { $nin: ["RESOLVED", "CLOSED"] }, assignedTo: adminUser._id }),
    Dispute.countDocuments({
      status: { $nin: ["RESOLVED", "CLOSED"] },
      decisionDueAt: { $lte: new Date(now.getTime() + 24 * 60 * 60 * 1000) },
    }),
    Dispute.countDocuments({
      status: { $in: ["AWAITING_CUSTOMER_EVIDENCE", "AWAITING_PROVIDER_EVIDENCE"] },
    }),
    Dispute.countDocuments({ status: "DECISION_PENDING" }),
    Dispute.countDocuments({
      caseType: "STRIPE_CHARGEBACK",
      status: { $nin: ["RESOLVED", "CLOSED"] },
      stripeEvidenceDueAt: { $ne: null },
    }),
    Dispute.countDocuments({ status: { $in: ["RESOLVED", "CLOSED"] }, resolvedAt: { $gte: thirtyDaysAgo } }),
    Dispute.aggregate([
      { $match: { status: { $nin: ["RESOLVED", "CLOSED"] } } },
      { $group: { _id: null, amountMinor: { $sum: "$amountMinor" } } },
    ]),
  ]);
  return {
    ...result,
    stats: {
      unassigned,
      mine,
      slaRisk,
      awaitingEvidence,
      decisionPending,
      stripeDeadline,
      resolved30d,
      amountAtRisk: Number(amountRows[0]?.amountMinor || 0) / 100,
    },
  };
};

export const getAdminDispute = (adminUser, disputeId) =>
  getDisputeDetail(adminUser, disputeId);

export const createAdminDispute = async (adminUser, payload = {}) => {
  if (!payload.claimantId) {
    throw new AppError("claimantId is required when an admin opens a participant case", 400);
  }
  const claimant = await User.findById(payload.claimantId);
  if (!claimant) throw new AppError("Claimant not found", 404);
  return createParticipantDispute(claimant, payload);
};

export const updateAdminDispute = async (adminUser, disputeId, payload = {}) => {
  if (payload.assignedTo !== undefined || payload.assignedTeam) {
    return assignCanonicalDispute(adminUser, disputeId, payload);
  }
  if (payload.status) {
    return transitionCanonicalDispute(adminUser, disputeId, {
      ...payload,
      reason: payload.reason || payload.notes || "Admin case update",
    });
  }
  const dispute = await Dispute.findById(disputeId);
  if (!dispute) throw new AppError("Dispute not found", 404);
  if (payload.priority) dispute.priority = parsePriority(payload.priority);
  if (payload.notes) {
    await DisputeMessage.create({
      dispute: dispute._id,
      sender: adminUser._id,
      senderRole: adminUser.role,
      visibility: "INTERNAL",
      body: payload.notes,
      readBy: [adminUser._id],
    });
  }
  dispute.versionNumber += 1;
  await dispute.save();
  return serializeCanonicalDispute(dispute);
};

export const listAdminNotifications = async () => {
  const notifications = await Notification.find({})
    .sort({ createdAt: -1 })
    .limit(50)
    .populate("user", "email")
    .lean();

  return {
    items: notifications.map((item) => ({
      _id: item._id,
      type: item.type,
      title: item.title,
      body: item.body,
      isRead: item.isRead,
      user: item.user?.email || null,
      createdAt: item.createdAt,
    })),
    stats: {
      total: notifications.length,
      unread: notifications.filter((item) => !item.isRead).length,
      urgent: notifications.filter((item) => item.type?.toUpperCase().includes("ALERT")).length,
      today: notifications.filter(
        (item) => new Date(item.createdAt).toDateString() === new Date().toDateString()
      ).length,
    },
  };
};

export const markAdminNotificationRead = async (notificationId, adminUser) => {
  const notification = await Notification.findById(notificationId);
  if (!notification) throw new AppError("Notification not found", 404);

  notification.isRead = true;
  notification.readAt = notification.readAt || new Date();
  await notification.save();

  await writeAuditLog(
    adminUser,
    "Marked Notification Read",
    notification.title || notification._id.toString(),
    "Notifications"
  );

  return {
    _id: notification._id,
    isRead: notification.isRead,
    readAt: notification.readAt,
  };
};

export const markAllAdminNotificationsRead = async (adminUser) => {
  const unreadNotifications = await Notification.find({ isRead: false }).select("_id title");
  if (!unreadNotifications.length) {
    return { updatedCount: 0 };
  }

  const ids = unreadNotifications.map((item) => item._id);
  await Notification.updateMany(
    { _id: { $in: ids } },
    { $set: { isRead: true, readAt: new Date() } }
  );

  await writeAuditLog(
    adminUser,
    "Marked All Notifications Read",
    `${ids.length} notifications`,
    "Notifications"
  );

  return { updatedCount: ids.length };
};

export const removeAdminNotification = async (notificationId, adminUser) => {
  const notification = await Notification.findById(notificationId);
  if (!notification) throw new AppError("Notification not found", 404);

  await Notification.deleteOne({ _id: notification._id });
  await writeAuditLog(
    adminUser,
    "Deleted Notification",
    notification.title || notification._id.toString(),
    "Notifications"
  );

  return { _id: notification._id, deleted: true };
};

export const listAdminServiceCatalog = async (query = {}) => {
  const filter = {};
  if (query.category) {
    filter.category = safeRegex(query.category);
  }
  if (query.search) {
    filter.name = safeRegex(query.search);
  }

  const [items, statsAgg] = await Promise.all([
    ServiceCatalog.find(filter).sort({ createdAt: -1 }).lean(),
    ServiceCatalog.aggregate([
      {
        $group: {
          _id: null,
          totalServices: { $sum: 1 },
          avgBasePrice: { $avg: "$basePrice" },
          totalBookings: { $sum: "$bookingsCount" },
          categories: { $addToSet: "$category" },
        },
      },
    ]),
  ]);

  return {
    items,
    stats: {
      totalServices: statsAgg[0]?.totalServices || 0,
      avgBasePrice: Math.round((statsAgg[0]?.avgBasePrice || 0) * 100) / 100,
      totalBookings: statsAgg[0]?.totalBookings || 0,
      categories: statsAgg[0]?.categories?.length || 0,
    },
  };
};

export const createAdminServiceCatalogItem = async (payload = {}) => {
  if (!payload.name || !payload.category) {
    throw new AppError("name and category are required", 400);
  }
  return ServiceCatalog.create({
    name: payload.name,
    category: payload.category,
    description: payload.description,
    basePrice: payload.basePrice,
    currency: payload.currency || "GBP",
    durationLabel: payload.durationLabel,
    isActive: payload.isActive ?? true,
    bookingsCount: payload.bookingsCount ?? 0,
  });
};

export const updateAdminServiceCatalogItem = async (serviceId, payload = {}) => {
  const item = await ServiceCatalog.findById(serviceId);
  if (!item) throw new AppError("Service catalog item not found", 404);

  const fields = [
    "name",
    "category",
    "description",
    "basePrice",
    "currency",
    "durationLabel",
    "isActive",
    "bookingsCount",
  ];
  for (const field of fields) {
    if (payload[field] !== undefined) item[field] = payload[field];
  }
  await item.save();
  return item;
};

export const listAdminPromotions = async (query = {}) => {
  const filter = {};
  if (query.status) filter.status = parseStatus(query.status);
  if (query.search) filter.code = safeRegex(query.search);

  const [items, statsAgg] = await Promise.all([
    Promotion.find(filter).sort({ createdAt: -1 }).lean(),
    Promotion.aggregate([
      {
        $group: {
          _id: null,
          activePromotions: {
            $sum: { $cond: [{ $eq: ["$status", "ACTIVE"] }, 1, 0] },
          },
          totalUsage: { $sum: "$usageCount" },
          avgDiscount: { $avg: "$discountValue" },
        },
      },
    ]),
  ]);

  return {
    items,
    stats: {
      activePromotions: statsAgg[0]?.activePromotions || 0,
      totalUsage: statsAgg[0]?.totalUsage || 0,
      avgDiscount: Math.round((statsAgg[0]?.avgDiscount || 0) * 100) / 100,
    },
  };
};

export const createAdminPromotion = async (payload = {}) => {
  if (!payload.code || payload.discountValue === undefined) {
    throw new AppError("code and discountValue are required", 400);
  }
  return Promotion.create({
    code: payload.code,
    discountType: payload.discountType || "PERCENTAGE",
    discountValue: payload.discountValue,
    minAmount: payload.minAmount ?? 0,
    currency: payload.currency || "GBP",
    usageCount: payload.usageCount ?? 0,
    usageLimit: payload.usageLimit ?? 100,
    status: payload.status || "ACTIVE",
    expiresAt: payload.expiresAt,
  });
};

export const updateAdminPromotion = async (promotionId, payload = {}) => {
  const item = await Promotion.findById(promotionId);
  if (!item) throw new AppError("Promotion not found", 404);
  const fields = [
    "code",
    "discountType",
    "discountValue",
    "minAmount",
    "currency",
    "usageCount",
    "usageLimit",
    "status",
    "expiresAt",
  ];
  for (const field of fields) {
    if (payload[field] !== undefined) item[field] = payload[field];
  }
  await item.save();
  return item;
};

export const deleteAdminPromotion = async (promotionId) => {
  const item = await Promotion.findById(promotionId);
  if (!item) throw new AppError("Promotion not found", 404);
  await item.deleteOne();
  return { _id: item._id, deleted: true };
};

export const listAdminReviews = async (query = {}) => {
  const filter = {};
  if (query.status) filter.status = parseStatus(query.status);
  if (query.rating) filter.rating = Number(query.rating);
  if (query.search) {
    const searchRegex = safeRegex(query.search);
    filter.$or = [
      { customerName: searchRegex },
      { companyName: searchRegex },
      { serviceLabel: searchRegex },
      { mechanicName: searchRegex },
      { comment: searchRegex },
    ];
  }

  const [items, statsAgg] = await Promise.all([
    Review.find(filter).sort({ createdAt: -1 }).lean(),
    Review.aggregate([
      {
        $group: {
          _id: null,
          averageRating: { $avg: "$rating" },
          fiveStarReviews: {
            $sum: { $cond: [{ $eq: ["$rating", 5] }, 1, 0] },
          },
          fourStarReviews: {
            $sum: { $cond: [{ $eq: ["$rating", 4] }, 1, 0] },
          },
          flaggedReviews: {
            $sum: { $cond: [{ $eq: ["$status", "FLAGGED"] }, 1, 0] },
          },
          total: { $sum: 1 },
        },
      },
    ]),
  ]);

  return {
    items,
    stats: {
      averageRating: Math.round((statsAgg[0]?.averageRating || 0) * 10) / 10,
      fiveStarReviews: statsAgg[0]?.fiveStarReviews || 0,
      fourStarReviews: statsAgg[0]?.fourStarReviews || 0,
      flaggedReviews: statsAgg[0]?.flaggedReviews || 0,
      total: statsAgg[0]?.total || 0,
    },
  };
};

export const updateAdminReview = async (reviewId, payload = {}) => {
  const review = await Review.findById(reviewId);
  if (!review) throw new AppError("Review not found", 404);
  if (payload.status) review.status = parseStatus(payload.status);
  if (payload.comment !== undefined) review.comment = payload.comment;
  await review.save();
  return review;
};

export const getAdminReviewById = async (reviewId) => {
  const review = await Review.findById(reviewId).lean();
  if (!review) throw new AppError("Review not found", 404);
  return review;
};

export const deleteAdminReview = async (reviewId) => {
  const review = await Review.findById(reviewId);
  if (!review) throw new AppError("Review not found", 404);
  await review.deleteOne();
  return { _id: review._id, deleted: true };
};

export const listAdminAuditLogs = async (query = {}) => {
  const page = parsePage(query.page);
  const limit = parseLimit(query.limit);
  const skip = (page - 1) * limit;
  const filter = {};
  if (query.category) filter.category = safeRegex(query.category);
  if (query.search) {
    const searchRegex = safeRegex(query.search);
    filter.$or = [
      { userLabel: searchRegex },
      { action: searchRegex },
      { target: searchRegex },
      { category: searchRegex },
      { ipAddress: searchRegex },
    ];
  }

  const [items, total, todayCount, weekCount, distinctAdmins] = await Promise.all([
    AuditLog.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
    AuditLog.countDocuments(filter),
    AuditLog.countDocuments({
      ...filter,
      createdAt: {
        $gte: new Date(new Date().setHours(0, 0, 0, 0)),
      },
    }),
    AuditLog.countDocuments({
      ...filter,
      createdAt: { $gte: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) },
    }),
    AuditLog.distinct("userLabel", filter),
  ]);

  return {
    items,
    stats: {
      totalActions: total,
      today: todayCount,
      thisWeek: weekCount,
      activeAdmins: distinctAdmins.length,
    },
    meta: {
      page,
      limit,
      total,
      totalPages: Math.max(1, Math.ceil(total / limit)),
    },
  };
};

const REPORT_PERIOD_MONTHS = { "1M": 1, "3M": 3, "6M": 6, "1Y": 12 };

const parseReportPeriod = (value) => {
  const key = `${value || "6M"}`.trim().toUpperCase();
  return REPORT_PERIOD_MONTHS[key] ? key : "6M";
};

/** Last comma-separated address segment ≈ city/postcode area; empty → Unknown. */
const jobAreaExpr = {
  $let: {
    vars: {
      raw: {
        $trim: {
          input: {
            $arrayElemAt: [
              { $split: [{ $ifNull: ["$location.address", ""] }, ","] },
              -1,
            ],
          },
        },
      },
    },
    in: {
      $cond: [
        { $or: [{ $eq: ["$$raw", ""] }, { $eq: ["$$raw", null] }] },
        "Unknown",
        "$$raw",
      ],
    },
  },
};

export const getAdminReports = async (query = {}) => {
  const reportType = `${query.type || "REVENUE"}`.trim().toUpperCase();
  const period = parseReportPeriod(query.period);
  const monthCount = REPORT_PERIOD_MONTHS[period];
  const now = new Date();

  const months = Array.from({ length: monthCount }, (_, index) => {
    const date = new Date(now.getFullYear(), now.getMonth() - (monthCount - 1 - index), 1);
    return {
      year: date.getFullYear(),
      month: date.getMonth() + 1,
      label: formatMonthLabel(date),
    };
  });

  const rangeStart = new Date(now.getFullYear(), now.getMonth() - (monthCount - 1), 1);
  const prevStart = new Date(now.getFullYear(), now.getMonth() - (2 * monthCount - 1), 1);

  const paidMatch = (from, to) => ({
    status: { $in: ["PAID", "PARTIALLY_REFUNDED", "REFUNDED"] },
    paidAt: { $gte: from, $lte: to },
  });

  const [
    revenueCurrentAgg,
    revenuePreviousAgg,
    commissionCurrentAgg,
    commissionPreviousAgg,
    jobsCurrent,
    jobsPrevious,
    avgCurrentAgg,
    avgPreviousAgg,
    monthlyRevenueAgg,
    monthlyCommissionAgg,
    monthlyJobsAgg,
    jobsByAreaAgg,
    breakdownAgg,
    topCompaniesAgg,
    mechanicEarnAgg,
    activeCompanies,
  ] = await Promise.all([
    Invoice.aggregate([
      { $match: paidMatch(rangeStart, now) },
      { $group: { _id: null, total: { $sum: netCapturedInvoiceAmountExpression } } },
    ]),
    Invoice.aggregate([
      { $match: paidMatch(prevStart, new Date(rangeStart.getTime() - 1)) },
      { $group: { _id: null, total: { $sum: netCapturedInvoiceAmountExpression } } },
    ]),
    EarningTransaction.aggregate([
      { $match: { paidAt: { $gte: rangeStart, $lte: now } } },
      { $group: { _id: null, total: { $sum: "$platformFee" } } },
    ]),
    EarningTransaction.aggregate([
      { $match: { paidAt: { $gte: prevStart, $lt: rangeStart } } },
      { $group: { _id: null, total: { $sum: "$platformFee" } } },
    ]),
    Job.countDocuments({ createdAt: { $gte: rangeStart, $lte: now } }),
    Job.countDocuments({ createdAt: { $gte: prevStart, $lt: rangeStart } }),
    Invoice.aggregate([
      { $match: paidMatch(rangeStart, now) },
      { $group: { _id: null, avg: { $avg: netCapturedInvoiceAmountExpression } } },
    ]),
    Invoice.aggregate([
      { $match: paidMatch(prevStart, new Date(rangeStart.getTime() - 1)) },
      { $group: { _id: null, avg: { $avg: netCapturedInvoiceAmountExpression } } },
    ]),
    Invoice.aggregate([
      { $match: paidMatch(rangeStart, now) },
      {
        $group: {
          _id: { year: { $year: "$paidAt" }, month: { $month: "$paidAt" } },
          revenue: { $sum: netCapturedInvoiceAmountExpression },
        },
      },
    ]),
    EarningTransaction.aggregate([
      { $match: { paidAt: { $gte: rangeStart, $lte: now } } },
      {
        $group: {
          _id: { year: { $year: "$paidAt" }, month: { $month: "$paidAt" } },
          commission: { $sum: "$platformFee" },
        },
      },
    ]),
    Job.aggregate([
      { $match: { createdAt: { $gte: rangeStart, $lte: now } } },
      {
        $group: {
          _id: { year: { $year: "$createdAt" }, month: { $month: "$createdAt" } },
          services: { $sum: 1 },
        },
      },
    ]),
    Job.aggregate([
      { $match: { createdAt: { $gte: rangeStart, $lte: now } } },
      { $addFields: { area: jobAreaExpr } },
      { $group: { _id: "$area", jobs: { $sum: 1 } } },
      { $sort: { jobs: -1 } },
      { $limit: 8 },
    ]),
    Job.aggregate([
      { $match: { createdAt: { $gte: rangeStart, $lte: now } } },
      {
        $group: {
          _id: {
            $ifNull: ["$issueSubtype", { $ifNull: ["$issueType", "Other"] }],
          },
          count: { $sum: 1 },
        },
      },
      { $sort: { count: -1 } },
      { $limit: 6 },
    ]),
    Invoice.aggregate([
      { $match: paidMatch(rangeStart, now) },
      {
        $group: {
          _id: "$fleet",
          revenue: { $sum: netCapturedInvoiceAmountExpression },
          count: { $sum: 1 },
        },
      },
      { $sort: { revenue: -1 } },
      { $limit: 5 },
    ]),
    EarningTransaction.aggregate([
      { $match: { paidAt: { $gte: rangeStart, $lte: now } } },
      {
        $group: {
          _id: "$mechanic",
          revenue: { $sum: "$netAmount" },
          jobs: { $addToSet: "$job" },
        },
      },
      {
        $project: {
          revenue: 1,
          services: { $size: "$jobs" },
        },
      },
      { $sort: { revenue: -1 } },
      { $limit: 5 },
    ]),
    User.countDocuments({ role: ROLES.FLEET, status: USER_STATUS.ACTIVE }),
  ]);

  const totalRevenue = revenueCurrentAgg[0]?.total || 0;
  const totalCommission = commissionCurrentAgg[0]?.total || 0;
  const avgServiceValue =
    Math.round((avgCurrentAgg[0]?.avg || 0) * 100) / 100;
  const prevAvg =
    Math.round((avgPreviousAgg[0]?.avg || 0) * 100) / 100;

  const revenueMap = new Map(
    monthlyRevenueAgg.map((e) => [`${e._id.year}-${e._id.month}`, e.revenue])
  );
  const commissionMap = new Map(
    monthlyCommissionAgg.map((e) => [
      `${e._id.year}-${e._id.month}`,
      e.commission,
    ])
  );
  const jobsMap = new Map(
    monthlyJobsAgg.map((e) => [`${e._id.year}-${e._id.month}`, e.services])
  );

  const monthlyRevenueTrend = months.map((m) => {
    const key = `${m.year}-${m.month}`;
    return {
      month: m.label,
      revenue: revenueMap.get(key) || 0,
      commission: commissionMap.get(key) || 0,
      services: jobsMap.get(key) || 0,
    };
  });

  const breakdownTotal = breakdownAgg.reduce((s, i) => s + (i.count || 0), 0) || 0;
  const breakdownTypes = breakdownAgg.map((item) => {
    const count = item.count || 0;
    const percent =
      breakdownTotal > 0
        ? Math.round((count / breakdownTotal) * 1000) / 10
        : 0;
    return {
      name: item._id || "Other",
      count,
      percent,
    };
  });

  const topCompanyIds = topCompaniesAgg.map((item) => item._id).filter(Boolean);
  const [topCompanyUsers, vehicleCountsAgg] = await Promise.all([
    topCompanyIds.length
      ? User.find({ _id: { $in: topCompanyIds } })
          .select("fleetProfile.companyName email")
          .lean()
      : Promise.resolve([]),
    topCompanyIds.length
      ? Vehicle.aggregate([
          { $match: { fleet: { $in: topCompanyIds }, isActive: true } },
          { $group: { _id: "$fleet", count: { $sum: 1 } } },
        ])
      : Promise.resolve([]),
  ]);
  const topCompanyMap = new Map(
    topCompanyUsers.map((item) => [item._id.toString(), item])
  );
  const vehicleCountMap = new Map(
    vehicleCountsAgg.map((entry) => [entry._id.toString(), entry.count])
  );

  const mechanicIds = mechanicEarnAgg.map((item) => item._id).filter(Boolean);
  const mechanicUsers = mechanicIds.length
    ? await User.find({ _id: { $in: mechanicIds } })
        .select("email mechanicProfile.displayName mechanicProfile.rating")
        .lean()
    : [];
  const mechanicMap = new Map(
    mechanicUsers.map((item) => [item._id.toString(), item])
  );

  return {
    reportType,
    period,
    platformFeePercent: getPlatformFeePercent(),
    summary: {
      totalRevenue,
      totalCommission,
      totalServices: jobsCurrent,
      activeCompanies,
      avgServiceValue,
      trends: {
        revenue: trendPayload(totalRevenue, revenuePreviousAgg[0]?.total || 0),
        commission: trendPayload(
          totalCommission,
          commissionPreviousAgg[0]?.total || 0
        ),
        services: trendPayload(jobsCurrent, jobsPrevious),
        avgServiceValue: trendPayload(avgServiceValue, prevAvg),
      },
    },
    monthlyRevenueTrend,
    jobsByArea: jobsByAreaAgg.map((item) => ({
      area: item._id || "Unknown",
      jobs: item.jobs || 0,
    })),
    breakdownTypes,
    // Alias for older CSV / callers expecting topServices shape
    topServices: breakdownTypes.map((item) => ({
      name: item.name,
      count: item.count,
      percent: item.percent,
    })),
    topCompanies: topCompaniesAgg.map((item) => {
      const id = item._id?.toString?.() || "";
      const user = topCompanyMap.get(id);
      return {
        companyName:
          user?.fleetProfile?.companyName || user?.email || "Unknown Company",
        services: item.count,
        revenue: item.revenue,
        vehicles: vehicleCountMap.get(id) || 0,
      };
    }),
    mechanicPerformance: mechanicEarnAgg.map((item) => {
      const id = item._id?.toString?.() || "";
      const user = mechanicMap.get(id);
      return {
        mechanicName:
          user?.mechanicProfile?.displayName || user?.email || "Unknown",
        services: item.services || 0,
        rating: user?.mechanicProfile?.rating?.average || 0,
        revenue: item.revenue || 0,
      };
    }),
    exportFormat: `${query.format || "PDF"}`.trim().toUpperCase(),
  };
};

export const exportAdminReports = async (query = {}) => {
  const report = await getAdminReports(query);
  return {
    generatedAt: new Date(),
    format: `${query.format || report.exportFormat || "PDF"}`.trim().toUpperCase(),
    report,
    downloadUrl: null,
  };
};

export const getAdminSettings = async (adminUser) => {
  const freshAdmin = await User.findById(adminUser._id).lean();
  if (!freshAdmin) throw new AppError("Admin not found", 404);

  const platform = await serializePlatformCommercial();

  return {
    profile: {
      _id: freshAdmin._id,
      email: freshAdmin.email,
      fullName:
        freshAdmin.adminProfile?.fullName ||
        freshAdmin.email.split("@")[0],
      phoneNumber: freshAdmin.adminProfile?.phoneNumber || null,
      role: freshAdmin.role,
      profilePhotoUrl: freshAdmin.adminProfile?.profilePhotoUrl || null,
    },
    preferences: {
      timeZone: freshAdmin.adminSettings?.timeZone || "GMT",
      language: freshAdmin.adminSettings?.language || "English",
      notificationsEnabled:
        freshAdmin.adminSettings?.notificationsEnabled ?? true,
      securityAlertsEnabled:
        freshAdmin.adminSettings?.securityAlertsEnabled ?? true,
      notificationPreferences: normalizeAdminNotificationPreferences(
        freshAdmin.adminSettings?.notificationPreferences,
        {
          securityAlertsEnabled:
            freshAdmin.adminSettings?.securityAlertsEnabled ?? true,
        }
      ),
      regionalFormat: freshAdmin.adminSettings?.regionalFormat || "en-GB",
      billingEmail: freshAdmin.adminSettings?.billingEmail || freshAdmin.email,
      privacyMode: freshAdmin.adminSettings?.privacyMode || "STANDARD",
    },
    platform: {
      platformFeePercent: platform.platformFeePercent,
      standardVatRate: platform.standardVatRate,
      standardVatPercent: platform.standardVatPercent,
      enforceProviderQuoteReadiness:
        platform.enforceProviderQuoteReadiness === true,
      /** Payment-policy knobs — not yet enforced by workers. */
      autoReleaseHours: null,
      requireFleetApproval: true,
      disputeHoldEnabled: false,
      paymentPolicyStatus: "COMING_SOON",
    },
    security: {
      twoFactorAvailable: false,
      twoFactorRequired: false,
      accessTokenTtl: env.JWT_EXPIRES_IN || "7d",
      refreshTokenTtl: env.JWT_REFRESH_EXPIRES_IN || "30d",
      idleTimeoutHours: null,
      auditLogging: "admin_mutations",
      auditLoggingNote:
        "Every successful state-changing admin API request is recorded; read-only views are not audited.",
      ipAllowlistEnabled: false,
      gdprExportAvailable: true,
      gdprErasureAvailable: true,
      dataRetentionPolicyAvailable: true,
    },
  };
};

export const updateAdminSettings = async (adminUser, payload = {}) => {
  const admin = await User.findById(adminUser._id);
  if (!admin) throw new AppError("Admin not found", 404);

  admin.adminProfile = {
    ...(admin.adminProfile || {}),
    ...(payload.profile || {}),
  };

  if (payload.profile?.fullName !== undefined) {
    admin.adminProfile.fullName = `${payload.profile.fullName || ""}`.trim() || undefined;
  }
  if (payload.profile?.phoneNumber !== undefined) {
    admin.adminProfile.phoneNumber =
      `${payload.profile.phoneNumber || ""}`.trim() || undefined;
  }
  if (payload.profile?.profilePhotoUrl !== undefined) {
    admin.adminProfile.profilePhotoUrl =
      `${payload.profile.profilePhotoUrl || ""}`.trim() || undefined;
  }

  admin.adminSettings = {
    ...(admin.adminSettings || {}),
    ...(payload.preferences || {}),
  };

  if (payload.preferences?.timeZone !== undefined) {
    admin.adminSettings.timeZone =
      `${payload.preferences.timeZone || ""}`.trim() || "GMT";
  }
  if (payload.preferences?.language !== undefined) {
    admin.adminSettings.language =
      `${payload.preferences.language || ""}`.trim() || "English";
  }
  if (payload.preferences?.regionalFormat !== undefined) {
    admin.adminSettings.regionalFormat =
      `${payload.preferences.regionalFormat || ""}`.trim() || "en-GB";
  }
  if (payload.preferences?.billingEmail !== undefined) {
    admin.adminSettings.billingEmail =
      `${payload.preferences.billingEmail || ""}`.trim().toLowerCase() || undefined;
  }
  if (payload.preferences?.privacyMode !== undefined) {
    admin.adminSettings.privacyMode =
      `${payload.preferences.privacyMode || ""}`.trim().toUpperCase() || "STANDARD";
  }
  if (payload.preferences?.notificationsEnabled !== undefined) {
    admin.adminSettings.notificationsEnabled = Boolean(
      payload.preferences.notificationsEnabled
    );
  }
  if (payload.preferences?.securityAlertsEnabled !== undefined) {
    admin.adminSettings.securityAlertsEnabled = Boolean(
      payload.preferences.securityAlertsEnabled
    );
  }
  if (payload.preferences?.notificationPreferences !== undefined) {
    const normalized = normalizeAdminNotificationPreferences(
      payload.preferences.notificationPreferences,
      {
        securityAlertsEnabled:
          admin.adminSettings.securityAlertsEnabled ?? true,
      }
    );
    admin.adminSettings.notificationPreferences = normalized;
    admin.adminSettings.securityAlertsEnabled =
      normalized[ADMIN_NOTIFICATION_EVENTS.SYSTEM_HEALTH].push;
  } else if (payload.preferences?.securityAlertsEnabled !== undefined) {
    const normalized = normalizeAdminNotificationPreferences(
      admin.adminSettings.notificationPreferences,
      {
        securityAlertsEnabled: admin.adminSettings.securityAlertsEnabled,
      }
    );
    normalized[ADMIN_NOTIFICATION_EVENTS.SYSTEM_HEALTH].push =
      admin.adminSettings.securityAlertsEnabled;
    admin.adminSettings.notificationPreferences = normalized;
  }

  if (payload.platform) {
    const feeIn =
      payload.platform.platformFeePercent ?? payload.platform.commissionRate;
    const vatIn =
      payload.platform.standardVatRate ??
      payload.platform.vatRate ??
      (payload.platform.standardVatPercent != null
        ? Number(payload.platform.standardVatPercent) / 100
        : undefined);

    if (feeIn !== undefined) {
      const n = Number(feeIn);
      if (!Number.isFinite(n) || n < 0 || n > 100) {
        throw new AppError("platformFeePercent must be between 0 and 100", 400);
      }
    }
    if (vatIn !== undefined) {
      const n = Number(vatIn);
      const fraction = n > 1 ? n / 100 : n;
      if (!Number.isFinite(fraction) || fraction < 0 || fraction > 1) {
        throw new AppError("standardVatRate must be between 0 and 1 (or 0–100 as percent)", 400);
      }
    }

    const enforceIn = payload.platform.enforceProviderQuoteReadiness;
    if (enforceIn !== undefined && typeof enforceIn !== "boolean") {
      throw new AppError("enforceProviderQuoteReadiness must be a boolean", 400);
    }

    await updatePlatformCommercialSettings(
      {
        ...(feeIn !== undefined ? { platformFeePercent: feeIn } : {}),
        ...(vatIn !== undefined ? { standardVatRate: vatIn } : {}),
        ...(enforceIn !== undefined
          ? { enforceProviderQuoteReadiness: enforceIn }
          : {}),
      },
      adminUser
    );
  }

  await admin.save();
  await writeAuditLog(
    adminUser,
    "Updated Admin Settings",
    admin.email,
    "Settings"
  );

  return getAdminSettings(admin);
};

export const approveMechanic = async (userId, payload = {}) => {
  const mechanic = await findMechanicById(userId);

  mechanic.status = USER_STATUS.ACTIVE;
  mechanic.mechanicProfile = {
    ...(mechanic.mechanicProfile || {}),
    verification: {
      ...(mechanic.mechanicProfile?.verification || {}),
      status: MECHANIC_VERIFICATION_STATUS.APPROVED,
      reviewedAt: new Date(),
      reviewNotes: `${payload.notes || ""}`.trim() || undefined,
    },
  };

  await mechanic.save();
  return serializeMechanicReviewItem(mechanic);
};

export const rejectMechanic = async (userId, payload = {}) => {
  const mechanic = await findMechanicById(userId);
  const reason = `${payload.reason || payload.notes || ""}`.trim();
  if (!reason) throw new AppError("reason is required", 400);

  mechanic.status = USER_STATUS.PENDING_REVIEW;
  mechanic.mechanicProfile = {
    ...(mechanic.mechanicProfile || {}),
    verification: {
      ...(mechanic.mechanicProfile?.verification || {}),
      status: MECHANIC_VERIFICATION_STATUS.REJECTED,
      reviewedAt: new Date(),
      reviewNotes: reason,
    },
  };

  await mechanic.save();
  return serializeMechanicReviewItem(mechanic);
};

export const updateUserStatus = async (userId, payload = {}) => {
  const nextStatus = `${payload.status || ""}`.trim().toUpperCase();
  if (!userStatusValues.includes(nextStatus)) {
    throw new AppError(
      `status must be one of ${userStatusValues.join(", ")}`,
      400
    );
  }

  const user = await User.findById(userId);
  if (!user) throw new AppError("User not found", 404);

  user.status = nextStatus;

  if (user.role === ROLES.MECHANIC && nextStatus === USER_STATUS.ACTIVE) {
    user.mechanicProfile = {
      ...(user.mechanicProfile || {}),
      verification: {
        ...(user.mechanicProfile?.verification || {}),
        status:
          user.mechanicProfile?.verification?.status ===
          MECHANIC_VERIFICATION_STATUS.APPROVED
            ? MECHANIC_VERIFICATION_STATUS.APPROVED
            : MECHANIC_VERIFICATION_STATUS.UNDER_REVIEW,
        reviewedAt: new Date(),
        reviewNotes:
          `${payload.notes || ""}`.trim() ||
          user.mechanicProfile?.verification?.reviewNotes,
      },
    };
  }

  await user.save();

  return {
    _id: user._id,
    email: user.email,
    role: user.role,
    status: user.status,
    updatedAt: user.updatedAt,
  };
};
