import crypto from "crypto";
import AppError from "../../utils/AppError.js";
import { ROLES } from "../../constants/domain.js";
import { Dispute } from "./dispute.model.js";
import { DisputeEvent } from "./disputeEvent.model.js";
import { DisputeMessage } from "./disputeMessage.model.js";
import { DisputeEvidence } from "./disputeEvidence.model.js";
import { DisputeTask } from "./disputeTask.model.js";
import { DisputeFinancialAction } from "./disputeFinancialAction.model.js";
import {
  resolvePrivateEvidence,
  storePrivateEvidence,
} from "./disputeEvidenceStorage.service.js";
import { Job } from "../job/job.model.js";
import { Invoice } from "../invoice/invoice.model.js";
import { Refund } from "../billing/refund.model.js";
import { createStripeRefund } from "../billing/stripe.service.js";
import { applyStripeRefundToInvoice } from "../billing/stripeWebhook.service.js";
import { SupportTicket } from "../supportTicket/supportTicket.model.js";
import { createNotification } from "../notification/notification.service.js";
import { notifyAdminsSafely } from "../notification/adminNotification.service.js";
import { ADMIN_NOTIFICATION_EVENTS } from "../notification/adminNotificationEvents.js";

const ACTIVE_STATUSES = [
  "OPEN",
  "TRIAGE",
  "AWAITING_CUSTOMER_EVIDENCE",
  "AWAITING_PROVIDER_EVIDENCE",
  "INVESTIGATING",
  "DECISION_PENDING",
  "APPEALED",
  "ESCALATED",
  "IN_REVIEW",
];

const TRANSITIONS = {
  OPEN: ["TRIAGE", "ESCALATED"],
  TRIAGE: [
    "AWAITING_CUSTOMER_EVIDENCE",
    "AWAITING_PROVIDER_EVIDENCE",
    "INVESTIGATING",
    "ESCALATED",
  ],
  IN_REVIEW: ["INVESTIGATING", "DECISION_PENDING", "ESCALATED"],
  AWAITING_CUSTOMER_EVIDENCE: ["INVESTIGATING", "ESCALATED"],
  AWAITING_PROVIDER_EVIDENCE: ["INVESTIGATING", "ESCALATED"],
  INVESTIGATING: ["DECISION_PENDING", "ESCALATED"],
  DECISION_PENDING: ["RESOLVED", "INVESTIGATING", "ESCALATED"],
  ESCALATED: ["INVESTIGATING", "DECISION_PENDING"],
  RESOLVED: ["CLOSED", "APPEALED"],
  APPEALED: ["INVESTIGATING"],
  CLOSED: [],
};

const parsePage = (value) => {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 1;
};

const parseLimit = (value) => {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.min(Math.floor(n), 100) : 20;
};

const idOf = (value) => `${value?._id || value || ""}`;
const sameId = (a, b) => Boolean(a && b && idOf(a) === idOf(b));
const isMechanicRole = (role) =>
  [ROLES.MECHANIC, ROLES.MECHANIC_EMPLOYEE].includes(role);

const ACTION_ROLES = {
  VIEW_CASE: [ROLES.FLEET, ROLES.COMPANY, ROLES.MECHANIC, ROLES.MECHANIC_EMPLOYEE, ROLES.ADMIN],
  OPEN_CASE: [ROLES.FLEET, ROLES.COMPANY, ROLES.MECHANIC, ROLES.MECHANIC_EMPLOYEE],
  PARTY_MESSAGE: [ROLES.FLEET, ROLES.COMPANY, ROLES.MECHANIC, ROLES.MECHANIC_EMPLOYEE, ROLES.ADMIN],
  INTERNAL_NOTE: [ROLES.ADMIN],
  UPLOAD_EVIDENCE: [ROLES.FLEET, ROLES.COMPANY, ROLES.MECHANIC, ROLES.MECHANIC_EMPLOYEE, ROLES.ADMIN],
  ASSIGN_CASE: [ROLES.ADMIN],
  TRANSITION_CASE: [ROLES.ADMIN],
  DECIDE_CASE: [ROLES.ADMIN],
  EXECUTE_REMEDY: [ROLES.ADMIN],
  REVIEW_EVIDENCE: [ROLES.ADMIN],
};

export const assertDisputeActionPermission = (user, action) => {
  if (!ACTION_ROLES[action]?.includes(user?.role)) {
    throw new AppError(`Permission denied for dispute action ${action}`, 403);
  }
};

const caseNo = () =>
  `DSP-${new Date().getFullYear()}-${crypto
    .randomBytes(4)
    .toString("hex")
    .toUpperCase()}`;

const reasonCode = (value) => {
  const normalized = `${value || "OTHER"}`.trim().toUpperCase();
  const allowed = [
    "QUALITY",
    "INCORRECT_PARTS",
    "OVERCHARGE",
    "DAMAGE",
    "NO_SHOW",
    "PAYMENT",
    "CHARGEBACK",
    "OTHER",
  ];
  return allowed.includes(normalized) ? normalized : "OTHER";
};

const populateCase = (query) =>
  query
    .populate("claimant", "email role fleetProfile.companyName companyProfile.companyName mechanicProfile.displayName")
    .populate("respondent", "email role fleetProfile.companyName companyProfile.companyName mechanicProfile.displayName")
    .populate("company", "email fleetProfile.companyName")
    .populate("mechanic", "email mechanicProfile.displayName")
    .populate("job", "jobCode title status vehicle location assignedCompany assignedMechanic fleet")
    .populate("invoice", "invoiceNo status totalAmount subtotal currency payment refundedAmount")
    .populate("assignedTo", "email role");

const userLabel = (user) =>
  user?.fleetProfile?.companyName ||
  user?.companyProfile?.companyName ||
  user?.mechanicProfile?.displayName ||
  user?.email ||
  null;

export const serializeDispute = (dispute) => ({
  _id: dispute._id,
  caseNo: dispute.caseNo || idOf(dispute._id),
  caseType: dispute.caseType || "SERVICE_DISPUTE",
  title: dispute.title,
  description: dispute.description || null,
  reason: dispute.reason || null,
  reasonCode: dispute.reasonCode || "OTHER",
  claimant: dispute.claimant
    ? {
        _id: dispute.claimant._id || dispute.claimant,
        role: dispute.claimant.role || dispute.claimantRole,
        name: userLabel(dispute.claimant),
        email: dispute.claimant.email || null,
      }
    : null,
  respondent: dispute.respondent
    ? {
        _id: dispute.respondent._id || dispute.respondent,
        role: dispute.respondent.role || dispute.respondentRole,
        name: userLabel(dispute.respondent),
        email: dispute.respondent.email || null,
      }
    : null,
  company: dispute.company
    ? {
        _id: dispute.company._id || dispute.company,
        companyName:
          dispute.company.fleetProfile?.companyName ||
          dispute.company.companyProfile?.companyName ||
          dispute.company.email ||
          null,
      }
    : null,
  mechanic: dispute.mechanic
    ? {
        _id: dispute.mechanic._id || dispute.mechanic,
        displayName:
          dispute.mechanic.mechanicProfile?.displayName ||
          dispute.mechanic.email ||
          null,
      }
    : null,
  job: dispute.job
    ? {
        _id: dispute.job._id || dispute.job,
        jobCode: dispute.job.jobCode || null,
        title: dispute.job.title || null,
        status: dispute.job.status || null,
      }
    : null,
  invoice: dispute.invoice
    ? {
        _id: dispute.invoice._id || dispute.invoice,
        invoiceNo: dispute.invoice.invoiceNo || null,
        status: dispute.invoice.status || null,
        totalAmount: dispute.invoice.totalAmount ?? null,
        currency: dispute.invoice.currency || dispute.currency || "GBP",
        paymentStatus: dispute.invoice.payment?.status || null,
      }
    : null,
  supportTicket: dispute.supportTicket || null,
  customerName: dispute.customerName || null,
  serviceLabel: dispute.serviceLabel || null,
  amount: dispute.amountMinor != null ? dispute.amountMinor / 100 : dispute.amount || 0,
  amountMinor: dispute.amountMinor ?? Math.round(Number(dispute.amount || 0) * 100),
  currency: dispute.currency || "GBP",
  priority: dispute.priority,
  status: dispute.status,
  version: dispute.versionNumber || 1,
  assignedTo: dispute.assignedTo
    ? {
        _id: dispute.assignedTo._id || dispute.assignedTo,
        email: dispute.assignedTo.email || null,
      }
    : null,
  assignedTeam: dispute.assignedTeam || "DISPUTES",
  responseDueAt: dispute.responseDueAt || null,
  evidenceDueAt: dispute.evidenceDueAt || null,
  decisionDueAt: dispute.decisionDueAt || null,
  nextActionOwner: dispute.nextActionOwner || "ADMIN",
  processorStatus: dispute.processorStatus || "NONE",
  stripeDisputeId: dispute.stripeDisputeId || null,
  stripeEvidenceDueAt: dispute.stripeEvidenceDueAt || null,
  financialState: dispute.financialState || "NO_ACTION",
  decision: dispute.decision || null,
  appeal: dispute.appeal || null,
  legalHold: dispute.legalHold || { active: false },
  notes: dispute.notes || null,
  resolvedAt: dispute.resolvedAt || null,
  closedAt: dispute.closedAt || null,
  createdAt: dispute.createdAt,
  updatedAt: dispute.updatedAt,
});

export const isJobParticipant = (job, user) =>
  user.role === ROLES.ADMIN ||
    (user.role === ROLES.FLEET && sameId(job.fleet, user._id)) ||
    (user.role === ROLES.COMPANY && sameId(job.assignedCompany, user._id)) ||
    (isMechanicRole(user.role) && sameId(job.assignedMechanic, user._id));

const assertJobParticipant = (job, user) => {
  if (!isJobParticipant(job, user)) {
    throw new AppError("You are not a participant in this job", 403);
  }
};

const assertCaseAccess = (dispute, user, { adminOnly = false } = {}) => {
  if (user.role === ROLES.ADMIN) return;
  if (adminOnly) throw new AppError("Admin permission required", 403);
  if (!sameId(dispute.claimant, user._id) && !sameId(dispute.respondent, user._id)) {
    throw new AppError("Dispute not found", 404);
  }
};

const recordEvent = ({
  dispute,
  actor,
  source,
  type,
  fromStatus,
  toStatus,
  reason,
  correlationId,
  payload,
}) =>
  DisputeEvent.create({
    dispute: dispute._id,
    actor: actor?._id,
    actorRole: actor?.role,
    source,
    type,
    fromStatus,
    toStatus,
    reason,
    correlationId,
    payload,
  });

const notifyCaseParty = async (userId, dispute, title, body) => {
  if (!userId) return;
  await createNotification({
    user: userId,
    type: "DISPUTE_UPDATED",
    eventKey: "DISPUTE_UPDATED",
    dedupeKey: `${dispute._id}:${dispute.versionNumber}:${title}`,
    title,
    body,
    data: {
      disputeId: dispute._id.toString(),
      caseNo: dispute.caseNo,
      jobId: idOf(dispute.job) || null,
      screen: "DISPUTE_DETAIL",
    },
  });
};

const sealJobEvidence = async (dispute, job, actor) => {
  const refsByUrl = new Map();
  for (const item of [...(job.photos || []), ...(job.attachments || [])]) {
    const url = typeof item === "string" ? item : item?.url;
    if (!url || refsByUrl.has(url)) continue;
    refsByUrl.set(url, {
      url,
      name:
        (typeof item === "object" &&
          (item?.originalName || item?.name || item?.fileName)) ||
        "Job evidence",
      mimeType:
        (typeof item === "object" && item?.mimeType) ||
        "application/octet-stream",
      sha256: crypto.createHash("sha256").update(url).digest("hex"),
    });
  }
  const refs = [...refsByUrl.values()];
  if (!refs.length) return;
  await recordEvent({
    dispute,
    actor,
    source: "SYSTEM",
    type: "JOB_EVIDENCE_SEALED",
    correlationId: `sealed-job-evidence:${dispute._id}`,
    payload: {
      count: refs.length,
      references: refs,
      sealedAt: new Date(),
    },
  });
};

export const createParticipantDispute = async (user, payload = {}) => {
  assertDisputeActionPermission(user, "OPEN_CASE");
  const jobId = `${payload.jobId || ""}`.trim();
  if (!jobId) throw new AppError("jobId is required", 400);
  const title = `${payload.title || ""}`.trim();
  if (!title) throw new AppError("title is required", 400);
  const description = `${payload.description || ""}`.trim();
  if (description.length < 10) {
    throw new AppError("description must be at least 10 characters", 400);
  }

  const job = await Job.findById(jobId)
    .populate("fleet", "email role fleetProfile")
    .populate("assignedCompany", "email role companyProfile")
    .populate("assignedMechanic", "email role mechanicProfile")
    .lean();
  if (!job) throw new AppError("Job not found", 404);
  assertJobParticipant(job, user);

  const invoice = await Invoice.findOne({ job: job._id }).lean();
  if (payload.invoiceId && (!invoice || !sameId(invoice._id, payload.invoiceId))) {
    throw new AppError("Invoice does not belong to this job", 400);
  }

  const code = reasonCode(payload.reasonCode);
  const duplicate = await Dispute.findOne({
    job: job._id,
    reasonCode: code,
    status: { $in: ACTIVE_STATUSES },
  }).lean();
  if (duplicate) {
    throw new AppError(`An active ${code.toLowerCase()} dispute already exists for this job`, 409, {
      disputeId: duplicate._id,
      caseNo: duplicate.caseNo,
    });
  }

  const claimantIsProvider = isMechanicRole(user.role);
  const respondent = claimantIsProvider
    ? job.assignedCompany || job.fleet
    : job.assignedMechanic;
  if (!respondent) throw new AppError("This job has no counterparty to dispute", 400);
  const respondentRole = claimantIsProvider
    ? job.assignedCompany
      ? ROLES.COMPANY
      : ROLES.FLEET
    : job.assignedMechanic?.role || ROLES.MECHANIC;
  const amountMinor = invoice
    ? Math.round(Number(invoice.totalAmount || 0) * 100)
    : Math.round(Number(job.finalAmount || job.acceptedAmount || 0) * 100);
  const now = new Date();
  const dispute = await Dispute.create({
    caseNo: caseNo(),
    caseType: "SERVICE_DISPUTE",
    title,
    description,
    reason: payload.reason || description,
    reasonCode: code,
    claimant: user._id,
    claimantRole: user.role,
    respondent: respondent._id || respondent,
    respondentRole,
    createdBy: user._id,
    company: job.fleet?._id || job.fleet,
    mechanic: job.assignedMechanic?._id || job.assignedMechanic,
    job: job._id,
    invoice: invoice?._id,
    customerName:
      job.fleet?.fleetProfile?.companyName ||
      job.assignedCompany?.companyProfile?.companyName ||
      null,
    serviceLabel: job.title || job.jobCode,
    amount: amountMinor / 100,
    amountMinor,
    currency: invoice?.currency || job.currency || "GBP",
    priority: `${payload.priority || "MEDIUM"}`.toUpperCase(),
    status: "OPEN",
    responseDueAt: new Date(now.getTime() + 24 * 60 * 60 * 1000),
    evidenceDueAt: new Date(now.getTime() + 48 * 60 * 60 * 1000),
    decisionDueAt: new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000),
    nextActionOwner: "ADMIN",
  });
  await recordEvent({
    dispute,
    actor: user,
    source: "USER",
    type: "CASE_OPENED",
    toStatus: "OPEN",
    reason: payload.reason,
    payload: { jobId: job._id, invoiceId: invoice?._id, reasonCode: code },
  });
  await DisputeTask.create({
    dispute: dispute._id,
    type: "ADMIN_TRIAGE",
    ownerType: "ADMIN",
    dueAt: dispute.responseDueAt,
  });
  await sealJobEvidence(dispute, job, user);
  await notifyCaseParty(
    respondent._id || respondent,
    dispute,
    `Dispute ${dispute.caseNo} opened`,
    `${userLabel(user)} opened a dispute for ${job.jobCode}.`
  );
  await notifyAdminsSafely({
    eventKey: ADMIN_NOTIFICATION_EVENTS.DISPUTE_OPENED,
    dedupeKey: `dispute-opened:${dispute._id}`,
    title: `New dispute ${dispute.caseNo}`,
    body: `${title} requires triage.`,
    data: {
      disputeId: dispute._id.toString(),
      jobId: job._id.toString(),
      invoiceId: invoice?._id?.toString?.() || null,
      screen: "ADMIN_DISPUTE",
    },
  });
  return getDisputeDetail(user, dispute._id);
};

const participantFilter = (user) =>
  user.role === ROLES.ADMIN
    ? {}
    : { $or: [{ claimant: user._id }, { respondent: user._id }] };

export const listEligibleDisputeJobs = async (user) => {
  const filter =
    user.role === ROLES.FLEET
      ? { fleet: user._id }
      : user.role === ROLES.COMPANY
        ? { assignedCompany: user._id }
        : isMechanicRole(user.role)
          ? { assignedMechanic: user._id }
          : {};
  if (user.role === ROLES.ADMIN) {
    throw new AppError("Admins must open cases on behalf of a selected claimant", 400);
  }
  return Job.find(filter)
    .sort({ updatedAt: -1 })
    .limit(100)
    .select("_id jobCode title status completedAt updatedAt")
    .lean();
};

export const listDisputesForUser = async (user, query = {}) => {
  const page = parsePage(query.page);
  const limit = parseLimit(query.limit);
  const filter = participantFilter(user);
  if (query.status) filter.status = `${query.status}`.trim().toUpperCase();
  if (query.priority) filter.priority = `${query.priority}`.trim().toUpperCase();
  if (query.assignedTo === "me" && user.role === ROLES.ADMIN) filter.assignedTo = user._id;
  if (query.queue === "unassigned") filter.assignedTo = { $exists: false };
  if (query.queue === "sla_risk") {
    filter.decisionDueAt = { $lte: new Date(Date.now() + 24 * 60 * 60 * 1000) };
    filter.status = { $in: ACTIVE_STATUSES };
  }
  if (query.queue === "awaiting") {
    filter.status = {
      $in: ["AWAITING_CUSTOMER_EVIDENCE", "AWAITING_PROVIDER_EVIDENCE"],
    };
  }
  if (query.queue === "stripe") {
    filter.caseType = "STRIPE_CHARGEBACK";
    filter.status = { $in: ACTIVE_STATUSES };
    filter.stripeEvidenceDueAt = { $ne: null };
  }
  if (query.queue === "resolved") {
    filter.status = { $in: ["RESOLVED", "CLOSED"] };
    filter.resolvedAt = {
      $gte: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000),
    };
  }
  if (query.search) {
    const regex = new RegExp(`${query.search}`.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
    filter.$and = [
      ...(filter.$and || []),
      { $or: [{ caseNo: regex }, { title: regex }, { serviceLabel: regex }] },
    ];
  }
  const [items, total] = await Promise.all([
    populateCase(
      Dispute.find(filter)
        .sort({ priority: -1, decisionDueAt: 1, updatedAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
    ).lean(),
    Dispute.countDocuments(filter),
  ]);
  return {
    items: items.map(serializeDispute),
    meta: { page, limit, total, totalPages: Math.ceil(total / limit) || 1 },
  };
};

export const getDisputeDetail = async (user, disputeId) => {
  const dispute = await populateCase(Dispute.findById(disputeId)).lean();
  if (!dispute) throw new AppError("Dispute not found", 404);
  assertCaseAccess(dispute, user);
  const messageFilter = { dispute: dispute._id };
  if (user.role !== ROLES.ADMIN) messageFilter.visibility = "PARTIES";
  const [events, messages, evidence, tasks, financialActions, refunds] =
    await Promise.all([
      DisputeEvent.find({ dispute: dispute._id })
        .sort({ createdAt: 1 })
        .populate("actor", "email role mechanicProfile.displayName fleetProfile.companyName companyProfile.companyName")
        .lean(),
      DisputeMessage.find(messageFilter)
        .sort({ createdAt: 1 })
        .populate("sender", "email role mechanicProfile.displayName fleetProfile.companyName companyProfile.companyName")
        .lean(),
      DisputeEvidence.find({ dispute: dispute._id })
        .sort({ createdAt: 1 })
        .populate("uploader", "email role")
        .lean(),
      DisputeTask.find({ dispute: dispute._id }).sort({ dueAt: 1 }).lean(),
      DisputeFinancialAction.find({ dispute: dispute._id })
        .sort({ createdAt: 1 })
        .lean(),
      Refund.find({ invoice: dispute.invoice?._id || dispute.invoice })
        .sort({ createdAt: 1 })
        .lean(),
    ]);
  return {
    ...serializeDispute(dispute),
    events,
    messages,
    evidence,
    tasks,
    financialActions,
    refunds,
    counts: {
      messages: messages.length,
      evidence: evidence.length,
      openTasks: tasks.filter((task) => task.status === "OPEN").length,
    },
  };
};

export const addDisputeMessage = async (user, disputeId, payload = {}) => {
  const dispute = await Dispute.findById(disputeId);
  if (!dispute) throw new AppError("Dispute not found", 404);
  assertCaseAccess(dispute, user);
  const body = `${payload.body || payload.message || ""}`.trim();
  if (!body) throw new AppError("message is required", 400);
  const internal = payload.internal === true;
  assertDisputeActionPermission(user, internal ? "INTERNAL_NOTE" : "PARTY_MESSAGE");
  if (internal && user.role !== ROLES.ADMIN) {
    throw new AppError("Only admins can add internal notes", 403);
  }
  const message = await DisputeMessage.create({
    dispute: dispute._id,
    sender: user._id,
    senderRole: user.role,
    visibility: internal ? "INTERNAL" : "PARTIES",
    body,
    readBy: [user._id],
  });
  await recordEvent({
    dispute,
    actor: user,
    source: user.role === ROLES.ADMIN ? "ADMIN" : "USER",
    type: internal ? "INTERNAL_NOTE_ADDED" : "MESSAGE_ADDED",
    payload: { messageId: message._id },
  });
  if (!internal) {
    const partyRecipients =
      user.role === ROLES.ADMIN
        ? [dispute.claimant, dispute.respondent]
        : [
            sameId(dispute.claimant, user._id)
              ? dispute.respondent
              : dispute.claimant,
          ];
    await Promise.all(
      partyRecipients
        .filter((recipient) => recipient && !sameId(recipient, user._id))
        .map((recipient) =>
          notifyCaseParty(
            recipient,
            dispute,
            `New message on ${dispute.caseNo}`,
            body.slice(0, 180)
          )
        )
    );
    if (user.role !== ROLES.ADMIN) {
      await notifyAdminsSafely({
        eventKey: ADMIN_NOTIFICATION_EVENTS.DISPUTE_MESSAGE,
        type: "ADMIN_DISPUTE_MESSAGE",
        dedupeKey: `dispute-message:${message._id}`,
        title: `New message on ${dispute.caseNo}`,
        body: `${userLabel(user) || user.role}: ${body.slice(0, 160)}`,
        data: {
          disputeId: dispute._id.toString(),
          caseNo: dispute.caseNo,
          jobId: idOf(dispute.job) || null,
          messageId: message._id.toString(),
          screen: "ADMIN_DISPUTE",
        },
      });
    }
  }
  return message.toObject();
};

export const addDisputeEvidenceMetadata = async (user, disputeId, payload = {}) => {
  const dispute = await Dispute.findById(disputeId);
  if (!dispute) throw new AppError("Dispute not found", 404);
  assertCaseAccess(dispute, user);
  const mimeType = `${payload.mimeType || ""}`.trim().toLowerCase();
  const allowed = ["image/jpeg", "image/png", "image/webp", "application/pdf"];
  if (!allowed.includes(mimeType)) throw new AppError("Unsupported evidence file type", 400);
  const size = Number(payload.size);
  if (!Number.isFinite(size) || size < 1 || size > 10 * 1024 * 1024) {
    throw new AppError("Evidence must be between 1 byte and 10 MB", 400);
  }
  if (!payload.storageKey || !payload.sha256 || !payload.originalName) {
    throw new AppError("storageKey, sha256, and originalName are required", 400);
  }
  const representedParty =
    user.role === ROLES.ADMIN
      ? "ADMIN"
      : sameId(dispute.claimant, user._id)
        ? "CLAIMANT"
        : "RESPONDENT";
  const evidence = await DisputeEvidence.create({
    dispute: dispute._id,
    uploader: user._id,
    uploaderRole: user.role,
    representedParty,
    originalName: payload.originalName,
    storageKey: payload.storageKey,
    mimeType,
    size,
    sha256: `${payload.sha256}`.toLowerCase(),
    source: "UPLOAD",
    scanStatus: payload.scanStatus === "CLEAN" ? "CLEAN" : "PENDING",
    description: payload.description,
  });
  await recordEvent({
    dispute,
    actor: user,
    source: user.role === ROLES.ADMIN ? "ADMIN" : "USER",
    type: "EVIDENCE_ADDED",
    payload: { evidenceId: evidence._id, originalName: evidence.originalName },
  });
  return evidence.toObject();
};

export const uploadDisputeEvidence = async (
  user,
  disputeId,
  file,
  payload = {}
) => {
  assertDisputeActionPermission(user, "UPLOAD_EVIDENCE");
  const dispute = await Dispute.findById(disputeId);
  if (!dispute) throw new AppError("Dispute not found", 404);
  assertCaseAccess(dispute, user);
  if (["CLOSED"].includes(dispute.status) || dispute.legalHold?.active) {
    throw new AppError("Evidence cannot be changed on this case", 400);
  }
  const count = await DisputeEvidence.countDocuments({ dispute: dispute._id });
  if (count >= 20) throw new AppError("This case has reached the 20-file evidence limit", 400);
  const stored = await storePrivateEvidence({ disputeId: dispute._id, file });
  const representedParty =
    user.role === ROLES.ADMIN
      ? "ADMIN"
      : sameId(dispute.claimant, user._id)
        ? "CLAIMANT"
        : "RESPONDENT";
  const evidence = await DisputeEvidence.create({
    dispute: dispute._id,
    uploader: user._id,
    uploaderRole: user.role,
    representedParty,
    originalName: file.originalname,
    ...stored,
    scanStatus:
      process.env.NODE_ENV === "production" ? "PENDING" : "UNAVAILABLE",
    source: "UPLOAD",
    description: payload.description,
  });
  await recordEvent({
    dispute,
    actor: user,
    source: user.role === ROLES.ADMIN ? "ADMIN" : "USER",
    type: "EVIDENCE_UPLOADED",
    payload: {
      evidenceId: evidence._id,
      originalName: evidence.originalName,
      sha256: evidence.sha256,
      size: evidence.size,
    },
  });
  return evidence.toObject();
};

export const downloadDisputeEvidence = async (user, disputeId, evidenceId) => {
  const dispute = await Dispute.findById(disputeId);
  if (!dispute) throw new AppError("Dispute not found", 404);
  assertCaseAccess(dispute, user);
  const evidence = await DisputeEvidence.findOne({
    _id: evidenceId,
    dispute: dispute._id,
  }).lean();
  if (!evidence) throw new AppError("Evidence not found", 404);
  if (
    user.role !== ROLES.ADMIN &&
    !["CLEAN", "UNAVAILABLE"].includes(evidence.scanStatus)
  ) {
    throw new AppError("Evidence is not available until security review completes", 403);
  }
  return {
    evidence,
    location: await resolvePrivateEvidence(evidence.storageKey),
  };
};

export const reviewDisputeEvidence = async (
  admin,
  disputeId,
  evidenceId,
  payload = {}
) => {
  assertDisputeActionPermission(admin, "REVIEW_EVIDENCE");
  const scanStatus = `${payload.scanStatus || ""}`.toUpperCase();
  if (!["CLEAN", "REJECTED"].includes(scanStatus)) {
    throw new AppError("scanStatus must be CLEAN or REJECTED", 400);
  }
  const evidence = await DisputeEvidence.findOneAndUpdate(
    { _id: evidenceId, dispute: disputeId },
    { $set: { scanStatus } },
    { new: true }
  );
  if (!evidence) throw new AppError("Evidence not found", 404);
  const dispute = await Dispute.findById(disputeId);
  await recordEvent({
    dispute,
    actor: admin,
    source: "ADMIN",
    type: "EVIDENCE_SECURITY_REVIEWED",
    reason: payload.reason,
    payload: { evidenceId: evidence._id, scanStatus },
  });
  return evidence.toObject();
};

export const assignDispute = async (admin, disputeId, payload = {}) => {
  assertDisputeActionPermission(admin, "ASSIGN_CASE");
  const dispute = await Dispute.findById(disputeId);
  if (!dispute) throw new AppError("Dispute not found", 404);
  const expectedVersion = Number(payload.version);
  if (expectedVersion && expectedVersion !== dispute.versionNumber) {
    throw new AppError("This dispute was updated by another admin. Refresh and retry.", 409);
  }
  dispute.assignedTo = payload.assignedTo || admin._id;
  dispute.assignedTeam = payload.assignedTeam || "DISPUTES";
  dispute.versionNumber += 1;
  await dispute.save();
  await recordEvent({
    dispute,
    actor: admin,
    source: "ADMIN",
    type: "CASE_ASSIGNED",
    payload: { assignedTo: dispute.assignedTo, assignedTeam: dispute.assignedTeam },
  });
  return getDisputeDetail(admin, dispute._id);
};

export const transitionDispute = async (admin, disputeId, payload = {}) => {
  assertDisputeActionPermission(admin, "TRANSITION_CASE");
  const nextStatus = `${payload.status || ""}`.trim().toUpperCase();
  const reason = `${payload.reason || ""}`.trim();
  if (!nextStatus || !reason) throw new AppError("status and reason are required", 400);
  const dispute = await Dispute.findById(disputeId);
  if (!dispute) throw new AppError("Dispute not found", 404);
  const expectedVersion = Number(payload.version);
  if (expectedVersion && expectedVersion !== dispute.versionNumber) {
    throw new AppError("This dispute was updated by another admin. Refresh and retry.", 409);
  }
  if (!(TRANSITIONS[dispute.status] || []).includes(nextStatus)) {
    throw new AppError(`Cannot transition ${dispute.status} to ${nextStatus}`, 400);
  }
  const fromStatus = dispute.status;
  dispute.status = nextStatus;
  dispute.versionNumber += 1;
  dispute.nextActionOwner =
    nextStatus === "AWAITING_CUSTOMER_EVIDENCE"
      ? "CLAIMANT"
      : nextStatus === "AWAITING_PROVIDER_EVIDENCE"
        ? "RESPONDENT"
        : nextStatus === "CLOSED"
          ? "NONE"
          : "ADMIN";
  if (nextStatus === "RESOLVED") {
    if (!dispute.decision?.outcome) {
      throw new AppError("Record a formal decision before resolving the dispute", 400);
    }
    dispute.resolvedAt = new Date();
    dispute.resolvedBy = admin._id;
  }
  if (nextStatus === "CLOSED") dispute.closedAt = new Date();
  await dispute.save();
  await recordEvent({
    dispute,
    actor: admin,
    source: "ADMIN",
    type: "STATUS_CHANGED",
    fromStatus,
    toStatus: nextStatus,
    reason,
    correlationId: payload.idempotencyKey,
  });
  await Promise.all([
    notifyCaseParty(dispute.claimant, dispute, `${dispute.caseNo} updated`, `Status changed to ${nextStatus}.`),
    notifyCaseParty(dispute.respondent, dispute, `${dispute.caseNo} updated`, `Status changed to ${nextStatus}.`),
  ]);
  return getDisputeDetail(admin, dispute._id);
};

export const decideDispute = async (admin, disputeId, payload = {}) => {
  assertDisputeActionPermission(admin, "DECIDE_CASE");
  const dispute = await Dispute.findById(disputeId);
  if (!dispute) throw new AppError("Dispute not found", 404);
  const expectedVersion = Number(payload.version);
  if (expectedVersion && expectedVersion !== dispute.versionNumber) {
    throw new AppError("This dispute was updated by another admin. Refresh and retry.", 409);
  }
  if (!["DECISION_PENDING", "INVESTIGATING", "ESCALATED"].includes(dispute.status)) {
    throw new AppError("Move the case into investigation or decision pending first", 400);
  }
  const outcome = `${payload.outcome || ""}`.trim().toUpperCase();
  const allowed = [
    "NO_ACTION",
    "PARTIAL_REFUND",
    "FULL_REFUND",
    "REATTENDANCE",
    "SERVICE_CREDIT",
  ];
  if (!allowed.includes(outcome)) throw new AppError("A valid remedy is required", 400);
  const findings = `${payload.findings || ""}`.trim();
  const rationale = `${payload.rationale || ""}`.trim();
  if (findings.length < 10 || rationale.length < 10) {
    throw new AppError("Findings and rationale must each be at least 10 characters", 400);
  }
  let amountMinor = Number(payload.amountMinor || 0);
  if (outcome === "FULL_REFUND") amountMinor = dispute.amountMinor;
  if (["PARTIAL_REFUND", "SERVICE_CREDIT"].includes(outcome)) {
    if (!Number.isInteger(amountMinor) || amountMinor <= 0 || amountMinor > dispute.amountMinor) {
      throw new AppError("Decision amount must be positive and no greater than the disputed amount", 400);
    }
  } else if (!["FULL_REFUND"].includes(outcome)) {
    amountMinor = 0;
  }
  const correlationId =
    `${payload.idempotencyKey || ""}`.trim() ||
    `decision:${dispute._id}:${dispute.versionNumber + 1}`;
  const existingEvent = await DisputeEvent.findOne({
    dispute: dispute._id,
    correlationId,
  }).lean();
  if (existingEvent) return getDisputeDetail(admin, dispute._id);

  const fromStatus = dispute.status;
  dispute.decision = {
    outcome,
    findings,
    rationale,
    amountMinor,
    decidedBy: admin._id,
    decidedAt: new Date(),
    idempotencyKey: correlationId,
  };
  dispute.status = "RESOLVED";
  dispute.resolvedAt = new Date();
  dispute.resolvedBy = admin._id;
  dispute.nextActionOwner = "NONE";
  dispute.versionNumber += 1;
  if (["PARTIAL_REFUND", "FULL_REFUND", "SERVICE_CREDIT"].includes(outcome)) {
    dispute.financialState = "REFUND_PENDING";
  }
  await dispute.save();
  await recordEvent({
    dispute,
    actor: admin,
    source: "ADMIN",
    type: "DECISION_RECORDED",
    fromStatus,
    toStatus: "RESOLVED",
    reason: rationale,
    correlationId,
    payload: { outcome, findings, amountMinor },
  });
  if (["PARTIAL_REFUND", "FULL_REFUND", "SERVICE_CREDIT"].includes(outcome)) {
    if (!dispute.invoice) throw new AppError("A financial remedy requires an invoice", 400);
    const highValueThreshold = Math.round(
      Number(process.env.DISPUTE_SECOND_APPROVAL_THRESHOLD || 1000) * 100
    );
    await DisputeFinancialAction.findOneAndUpdate(
      { idempotencyKey: correlationId },
      {
        $setOnInsert: {
          dispute: dispute._id,
          invoice: dispute.invoice,
          requestedBy: admin._id,
          type: outcome === "SERVICE_CREDIT" ? "SERVICE_CREDIT" : "REFUND",
          amountMinor,
          currency: dispute.currency,
          status: amountMinor >= highValueThreshold ? "PENDING_APPROVAL" : "APPROVED",
          idempotencyKey: correlationId,
        },
      },
      { upsert: true, new: true }
    );
  }
  await Promise.all([
    notifyCaseParty(dispute.claimant, dispute, `${dispute.caseNo} decided`, `Decision: ${outcome.replaceAll("_", " ")}.`),
    notifyCaseParty(dispute.respondent, dispute, `${dispute.caseNo} decided`, `Decision: ${outcome.replaceAll("_", " ")}.`),
  ]);
  return getDisputeDetail(admin, dispute._id);
};

export const executeDisputeFinancialAction = async (admin, disputeId, actionId) => {
  assertDisputeActionPermission(admin, "EXECUTE_REMEDY");
  const dispute = await Dispute.findById(disputeId);
  if (!dispute) throw new AppError("Dispute not found", 404);
  const action = await DisputeFinancialAction.findOne({
    _id: actionId,
    dispute: dispute._id,
  });
  if (!action) throw new AppError("Financial action not found", 404);
  if (action.status === "SUCCEEDED") return getDisputeDetail(admin, dispute._id);
  if (action.status !== "APPROVED") {
    throw new AppError("Financial action requires approval before execution", 400);
  }
  if (action.type !== "REFUND") {
    action.status = "SUCCEEDED";
    action.processedAt = new Date();
    await action.save();
    dispute.financialState = "RECONCILED";
    await dispute.save();
    return getDisputeDetail(admin, dispute._id);
  }
  const invoice = await Invoice.findById(action.invoice);
  if (!invoice) throw new AppError("Invoice not found", 404);
  if (!invoice.payment?.stripePaymentIntentId) {
    throw new AppError("The linked invoice has no Stripe payment to refund", 400);
  }
  action.status = "PROCESSING";
  await action.save();
  try {
    const stripeRefund = await createStripeRefund({
      paymentIntentId: invoice.payment.stripePaymentIntentId,
      amount: action.amountMinor / 100,
      reason: "requested_by_customer",
      idempotencyKey: action.idempotencyKey,
      metadata: {
        invoiceId: invoice._id.toString(),
        jobId: invoice.job.toString(),
        disputeId: dispute._id.toString(),
        caseNo: dispute.caseNo,
        adminId: admin._id.toString(),
      },
    });
    const result = await applyStripeRefundToInvoice(stripeRefund, {
      source: "ADMIN",
      initiatedBy: admin._id,
      reason: `Approved dispute ${dispute.caseNo}: ${dispute.decision?.rationale}`,
    });
    action.status = "SUCCEEDED";
    action.processedAt = new Date();
    action.refund = result.refundId;
    await action.save();
    dispute.financialState =
      action.amountMinor >= dispute.amountMinor ? "FULLY_ADJUSTED" : "PARTIALLY_ADJUSTED";
    dispute.versionNumber += 1;
    await dispute.save();
    await recordEvent({
      dispute,
      actor: admin,
      source: "ADMIN",
      type: "FINANCIAL_ACTION_SUCCEEDED",
      correlationId: `financial:${action.idempotencyKey}`,
      payload: {
        actionId: action._id,
        refundId: result.refundId,
        amountMinor: action.amountMinor,
      },
    });
  } catch (error) {
    action.status = "FAILED";
    action.failureReason = error?.message || "Refund failed";
    await action.save();
    await recordEvent({
      dispute,
      actor: admin,
      source: "ADMIN",
      type: "FINANCIAL_ACTION_FAILED",
      correlationId: `financial-failed:${action.idempotencyKey}`,
      reason: action.failureReason,
      payload: { actionId: action._id },
    });
    throw error;
  }
  return getDisputeDetail(admin, dispute._id);
};

export const approveDisputeFinancialAction = async (
  admin,
  disputeId,
  actionId
) => {
  const action = await DisputeFinancialAction.findOne({
    _id: actionId,
    dispute: disputeId,
  });
  if (!action) throw new AppError("Financial action not found", 404);
  if (action.status === "PENDING_APPROVAL") {
    if (sameId(action.requestedBy, admin._id)) {
      throw new AppError("High-value remedies require approval by a different admin", 403);
    }
    action.status = "APPROVED";
    action.approvedBy = admin._id;
    await action.save();
  }
  return executeDisputeFinancialAction(admin, disputeId, actionId);
};

export const requestDisputeAppeal = async (user, disputeId, payload = {}) => {
  const dispute = await Dispute.findById(disputeId);
  if (!dispute) throw new AppError("Dispute not found", 404);
  assertCaseAccess(dispute, user);
  if (dispute.status !== "RESOLVED") throw new AppError("Only resolved disputes can be appealed", 400);
  const reason = `${payload.reason || ""}`.trim();
  if (reason.length < 10) throw new AppError("Appeal reason must be at least 10 characters", 400);
  dispute.status = "APPEALED";
  dispute.appeal = { requestedBy: user._id, reason, requestedAt: new Date() };
  dispute.versionNumber += 1;
  dispute.nextActionOwner = "ADMIN";
  await dispute.save();
  await recordEvent({
    dispute,
    actor: user,
    source: "USER",
    type: "APPEAL_REQUESTED",
    fromStatus: "RESOLVED",
    toStatus: "APPEALED",
    reason,
  });
  return getDisputeDetail(user, dispute._id);
};

export const escalateSupportTicketToDispute = async (user, ticketId, payload = {}) => {
  const ticket = await SupportTicket.findById(ticketId).lean();
  if (!ticket) throw new AppError("Support ticket not found", 404);
  if (ticket.category !== "JOB_ISSUE" || !ticket.job) {
    throw new AppError("Only job-issue tickets linked to a job can be escalated", 400);
  }
  if (ticket.dispute) throw new AppError("This ticket is already linked to a dispute", 409);
  if (user.role !== ROLES.ADMIN && !sameId(ticket.user, user._id)) {
    throw new AppError("Forbidden", 403);
  }
  const dispute = await createParticipantDispute(
    user.role === ROLES.ADMIN ? await import("../user/user.model.js").then(({ User }) => User.findById(ticket.user)) : user,
    {
      jobId: ticket.job,
      title: payload.title || ticket.subject,
      description: payload.description || ticket.message,
      reasonCode: payload.reasonCode || "OTHER",
      reason: payload.reason || "Escalated from support",
    }
  );
  await SupportTicket.updateOne({ _id: ticket._id }, { $set: { dispute: dispute._id } });
  await Dispute.updateOne({ _id: dispute._id }, { $set: { supportTicket: ticket._id } });
  return getDisputeDetail(user, dispute._id);
};

// Backward-compatible service names used by existing controllers.
export const createFleetDispute = createParticipantDispute;
export const listFleetDisputes = listDisputesForUser;
export const listMechanicDisputes = listDisputesForUser;
export const getMechanicDisputeById = getDisputeDetail;
export const updateFleetDispute = async (user, disputeId, payload) =>
  addDisputeMessage(user, disputeId, {
    body: payload.notes || payload.description || payload.reason || "Dispute updated",
  });
export const updateMechanicDispute = updateFleetDispute;

export { ACTIVE_STATUSES, TRANSITIONS, recordEvent, assertCaseAccess };
