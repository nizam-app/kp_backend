import AppError from "../../utils/AppError.js";
import { SupportTicket } from "./supportTicket.model.js";

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
  resolution: ticket.resolution || null,
  resolvedAt: ticket.resolvedAt || null,
  createdAt: ticket.createdAt,
  updatedAt: ticket.updatedAt,
});

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
