import AppError from "../../utils/AppError.js";
import { SupportTicket } from "./supportTicket.model.js";
import { createNotification } from "../notification/notification.service.js";

const parsePage = (value) => {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 1;
};

const parseLimit = (value) => {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return 20;
  return Math.min(Math.floor(n), 100);
};

const serializeTicket = (ticket) => ({
  _id: ticket._id,
  subject: ticket.subject,
  message: ticket.message,
  category: ticket.category,
  status: ticket.status,
  assignedTo: ticket.assignedTo
    ? {
        _id: ticket.assignedTo._id || ticket.assignedTo,
        email: ticket.assignedTo.email || null,
      }
    : null,
  resolution: ticket.resolution || null,
  resolvedAt: ticket.resolvedAt || null,
  replies:
    ticket.replies?.map((reply) => ({
      _id: reply._id,
      sender: reply.sender
        ? {
            _id: reply.sender._id || reply.sender,
            email: reply.sender.email || null,
            role: reply.sender.role || reply.role || null,
          }
        : null,
      role: reply.role || null,
      message: reply.message,
      internal: Boolean(reply.internal),
      createdAt: reply.createdAt,
    })) || [],
  repliesCount: ticket.replies?.length || 0,
  createdAt: ticket.createdAt,
  updatedAt: ticket.updatedAt,
});

const ensureTicketAccess = (ticket, user) => {
  const isOwner = ticket.user.toString() === user._id.toString();
  const isAdmin = user.role === "ADMIN";
  if (!isOwner && !isAdmin) {
    throw new AppError("Forbidden", 403);
  }
  return { isOwner, isAdmin };
};

const normalizeStatus = (value) =>
  `${value || ""}`.trim().toUpperCase();

export const createSupportTicket = async (user, payload = {}) => {
  const subject = `${payload.subject || ""}`.trim();
  const message = `${payload.message || ""}`.trim();
  if (!subject) throw new AppError("subject is required", 400);
  if (!message) throw new AppError("message is required", 400);

  const ticket = await SupportTicket.create({
    user: user._id,
    subject,
    message,
    category: `${payload.category || "GENERAL"}`.trim() || "GENERAL",
  });

  await createNotification({
    user: user._id,
    type: "SUPPORT_TICKET_CREATED",
    title: `Support ticket opened: ${subject}`,
    body: "TruckFix support has received your case.",
    data: {
      ticketId: ticket._id.toString(),
      category: ticket.category,
    },
  });

  return serializeTicket(ticket);
};

export const listSupportTickets = async (user, query = {}) => {
  const page = parsePage(query.page);
  const limit = parseLimit(query.limit);
  const skip = (page - 1) * limit;

  const filter = { user: user._id };
  if (query.status) filter.status = `${query.status}`.trim().toUpperCase();

  const [items, total] = await Promise.all([
    SupportTicket.find(filter)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .lean(),
    SupportTicket.countDocuments(filter),
  ]);

  return {
    items: items.map(serializeTicket),
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

  const { isAdmin } = ensureTicketAccess(ticket, user);

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

  if (payload.resolution !== undefined) {
    if (!isAdmin && normalizeStatus(payload.status) !== "CLOSED") {
      throw new AppError("Only admins can set resolution notes directly", 403);
    }
    ticket.resolution = `${payload.resolution || ""}`.trim() || undefined;
  }

  await ticket.save();

  if (isAdmin && ticket.user) {
    await createNotification({
      user: ticket.user,
      type: "SUPPORT_TICKET_UPDATED",
      title: `Support ticket updated: ${ticket.subject}`,
      body: `Support changed the ticket status to ${ticket.status}.`,
      data: {
        ticketId: ticket._id.toString(),
        status: ticket.status,
      },
    });
  }
  return serializeTicket(ticket);
};

export const getSupportTicketById = async (user, ticketId) => {
  const ticket = await SupportTicket.findById(ticketId)
    .populate("assignedTo", "email role")
    .populate("replies.sender", "email role");
  if (!ticket) throw new AppError("Support ticket not found", 404);

  const { isAdmin } = ensureTicketAccess(ticket, user);
  const serialized = serializeTicket(ticket);
  if (!isAdmin) {
    serialized.replies = serialized.replies.filter((reply) => !reply.internal);
    serialized.repliesCount = serialized.replies.length;
  }
  return serialized;
};

export const addSupportTicketReply = async (user, ticketId, payload = {}) => {
  const ticket = await SupportTicket.findById(ticketId)
    .populate("assignedTo", "email role")
    .populate("replies.sender", "email role");
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

  if (ticket.status === "OPEN") ticket.status = "IN_PROGRESS";
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

  await ticket.save();

  const recipientUserId = isAdmin ? ticket.user : ticket.assignedTo?._id || ticket.assignedTo;
  if (recipientUserId) {
    await createNotification({
      user: recipientUserId,
      type: "SUPPORT_TICKET_REPLY",
      title: `New reply on support ticket: ${ticket.subject}`,
      body: message.length > 120 ? `${message.slice(0, 117)}...` : message,
      data: {
        ticketId: ticket._id.toString(),
        status: ticket.status,
      },
    });
  }

  const fresh = await SupportTicket.findById(ticket._id)
    .populate("assignedTo", "email role")
    .populate("replies.sender", "email role");

  const serialized = serializeTicket(fresh);
  if (!isAdmin) {
    serialized.replies = serialized.replies.filter((reply) => !reply.internal);
    serialized.repliesCount = serialized.replies.length;
  }
  return serialized;
};
