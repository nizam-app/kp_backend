import { sendResponse } from "../../utils/sendResponse.js";
import {
  getInvoiceByIdForUser,
  getInvoiceDownloadForUser,
  listInvoices,
} from "./invoice.service.js";

export const listInvoicesController = async (req, res) => {
  const result = await listInvoices(req.user, req.query);
  return sendResponse(res, {
    message: "Invoices fetched",
    data: result.items,
    meta: result.meta,
  });
};

export const getInvoiceByIdController = async (req, res) => {
  const invoice = await getInvoiceByIdForUser(req.params.invoiceId, req.user);
  return sendResponse(res, {
    message: "Invoice fetched",
    data: invoice,
  });
};

export const getInvoiceDownloadController = async (req, res) => {
  const result = await getInvoiceDownloadForUser(req.params.invoiceId, req.user);
  return sendResponse(res, {
    message: "Invoice download ready",
    data: result,
  });
};
