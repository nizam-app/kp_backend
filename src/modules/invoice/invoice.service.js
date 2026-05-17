import AppError from "../../utils/AppError.js";
import { ROLES } from "../../constants/domain.js";
import { companyEarningsBreakdown } from "../../utils/companyEarningsMath.js";
import { resolveMechanicRatingForInvoiceContext } from "../../utils/mechanicRating.js";
import { Invoice } from "./invoice.model.js";

const toObjectIdString = (value) => value?.toString();

const formatJobDurationLabel = (job) => {
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

const toInvoiceDetail = (invoice) => {
  const ce = companyEarningsBreakdown(invoice.job, invoice);

  return {
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
    rating: resolveMechanicRatingForInvoiceContext(invoice, invoice.mechanic),
    profilePhotoUrl:
      invoice.mechanicSnapshot?.profilePhotoUrl ||
      invoice.mechanic?.mechanicProfile?.profilePhotoUrl ||
      null,
  },
  job: {
    _id: invoice.job?._id || invoice.job,
    jobCode: invoice.job?.jobCode || null,
    title: invoice.job?.title || null,
    description: invoice.job?.description || null,
    completionSummary: invoice.job?.completionSummary || null,
    vehicle: invoice.job?.vehicle || null,
    location: invoice.job?.location || null,
    completedAt: invoice.job?.completedAt || null,
    completedDateLabel: invoice.job?.completedAt
      ? new Date(invoice.job.completedAt).toLocaleDateString("en-GB", {
          day: "numeric",
          month: "short",
          year: "numeric",
        })
      : null,
    assignedAt: invoice.job?.assignedAt || null,
    postedAt: invoice.job?.postedAt || null,
    durationLabel: formatJobDurationLabel(invoice.job),
  },
  /** Same figures as `GET /company/earnings/jobs` rows when job is linked. */
  companyPayout: invoice.job
    ? {
        platformFeePercent: ce.platformFeePercent,
        grossAmount: ce.grossAmount,
        platformFeeAmount: ce.platformFeeAmount,
        platformFee: ce.platformFeeAmount,
        netAmount: ce.netAmount,
        currency: ce.currency,
      }
    : null,
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
  primaryActions: [
    {
      key: "DOWNLOAD_INVOICE",
      label: "DOWNLOAD INVOICE",
      icon: "DOWNLOAD",
      method: "GET",
      path: `/api/v1/invoices/${invoice._id}/download`,
    },
  ],
  };
};

const ensureInvoiceAccess = (invoice, user) => {
  if (!invoice) throw new AppError("Invoice not found", 404);
  if (user.role === "ADMIN") return;

  const relatedFleetId = toObjectIdString(invoice.fleet?._id || invoice.fleet);
  const relatedMechanicId = toObjectIdString(
    invoice.mechanic?._id || invoice.mechanic
  );
  const userId = toObjectIdString(user._id);

  if (userId === relatedFleetId || userId === relatedMechanicId) return;

  if (user.role === ROLES.COMPANY) {
    const assignedCompanyId = toObjectIdString(invoice.job?.assignedCompany);
    if (assignedCompanyId && assignedCompanyId === userId) return;
  }

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
    .populate(
      "job",
      "jobCode title description completionSummary vehicle location completedAt assignedAt postedAt createdAt assignedCompany finalAmount acceptedAmount estimatedPayout"
    )
    .populate("fleet", "email fleetProfile.companyName fleetProfile.vatNumber fleetProfile.billingAddress")
    .populate(
      "mechanic",
      "email mechanicProfile.displayName mechanicProfile.businessName mechanicProfile.rating mechanicProfile.profilePhotoUrl"
    )
    .lean();

  ensureInvoiceAccess(invoice, user);
  return toInvoiceDetail(invoice);
};

export const getInvoiceDownloadForUser = async (invoiceId, user) => {
  const invoice = await Invoice.findById(invoiceId)
    .populate("job", "assignedCompany")
    .lean();
  ensureInvoiceAccess(invoice, user);

  return {
    invoiceId: invoice._id,
    invoiceNo: invoice.invoiceNo,
    downloadUrl: invoice.pdfUrl || `/api/v1/invoices/${invoice._id}/download`,
  };
};
