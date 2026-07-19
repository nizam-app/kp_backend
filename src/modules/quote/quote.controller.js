import { sendResponse } from "../../utils/sendResponse.js";
import {
  acceptQuote,
  amendQuote,
  countOwnerQuotesByStatus,
  declineQuote,
  getQuoteByIdForUser,
  listJobQuotes,
  listOwnerQuotesPaginated,
  submitQuote,
  withdrawQuote,
} from "./quote.service.js";

export const submitQuoteController = async (req, res) => {
  const quote = await submitQuote(req.params.jobId, req.body, req.user);
  return sendResponse(res, {
    statusCode: 201,
    message: "Quote submitted",
    data: quote,
  });
};

export const listJobQuotesController = async (req, res) => {
  const quotes = await listJobQuotes(req.params.jobId, req.user);
  const hasNewShape =
    !quotes.length ||
    quotes.some(
      (q) =>
        Object.hasOwn(q, "distanceKm") &&
        q.mechanic &&
        Object.hasOwn(q.mechanic, "profilePhotoUrl")
    );
  return sendResponse(res, {
    message: "Quotes fetched",
    data: quotes,
    meta: {
      quotesFormatV2: hasNewShape,
    },
  });
};

export const getQuoteByIdController = async (req, res) => {
  const quote = await getQuoteByIdForUser(req.params.quoteId, req.user);
  return sendResponse(res, {
    message: "Quote fetched",
    data: quote,
  });
};

export const acceptQuoteController = async (req, res) => {
  const result = await acceptQuote(req.params.quoteId, req.user);
  return sendResponse(res, {
    message: "Quote accepted",
    data: result,
  });
};

export const declineQuoteController = async (req, res) => {
  const quote = await declineQuote(req.params.quoteId, req.user);
  return sendResponse(res, {
    message: "Quote declined",
    data: quote,
  });
};

export const amendQuoteController = async (req, res) => {
  const quote = await amendQuote(req.params.quoteId, req.body, req.user);
  return sendResponse(res, {
    message: "Quote amended",
    data: quote,
  });
};

export const withdrawQuoteController = async (req, res) => {
  const quote = await withdrawQuote(req.params.quoteId, req.user);
  return sendResponse(res, {
    message: "Quote withdrawn",
    data: quote,
  });
};

export const listMyQuotesController = async (req, res) => {
  const [result, quoteCounts] = await Promise.all([
    listOwnerQuotesPaginated(req.user, req.query),
    countOwnerQuotesByStatus(req.user),
  ]);
  return sendResponse(res, {
    message: "My quotes fetched",
    data: result.items,
    meta: {
      ...result.meta,
      quotesByStatus: {
        ALL: quoteCounts.total,
        WAITING: quoteCounts.WAITING,
        ACCEPTED: quoteCounts.ACCEPTED,
        IN_PROGRESS: quoteCounts.IN_PROGRESS,
        AWAITING_APPROVAL: quoteCounts.AWAITING_APPROVAL,
        COMPLETED: quoteCounts.COMPLETED,
        CANCELLED: quoteCounts.CANCELLED,
        DECLINED: quoteCounts.DECLINED,
        EXPIRED: quoteCounts.EXPIRED,
        WITHDRAWN: quoteCounts.WITHDRAWN,
      },
    },
  });
};
