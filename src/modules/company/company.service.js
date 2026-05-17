import crypto from "crypto";
import mongoose from "mongoose";
import AppError from "../../utils/AppError.js";
import { ROLES, JOB_STATUS, MECHANIC_AVAILABILITY, QUOTE_STATUS } from "../../constants/domain.js";
import { Job } from "../job/job.model.js";
import { Invoice } from "../invoice/invoice.model.js";
import { User } from "../user/user.model.js";
import { JobEvent } from "../jobEvent/jobEvent.model.js";
import { CompanyInvite } from "./companyInvite.model.js";
import {
  getJobByIdForUser,
  listJobs,
  countCompanyFeedJobs,
  countCompanyFeedJobsPostedSince,
} from "../job/job.service.js";
import { companyEarningsBreakdown } from "../../utils/companyEarningsMath.js";
import { readMechanicProfileRatingAverage, resolveMechanicRatingForInvoiceContext } from "../../utils/mechanicRating.js";
import { listOwnerQuotesPaginated, countOwnerQuotesByStatus } from "../quote/quote.service.js";
import { env } from "../../config/env.js";

const ACTIVE_JOB_STATUSES = [
  JOB_STATUS.ASSIGNED,
  JOB_STATUS.EN_ROUTE,
  JOB_STATUS.ON_SITE,
  JOB_STATUS.IN_PROGRESS,
  JOB_STATUS.AWAITING_APPROVAL,
];

/** Jobs booked to the company but no mechanic yet (schema often stores `null`, not missing key). */
const noAssignedMechanicClause = () => ({
  $or: [{ assignedMechanic: { $exists: false } }, { assignedMechanic: null }],
});

const jobHasAssignedMechanic = (job) => {
  const m = job?.assignedMechanic;
  if (m == null) return false;
  if (typeof m === "object" && m._id) return true;
  if (typeof m === "string" && `${m}`.trim()) return true;
  return false;
};

const ensureCompanyUser = (user) => {
  if (!user?._id || user.role !== ROLES.COMPANY) {
    throw new AppError("Only company users can access this resource", 403);
  }
};

const monthRange = (date = new Date()) => {
  const start = new Date(date.getFullYear(), date.getMonth(), 1);
  const end = new Date(date.getFullYear(), date.getMonth() + 1, 1);
  return { start, end };
};

const monthRangePrev = (date = new Date()) => {
  const start = new Date(date.getFullYear(), date.getMonth() - 1, 1);
  const end = new Date(date.getFullYear(), date.getMonth(), 1);
  return { start, end };
};

/** Same idea as fleet/mechanic job cards — relative label for dashboard activity rows. */
const formatActivityRelative = (value) => {
  if (!value) return null;
  const ms = Date.now() - new Date(value).getTime();
  if (!Number.isFinite(ms)) return null;
  const minutes = Math.max(Math.round(ms / 60000), 0);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hr${hours === 1 ? "" : "s"} ago`;
  const days = Math.floor(hours / 24);
  return `${days} day${days === 1 ? "" : "s"} ago`;
};

const companyJobStatusUi = (status, job, listTab = null) => {
  const tab = listTab != null ? `${listTab}`.toLowerCase() : null;
  const hasMechanic = jobHasAssignedMechanic(job);
  const activeNeedingDispatch = [
    JOB_STATUS.ASSIGNED,
    JOB_STATUS.EN_ROUTE,
    JOB_STATUS.ON_SITE,
    JOB_STATUS.IN_PROGRESS,
  ].includes(status);

  if (!hasMechanic && activeNeedingDispatch) {
    return { key: "UNASSIGNED", label: "UNASSIGNED", tone: "orange" };
  }

  if (tab === "assigned" && hasMechanic && status === JOB_STATUS.EN_ROUTE) {
    return { key: "ASSIGNED", label: "ASSIGNED", tone: "blue" };
  }

  switch (status) {
    case JOB_STATUS.AWAITING_APPROVAL:
      return { key: "PENDING_REVIEW", label: "PENDING REVIEW", tone: "yellow" };
    case JOB_STATUS.ASSIGNED:
      return job?.scheduledFor
        ? { key: "SCHEDULED", label: "SCHEDULED", tone: "blue" }
        : { key: "ASSIGNED", label: "ASSIGNED", tone: "blue" };
    case JOB_STATUS.EN_ROUTE:
      return { key: "EN_ROUTE", label: "EN ROUTE", tone: "amber" };
    case JOB_STATUS.ON_SITE:
      return { key: "ON_SITE", label: "ON SITE", tone: "green" };
    case JOB_STATUS.IN_PROGRESS:
      return { key: "IN_PROGRESS", label: "IN PROGRESS", tone: "amber" };
    case JOB_STATUS.COMPLETED:
      return { key: "COMPLETED", label: "COMPLETED", tone: "green" };
    case JOB_STATUS.CANCELLED:
      return { key: "CANCELLED", label: "CANCELLED", tone: "red" };
    default:
      return { key: "UNKNOWN", label: status || "UNKNOWN", tone: "neutral" };
  }
};

const normalizeCompanyStatusUiInput = (raw) => {
  if (raw == null) return "";
  let s = `${raw}`.trim();
  if (!s) return "";
  s = s.replace(/_/g, " ");
  s = s.replace(/\s+/g, " ").trim().toUpperCase();
  return s;
};

/**
 * Optional GET /company/jobs filters: `statusUiLabel`, `statusUiKey` (snake_case aliases supported).
 * Maps UI labels to Mongo filters — e.g. `statusUiLabel=PENDING%20REVIEW` ≡ `tab=pending_review`.
 */
const parseCompanyJobsStatusUiQuery = (query) => {
  const keyRaw = query.statusUiKey ?? query.status_ui_key;
  const labelRaw =
    query.statusUiLabel ?? query.status_ui_label ?? query.statusLabel ?? query.status_label;

  const keyFromParam =
    keyRaw != null
      ? `${keyRaw}`.trim().toUpperCase().replace(/-/g, "_").replace(/\s+/g, "_")
      : "";
  const labelNorm = labelRaw != null ? normalizeCompanyStatusUiInput(labelRaw) : "";

  const labelToKey = {
    "PENDING REVIEW": "PENDING_REVIEW",
    PENDINGREVIEW: "PENDING_REVIEW",
    UNASSIGNED: "UNASSIGNED",
    COMPLETED: "COMPLETED",
    "EN ROUTE": "EN_ROUTE",
    ENROUTE: "EN_ROUTE",
    "ON SITE": "ON_SITE",
    ONSITE: "ON_SITE",
    "IN PROGRESS": "IN_PROGRESS",
    INPROGRESS: "IN_PROGRESS",
    ASSIGNED: "ASSIGNED",
    SCHEDULED: "SCHEDULED",
    CANCELLED: "CANCELLED",
  };

  let canonical = "";
  if (keyFromParam) canonical = keyFromParam;
  if (!canonical && labelNorm) canonical = labelToKey[labelNorm] || "";

  if (!canonical) return null;

  const ui = (key, label) => ({ statusUiKey: key, statusUiLabel: label });

  switch (canonical) {
    case "UNASSIGNED":
      return {
        filter: {
          ...noAssignedMechanicClause(),
          status: {
            $in: [
              JOB_STATUS.ASSIGNED,
              JOB_STATUS.EN_ROUTE,
              JOB_STATUS.ON_SITE,
              JOB_STATUS.IN_PROGRESS,
            ],
          },
        },
        metaTab: "unassigned",
        ...ui("UNASSIGNED", "UNASSIGNED"),
      };
    case "PENDING_REVIEW":
      return {
        filter: { status: JOB_STATUS.AWAITING_APPROVAL },
        metaTab: "pending_review",
        ...ui("PENDING_REVIEW", "PENDING REVIEW"),
      };
    case "COMPLETED":
      return {
        filter: { status: JOB_STATUS.COMPLETED },
        metaTab: "completed",
        ...ui("COMPLETED", "COMPLETED"),
      };
    case "EN_ROUTE":
      return {
        filter: { status: JOB_STATUS.EN_ROUTE },
        metaTab: "all",
        ...ui("EN_ROUTE", "EN ROUTE"),
      };
    case "ON_SITE":
      return {
        filter: { status: JOB_STATUS.ON_SITE },
        metaTab: "all",
        ...ui("ON_SITE", "ON SITE"),
      };
    case "IN_PROGRESS":
      return {
        filter: { status: JOB_STATUS.IN_PROGRESS },
        metaTab: "all",
        ...ui("IN_PROGRESS", "IN PROGRESS"),
      };
    case "ASSIGNED":
      return {
        filter: {
          status: JOB_STATUS.ASSIGNED,
          $or: [{ scheduledFor: null }, { scheduledFor: { $exists: false } }],
        },
        metaTab: "all",
        ...ui("ASSIGNED", "ASSIGNED"),
      };
    case "SCHEDULED":
      return {
        filter: {
          status: JOB_STATUS.ASSIGNED,
          scheduledFor: { $ne: null, $exists: true },
        },
        metaTab: "all",
        ...ui("SCHEDULED", "SCHEDULED"),
      };
    case "CANCELLED":
      return {
        filter: { status: JOB_STATUS.CANCELLED },
        metaTab: "all",
        ...ui("CANCELLED", "CANCELLED"),
      };
    default:
      return null;
  }
};

const vehicleHeadlineFromJob = (job) => {
  const v = job?.vehicle;
  if (!v) return null;
  const parts = [v.make, v.model].filter(Boolean);
  return parts.length ? parts.join(" ").trim() : null;
};

const mechanicWorkStatusLine = (job) => {
  if (!job?.assignedMechanic) return null;
  if ([JOB_STATUS.AWAITING_APPROVAL, JOB_STATUS.COMPLETED].includes(job.status)) {
    return "Completed job";
  }
  if (job.status === JOB_STATUS.EN_ROUTE) return "En route";
  if (job.status === JOB_STATUS.ASSIGNED) return "Assigned";
  if (job.status === JOB_STATUS.ON_SITE) return "On site";
  if (job.status === JOB_STATUS.IN_PROGRESS) return "In progress";
  return null;
};

const timelineClockLabel = (job) => {
  if (job.completedAt) {
    const rel = formatActivityRelative(job.completedAt);
    return rel ? `Completed ${rel}` : null;
  }
  if (job.assignedAt) {
    const rel = formatActivityRelative(job.assignedAt);
    return rel ? `Assigned ${rel}` : null;
  }
  const rel = formatActivityRelative(job.postedAt || job.createdAt);
  return rel || null;
};

const primaryActionForCompanyJob = (job) => {
  if (job.status === JOB_STATUS.AWAITING_APPROVAL) {
    return {
      key: "REVIEW_APPROVE_INVOICE",
      label: "Review & Approve Invoice",
      icon: "EYE",
      method: "PATCH",
      path: `/api/v1/company/jobs/${job._id.toString()}/complete/approve`,
    };
  }
  if (
    !jobHasAssignedMechanic(job) &&
    [JOB_STATUS.ASSIGNED, JOB_STATUS.EN_ROUTE, JOB_STATUS.ON_SITE, JOB_STATUS.IN_PROGRESS].includes(job.status)
  ) {
    return { key: "ASSIGN_MECHANIC", label: "Assign Mechanic", icon: "USER_PLUS" };
  }
  if (jobHasAssignedMechanic(job) && [JOB_STATUS.ASSIGNED, JOB_STATUS.EN_ROUTE].includes(job.status)) {
    return { key: "REASSIGN_MECHANIC", label: "Reassign", icon: "SWAP" };
  }
  return null;
};

const urgencyUi = (urgency) => {
  const map = {
    CRITICAL: { label: "URGENT", tone: "red" },
    HIGH: { label: "HIGH", tone: "orange" },
    MEDIUM: { label: "MEDIUM", tone: "blue" },
    LOW: { label: "LOW", tone: "neutral" },
  };
  return map[urgency] || { label: urgency || "—", tone: "neutral" };
};

const buildLatestInvoiceByJobMap = async (jobIds) => {
  if (!jobIds.length) return {};
  const invoices = await Invoice.find({ job: { $in: jobIds } })
    .sort({ createdAt: -1 })
    .select("job invoiceNo status totalAmount currency paidAt createdAt mechanicSnapshot mechanic")
    .lean();
  const map = {};
  for (const inv of invoices) {
    const k = inv.job?.toString?.();
    if (k && !map[k]) map[k] = inv;
  }
  return map;
};

const serializeCompanyJobListItem = (job, invoiceByJobId = {}, extras = {}) => {
  const inv = invoiceByJobId[job._id.toString()] || null;
  const total = Number(job.finalAmount ?? job.acceptedAmount ?? inv?.totalAmount ?? 0) || null;
  const currency = job.currency || inv?.currency || "GBP";
  const refMap = extras.mechanicDisplayRefById;
  const mechanicKey = job.assignedMechanic?._id
    ? `${job.assignedMechanic._id}`
    : job.assignedMechanic
      ? `${job.assignedMechanic}`
      : "";
  const employeeDisplayRef =
    refMap instanceof Map && mechanicKey ? refMap.get(mechanicKey) || null : null;

  return {
    _id: job._id,
    jobCode: job.jobCode,
    title: job.title,
    issueType: job.issueType ?? null,
    /** Short headline for the breakdown (same as fleet “issue” line in many UIs). */
    issueTitle: job.title || null,
    jobDescription: job.description || null,
    completionSummary: job.completionSummary || null,
    description: job.completionSummary || job.description,
    status: job.status,
    needsMechanicAssignment:
      !jobHasAssignedMechanic(job) &&
      [JOB_STATUS.ASSIGNED, JOB_STATUS.EN_ROUTE, JOB_STATUS.ON_SITE, JOB_STATUS.IN_PROGRESS].includes(
        job.status
      ),
    statusUi: companyJobStatusUi(job.status, job, extras.companyJobsListTab ?? null),
    urgency: job.urgency,
    urgencyUi: urgencyUi(job.urgency),
    vehicle: job.vehicle || null,
    vehicleHeadline: vehicleHeadlineFromJob(job),
    location: job.location || null,
    locationLabel: job.location?.address || null,
    assignedAt: job.assignedAt || null,
    completedAt: job.completedAt || null,
    updatedAt: job.updatedAt || null,
    timelineLabel: timelineClockLabel(job),
    completedAgoLabel:
      job.completedAt && formatActivityRelative(job.completedAt)
        ? `Completed ${formatActivityRelative(job.completedAt)}`
        : null,
    postedAgoLabel: formatActivityRelative(job.postedAt || job.createdAt),
    fleet: job.fleet
      ? {
          _id: job.fleet._id || job.fleet,
          companyName: job.fleet.fleetProfile?.companyName || null,
        }
      : null,
    assignedMechanic: job.assignedMechanic
      ? {
          _id: job.assignedMechanic._id || job.assignedMechanic,
          id: employeeDisplayRef,
          employeeDisplayRef,
          displayName: job.assignedMechanic.mechanicProfile?.displayName || null,
          rating: resolveMechanicRatingForInvoiceContext(inv, job.assignedMechanic),
          phone: job.assignedMechanic.mechanicProfile?.phone || null,
          profilePhotoUrl: job.assignedMechanic.mechanicProfile?.profilePhotoUrl || null,
          workStatusLine: mechanicWorkStatusLine(job),
        }
      : null,
    acceptedAmount: job.acceptedAmount ?? null,
    finalAmount: job.finalAmount ?? null,
    currency,
    invoice: {
      label: "Total invoice",
      totalAmount: total,
      currency,
      invoiceNo: inv?.invoiceNo || null,
      invoiceId: inv?._id || null,
      status: inv?.status || null,
      paidAt: inv?.paidAt || null,
    },
    primaryAction: primaryActionForCompanyJob(job),
  };
};

const activityIconForType = (type) => {
  switch (type) {
    case "JOB_COMPLETED":
      return "CHECK";
    case "MECHANIC_ASSIGNED":
    case "MECHANIC_REASSIGNED":
    case "COMPANY_JOB_BOOKED":
      return "BRIEFCASE";
    case "MECHANIC_EN_ROUTE":
      return "VAN";
    case "MECHANIC_ON_SITE":
      return "LOCATION";
    case "MECHANIC_ONLINE":
    case "SHIFT_STARTED":
      return "PERSON";
    default:
      return "INFO";
  }
};

const actorDisplayName = (actor) =>
  actor?.mechanicProfile?.displayName ||
  actor?.companyProfile?.contactName ||
  (actor?.email ? String(actor.email).split("@")[0] : null);

/** Rows for company dashboard “Recent activity” (title / detail / icon). */
const buildCompanyDashboardActivity = (event) => {
  const ui = event.payload?.ui;
  if (ui?.title) {
    return {
      title: ui.title,
      detail: ui.detail ?? event.note ?? "",
      icon: ui.icon ?? activityIconForType(event.type),
    };
  }

  const jobCode = event.job?.jobCode || event.payload?.jobCode || null;
  const name = actorDisplayName(event.actor);

  let title = "Update";
  let detail = event.note || "";

  switch (event.type) {
    case "JOB_COMPLETED":
      title = "Job completed";
      detail = jobCode && name ? `${jobCode} by ${name}` : detail || (jobCode ? `${jobCode} completed` : detail);
      break;
    case "MECHANIC_ASSIGNED":
    case "MECHANIC_REASSIGNED":
      title = event.type === "MECHANIC_REASSIGNED" ? "Mechanic reassigned" : "New job assigned";
      detail = jobCode && name ? `${jobCode} to ${name}` : detail;
      break;
    case "MECHANIC_EN_ROUTE":
      title = "Mechanic en route";
      detail = jobCode && name ? `${name} for ${jobCode}` : detail;
      break;
    case "MECHANIC_ON_SITE":
      title = "Mechanic on site";
      detail = jobCode && name ? `${name} at ${jobCode}` : detail;
      break;
    case "COMPANY_JOB_BOOKED":
      title = "Job booked";
      detail = jobCode ? `${jobCode} needs a mechanic` : detail;
      break;
    case "SHIFT_STARTED":
    case "MECHANIC_ONLINE":
      title = "Mechanic online";
      detail = name ? `${name} started shift` : detail;
      break;
    default:
      title = `${event.type || "EVENT"}`
        .split("_")
        .filter(Boolean)
        .map((w) => w.charAt(0) + w.slice(1).toLowerCase())
        .join(" ");
  }

  return {
    title,
    detail,
    icon: activityIconForType(event.type),
  };
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

const buildMechanicEmployeeSignupUrl = (invite) => {
  const base = env.APP_PUBLIC_URL;
  if (!base || !invite?.token || !invite?.email) return null;
  const q = new URLSearchParams({
    role: ROLES.MECHANIC_EMPLOYEE,
    email: `${invite.email}`,
    inviteToken: `${invite.token}`,
  });
  return `${base}/register?${q.toString()}`;
};

/**
 * @param {object} invite — CompanyInvite doc or lean object (needs `token` when includeSecrets)
 * @param {{ includeSecrets?: boolean }} [options] — only POST /team/invitations should use includeSecrets (token + signupUrl)
 */
const serializeInvite = (invite, options = {}) => {
  const { includeSecrets = false } = options;
  const out = {
    _id: invite._id,
    email: invite.email,
    status: invite.status,
    expiresAt: invite.expiresAt,
    acceptedAt: invite.acceptedAt || null,
    cancelledAt: invite.cancelledAt || null,
    createdAt: invite.createdAt,
  };
  if (includeSecrets && invite.token) {
    out.inviteToken = invite.token;
    const signupUrl = buildMechanicEmployeeSignupUrl(invite);
    if (signupUrl) out.signupUrl = signupUrl;
  }
  return out;
};

/** Human-readable specialty line items for company Team / profile UIs. */
const TEAM_SKILL_LABELS = {
  TYRES: "Tyre service",
  BATTERY: "Battery & jump-start",
  ENGINE: "Engine Repair",
  BRAKES: "Brake Systems",
  ELECTRICAL: "Electrical",
  OTHER: "General repair",
  AIR_SYSTEMS: "Air Systems",
  TRANSMISSION: "Transmission",
};

const teamSkillLabel = (code) => TEAM_SKILL_LABELS[code] || `${code || ""}`.replace(/_/g, " ").trim() || "Other";

const formatJoinedMonthYear = (value) => {
  if (!value) return null;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleString("en-GB", { month: "short", year: "numeric" });
};

/**
 * Stable card ids (M-001 …): explicit `companyMembership.employeeDisplayRef` wins,
 * then gap-filled codes by tenure (`joinedAt` / `createdAt`).
 */
const resolveEmployeeDisplayRefs = (members) => {
  const map = new Map();
  const used = new Set();
  if (!Array.isArray(members) || !members.length) return map;

  for (const m of members) {
    const ex = `${m.companyMembership?.employeeDisplayRef || ""}`.trim().slice(0, 16);
    if (ex) {
      map.set(`${m._id}`, ex);
      used.add(ex);
    }
  }

  const remaining = members.filter((m) => !map.has(`${m._id}`));
  remaining.sort((a, b) => {
    const ta = new Date(a.companyMembership?.joinedAt || a.createdAt || 0).getTime();
    const tb = new Date(b.companyMembership?.joinedAt || b.createdAt || 0).getTime();
    return ta - tb;
  });

  let seq = 1;
  for (const m of remaining) {
    let ref;
    do {
      ref = `M-${String(seq).padStart(3, "0")}`;
      seq += 1;
    } while (used.has(ref));
    map.set(`${m._id}`, ref);
    used.add(ref);
  }

  return map;
};

const loadTeamMemberDisplayRefMap = async (companyUser) => {
  const teamMembers = await User.find({
    role: ROLES.MECHANIC_EMPLOYEE,
    "companyMembership.company": companyUser._id,
    "companyMembership.status": "ACTIVE",
  })
    .select("_id companyMembership.joinedAt companyMembership.createdAt companyMembership.employeeDisplayRef createdAt")
    .lean();
  return resolveEmployeeDisplayRefs(teamMembers);
};

const serializeTeamMember = (member, stats = {}, extras = {}) => {
  const activeJobs = stats.activeJobs || 0;
  const av = member.mechanicProfile?.availability || MECHANIC_AVAILABILITY.OFFLINE;
  const workStatusUi =
    extras.workStatusUi ||
    (() => {
      if (av !== MECHANIC_AVAILABILITY.ONLINE) {
        return { key: "offline", label: "offline", tone: "neutral", dotTone: "grey" };
      }
      if (activeJobs > 0) {
        return { key: "busy", label: "busy", tone: "orange", dotTone: "orange" };
      }
      return { key: "active", label: "active", tone: "green", dotTone: "green" };
    })();

  const displayRef = extras.employeeDisplayRef || null;

  return {
    _id: member._id,
    email: member.email,
    role: member.role,
    /** Same as `employeeDisplayRef` — matches company app card “M-001” id. */
    id: displayRef,
    /** Account lifecycle (`USER_STATUS`), not on-shift availability. */
    status: member.status,
    displayName:
      member.mechanicProfile?.displayName ||
      member.companyProfile?.contactName ||
      member.email,
    phone: member.mechanicProfile?.phone || null,
    profilePhotoUrl: member.mechanicProfile?.profilePhotoUrl || null,
    businessType: member.mechanicProfile?.businessType || null,
    baseLocationText: member.mechanicProfile?.baseLocationText || null,
    availability: av,
    workStatusUi,
    /** Stable display id for Team cards (seeded or tenure-based). */
    employeeDisplayRef: displayRef,
    rating: readMechanicProfileRatingAverage(member),
    ratingCount: member.mechanicProfile?.rating?.count ?? null,
    skills: member.mechanicProfile?.skills || [],
    skillsLabels: (member.mechanicProfile?.skills || []).map(teamSkillLabel),
    verificationStatus: member.mechanicProfile?.verification?.status || null,
    jobsCompleted: stats.jobsCompleted || 0,
    activeJobs,
    joinedAt: member.companyMembership?.joinedAt || member.createdAt,
    joinedMonthLabel: formatJoinedMonthYear(
      member.companyMembership?.joinedAt || member.createdAt
    ),
    jobTitle: member.companyMembership?.jobTitle || null,
    companyMembershipStatus: member.companyMembership?.status || null,
    cardAction: {
      label: "More",
      icon: "KEBAB_VERTICAL",
      href: `/api/v1/company/team/members/${member._id}`,
    },
  };
};

const serializeCompanyTeamMemberDetail = (
  member,
  { activeJobs, jobsCompleted, employeeDisplayRef, pendingReviewCount }
) => {
  const base = serializeTeamMember(
    member,
    { activeJobs, jobsCompleted },
    { employeeDisplayRef }
  );
  const skills = member.mechanicProfile?.skills || [];
  const joinedAt = member.companyMembership?.joinedAt || member.createdAt;
  const phone = base.phone;
  const telDigits = phone ? `${phone}`.replace(/[^\d+]/g, "") : null;

  return {
    ...base,
    performance: {
      title: "Performance",
      rating: base.rating,
      ratingCount: base.ratingCount,
      activeJobs: base.activeJobs,
      jobsCompleted: base.jobsCompleted,
    },
    contact: {
      title: "Contact",
      email: base.email,
      phone,
      joinedAt,
      joinedMonthLabel: formatJoinedMonthYear(joinedAt),
    },
    specialties: {
      title: "Specialties",
      skills,
      labels: skills.map(teamSkillLabel),
      chips: skills.map((code) => ({ code, label: teamSkillLabel(code) })),
    },
    actions: {
      canCall: Boolean(phone),
      canMessage: true,
      canRemoveFromTeam: true,
    },
    primaryActions: [
      ...(phone
        ? [{ key: "CALL", label: "Call", icon: "PHONE", telUri: telDigits ? `tel:${telDigits}` : null }]
        : []),
      {
        key: "MESSAGE",
        label: "Message",
        icon: "CHAT",
        threadsUrl: "/api/v1/chat/threads",
      },
      {
        key: "REMOVE_FROM_TEAM",
        label: "Remove from Team",
        icon: "USER_MINUS",
        destructive: true,
        method: "DELETE",
        path: `/api/v1/company/team/members/${member._id}`,
      },
    ],
    meta: {
      pendingReviewCount,
      jobsNavBadgeCount: pendingReviewCount,
    },
  };
};

const companyJobDurationLabelForEarnings = (job) => {
  if (!job?.completedAt) return null;
  const start = job.assignedAt || job.postedAt || job.createdAt;
  if (!start) return null;
  const ms = Math.max(new Date(job.completedAt).getTime() - new Date(start).getTime(), 0);
  const mins = Math.round(ms / 60000);
  if (!Number.isFinite(mins) || mins <= 0) return null;
  if (mins < 60) return `${mins}m`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m ? `${h}h ${m}m` : `${h}h`;
};

const serializeCompanyInvoiceJob = (job, invoice) => {
  const breakdown = companyEarningsBreakdown(job, invoice);

  return {
    _id: job._id,
    jobCode: job.jobCode,
    title: job.title,
    description: job.completionSummary || job.description,
    vehicle: job.vehicle || null,
    vehicleHeadline: vehicleHeadlineFromJob(job),
    location: job.location || null,
    completedAt: job.completedAt || null,
    completedDateLabel: job.completedAt
      ? new Date(job.completedAt).toLocaleDateString("en-GB", {
          day: "numeric",
          month: "short",
          year: "numeric",
        })
      : null,
    durationLabel: companyJobDurationLabelForEarnings(job),
    platformFeePercent: breakdown.platformFeePercent,
    grossAmount: breakdown.grossAmount,
    platformFee: breakdown.platformFeeAmount,
    netAmount: breakdown.netAmount,
    currency: breakdown.currency,
    mechanic: (() => {
      if (job.assignedMechanic) {
        return {
          _id: job.assignedMechanic._id || job.assignedMechanic,
          displayName: job.assignedMechanic.mechanicProfile?.displayName || null,
          rating: resolveMechanicRatingForInvoiceContext(invoice, job.assignedMechanic),
          profilePhotoUrl: job.assignedMechanic.mechanicProfile?.profilePhotoUrl || null,
        };
      }
      if (invoice?.mechanicSnapshot) {
        return {
          _id: invoice.mechanic || null,
          displayName: invoice.mechanicSnapshot.displayName || null,
          rating: resolveMechanicRatingForInvoiceContext(invoice, null),
          profilePhotoUrl: invoice.mechanicSnapshot.profilePhotoUrl || null,
        };
      }
      return null;
    })(),
    fleet: job.fleet
      ? {
          _id: job.fleet._id || job.fleet,
          companyName: job.fleet.fleetProfile?.companyName || null,
        }
      : null,
    invoice: invoice
      ? {
          _id: invoice._id,
          invoiceNo: invoice.invoiceNo,
          pdfUrl: invoice.pdfUrl || null,
          status: invoice.status,
          paidAt: invoice.paidAt || null,
        }
      : null,
    primaryAction: invoice
      ? {
          key: "VIEW_INVOICE",
          label: "View Invoice",
          icon: "DOCUMENT",
          invoiceId: invoice._id,
          href: `/api/v1/invoices/${invoice._id}`,
        }
      : null,
  };
};

export const getCompanyDashboard = async (companyUser) => {
  ensureCompanyUser(companyUser);

  const { start, end } = monthRange();
  const { start: prevStart, end: prevEnd } = monthRangePrev();

  const companyJobIds = await Job.find({ assignedCompany: companyUser._id }).distinct("_id");

  const unassignedFilter = {
    assignedCompany: companyUser._id,
    ...noAssignedMechanicClause(),
    status: { $in: [JOB_STATUS.ASSIGNED, JOB_STATUS.EN_ROUTE, JOB_STATUS.ON_SITE, JOB_STATUS.IN_PROGRESS] },
  };

  const [
    teamCount,
    onlineMechanicsCount,
    activeJobsCount,
    unassignedJobsCount,
    pendingInvitesCount,
    unassignedJobs,
    monthRevenueAgg,
    monthRevenuePrevAgg,
    avgRatingAgg,
    recentEvents,
  ] = await Promise.all([
    User.countDocuments({
      role: ROLES.MECHANIC_EMPLOYEE,
      status: { $ne: "BLOCKED" },
      "companyMembership.company": companyUser._id,
      "companyMembership.status": "ACTIVE",
    }),
    User.countDocuments({
      role: ROLES.MECHANIC_EMPLOYEE,
      status: { $ne: "BLOCKED" },
      "companyMembership.company": companyUser._id,
      "companyMembership.status": "ACTIVE",
      "mechanicProfile.availability": MECHANIC_AVAILABILITY.ONLINE,
    }),
    Job.countDocuments({
      assignedCompany: companyUser._id,
      status: { $in: ACTIVE_JOB_STATUSES },
    }),
    Job.countDocuments(unassignedFilter),
    CompanyInvite.countDocuments({ company: companyUser._id, status: "PENDING" }),
    Job.find(unassignedFilter)
      .sort({ assignedAt: -1, createdAt: -1 })
      .limit(6)
      .select("jobCode title description urgency location vehicle status createdAt assignedAt")
      .lean(),
    Job.aggregate([
      {
        $match: {
          assignedCompany: companyUser._id,
          status: JOB_STATUS.COMPLETED,
          completedAt: { $gte: start, $lt: end },
        },
      },
      {
        $group: {
          _id: null,
          gross: {
            $sum: {
              $ifNull: ["$finalAmount", { $ifNull: ["$acceptedAmount", "$estimatedPayout"] }],
            },
          },
        },
      },
    ]),
    Job.aggregate([
      {
        $match: {
          assignedCompany: companyUser._id,
          status: JOB_STATUS.COMPLETED,
          completedAt: { $gte: prevStart, $lt: prevEnd },
        },
      },
      {
        $group: {
          _id: null,
          gross: {
            $sum: {
              $ifNull: ["$finalAmount", { $ifNull: ["$acceptedAmount", "$estimatedPayout"] }],
            },
          },
        },
      },
    ]),
    User.aggregate([
      {
        $match: {
          role: ROLES.MECHANIC_EMPLOYEE,
          "companyMembership.company": companyUser._id,
          "companyMembership.status": "ACTIVE",
        },
      },
      {
        $group: {
          _id: null,
          avgRating: { $avg: "$mechanicProfile.rating.average" },
          ratingReviewCount: { $sum: { $ifNull: ["$mechanicProfile.rating.count", 0] } },
        },
      },
    ]),
    JobEvent.find({
      $or: [{ "payload.companyId": companyUser._id }, { job: { $in: companyJobIds } }],
    })
      .sort({ createdAt: -1 })
      .limit(8)
      .populate("actor", "email role mechanicProfile.displayName companyProfile.contactName")
      .populate("job", "jobCode")
      .lean(),
  ]);

  const currentMonthGross = monthRevenueAgg[0]?.gross || 0;
  const previousMonthGross = monthRevenuePrevAgg[0]?.gross || 0;
  let monthRevenueChangePercent = null;
  if (previousMonthGross > 0) {
    monthRevenueChangePercent =
      Math.round(((currentMonthGross - previousMonthGross) / previousMonthGross) * 1000) / 10;
  }

  return {
    company: {
      _id: companyUser._id,
      companyName: companyUser.companyProfile?.companyName || null,
      contactName: companyUser.companyProfile?.contactName || null,
      phone: companyUser.companyProfile?.phone || null,
    },
    cards: {
      activeJobs: activeJobsCount,
      mechanics: teamCount,
      onlineMechanics: onlineMechanicsCount,
      monthRevenue: currentMonthGross,
      monthRevenueChangePercent,
      averageRating: Math.round((avgRatingAgg[0]?.avgRating || 0) * 10) / 10,
      ratingReviewCount: Math.round(avgRatingAgg[0]?.ratingReviewCount || 0),
    },
    quickActions: {
      pendingInvites: pendingInvitesCount,
    },
    unassignedJobsCount,
    unassignedJobs: unassignedJobs.map((job) => ({
      _id: job._id,
      jobCode: job.jobCode,
      title: job.title,
      description: job.description,
      urgency: job.urgency,
      vehicle: job.vehicle || null,
      location: job.location || null,
      status: job.status,
      assignedAt: job.assignedAt || null,
      createdAt: job.createdAt,
    })),
    recentActivity: recentEvents.map((event) => {
      const ui = buildCompanyDashboardActivity(event);
      return {
        _id: event._id,
        type: event.type,
        title: ui.title,
        detail: ui.detail,
        icon: ui.icon,
        note: event.note || null,
        payload: event.payload || null,
        createdAt: event.createdAt,
        relativeTime: formatActivityRelative(event.createdAt),
      };
    }),
  };
};

export const getCompanyFeed = async (companyUser, query) => {
  ensureCompanyUser(companyUser);
  return listJobs(companyUser, { ...query, feed: "true" });
};

const quoteOwnerId = (v) => (v?._id || v)?.toString?.() || null;

/** Fleet-facing labels for company Job Feed quote cards (matches mobile mock). */
const companyFeedQuoteDisplayStatus = (quoteStatus) => {
  if (quoteStatus === QUOTE_STATUS.WAITING) return "PENDING";
  if (quoteStatus === QUOTE_STATUS.DECLINED) return "REJECTED";
  return quoteStatus;
};

const companyFeedQuoteDisplayStatusUi = (quoteStatus) => {
  switch (quoteStatus) {
    case QUOTE_STATUS.WAITING:
      return { label: "PENDING", tone: "yellow" };
    case QUOTE_STATUS.ACCEPTED:
      return { label: "ACCEPTED", tone: "green" };
    case QUOTE_STATUS.DECLINED:
      return { label: "REJECTED", tone: "red" };
    case QUOTE_STATUS.EXPIRED:
      return { label: "EXPIRED", tone: "neutral" };
    case QUOTE_STATUS.WITHDRAWN:
      return { label: "WITHDRAWN", tone: "neutral" };
    default:
      return { label: quoteStatus || "UNKNOWN", tone: "neutral" };
  }
};

export const getCompanyFeedSummary = async (companyUser, query) => {
  ensureCompanyUser(companyUser);
  const h = Number(query.newWithinHours ?? 24);
  const hours = Number.isFinite(h) && h > 0 ? h : 24;
  const [availableJobsCount, newJobsCount, quoteCounts, pendingReviewCount] = await Promise.all([
    countCompanyFeedJobs(companyUser, query),
    countCompanyFeedJobsPostedSince(companyUser, query, hours),
    countOwnerQuotesByStatus(companyUser),
    Job.countDocuments({
      assignedCompany: companyUser._id,
      status: JOB_STATUS.AWAITING_APPROVAL,
    }),
  ]);
  return {
    availableJobsCount,
    newJobsCount,
    newWithinHours: hours,
    myQuotesCount: quoteCounts.total,
    /** Same as Job Management “pending review”; use for bottom-nav Jobs badge when on Feed. */
    pendingReviewCount,
    jobsNavBadgeCount: pendingReviewCount,
    quotesByStatus: {
      WAITING: quoteCounts.WAITING,
      PENDING: quoteCounts.WAITING,
      ACCEPTED: quoteCounts.ACCEPTED,
      DECLINED: quoteCounts.DECLINED,
      REJECTED: quoteCounts.DECLINED,
      EXPIRED: quoteCounts.EXPIRED,
      WITHDRAWN: quoteCounts.WITHDRAWN,
    },
    tabs: {
      availableJobs: { key: "available", count: availableJobsCount },
      myQuotes: { key: "my_quotes", count: quoteCounts.total },
    },
    header: {
      newJobsBadgeCount: newJobsCount,
      newJobsWithinHours: hours,
    },
  };
};

export const getCompanyQuotes = async (companyUser, query) => {
  ensureCompanyUser(companyUser);
  const [result, quoteCounts, pendingReviewCount, availableJobsCount] = await Promise.all([
    listOwnerQuotesPaginated(companyUser, query),
    countOwnerQuotesByStatus(companyUser),
    Job.countDocuments({
      assignedCompany: companyUser._id,
      status: JOB_STATUS.AWAITING_APPROVAL,
    }),
    countCompanyFeedJobs(companyUser, query),
  ]);
  const companyId = quoteOwnerId(companyUser._id);
  const items = result.items.map((q) => {
    const ac = quoteOwnerId(q.job?.assignedCompany);
    const assignMechanicRequired =
      q.status === QUOTE_STATUS.ACCEPTED && ac === companyId && !q.job?.assignedMechanic;
    const vehicleHeadline = q.job?.vehicle
      ? [q.job.vehicle.make, q.job.vehicle.model].filter(Boolean).join(" ").trim() || null
      : null;
    const locationLabel = q.job?.location?.address || null;
    const postedAt = q.job?.postedAt || q.job?.createdAt;
    const jobPostedAgoLabel = formatActivityRelative(postedAt);
    const displayStatus = companyFeedQuoteDisplayStatus(q.status);
    return {
      ...q,
      feed: {
        displayStatus,
        displayStatusUi: companyFeedQuoteDisplayStatusUi(q.status),
        vehicleHeadline,
        locationLabel,
        issueDescription: q.job?.description || null,
        jobTitle: q.job?.title || null,
        jobCode: q.job?.jobCode || null,
        jobId: q.job?._id || null,
        jobPostedAt: postedAt || null,
        jobPostedAgoLabel,
        timelineClockLabel: jobPostedAgoLabel,
        quoteAmount: q.amount ?? null,
        quoteCurrency: q.currency || "GBP",
        quoteBreakdown: q.breakdown || null,
        assignMechanicRequired,
        acceptedBanner:
          q.status === QUOTE_STATUS.ACCEPTED && assignMechanicRequired
            ? { tone: "green", text: "Quote accepted - Assign mechanic", icon: "CHECK" }
            : q.status === QUOTE_STATUS.ACCEPTED
              ? { tone: "green", text: "Quote accepted", icon: "CHECK" }
              : null,
        primaryAction: assignMechanicRequired
          ? {
              key: "ASSIGN_MECHANIC",
              label: "Assign",
              icon: "USER_PLUS",
              jobId: q.job?._id || null,
            }
          : null,
      },
    };
  });
  return {
    items,
    meta: {
      ...result.meta,
      myQuotesTotal: quoteCounts.total,
      pendingReviewCount,
      jobsNavBadgeCount: pendingReviewCount,
      quotesByStatus: {
        WAITING: quoteCounts.WAITING,
        PENDING: quoteCounts.WAITING,
        ACCEPTED: quoteCounts.ACCEPTED,
        DECLINED: quoteCounts.DECLINED,
        REJECTED: quoteCounts.DECLINED,
        EXPIRED: quoteCounts.EXPIRED,
        WITHDRAWN: quoteCounts.WITHDRAWN,
      },
      tabs: {
        availableJobs: { key: "available", count: availableJobsCount },
        myQuotes: { key: "my_quotes", count: quoteCounts.total },
      },
    },
  };
};

export const getCompanyJobs = async (companyUser, query = {}) => {
  ensureCompanyUser(companyUser);

  const page = parsePage(query.page);
  const limit = parseLimit(query.limit);
  const skip = (page - 1) * limit;
  const filter = { assignedCompany: companyUser._id };

  const statusUiQuery = parseCompanyJobsStatusUiQuery(query);
  let tab = `${query.tab || "all"}`.toLowerCase();
  let appliedStatusUi = null;

  if (statusUiQuery) {
    Object.assign(filter, statusUiQuery.filter);
    tab = statusUiQuery.metaTab;
    appliedStatusUi = {
      key: statusUiQuery.statusUiKey,
      label: statusUiQuery.statusUiLabel,
    };
  } else if (tab === "unassigned") {
    Object.assign(filter, noAssignedMechanicClause());
    filter.status = { $in: [JOB_STATUS.ASSIGNED, JOB_STATUS.EN_ROUTE, JOB_STATUS.ON_SITE, JOB_STATUS.IN_PROGRESS] };
  } else if (tab === "assigned") {
    filter.assignedMechanic = { $exists: true, $ne: null };
    filter.status = { $in: [JOB_STATUS.ASSIGNED, JOB_STATUS.EN_ROUTE] };
  } else if (tab === "in_progress") {
    filter.status = { $in: [JOB_STATUS.ON_SITE, JOB_STATUS.IN_PROGRESS] };
  } else if (tab === "pending_review") {
    filter.status = JOB_STATUS.AWAITING_APPROVAL;
  } else if (tab === "completed") {
    filter.status = JOB_STATUS.COMPLETED;
  }

  const [items, total, summary] = await Promise.all([
    Job.find(filter)
      .sort({ updatedAt: -1, createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .populate("fleet", "fleetProfile.companyName fleetProfile.contactName")
      .populate(
        "assignedMechanic",
        "mechanicProfile.displayName mechanicProfile.rating mechanicProfile.phone mechanicProfile.profilePhotoUrl"
      )
      .lean(),
    Job.countDocuments(filter),
    Promise.all([
      Job.countDocuments({
        assignedCompany: companyUser._id,
        ...noAssignedMechanicClause(),
        status: { $in: [JOB_STATUS.ASSIGNED, JOB_STATUS.EN_ROUTE, JOB_STATUS.ON_SITE, JOB_STATUS.IN_PROGRESS] },
      }),
      Job.countDocuments({
        assignedCompany: companyUser._id,
        assignedMechanic: { $exists: true, $ne: null },
        status: { $in: [JOB_STATUS.ASSIGNED, JOB_STATUS.EN_ROUTE] },
      }),
      Job.countDocuments({
        assignedCompany: companyUser._id,
        status: { $in: [JOB_STATUS.ON_SITE, JOB_STATUS.IN_PROGRESS] },
      }),
      Job.countDocuments({
        assignedCompany: companyUser._id,
        status: JOB_STATUS.AWAITING_APPROVAL,
      }),
      Job.countDocuments({
        assignedCompany: companyUser._id,
        status: { $nin: [JOB_STATUS.CANCELLED] },
      }),
    ]),
  ]);

  const invoiceByJobId = await buildLatestInvoiceByJobMap(items.map((j) => j._id));
  const mechanicDisplayRefById = await loadTeamMemberDisplayRefMap(companyUser);
  const serializedItems = items.map((job) =>
    serializeCompanyJobListItem(job, invoiceByJobId, {
      mechanicDisplayRefById,
      companyJobsListTab: tab,
    })
  );

  const [unassigned, assigned, inProgress, pendingReview, allActive] = summary;

  return {
    items: serializedItems,
    meta: {
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit) || 1,
      tab,
      appliedStatusUi,
      pendingReviewCount: pendingReview,
      tabCounts: {
        all: allActive,
        pendingReview,
        unassigned,
        assigned,
        inProgress,
      },
    },
    summary: {
      unassigned,
      assigned,
      inProgress,
      pendingReview,
      all: allActive,
    },
  };
};

export const getCompanyJobById = async (jobId, companyUser) => {
  ensureCompanyUser(companyUser);
  return getJobByIdForUser(jobId, companyUser);
};

export const assignMechanicToCompanyJob = async (jobId, employeeId, companyUser) => {
  ensureCompanyUser(companyUser);

  const [job, employee] = await Promise.all([
    Job.findById(jobId),
    User.findOne({
      _id: employeeId,
      role: ROLES.MECHANIC_EMPLOYEE,
      "companyMembership.company": companyUser._id,
      "companyMembership.status": "ACTIVE",
    }),
  ]);

  if (!job) throw new AppError("Job not found", 404);
  if (!employee) throw new AppError("Mechanic employee not found", 404);
  if (`${job.assignedCompany || ""}` !== `${companyUser._id}`) {
    throw new AppError("Job is not assigned to this company", 403);
  }
  if ([JOB_STATUS.COMPLETED, JOB_STATUS.CANCELLED].includes(job.status)) {
    throw new AppError("This job can no longer be assigned", 400);
  }

  const previousMechanic = job.assignedMechanic || null;
  job.assignedMechanic = employee._id;
  if (!job.assignedAt) job.assignedAt = new Date();
  await job.save();

  await JobEvent.create({
    job: job._id,
    actor: companyUser._id,
    type: previousMechanic ? "MECHANIC_REASSIGNED" : "MECHANIC_ASSIGNED",
    toStatus: job.status,
    payload: {
      companyId: companyUser._id,
      previousMechanicId: previousMechanic,
      mechanicId: employee._id,
    },
  });

  const displayRefMap = await loadTeamMemberDisplayRefMap(companyUser);
  const mechanicRef = displayRefMap.get(`${employee._id}`) || null;

  return {
    _id: job._id,
    jobCode: job.jobCode,
    assignedMechanic: {
      _id: employee._id,
      displayName: employee.mechanicProfile?.displayName || employee.email,
      phone: employee.mechanicProfile?.phone || null,
      profilePhotoUrl: employee.mechanicProfile?.profilePhotoUrl || null,
      employeeDisplayRef: mechanicRef,
      id: mechanicRef,
    },
  };
};

export const getCompanyTeam = async (companyUser) => {
  ensureCompanyUser(companyUser);

  const [members, pendingInvites, activeJobsByMechanic, completedJobsByMechanic, pendingReviewCount] =
    await Promise.all([
      User.find({
        role: ROLES.MECHANIC_EMPLOYEE,
        "companyMembership.company": companyUser._id,
        "companyMembership.status": "ACTIVE",
      })
        .sort({ createdAt: -1 })
        .lean(),
      CompanyInvite.find({ company: companyUser._id, status: "PENDING" })
        .sort({ createdAt: -1 })
        .lean(),
      Job.aggregate([
        {
          $match: {
            assignedCompany: companyUser._id,
            assignedMechanic: { $ne: null },
            status: { $in: ACTIVE_JOB_STATUSES },
          },
        },
        { $group: { _id: "$assignedMechanic", count: { $sum: 1 } } },
      ]),
      Job.aggregate([
        {
          $match: {
            assignedCompany: companyUser._id,
            assignedMechanic: { $ne: null },
            status: JOB_STATUS.COMPLETED,
          },
        },
        { $group: { _id: "$assignedMechanic", count: { $sum: 1 } } },
      ]),
      Job.countDocuments({
        assignedCompany: companyUser._id,
        status: JOB_STATUS.AWAITING_APPROVAL,
      }),
    ]);

  const activeMap = new Map(activeJobsByMechanic.map((item) => [`${item._id}`, item.count]));
  const completedMap = new Map(
    completedJobsByMechanic.map((item) => [`${item._id}`, item.count])
  );

  const employeeDisplayRefById = resolveEmployeeDisplayRefs(members);

  return {
    members: members.map((member) => {
      const activeJobs = activeMap.get(`${member._id}`) || 0;
      const jobsCompleted = completedMap.get(`${member._id}`) || 0;
      return serializeTeamMember(
        member,
        { activeJobs, jobsCompleted },
        { employeeDisplayRef: employeeDisplayRefById.get(`${member._id}`) || null }
      );
    }),
    pendingInvites: pendingInvites.map((inv) => serializeInvite(inv, { includeSecrets: false })),
    inviteAction: {
      method: "POST",
      path: "/api/v1/company/team/invitations",
      bodyFields: ["email"],
      responseFields: ["inviteToken", "signupUrl (when APP_PUBLIC_URL is set)"],
    },
    meta: {
      pendingReviewCount,
      jobsNavBadgeCount: pendingReviewCount,
      memberCount: members.length,
      pendingInviteCount: pendingInvites.length,
    },
  };
};

export const getCompanyTeamMemberById = async (mechanicId, companyUser) => {
  ensureCompanyUser(companyUser);
  if (!mongoose.Types.ObjectId.isValid(mechanicId)) {
    throw new AppError("Invalid mechanic id", 400);
  }

  const [member, pendingReviewCount, employeeDisplayRefById] = await Promise.all([
    User.findOne({
      _id: mechanicId,
      role: ROLES.MECHANIC_EMPLOYEE,
      "companyMembership.company": companyUser._id,
      "companyMembership.status": "ACTIVE",
    }).lean(),
    Job.countDocuments({
      assignedCompany: companyUser._id,
      status: JOB_STATUS.AWAITING_APPROVAL,
    }),
    loadTeamMemberDisplayRefMap(companyUser),
  ]);

  if (!member) throw new AppError("Team member not found", 404);

  const [activeJobs, jobsCompleted] = await Promise.all([
    Job.countDocuments({
      assignedCompany: companyUser._id,
      assignedMechanic: mechanicId,
      status: { $in: ACTIVE_JOB_STATUSES },
    }),
    Job.countDocuments({
      assignedCompany: companyUser._id,
      assignedMechanic: mechanicId,
      status: JOB_STATUS.COMPLETED,
    }),
  ]);

  return serializeCompanyTeamMemberDetail(member, {
    activeJobs,
    jobsCompleted,
    employeeDisplayRef: employeeDisplayRefById.get(`${member._id}`) || null,
    pendingReviewCount,
  });
};

export const removeCompanyTeamMember = async (mechanicId, companyUser) => {
  ensureCompanyUser(companyUser);
  if (!mongoose.Types.ObjectId.isValid(mechanicId)) {
    throw new AppError("Invalid mechanic id", 400);
  }

  const member = await User.findOne({
    _id: mechanicId,
    role: ROLES.MECHANIC_EMPLOYEE,
    "companyMembership.company": companyUser._id,
    "companyMembership.status": "ACTIVE",
  });
  if (!member) throw new AppError("Team member not found", 404);

  member.companyMembership.status = "INACTIVE";
  await member.save();

  return {
    _id: member._id,
    removed: true,
    membershipStatus: member.companyMembership.status,
  };
};

export const createCompanyInvite = async (companyUser, payload = {}) => {
  ensureCompanyUser(companyUser);

  const email = `${payload.email || ""}`.trim().toLowerCase();
  if (!email) throw new AppError("email is required", 400);

  const existingMember = await User.findOne({
    email,
    "companyMembership.company": companyUser._id,
    "companyMembership.status": "ACTIVE",
  }).lean();
  if (existingMember) {
    throw new AppError("This user is already part of the company", 409);
  }

  const existingInvite = await CompanyInvite.findOne({
    company: companyUser._id,
    email,
    status: "PENDING",
    expiresAt: { $gt: new Date() },
  });

  if (existingInvite) {
    return serializeInvite(existingInvite, { includeSecrets: true });
  }

  const invite = await CompanyInvite.create({
    company: companyUser._id,
    email,
    invitedBy: companyUser._id,
    token: crypto.randomBytes(24).toString("hex"),
    expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
  });

  return serializeInvite(invite, { includeSecrets: true });
};

export const cancelCompanyInvite = async (inviteId, companyUser) => {
  ensureCompanyUser(companyUser);

  const invite = await CompanyInvite.findOne({
    _id: inviteId,
    company: companyUser._id,
    status: "PENDING",
  });
  if (!invite) throw new AppError("Invite not found", 404);

  invite.status = "CANCELLED";
  invite.cancelledAt = new Date();
  await invite.save();

  return serializeInvite(invite, { includeSecrets: false });
};

export const getCompanyEarningsSummary = async (companyUser) => {
  ensureCompanyUser(companyUser);

  const now = new Date();
  const { start, end } = monthRange(now);

  const monthBuckets = [];
  for (let i = 5; i >= 0; i -= 1) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    monthBuckets.push({
      label: d.toLocaleString("en-GB", { month: "short" }),
      year: d.getFullYear(),
      monthIndex: d.getMonth(),
      start: new Date(d.getFullYear(), d.getMonth(), 1),
      end: new Date(d.getFullYear(), d.getMonth() + 1, 1),
    });
  }

  const [monthAgg, allTimeAgg, completedCount, monthlySeries, firstCompleted] = await Promise.all([
    Job.aggregate([
      {
        $match: {
          assignedCompany: companyUser._id,
          status: JOB_STATUS.COMPLETED,
          completedAt: { $gte: start, $lt: end },
        },
      },
      {
        $group: {
          _id: null,
          gross: {
            $sum: {
              $ifNull: ["$finalAmount", { $ifNull: ["$acceptedAmount", "$estimatedPayout"] }],
            },
          },
        },
      },
    ]),
    Job.aggregate([
      {
        $match: {
          assignedCompany: companyUser._id,
          status: JOB_STATUS.COMPLETED,
        },
      },
      {
        $group: {
          _id: null,
          gross: {
            $sum: {
              $ifNull: ["$finalAmount", { $ifNull: ["$acceptedAmount", "$estimatedPayout"] }],
            },
          },
        },
      },
    ]),
    Job.countDocuments({
      assignedCompany: companyUser._id,
      status: JOB_STATUS.COMPLETED,
    }),
    Promise.all(
      monthBuckets.map(async (b) => {
        const agg = await Job.aggregate([
          {
            $match: {
              assignedCompany: companyUser._id,
              status: JOB_STATUS.COMPLETED,
              completedAt: { $gte: b.start, $lt: b.end },
            },
          },
          {
            $group: {
              _id: null,
              gross: {
                $sum: {
                  $ifNull: ["$finalAmount", { $ifNull: ["$acceptedAmount", "$estimatedPayout"] }],
                },
              },
            },
          },
        ]);
        const grossAmount = agg[0]?.gross || 0;
        const netAmount = Math.max(Math.round(grossAmount * 0.88 * 100) / 100, 0);
        const isCurrentMonth = b.monthIndex === now.getMonth() && b.year === now.getFullYear();
        return {
          label: b.label,
          year: b.year,
          month: b.monthIndex + 1,
          grossAmount,
          netAmount,
          platformFeeRate: 0.12,
          isCurrentMonth,
        };
      })
    ),
    Job.findOne({
      assignedCompany: companyUser._id,
      status: JOB_STATUS.COMPLETED,
    })
      .sort({ completedAt: 1 })
      .select("completedAt")
      .lean(),
  ]);

  const monthGross = monthAgg[0]?.gross || 0;
  const allTimeGross = allTimeAgg[0]?.gross || 0;
  const monthNet = Math.max(Math.round(monthGross * 0.88 * 100) / 100, 0);
  const allTimeNet = Math.max(Math.round(allTimeGross * 0.88 * 100) / 100, 0);

  const monthShort = now.toLocaleString("en-GB", { month: "short" });
  const monthKeyUpper = monthShort.toUpperCase();
  const allTimeSinceLabel = firstCompleted?.completedAt
    ? new Date(firstCompleted.completedAt).toLocaleDateString("en-GB", {
        month: "short",
        year: "numeric",
      })
    : null;

  return {
    cards: {
      monthGross,
      monthNet,
      allTimeGross,
      allTimeNet,
      completedJobs: completedCount,
    },
    display: {
      monthGrossLabel: `${monthKeyUpper} GROSS`,
      monthNetLabel: `${monthKeyUpper} NET`,
      monthGrossSubtext: "Before platform fee",
      monthNetSubtext: "After 12% fee",
      allTimeLabel: "ALL-TIME",
      allTimeSubtext: allTimeSinceLabel ? `Net since ${allTimeSinceLabel}` : "Net after 12% fee",
    },
    monthlyNetIncome: {
      title: "MONTHLY NET INCOME",
      rangeLabel: "Last 6 months",
      footnote: "12% platform fee already deducted from net figures",
      months: monthlySeries,
    },
  };
};

export const listCompanyEarningJobs = async (companyUser, query = {}) => {
  ensureCompanyUser(companyUser);

  const page = parsePage(query.page);
  const limit = parseLimit(query.limit);
  const skip = (page - 1) * limit;

  const [jobs, total] = await Promise.all([
    Job.find({
      assignedCompany: companyUser._id,
      status: JOB_STATUS.COMPLETED,
    })
      .sort({ completedAt: -1, updatedAt: -1 })
      .skip(skip)
      .limit(limit)
      .populate("fleet", "fleetProfile.companyName")
      .populate("assignedMechanic", "mechanicProfile.displayName mechanicProfile.rating mechanicProfile.profilePhotoUrl")
      .lean(),
    Job.countDocuments({
      assignedCompany: companyUser._id,
      status: JOB_STATUS.COMPLETED,
    }),
  ]);

  const invoices = await Invoice.find({
    job: { $in: jobs.map((job) => job._id) },
  })
    .select("_id job invoiceNo pdfUrl status paidAt mechanicSnapshot mechanic")
    .lean();

  const invoiceMap = new Map(invoices.map((invoice) => [`${invoice.job}`, invoice]));

  return {
    items: jobs.map((job) => serializeCompanyInvoiceJob(job, invoiceMap.get(`${job._id}`))),
    meta: {
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit) || 1,
    },
  };
};
