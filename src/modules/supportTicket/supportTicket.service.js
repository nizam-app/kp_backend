import AppError from "../../utils/AppError.js";
import { SupportTicket, SUPPORT_TICKET_CATEGORIES } from "./supportTicket.model.js";
import { createNotification } from "../notification/notification.service.js";
import { User } from "../user/user.model.js";
import { Job } from "../job/job.model.js";
import { ROLES } from "../../constants/domain.js";
import { resolveJobRef } from "../job/job.service.js";

const parsePage = (value) => {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 1;
};

const parseLimit = (value) => {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return 20;
  return Math.min(Math.floor(n), 100);
};

const STATUS_LABELS = {
  OPEN: "Waiting for support",
  IN_PROGRESS: "Support is reviewing",
  RESOLVED: "Resolved",
  CLOSED: "Closed",
};

const CATEGORY_LABELS = {
  GENERAL: "General",
  BILLING: "Billing & payments",
  JOB_ISSUE: "Job issue",
  ACCOUNT: "Account & profile",
  TECHNICAL: "Technical",
};

const logOpsEmail = (subject, body) => {
  const to = process.env.SUPPORT_OPS_EMAIL;
  if (!to) return;
  console.info(`[support-email] To: ${to} | ${subject} | ${body}`);
};

const nextTicketRef = async () => {
  const count = await SupportTicket.countDocuments();
  return `ST-${String(count + 1).padStart(5, "0")}`;
};

const notifyUsers = async (userIds, payload) => {
  const ids = [...new Set((userIds || []).filter(Boolean).map((id) => `${id}`))];
  if (!ids.length) return;
  await Promise.all(
    ids.map((userId) =>
      createNotification({
        user: userId,
        ...payload,
      })
    )
  );
};

const notifyAdmins = async (payload) => {
  const admins = await User.find({ role: ROLES.ADMIN }).select("_id").lean();
  await notifyUsers(
    admins.map((a) => a._id),
    payload
  );
};

const resolveJobForUser = async (user, jobRef) => {
  const raw = `${jobRef || ""}`.trim();
  if (!raw) return { job: null, jobCode: null };

  const jobId = await resolveJobRef(raw);
  const job = await Job.findById(jobId).select("_id jobCode fleet").lean();
  if (!job) throw new AppError("Linked job not found", 404);
  if (user.role === ROLES.FLEET && `${job.fleet}` !== `${user._id}`) {
    throw new AppError("You can only link your own jobs", 403);
  }
  return { job: job._id, jobCode: job.jobCode || null };
};

const serializeTicket = (ticket, { includeInternalReplies = false } = {}) => {
  let replies =
    ticket.replies?.map((reply) => ({
      _id: reply._id,
      sender: reply.sender
        ? {
            _id: reply.sender._id || reply.sender,
            email: reply.sender.email || null,
            role: reply.sender.role || reply.role || null,
            displayName:
              reply.sender.fleetProfile?.companyName ||
              reply.sender.mechanicProfile?.displayName ||
              reply.sender.adminProfile?.displayName ||
              null,
          }
        : null,
      role: reply.role || null,
      message: reply.message,
      internal: Boolean(reply.internal),
      createdAt: reply.createdAt,
    })) || [];

  if (!includeInternalReplies) {
    replies = replies.filter((reply) => !reply.internal);
  }

  return {
    _id: ticket._id,
    ticketRef: ticket.ticketRef || null,
    subject: ticket.subject,
    message: ticket.message,
    category: ticket.category,
    categoryLabel: CATEGORY_LABELS[ticket.category] || ticket.category,
    status: ticket.status,
    statusLabel: STATUS_LABELS[ticket.status] || ticket.status,
    job: ticket.job || null,
    jobCode: ticket.jobCode || null,
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

const ensureTicketAccess = (ticket, user) => {
  const isOwner = ticket.user.toString() === user._id.toString();
  const isAdmin = user.role === ROLES.ADMIN;
  if (!isOwner && !isAdmin) {
    throw new AppError("Forbidden", 403);
  }
  return { isOwner, isAdmin };
};

const normalizeStatus = (value) => `${value || ""}`.trim().toUpperCase();

/** True when support (admin) has replied or taken ownership. */
const ticketHasAdminEngagement = (ticket) => {
  if (ticket.assignedTo) return true;
  return (ticket.replies || []).some(
    (reply) => `${reply.role || ""}`.trim().toUpperCase() === ROLES.ADMIN
  );
};

/** IN_PROGRESS without any admin engagement should be waiting for support. */
const ticketShouldWaitForSupport = (ticket) =>
  `${ticket.status || ""}`.trim().toUpperCase() === "IN_PROGRESS" &&
  !ticketHasAdminEngagement(ticket);

/** Reset tickets mis-filed as in-progress after customer-only replies. */
export const reconcileMisfiledSupportTickets = async () => {
  const candidates = await SupportTicket.find({ status: "IN_PROGRESS" }).lean();
  const toFix = candidates.filter(ticketShouldWaitForSupport);
  if (!toFix.length) {
    return { matched: candidates.length, fixed: 0, ticketRefs: [] };
  }

  await SupportTicket.updateMany(
    { _id: { $in: toFix.map((t) => t._id) } },
    { $set: { status: "OPEN" }, $unset: { resolvedAt: "" } }
  );

  return {
    matched: candidates.length,
    fixed: toFix.length,
    ticketRefs: toFix.map((t) => t.ticketRef || `${t._id}`),
  };
};

const reconcileTicketIfNeeded = async (ticketLike) => {
  if (!ticketShouldWaitForSupport(ticketLike)) return ticketLike;
  await SupportTicket.updateOne(
    { _id: ticketLike._id, status: "IN_PROGRESS" },
    { $set: { status: "OPEN" }, $unset: { resolvedAt: "" } }
  );
  return { ...ticketLike, status: "OPEN", resolvedAt: undefined };
};

export { reconcileTicketIfNeeded as reconcileSupportTicketIfNeeded };

export const createSupportTicket = async (user, payload = {}) => {
  const subject = `${payload.subject || ""}`.trim();
  const message = `${payload.message || ""}`.trim();
  if (!subject) throw new AppError("subject is required", 400);
  if (!message) throw new AppError("message is required", 400);

  const categoryRaw = `${payload.category || "GENERAL"}`.trim().toUpperCase();
  const category = SUPPORT_TICKET_CATEGORIES.includes(categoryRaw)
    ? categoryRaw
    : "GENERAL";

  const { job, jobCode } = await resolveJobForUser(user, payload.jobId || payload.jobCode);

  const ticketRef = await nextTicketRef();
  const ticket = await SupportTicket.create({
    user: user._id,
    ticketRef,
    subject,
    message,
    category,
    ...(job ? { job, jobCode } : {}),
  });

  const refLabel = ticket.ticketRef || ticket._id.toString().slice(-6);

  await notifyUsers([user._id], {
    type: "SUPPORT_TICKET_CREATED",
    title: `Ticket ${refLabel} submitted`,
    body: `We received your request (“${subject}”). Support typically responds within one business day.`,
    data: {
      ticketId: ticket._id.toString(),
      ticketRef: refLabel,
      category: ticket.category,
      screen: "SUPPORT_TICKET",
    },
  });

  await notifyAdmins({
    type: "SUPPORT_TICKET_CREATED",
    title: `New support ticket ${refLabel}`,
    body: `${subject} — ${CATEGORY_LABELS[category] || category}`,
    data: {
      ticketId: ticket._id.toString(),
      ticketRef: refLabel,
      category: ticket.category,
      screen: "ADMIN_SUPPORT",
    },
  });

  logOpsEmail(
    `[TruckFix] New ticket ${refLabel}: ${subject}`,
    `Category: ${category}\nUser: ${user.email}\n\n${message}`
  );

  return serializeTicket(ticket);
};

export const listSupportTickets = async (user, query = {}) => {
  const page = parsePage(query.page);
  const limit = parseLimit(query.limit);
  const skip = (page - 1) * limit;

  const filter = { user: user._id };
  if (query.status) filter.status = `${query.status}`.trim().toUpperCase();

  const [rawItems, total] = await Promise.all([
    SupportTicket.find(filter)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .lean(),
    SupportTicket.countDocuments(filter),
  ]);

  const items = await Promise.all(rawItems.map((t) => reconcileTicketIfNeeded(t)));

  return {
    items: items.map((t) => serializeTicket(t)),
    meta: {
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit) || 1,
    },
  };
};

export const updateSupportTicket = async (user, ticketId, payload = {}) => {
  const ticket = await SupportTicket.findById(ticketId);
  if (!ticket) throw new AppError("Support ticket not found", 404);

  const { isOwner, isAdmin } = ensureTicketAccess(ticket, user);

  if (payload.status !== undefined) {
    const nextStatus = normalizeStatus(payload.status);
    const allowedStatuses = isAdmin
      ? ["OPEN", "IN_PROGRESS", "RESOLVED", "CLOSED"]
      : ["OPEN", "CLOSED"];

    if (!allowedStatuses.includes(nextStatus)) {
      throw new AppError(
        `status must be one of ${allowedStatuses.join(", ")}`,
        400
      );
    }

    ticket.status = nextStatus;
    if (["RESOLVED", "CLOSED"].includes(nextStatus)) {
      ticket.resolvedAt = ticket.resolvedAt || new Date();
    }
    if (nextStatus === "OPEN") {
      ticket.resolvedAt = undefined;
      if (!isAdmin) ticket.resolution = undefined;
    }
  }

  if (payload.assignedTo !== undefined && isAdmin) {
    ticket.assignedTo = payload.assignedTo || undefined;
  }

  if (payload.resolution !== undefined) {
    if (!isAdmin && normalizeStatus(payload.status) !== "CLOSED") {
      throw new AppError("Only admins can set resolution notes directly", 403);
    }
    ticket.resolution = `${payload.resolution || ""}`.trim() || undefined;
  }

  await ticket.save();

  if (isAdmin && ticket.user) {
    await notifyUsers([ticket.user], {
      type: "SUPPORT_TICKET_UPDATED",
      title: `Ticket ${ticket.ticketRef || ticket.subject} updated`,
      body: `Status is now “${STATUS_LABELS[ticket.status] || ticket.status}”.`,
      data: {
        ticketId: ticket._id.toString(),
        ticketRef: ticket.ticketRef,
        status: ticket.status,
        screen: "SUPPORT_TICKET",
      },
    });
  }

  return serializeTicket(ticket);
};

export const getSupportTicketById = async (user, ticketId) => {
  const ticket = await SupportTicket.findById(ticketId)
    .populate("assignedTo", "email role")
    .populate("replies.sender", "email role fleetProfile.companyName mechanicProfile.displayName adminProfile.displayName");
  if (!ticket) throw new AppError("Support ticket not found", 404);

  if (ticketShouldWaitForSupport(ticket)) {
    ticket.status = "OPEN";
    ticket.resolvedAt = undefined;
    await ticket.save();
  }

  const { isAdmin } = ensureTicketAccess(ticket, user);
  return serializeTicket(ticket, { includeInternalReplies: isAdmin });
};

export const addSupportTicketReply = async (user, ticketId, payload = {}) => {
  const ticket = await SupportTicket.findById(ticketId)
    .populate("assignedTo", "email role")
    .populate("replies.sender", "email role fleetProfile.companyName mechanicProfile.displayName adminProfile.displayName");
  if (!ticket) throw new AppError("Support ticket not found", 404);

  const { isAdmin } = ensureTicketAccess(ticket, user);
  const message = `${payload.message || ""}`.trim();
  if (!message) throw new AppError("message is required", 400);

  const internal = payload.internal === true;
  if (internal && !isAdmin) {
    throw new AppError("Only admins can create internal replies", 403);
  }

  ticket.replies.push({
    sender: user._id,
    role: user.role,
    message,
    internal,
    createdAt: new Date(),
  });

  // Only move to "in progress" when support engages — not when the customer adds follow-ups.
  if (isAdmin && ticket.status === "OPEN") {
    ticket.status = "IN_PROGRESS";
  }
  if (payload.status !== undefined) {
    const nextStatus = `${payload.status}`.trim().toUpperCase();
    const allowedStatuses = isAdmin
      ? ["OPEN", "IN_PROGRESS", "RESOLVED", "CLOSED"]
      : ["OPEN", "CLOSED"];
    if (!allowedStatuses.includes(nextStatus)) {
      throw new AppError(
        `status must be one of ${allowedStatuses.join(", ")}`,
        400
      );
    }
    ticket.status = nextStatus;
  }

  if (isAdmin && payload.resolution !== undefined) {
    ticket.resolution = `${payload.resolution || ""}`.trim() || undefined;
  }

  if (["RESOLVED", "CLOSED"].includes(ticket.status) && !ticket.resolvedAt) {
    ticket.resolvedAt = new Date();
  }
  if (ticket.status === "OPEN") {
    ticket.resolvedAt = undefined;
  }

  if (isAdmin && !ticket.assignedTo) {
    ticket.assignedTo = user._id;
  }

  await ticket.save();

  const refLabel = ticket.ticketRef || ticket._id.toString().slice(-6);

  if (isAdmin) {
    await notifyUsers([ticket.user], {
      type: "SUPPORT_TICKET_REPLY",
      title: `Support replied on ${refLabel}`,
      body: message.length > 120 ? `${message.slice(0, 117)}...` : message,
      data: {
        ticketId: ticket._id.toString(),
        ticketRef: refLabel,
        status: ticket.status,
        screen: "SUPPORT_TICKET",
      },
    });
  } else {
    const adminIds = [];
    if (ticket.assignedTo) {
      adminIds.push(ticket.assignedTo._id || ticket.assignedTo);
    } else {
      const admins = await User.find({ role: ROLES.ADMIN }).select("_id").lean();
      adminIds.push(...admins.map((a) => a._id));
    }
    await notifyUsers(adminIds, {
      type: "SUPPORT_TICKET_REPLY",
      title: `Customer reply on ${refLabel}`,
      body: message.length > 120 ? `${message.slice(0, 117)}...` : message,
      data: {
        ticketId: ticket._id.toString(),
        ticketRef: refLabel,
        status: ticket.status,
        screen: "ADMIN_SUPPORT",
      },
    });
    logOpsEmail(
      `[TruckFix] Reply on ${refLabel}`,
      `From: ${user.email}\n\n${message}`
    );
  }

  const fresh = await SupportTicket.findById(ticket._id)
    .populate("assignedTo", "email role")
    .populate("replies.sender", "email role fleetProfile.companyName mechanicProfile.displayName adminProfile.displayName");

  return serializeTicket(fresh, { includeInternalReplies: isAdmin });
};
