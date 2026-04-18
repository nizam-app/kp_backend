import { sendResponse } from "../../utils/sendResponse.js";
import {
  addSupportTicketReply,
  createSupportTicket,
  getSupportTicketById,
  listSupportTickets,
  updateSupportTicket,
} from "./supportTicket.service.js";

export const createSupportTicketController = async (req, res) => {
  const ticket = await createSupportTicket(req.user, req.body);
  return sendResponse(res, {
    statusCode: 201,
    message: "Support ticket created",
    data: ticket,
  });
};

export const listSupportTicketsController = async (req, res) => {
  const result = await listSupportTickets(req.user, req.query);
  return sendResponse(res, {
    message: "Support tickets fetched",
    data: result.items,
    meta: result.meta,
  });
};

export const getSupportTicketByIdController = async (req, res) => {
  const ticket = await getSupportTicketById(req.user, req.params.ticketId);
  return sendResponse(res, {
    message: "Support ticket fetched",
    data: ticket,
  });
};

export const updateSupportTicketController = async (req, res) => {
  const ticket = await updateSupportTicket(req.user, req.params.ticketId, req.body);
  return sendResponse(res, {
    message: "Support ticket updated",
    data: ticket,
  });
};

export const addSupportTicketReplyController = async (req, res) => {
  const ticket = await addSupportTicketReply(req.user, req.params.ticketId, req.body);
  return sendResponse(res, {
    statusCode: 201,
    message: "Support ticket reply added",
    data: ticket,
  });
};
