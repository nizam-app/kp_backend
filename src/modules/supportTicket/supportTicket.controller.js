import { sendResponse } from "../../utils/sendResponse.js";
import {
  createSupportTicket,
  listSupportTickets,
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
