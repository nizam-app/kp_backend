import AppError from "../../utils/AppError.js";
import { ROLES } from "../../constants/domain.js";
import { companyEarningsBreakdown } from "../../utils/companyEarningsMath.js";
import { resolveMechanicRatingForInvoiceContext } from "../../utils/mechanicRating.js";
import { Invoice } from "./invoice.model.js";
import { Job } from "../job/job.model.js";
import { JobEvent } from "../jobEvent/jobEvent.model.js";

const toObjectIdString = (value) => value?.toString();

const roundMoney = (n) => Math.round((Number(n || 0) + Number.EPSILON) * 100) / 100;

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

const invoiceVatApplied = (invoice) =>
  invoice.vatApplied === true || Number(invoice.vatAmount) > 0;

const invoiceVatRate = (invoice) => {
  if (Number(invoice.vatRate) > 0) return Number(invoice.vatRate);
  const subtotal = Number(invoice.subtotal);
  const vatAmount = Number(invoice.vatAmount);
  return subtotal > 0 && vatAmount > 0 ? vatAmount / subtotal : 0;
};

const buildFallbackLineItems = (invoice) => {
  if (Array.isArray(invoice.lineItems) && invoice.lineItems.length > 0) {
    return invoice.lineItems;
  }

  const amount = roundMoney(invoice.subtotal ?? invoice.totalAmount ?? 0);
  return [
    {
      description: "Repair service",
      quantity: 1,
      unitAmount: amount,
      totalAmount: amount,
    },
  ];
};

const isDegenerateInvoiceLines = (lineItems, job) => {
  if (!Array.isArray(lineItems) || lineItems.length === 0) return true;
  if (lineItems.length !== 1) return false;
  const desc = `${lineItems[0]?.description || ""}`.trim();
  const jobDesc = `${job?.description || ""}`.trim();
  const jobSummary = `${job?.completionSummary || ""}`.trim();
  if (!desc) return true;
  if (jobDesc && desc === jobDesc) return true;
  if (jobSummary && desc === jobSummary) return true;
  return false;
};

const recoverCompletionLineItems = async (jobId, jobDoc) => {
  const job =
    jobDoc ||
    (await Job.findById(jobId).select("completionInvoice description completionSummary").lean());
  if (!job) return null;

  const fromJob = job.completionInvoice?.lineItems;
  if (Array.isArray(fromJob) && fromJob.length) {
    return fromJob.map((row) => ({
      description: `${row.description || "Service"}`.trim().slice(0, 240) || "Service",
      quantity: Number(row.quantity) > 0 ? Number(row.quantity) : 1,
      unitAmount: roundMoney(Number(row.unitAmount ?? row.totalAmount ?? 0)),
      totalAmount: roundMoney(Number(row.totalAmount ?? row.unitAmount ?? 0)),
    }));
  }

  const event = await JobEvent.findOne({ job: job._id || jobId, type: "WORK_COMPLETED" })
    .sort({ createdAt: -1 })
    .select("payload")
    .lean();
  const rows = event?.payload?.invoiceLineItems || event?.payload?.invoiceLineSummaries;
  if (!Array.isArray(rows) || !rows.length) return null;

  return rows.map((row) => {
    const total = roundMoney(Number(row.totalAmount ?? row.amount ?? row.unitAmount ?? 0));
    const qty = Number(row.quantity) > 0 ? Number(row.quantity) : 1;
    const unit = row.unitAmount != null ? roundMoney(Number(row.unitAmount)) : total;
    return {
      description: `${row.description || "Service"}`.trim().slice(0, 240) || "Service",
      quantity: qty,
      unitAmount: unit,
      totalAmount: total,
    };
  });
};

const ensureInvoiceLineItemsAccurate = async (invoiceLean) => {
  if (!invoiceLean?._id) return invoiceLean;
  const jobId = invoiceLean.job?._id || invoiceLean.job;
  let jobLean =
    invoiceLean.job && typeof invoiceLean.job === "object" ? { ...invoiceLean.job } : null;
  if (jobId && (!jobLean?.completionInvoice || !jobLean?.description)) {
    const extra = await Job.findById(jobId)
      .select("description completionSummary completionInvoice")
      .lean();
    if (extra) jobLean = { ...(jobLean || {}), ...extra };
  }

  if (!isDegenerateInvoiceLines(invoiceLean.lineItems, jobLean || invoiceLean.job)) {
    return invoiceLean;
  }

  const recovered = await recoverCompletionLineItems(jobId, jobLean);
  if (recovered?.length) {
    invoiceLean.lineItems = recovered;
    await Invoice.updateOne({ _id: invoiceLean._id }, { $set: { lineItems: recovered } });
    return invoiceLean;
  }

  if (
    Array.isArray(invoiceLean.lineItems) &&
    invoiceLean.lineItems.length === 1 &&
    isDegenerateInvoiceLines(invoiceLean.lineItems, jobLean || invoiceLean.job)
  ) {
    const amount = roundMoney(
      invoiceLean.lineItems[0].totalAmount ?? invoiceLean.subtotal ?? invoiceLean.totalAmount ?? 0
    );
    invoiceLean.lineItems = [
      { description: "Repair service", quantity: 1, unitAmount: amount, totalAmount: amount },
    ];
    await Invoice.updateOne({ _id: invoiceLean._id }, { $set: { lineItems: invoiceLean.lineItems } });
  }
  return invoiceLean;
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
  vatRate: invoiceVatRate(invoice),
  vatApplied: invoiceVatApplied(invoice),
  currency: invoice.currency,
  status: invoice.status,
  payment: invoice.payment || null,
  supplier: invoice.supplierSnapshot || null,
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
  supplier: invoice.supplierSnapshot || null,
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
    vatRate: invoiceVatRate(invoice),
    vatApplied: invoiceVatApplied(invoice),
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
  if (user.role === ROLES.COMPANY) {
    const assignedJobIds = await Job.distinct("_id", { assignedCompany: user._id });
    filter.job = { $in: assignedJobIds };
  }
  if (query.status) filter.status = `${query.status}`.trim().toUpperCase();
  if (query.job) {
    const jobId = `${query.job}`.trim();
    if (jobId) {
      if (user.role === ROLES.COMPANY) {
        const hasAccess = await Job.exists({
          _id: jobId,
          assignedCompany: user._id,
        });
        filter.job = hasAccess ? jobId : { $in: [] };
      } else {
        filter.job = jobId;
      }
    }
  }

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
  let invoice = await Invoice.findById(invoiceId)
    .populate(
      "job",
      "jobCode title description completionSummary completionInvoice vehicle location completedAt assignedAt postedAt createdAt assignedCompany finalAmount acceptedAmount estimatedPayout"
    )
    .populate("fleet", "email fleetProfile.companyName fleetProfile.vatNumber fleetProfile.billingAddress")
    .populate(
      "mechanic",
      "email mechanicProfile.displayName mechanicProfile.businessName mechanicProfile.rating mechanicProfile.profilePhotoUrl"
    )
    .lean();

  ensureInvoiceAccess(invoice, user);
  invoice = await ensureInvoiceLineItemsAccurate(invoice);
  return toInvoiceDetail(invoice);
};

export const getInvoiceDownloadForUser = async (invoiceId, user) => {
  // Return the full invoice detail so clients can render a real document.
  // (pdfUrl is optional; most invoices are generated on demand.)
  return getInvoiceByIdForUser(invoiceId, user);
};
