import AppError from "../../utils/AppError.js";
import { Invoice } from "./invoice.model.js";

const toObjectIdString = (value) => value?.toString();

const parsePage = (value) => {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 1;
};

const parseLimit = (value) => {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return 20;
  return Math.min(Math.floor(n), 100);
};

const buildFallbackLineItems = (invoice) => {
  if (Array.isArray(invoice.lineItems) && invoice.lineItems.length > 0) {
    return invoice.lineItems;
  }

  return [
    {
      description: invoice.job?.completionSummary || invoice.job?.description || "Repair service",
      quantity: 1,
      unitAmount: invoice.subtotal,
      totalAmount: invoice.subtotal,
    },
  ];
};

const toInvoiceSummary = (invoice) => ({
  _id: invoice._id,
  invoiceNo: invoice.invoiceNo,
  jobId: invoice.job?._id || invoice.job,
  jobCode: invoice.job?.jobCode || null,
  title: invoice.job?.title || invoice.job?.vehicle?.registration || "Invoice",
  description:
    invoice.job?.completionSummary || invoice.job?.description || "Completed job invoice",
  vehicleRegistration: invoice.job?.vehicle?.registration || null,
  issuedAt: invoice.issuedAt,
  paidAt: invoice.paidAt || null,
  totalAmount: invoice.totalAmount,
  subtotal: invoice.subtotal,
  vatAmount: invoice.vatAmount,
  currency: invoice.currency,
  status: invoice.status,
  payment: invoice.payment || null,
  pdfUrl: invoice.pdfUrl || null,
  paidLabel: invoice.paidAt
    ? new Date(invoice.paidAt).toLocaleDateString("en-GB", {
        day: "2-digit",
        month: "short",
        year: "numeric",
      })
    : null,
});

const toInvoiceDetail = (invoice) => ({
  ...toInvoiceSummary(invoice),
  billedTo: {
    companyName:
      invoice.billedToSnapshot?.companyName ||
      invoice.fleet?.fleetProfile?.companyName ||
      invoice.fleet?.email ||
      null,
    vatNumber:
      invoice.billedToSnapshot?.vatNumber || invoice.fleet?.fleetProfile?.vatNumber || null,
    address:
      invoice.billedToSnapshot?.address ||
      invoice.fleet?.fleetProfile?.billingAddress ||
      invoice.job?.location?.address ||
      null,
  },
  mechanic: {
    displayName:
      invoice.mechanicSnapshot?.displayName ||
      invoice.mechanic?.mechanicProfile?.displayName ||
      invoice.mechanic?.email ||
      null,
    businessName:
      invoice.mechanicSnapshot?.businessName ||
      invoice.mechanic?.mechanicProfile?.businessName ||
      null,
    rating:
      invoice.mechanicSnapshot?.rating ||
      invoice.mechanic?.mechanicProfile?.rating?.average ||
      null,
  },
  job: {
    _id: invoice.job?._id || invoice.job,
    jobCode: invoice.job?.jobCode || null,
    title: invoice.job?.title || null,
    vehicle: invoice.job?.vehicle || null,
    location: invoice.job?.location || null,
    completedAt: invoice.job?.completedAt || null,
  },
  lineItems: buildFallbackLineItems(invoice),
  totals: {
    subtotal: invoice.subtotal,
    vatAmount: invoice.vatAmount,
    totalAmount: invoice.totalAmount,
    currency: invoice.currency,
  },
  payment: {
    provider: invoice.payment?.provider || "MANUAL",
    status: invoice.payment?.status || "PENDING",
    stripePaymentIntentId: invoice.payment?.stripePaymentIntentId || null,
    stripePaymentMethodId: invoice.payment?.stripePaymentMethodId || null,
    clientSecret: invoice.payment?.stripeClientSecret || null,
    lastError: invoice.payment?.lastError || null,
    authorizedAmount: invoice.payment?.authorizedAmount ?? null,
    capturedAmount: invoice.payment?.capturedAmount ?? null,
    updatedAt: invoice.payment?.updatedAt || null,
  },
  downloadUrl: invoice.pdfUrl || `/api/v1/invoices/${invoice._id}/download`,
});

const ensureInvoiceAccess = (invoice, user) => {
  if (!invoice) throw new AppError("Invoice not found", 404);
  if (user.role === "ADMIN") return;

  const relatedFleetId = toObjectIdString(invoice.fleet?._id || invoice.fleet);
  const relatedMechanicId = toObjectIdString(
    invoice.mechanic?._id || invoice.mechanic
  );
  const userId = toObjectIdString(user._id);

  if (userId === relatedFleetId || userId === relatedMechanicId) return;
  throw new AppError("Forbidden", 403);
};

export const listInvoices = async (user, query = {}) => {
  const page = parsePage(query.page);
  const limit = parseLimit(query.limit);
  const skip = (page - 1) * limit;

  const filter = {};
  if (user.role === "FLEET") filter.fleet = user._id;
  if (user.role === "MECHANIC") filter.mechanic = user._id;
  if (query.status) filter.status = `${query.status}`.trim().toUpperCase();

  const [items, total] = await Promise.all([
    Invoice.find(filter)
      .sort({ issuedAt: -1, createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .populate("job", "jobCode title description completionSummary vehicle location completedAt")
      .lean(),
    Invoice.countDocuments(filter),
  ]);

  return {
    items: items.map(toInvoiceSummary),
    meta: {
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit) || 1,
    },
  };
};

export const getInvoiceByIdForUser = async (invoiceId, user) => {
  const invoice = await Invoice.findById(invoiceId)
    .populate("job", "jobCode title description completionSummary vehicle location completedAt")
    .populate("fleet", "email fleetProfile.companyName fleetProfile.vatNumber fleetProfile.billingAddress")
    .populate(
      "mechanic",
      "email mechanicProfile.displayName mechanicProfile.businessName mechanicProfile.rating"
    )
    .lean();

  ensureInvoiceAccess(invoice, user);
  return toInvoiceDetail(invoice);
};

export const getInvoiceDownloadForUser = async (invoiceId, user) => {
  const invoice = await Invoice.findById(invoiceId).lean();
  ensureInvoiceAccess(invoice, user);

  return {
    invoiceId: invoice._id,
    invoiceNo: invoice.invoiceNo,
    downloadUrl: invoice.pdfUrl || `/api/v1/invoices/${invoice._id}/download`,
  };
};
