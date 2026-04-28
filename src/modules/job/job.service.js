import AppError from "../../utils/AppError.js";
import fs from "fs/promises";
import path from "path";
import crypto from "crypto";
import { ROLES, JOB_STATUS, QUOTE_STATUS } from "../../constants/domain.js";
import mongoose from "mongoose";
import {
  Job,
  JOB_ATTACHMENT_CATEGORIES,
  JOB_ATTACHMENT_FILE_TYPES,
} from "./job.model.js";
import { Quote } from "../quote/quote.model.js";
import { JobEvent } from "../jobEvent/jobEvent.model.js";
import { JobLocationPing } from "../jobLocationPing/jobLocationPing.model.js";
import { Invoice } from "../invoice/invoice.model.js";
import { EarningTransaction } from "../earning/earningTransaction.model.js";
import { PaymentMethod } from "../billing/paymentMethod.model.js";
import { createStripePaymentIntent } from "../billing/stripe.service.js";
import { getProfileCompletionSummary } from "../user/user.service.js";
import {
  emitJobEvent,
  emitJobLocationPing,
  emitJobPosted,
  emitJobStatusChanged,
} from "../../realtime/socket.js";

const toObjectIdString = (value) => (value?._id || value)?.toString();
const uploadsRoot = path.resolve(process.cwd(), "uploads", "jobs");

const parsePage = (value) => {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 1;
};

const parseLimit = (value) => {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return 20;
  return Math.min(Math.floor(n), 100);
};

const milesToMeters = (value) => Math.max(Number(value) || 1, 1) * 1609.34;

const roundMiles = (meters) => {
  if (!Number.isFinite(meters)) return null;
  return Math.round((meters / 1609.34) * 10) / 10;
};

const diffMinutesFromNow = (value) => {
  if (!value) return null;
  const ms = Date.now() - new Date(value).getTime();
  if (!Number.isFinite(ms)) return null;
  return Math.max(Math.round(ms / 60000), 0);
};

const formatRelativeAge = (value) => {
  const minutes = diffMinutesFromNow(value);
  if (minutes === null) return null;
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hr ago`;
  const days = Math.floor(hours / 24);
  return `${days} day${days === 1 ? "" : "s"} ago`;
};

const statusPresentation = (status, job) => {
  const map = {
    [JOB_STATUS.POSTED]: { label: "POSTED", tone: "red" },
    [JOB_STATUS.QUOTING]: { label: "QUOTING", tone: "amber" },
    [JOB_STATUS.ASSIGNED]: {
      label: job?.scheduledFor ? "SCHEDULED" : "ASSIGNED",
      tone: "blue",
    },
    [JOB_STATUS.EN_ROUTE]: { label: "EN ROUTE", tone: "amber" },
    [JOB_STATUS.ON_SITE]: { label: "ON SITE", tone: "green" },
    [JOB_STATUS.IN_PROGRESS]: { label: "IN PROGRESS", tone: "amber" },
    [JOB_STATUS.AWAITING_APPROVAL]: { label: "AWAITING APPROVAL", tone: "yellow" },
    [JOB_STATUS.COMPLETED]: { label: "DONE", tone: "green" },
    [JOB_STATUS.CANCELLED]: { label: "CANCELLED", tone: "red" },
  };
  return map[status] || { label: status, tone: "neutral" };
};

const computeCancellation = (status) => {
  const isFree = [JOB_STATUS.POSTED, JOB_STATUS.QUOTING, JOB_STATUS.ASSIGNED].includes(status);
  return {
    canCancel: ![JOB_STATUS.COMPLETED, JOB_STATUS.CANCELLED].includes(status),
    isFree,
    fee: isFree ? 0 : 35,
    currency: "GBP",
  };
};

const quoteBreakdown = (quote) => {
  const total = Number(quote?.amount) || 0;
  const callOutFee = Number(quote?.breakdown?.callOutFee) || Math.round(total * 0.2);
  const labour = Number(quote?.breakdown?.labour) || Math.max(total - callOutFee, 0);
  const parts = Number(quote?.breakdown?.parts) || 0;
  return {
    labour,
    callOutFee,
    parts,
    total,
    currency: quote?.currency || "GBP",
  };
};

const serializeJobCard = (job, viewer, extra = {}) => {
  const statusUi = statusPresentation(job.status, job);
  const cancellation = computeCancellation(job.status);
  const createdAt = job.postedAt || job.createdAt;
  return {
    _id: job._id,
    jobCode: job.jobCode,
    title: job.title,
    description: job.completionSummary || job.description,
    issueType: job.issueType,
    urgency: job.urgency,
    status: job.status,
    statusUi,
    vehicle: job.vehicle || null,
    location: job.location || null,
    photos: job.photos || [],
    attachments: (job.attachments || []).map(serializeJobAttachment),
    currency: job.currency || "GBP",
    estimatedPayout: job.estimatedPayout ?? job.acceptedAmount ?? job.finalAmount ?? null,
    acceptedAmount: job.acceptedAmount ?? null,
    finalAmount: job.finalAmount ?? null,
    quoteCount: job.quoteCount || 0,
    scheduledFor: job.scheduledFor || null,
    availabilityWindow: job.availabilityWindow || null,
    postedAt: createdAt,
    assignedAt: job.assignedAt || null,
    completedAt: job.completedAt || null,
    tracking: job.tracking || null,
    postedAgoLabel: formatRelativeAge(createdAt),
    quoteSummary: {
      count: job.quoteCount || 0,
      label: `${job.quoteCount || 0} quote${job.quoteCount === 1 ? "" : "s"}`,
    },
    fleet: job.fleet
      ? {
          _id: job.fleet._id || job.fleet,
          companyName: job.fleet.fleetProfile?.companyName || null,
          contactName: job.fleet.fleetProfile?.contactName || null,
          phone: job.fleet.fleetProfile?.phone || null,
        }
      : null,
    assignedMechanic: job.assignedMechanic
      ? {
          _id: job.assignedMechanic._id || job.assignedMechanic,
          displayName: job.assignedMechanic.mechanicProfile?.displayName || null,
          phone: job.assignedMechanic.mechanicProfile?.phone || null,
          rating: job.assignedMechanic.mechanicProfile?.rating?.average ?? null,
        }
      : null,
    assignedCompany: job.assignedCompany
      ? {
          _id: job.assignedCompany._id || job.assignedCompany,
          companyName: job.assignedCompany.companyProfile?.companyName || null,
          contactName: job.assignedCompany.companyProfile?.contactName || null,
          phone: job.assignedCompany.companyProfile?.phone || null,
        }
      : null,
    actions: {
      canTrack:
        viewer.role === ROLES.FLEET &&
        [JOB_STATUS.ASSIGNED, JOB_STATUS.EN_ROUTE, JOB_STATUS.ON_SITE, JOB_STATUS.IN_PROGRESS, JOB_STATUS.AWAITING_APPROVAL].includes(job.status),
      canApproveCompletion:
        viewer.role === ROLES.FLEET && job.status === JOB_STATUS.AWAITING_APPROVAL,
      canStartJourney:
        [ROLES.MECHANIC, ROLES.MECHANIC_EMPLOYEE].includes(viewer.role) &&
        job.status === JOB_STATUS.ASSIGNED,
      canArrive:
        [ROLES.MECHANIC, ROLES.MECHANIC_EMPLOYEE].includes(viewer.role) &&
        job.status === JOB_STATUS.EN_ROUTE,
      canStartWork:
        [ROLES.MECHANIC, ROLES.MECHANIC_EMPLOYEE].includes(viewer.role) &&
        job.status === JOB_STATUS.ON_SITE,
      canCompleteWork:
        [ROLES.MECHANIC, ROLES.MECHANIC_EMPLOYEE].includes(viewer.role) &&
        job.status === JOB_STATUS.IN_PROGRESS,
      canAssignMechanic:
        viewer.role === ROLES.COMPANY &&
        toObjectIdString(job.assignedCompany) === toObjectIdString(viewer._id) &&
        !job.assignedMechanic &&
        [JOB_STATUS.ASSIGNED, JOB_STATUS.EN_ROUTE, JOB_STATUS.ON_SITE, JOB_STATUS.IN_PROGRESS].includes(
          job.status
        ),
      cancellation,
    },
    ...extra,
  };
};

const mapStripePaymentIntentStatus = (status) => {
  switch (status) {
    case "succeeded":
      return { invoiceStatus: "PAID", paymentStatus: "SUCCEEDED", paid: true };
    case "processing":
      return { invoiceStatus: "ISSUED", paymentStatus: "PROCESSING", paid: false };
    case "requires_payment_method":
      return {
        invoiceStatus: "FAILED",
        paymentStatus: "REQUIRES_PAYMENT_METHOD",
        paid: false,
      };
    case "requires_action":
      return {
        invoiceStatus: "ISSUED",
        paymentStatus: "REQUIRES_ACTION",
        paid: false,
      };
    case "canceled":
      return { invoiceStatus: "FAILED", paymentStatus: "CANCELED", paid: false };
    default:
      return { invoiceStatus: "ISSUED", paymentStatus: "PENDING", paid: false };
  }
};

const serializeJobDetail = async (job, viewer) => {
  const base = serializeJobCard(job, viewer);
  const myQuote =
    viewer.role === ROLES.MECHANIC
      ? await Quote.findOne({ job: job._id, mechanic: viewer._id }).sort({ createdAt: -1 }).lean()
      : null;

  return {
    ...base,
    summary: {
      postedAgoLabel: formatRelativeAge(job.postedAt || job.createdAt),
      distanceMiles: base.distanceMiles ?? null,
      etaMinutes: job.tracking?.etaMinutes ?? null,
    },
    map: {
      origin: job.tracking?.latestMechanicLocation?.point || null,
      destination: job.location || null,
      etaMinutes: job.tracking?.etaMinutes ?? null,
    },
    workflow: {
      currentStep: job.status,
      steps: [
        { key: JOB_STATUS.ASSIGNED, label: "Journey", done: [JOB_STATUS.EN_ROUTE, JOB_STATUS.ON_SITE, JOB_STATUS.IN_PROGRESS, JOB_STATUS.AWAITING_APPROVAL, JOB_STATUS.COMPLETED].includes(job.status), active: job.status === JOB_STATUS.ASSIGNED },
        { key: JOB_STATUS.EN_ROUTE, label: "Arrived", done: [JOB_STATUS.ON_SITE, JOB_STATUS.IN_PROGRESS, JOB_STATUS.AWAITING_APPROVAL, JOB_STATUS.COMPLETED].includes(job.status), active: job.status === JOB_STATUS.EN_ROUTE },
        { key: JOB_STATUS.ON_SITE, label: "Work", done: [JOB_STATUS.IN_PROGRESS, JOB_STATUS.AWAITING_APPROVAL, JOB_STATUS.COMPLETED].includes(job.status), active: job.status === JOB_STATUS.ON_SITE },
        { key: JOB_STATUS.IN_PROGRESS, label: "Progress", done: [JOB_STATUS.AWAITING_APPROVAL, JOB_STATUS.COMPLETED].includes(job.status), active: job.status === JOB_STATUS.IN_PROGRESS },
        { key: JOB_STATUS.COMPLETED, label: "Done", done: job.status === JOB_STATUS.COMPLETED, active: job.status === JOB_STATUS.AWAITING_APPROVAL || job.status === JOB_STATUS.COMPLETED },
      ],
    },
    quoteContext: myQuote
      ? {
          myQuoteId: myQuote._id,
          amount: myQuote.amount,
          status: myQuote.status,
          availabilityType: myQuote.availabilityType,
          scheduledAt: myQuote.scheduledAt || null,
        }
      : null,
    paymentSummary:
      viewer.role === ROLES.FLEET
        ? {
            authorizedAmount:
              Number(job.acceptedAmount ?? job.estimatedPayout ?? 0) || null,
            finalAmount: Number(job.finalAmount ?? job.acceptedAmount ?? 0) || null,
            platformFee:
              Number(job.finalAmount ?? job.acceptedAmount ?? 0) > 0
                ? Math.round(
                    Number(job.finalAmount ?? job.acceptedAmount ?? 0) * 0.12 * 100
                  ) / 100
                : null,
            status:
              job.status === JOB_STATUS.COMPLETED
                ? "PAID"
                : [JOB_STATUS.ASSIGNED, JOB_STATUS.EN_ROUTE, JOB_STATUS.ON_SITE, JOB_STATUS.IN_PROGRESS, JOB_STATUS.AWAITING_APPROVAL].includes(
                    job.status
                  )
                ? "AUTHORIZED"
                : "PENDING",
            currency: job.currency || "GBP",
          }
        : null,
  };
};

const generateJobCode = async () => {
  for (let i = 0; i < 8; i += 1) {
    const random = Math.floor(1000 + Math.random() * 9000);
    const jobCode = `TF-${random}`;
    const exists = await Job.exists({ jobCode });
    if (!exists) return jobCode;
  }
  throw new AppError("Unable to generate job code", 500);
};

const generateInvoiceNo = async () => {
  for (let i = 0; i < 8; i += 1) {
    const random = Math.floor(1000 + Math.random() * 9000);
    const invoiceNo = `INV-${new Date().getFullYear()}-${random}`;
    const exists = await Invoice.exists({ invoiceNo });
    if (!exists) return invoiceNo;
  }
  throw new AppError("Unable to generate invoice number", 500);
};

const ensureLocation = (payload) => {
  const location = payload.location || {};
  const coordinates = location.coordinates || payload.coordinates;
  if (!Array.isArray(coordinates) || coordinates.length !== 2) {
    throw new AppError("location.coordinates must be [lng, lat]", 400);
  }
  return {
    type: "Point",
    coordinates,
    address: location.address || payload.address,
  };
};

const normalizeAvailabilityWindow = (payload = {}) => {
  const rawWindow = payload.availabilityWindow || {};
  const fromValue = rawWindow.from || payload.availabilityFrom || payload.scheduledFor;
  const toValue = rawWindow.to || payload.availabilityTo;
  const from = fromValue ? new Date(fromValue) : null;
  const to = toValue ? new Date(toValue) : null;

  if (fromValue && Number.isNaN(from.getTime())) {
    throw new AppError("availabilityWindow.from must be a valid date", 400);
  }
  if (toValue && Number.isNaN(to.getTime())) {
    throw new AppError("availabilityWindow.to must be a valid date", 400);
  }
  if (from && to && to <= from) {
    throw new AppError("availabilityWindow.to must be after availabilityWindow.from", 400);
  }

  return {
    scheduledFor: from || undefined,
    availabilityWindow: from || to ? { from: from || undefined, to: to || undefined } : undefined,
  };
};

const createJobEvent = async ({
  jobId,
  actorId,
  type,
  fromStatus,
  toStatus,
  note,
  payload,
}) => {
  const event = await JobEvent.create({
    job: jobId,
    actor: actorId,
    type,
    fromStatus,
    toStatus,
    note,
    payload,
  });
  emitJobEvent({
    jobId: toObjectIdString(jobId),
    event: {
      _id: event._id,
      jobId: toObjectIdString(jobId),
      actorId: toObjectIdString(actorId),
      type,
      fromStatus: fromStatus || null,
      toStatus: toStatus || null,
      note: note || null,
      payload: payload || null,
      createdAt: event.createdAt,
    },
  });
  return event;
};

const ensureFleetOwner = (job, fleetUserId) => {
  if (toObjectIdString(job.fleet) !== toObjectIdString(fleetUserId)) {
    throw new AppError("Forbidden", 403);
  }
};

const ensureAssignedMechanic = (job, mechanicUserId) => {
  if (toObjectIdString(job.assignedMechanic) !== toObjectIdString(mechanicUserId)) {
    throw new AppError("Forbidden", 403);
  }
};

const ensureJobParticipantAccess = (job, user) => {
  if (user.role === ROLES.ADMIN) return;

  const fleetId = toObjectIdString(job.fleet);
  const mechanicId = toObjectIdString(job.assignedMechanic);
  const companyId = toObjectIdString(job.assignedCompany);
  const userId = toObjectIdString(user._id);

  if (user.role === ROLES.FLEET && fleetId === userId) return;
  if (user.role === ROLES.MECHANIC && mechanicId === userId) return;
  if (user.role === ROLES.MECHANIC_EMPLOYEE && mechanicId === userId) return;
  if (user.role === ROLES.COMPANY && companyId === userId) return;

  throw new AppError("Forbidden", 403);
};

const mimeToExtension = (mime) => {
  const normalized = `${mime || ""}`.trim().toLowerCase();
  const map = {
    "image/jpeg": "jpg",
    "image/jpg": "jpg",
    "image/png": "png",
    "image/webp": "webp",
    "image/gif": "gif",
    "image/heic": "heic",
    "image/heif": "heif",
  };
  return map[normalized] || null;
};

const parseDataUrl = (value) => {
  const match = `${value || ""}`.match(/^data:(image\/[a-z0-9.+-]+);base64,(.+)$/i);
  if (!match) throw new AppError("photo dataUrl must be a valid base64 image data URL", 400);

  const extension = mimeToExtension(match[1]);
  if (!extension) throw new AppError("Unsupported image type", 400);

  return {
    extension,
    buffer: Buffer.from(match[2], "base64"),
  };
};

const mimeToDocExtension = (mime) => {
  const m = `${mime || ""}`.trim().toLowerCase();
  const map = {
    "application/pdf": "pdf",
    "application/msword": "doc",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
    "text/plain": "txt",
  };
  if (map[m]) return map[m];
  return null;
};

const classifyAttachmentFileType = (mime) => {
  const m = `${mime || ""}`.trim().toLowerCase();
  if (m.startsWith("image/")) return "IMAGE";
  if (m === "application/pdf") return "PDF";
  if (m.includes("word") || m.includes("officedocument") || m === "text/plain") {
    return "DOCUMENT";
  }
  return "OTHER";
};

const parseGenericAttachmentDataUrl = (value) => {
  const match = `${value || ""}`.match(/^data:([^;]+);base64,(.+)$/i);
  if (!match) throw new AppError("dataUrl must be a valid base64 data URL", 400);

  const mime = match[1].trim().toLowerCase();
  const buffer = Buffer.from(match[2], "base64");
  const maxBytes = 12 * 1024 * 1024;
  if (buffer.length > maxBytes) {
    throw new AppError("Attachment exceeds size limit (12mb)", 400);
  }

  const fileType = classifyAttachmentFileType(mime);
  let ext;
  if (fileType === "IMAGE") {
    ext = mimeToExtension(mime);
  } else {
    ext = mimeToDocExtension(mime);
  }
  if (!ext) {
    if (fileType === "OTHER") ext = "bin";
    else throw new AppError("Unsupported file type for this upload", 400);
  }

  return { mime, buffer, fileType, ext };
};

const serializeJobAttachment = (a) => ({
  _id: a._id,
  url: a.url,
  fileType: a.fileType,
  category: a.category,
  mimeType: a.mimeType || null,
  originalName: a.originalName || null,
  uploadedBy: a.uploadedBy?._id || a.uploadedBy,
  createdAt: a.createdAt,
  updatedAt: a.updatedAt,
});

const sanitizeFileName = (value) =>
  `${value || ""}`
    .trim()
    .replace(/[^a-zA-Z0-9._-]/g, "-")
    .replace(/-+/g, "-");

const upsertFinancialRecordsForCompletedJob = async (job, paymentContext = {}) => {
  if (!job.assignedMechanic) return { invoice: null, earningTransaction: null };

  const subtotal = Number(job.finalAmount ?? job.acceptedAmount ?? job.estimatedPayout ?? 0);
  const vatAmount = Math.round(subtotal * 0.2 * 100) / 100;
  const totalAmount = Math.round((subtotal + vatAmount) * 100) / 100;
  const platformFee = Math.round(subtotal * 0.12 * 100) / 100;
  const netAmount = Math.max(Math.round((subtotal - platformFee) * 100) / 100, 0);
  const paidAt = paymentContext.paidAt || job.completedAt || new Date();
  const invoiceStatus = paymentContext.invoiceStatus || "PAID";
  const paymentStatus = paymentContext.paymentStatus || "SUCCEEDED";

  let invoice = await Invoice.findOne({ job: job._id });
  if (!invoice) {
    invoice = await Invoice.create({
      invoiceNo: await generateInvoiceNo(),
      job: job._id,
      fleet: job.fleet,
      mechanic: job.assignedMechanic,
      subtotal,
      vatAmount,
      totalAmount,
      currency: job.currency || "GBP",
      status: invoiceStatus,
      issuedAt: paidAt,
      paidAt: invoiceStatus === "PAID" ? paidAt : undefined,
      payment: {
        provider: paymentContext.provider || "MANUAL",
        status: paymentStatus,
        stripeCustomerId: paymentContext.stripeCustomerId,
        stripePaymentMethodId: paymentContext.stripePaymentMethodId,
        stripePaymentIntentId: paymentContext.stripePaymentIntentId,
        stripeClientSecret: paymentContext.stripeClientSecret,
        lastError: paymentContext.lastError,
        authorizedAmount: totalAmount,
        capturedAmount: invoiceStatus === "PAID" ? totalAmount : undefined,
        updatedAt: new Date(),
      },
      lineItems: [
        {
          description: job.completionSummary || job.description || "Repair service",
          quantity: 1,
          unitAmount: subtotal,
          totalAmount: subtotal,
        },
      ],
      billedToSnapshot: {
        companyName: job.fleet?.fleetProfile?.companyName,
        vatNumber: job.fleet?.fleetProfile?.vatNumber,
        address: job.location?.address,
      },
      mechanicSnapshot: {
        displayName: job.assignedMechanic?.mechanicProfile?.displayName,
        businessName: job.assignedMechanic?.mechanicProfile?.businessName,
        rating: job.assignedMechanic?.mechanicProfile?.rating?.average,
      },
    });
  } else {
    invoice.subtotal = subtotal;
    invoice.vatAmount = vatAmount;
    invoice.totalAmount = totalAmount;
    invoice.currency = job.currency || invoice.currency || "GBP";
    invoice.status = invoiceStatus;
    invoice.paidAt = invoiceStatus === "PAID" ? paidAt : undefined;
    invoice.issuedAt = invoice.issuedAt || paidAt;
    invoice.payment = {
      ...(invoice.payment || {}),
      provider: paymentContext.provider || invoice.payment?.provider || "MANUAL",
      status: paymentStatus,
      stripeCustomerId:
        paymentContext.stripeCustomerId || invoice.payment?.stripeCustomerId,
      stripePaymentMethodId:
        paymentContext.stripePaymentMethodId || invoice.payment?.stripePaymentMethodId,
      stripePaymentIntentId:
        paymentContext.stripePaymentIntentId || invoice.payment?.stripePaymentIntentId,
      stripeClientSecret:
        paymentContext.stripeClientSecret || invoice.payment?.stripeClientSecret,
      lastError: paymentContext.lastError || invoice.payment?.lastError,
      authorizedAmount: totalAmount,
      capturedAmount: invoiceStatus === "PAID" ? totalAmount : undefined,
      updatedAt: new Date(),
    };
    if (!invoice.lineItems?.length) {
      invoice.lineItems = [
        {
          description: job.completionSummary || job.description || "Repair service",
          quantity: 1,
          unitAmount: subtotal,
          totalAmount: subtotal,
        },
      ];
    }
    await invoice.save();
  }

  let earningTransaction = null;
  if (invoiceStatus === "PAID") {
    earningTransaction = await EarningTransaction.findOneAndUpdate(
      { mechanic: job.assignedMechanic, job: job._id },
      {
        $set: {
          grossAmount: subtotal,
          platformFee,
          netAmount,
          currency: job.currency || "GBP",
          paidAt,
          notes: job.completionSummary || job.description || "Completed job payout",
        },
        $setOnInsert: {
          type: "JOB_PAYMENT",
          quote: job.acceptedQuote || undefined,
        },
      },
      { upsert: true, new: true }
    );
  }

  return { invoice, earningTransaction };
};

export const createJob = async (payload, fleetUser) => {
  if (!payload.title || !payload.description) {
    throw new AppError("title and description are required", 400);
  }
  const { profileCompletion } = await getProfileCompletionSummary(fleetUser);
  if (!profileCompletion?.isComplete) {
    throw new AppError("Complete your profile before posting a job", 400);
  }

  const scheduling = normalizeAvailabilityWindow(payload);

  const job = await Job.create({
    jobCode: await generateJobCode(),
    fleet: fleetUser._id,
    vehicle: {
      vehicleId: payload.vehicleId,
      registration: payload.registration,
      type: payload.vehicleType,
      make: payload.vehicleMake,
      model: payload.vehicleModel,
    },
    issueType: payload.issueType,
    title: payload.title,
    description: payload.description,
    urgency: payload.urgency,
    location: ensureLocation(payload),
    photos: payload.photos || [],
    status: JOB_STATUS.POSTED,
    postedAt: new Date(),
    estimatedPayout: payload.estimatedPayout,
    mode: payload.mode || undefined,
    scheduledFor: scheduling.scheduledFor,
    availabilityWindow: scheduling.availabilityWindow,
  });

  await createJobEvent({
    jobId: job._id,
    actorId: fleetUser._id,
    type: "JOB_POSTED",
    toStatus: JOB_STATUS.POSTED,
  });

  emitJobPosted(job);
  emitJobStatusChanged(job, {
    previousStatus: null,
    changedBy: toObjectIdString(fleetUser._id),
  });

  return job;
};

export const addJobPhotos = async (jobId, user, payload = {}) => {
  const job = await Job.findById(jobId);
  if (!job) throw new AppError("Job not found", 404);
  ensureJobParticipantAccess(job, user);

  const incoming = Array.isArray(payload.photos)
    ? payload.photos
    : payload.photo
    ? [payload.photo]
    : payload.dataUrl || payload.url
    ? [payload]
    : [];

  if (!incoming.length) {
    throw new AppError("At least one photo payload is required", 400);
  }

  const savedUrls = [];
  const targetDir = path.join(uploadsRoot, toObjectIdString(job._id));
  await fs.mkdir(targetDir, { recursive: true });

  for (const item of incoming) {
    if (item?.url) {
      savedUrls.push(`${item.url}`.trim());
      continue;
    }

    const { extension, buffer } = parseDataUrl(item?.dataUrl);
    const baseName = sanitizeFileName(item?.filename) || `photo-${crypto.randomUUID()}`;
    const fileName = `${baseName}-${Date.now()}-${crypto.randomUUID().slice(0, 8)}.${extension}`;
    const filePath = path.join(targetDir, fileName);
    await fs.writeFile(filePath, buffer);
    savedUrls.push(`/uploads/jobs/${toObjectIdString(job._id)}/${fileName}`);
  }

  job.photos = [...(job.photos || []), ...savedUrls];
  await job.save();

  await createJobEvent({
    jobId: job._id,
    actorId: user._id,
    type: "JOB_PHOTOS_ADDED",
    note: `Added ${savedUrls.length} photo${savedUrls.length === 1 ? "" : "s"}`,
    payload: {
      count: savedUrls.length,
      photos: savedUrls,
    },
  });

  return {
    jobId: job._id,
    photos: job.photos,
    added: savedUrls,
  };
};

export const removeJobPhoto = async (jobId, user, payload = {}) => {
  const job = await Job.findById(jobId);
  if (!job) throw new AppError("Job not found", 404);
  ensureJobParticipantAccess(job, user);

  const photoUrl = `${payload.photoUrl || ""}`.trim();
  if (!photoUrl) throw new AppError("photoUrl is required", 400);
  if (!(job.photos || []).includes(photoUrl)) {
    throw new AppError("Photo not found on this job", 404);
  }

  job.photos = (job.photos || []).filter((item) => item !== photoUrl);
  await job.save();

  const uploadsPrefix = `/uploads/jobs/${toObjectIdString(job._id)}/`;
  if (photoUrl.startsWith(uploadsPrefix)) {
    const fileName = photoUrl.slice(uploadsPrefix.length);
    const filePath = path.join(uploadsRoot, toObjectIdString(job._id), fileName);
    await fs.unlink(filePath).catch(() => null);
  }

  await createJobEvent({
    jobId: job._id,
    actorId: user._id,
    type: "JOB_PHOTO_REMOVED",
    note: "Removed a job photo",
    payload: {
      photoUrl,
    },
  });

  return {
    jobId: job._id,
    photos: job.photos,
    removed: photoUrl,
  };
};

export const addJobAttachments = async (jobId, user, payload = {}) => {
  const job = await Job.findById(jobId);
  if (!job) throw new AppError("Job not found", 404);
  ensureJobParticipantAccess(job, user);

  const items = Array.isArray(payload.items)
    ? payload.items
    : payload.item
    ? [payload.item]
    : [];
  if (!items.length) {
    throw new AppError("At least one item is required (use { items: [...] })", 400);
  }

  const targetDir = path.join(uploadsRoot, toObjectIdString(job._id));
  await fs.mkdir(targetDir, { recursive: true });
  const added = [];

  for (const item of items) {
    const category = JOB_ATTACHMENT_CATEGORIES.includes(item?.category)
      ? item.category
      : "OTHER";
    const fileTypeOverride = JOB_ATTACHMENT_FILE_TYPES.includes(item?.fileType)
      ? item.fileType
      : null;

    if (item?.url) {
      const url = `${item.url}`.trim();
      job.attachments.push({
        url,
        fileType: fileTypeOverride || "OTHER",
        category,
        mimeType: item.mimeType || null,
        originalName: item.originalName || null,
        uploadedBy: user._id,
      });
      added.push(url);
      continue;
    }

    if (!item?.dataUrl) {
      throw new AppError("Each item needs dataUrl, or url for an external file", 400);
    }
    const { mime, buffer, fileType, ext } = parseGenericAttachmentDataUrl(item.dataUrl);
    const resolvedType = fileTypeOverride || fileType;
    const baseName = sanitizeFileName(item?.filename) || `file-${crypto.randomUUID().slice(0, 8)}`;
    const fileName = `${baseName}-${Date.now()}.${ext}`;
    const filePath = path.join(targetDir, fileName);
    await fs.writeFile(filePath, buffer);
    const publicUrl = `/uploads/jobs/${toObjectIdString(job._id)}/${fileName}`;
    job.attachments.push({
      url: publicUrl,
      fileType: resolvedType,
      category,
      mimeType: mime,
      originalName: item?.originalName || null,
      uploadedBy: user._id,
    });
    added.push(publicUrl);
    if (resolvedType === "IMAGE" && !(job.photos || []).includes(publicUrl)) {
      job.photos = [...(job.photos || []), publicUrl];
    }
  }

  await job.save();

  await createJobEvent({
    jobId: job._id,
    actorId: user._id,
    type: "JOB_ATTACHMENTS_ADDED",
    note: `Added ${added.length} attachment(s)`,
    payload: { count: added.length },
  });

  return {
    jobId: job._id,
    attachments: (job.attachments || []).map(serializeJobAttachment),
    added,
  };
};

export const removeJobAttachment = async (jobId, user, attachmentId) => {
  if (!mongoose.Types.ObjectId.isValid(attachmentId)) {
    throw new AppError("Invalid attachment id", 400);
  }
  const job = await Job.findById(jobId);
  if (!job) throw new AppError("Job not found", 404);
  ensureJobParticipantAccess(job, user);

  const att = job.attachments.id(attachmentId);
  if (!att) throw new AppError("Attachment not found", 404);
  const url = att.url;
  att.deleteOne();
  job.photos = (job.photos || []).filter((p) => p !== url);
  await job.save();

  const uploadsPrefix = `/uploads/jobs/${toObjectIdString(job._id)}/`;
  if (url.startsWith(uploadsPrefix)) {
    const fileName = url.slice(uploadsPrefix.length);
    const filePath = path.join(uploadsRoot, toObjectIdString(job._id), fileName);
    await fs.unlink(filePath).catch(() => null);
  }

  await createJobEvent({
    jobId: job._id,
    actorId: user._id,
    type: "JOB_ATTACHMENT_REMOVED",
    note: "Removed a job attachment",
    payload: { attachmentId, url },
  });

  return {
    jobId: job._id,
    attachments: (job.attachments || []).map(serializeJobAttachment),
    removed: attachmentId,
  };
};

export const listJobs = async (user, query) => {
  const page = parsePage(query.page);
  const limit = parseLimit(query.limit);
  const skip = (page - 1) * limit;
  const filter = {};

  if (user.role === ROLES.FLEET) {
    filter.fleet = user._id;
    if (query.tab === "completed") {
      filter.status = JOB_STATUS.COMPLETED;
    } else if (query.tab === "active" || query.tab === "tracking") {
      filter.status = {
        $in: [
          JOB_STATUS.POSTED,
          JOB_STATUS.QUOTING,
          JOB_STATUS.ASSIGNED,
          JOB_STATUS.EN_ROUTE,
          JOB_STATUS.ON_SITE,
          JOB_STATUS.IN_PROGRESS,
          JOB_STATUS.AWAITING_APPROVAL,
        ],
      };
    }
  }

  let nearPoint = null;
  if ([ROLES.MECHANIC, ROLES.MECHANIC_EMPLOYEE].includes(user.role)) {
    if (`${query.feed}` === "true") {
      filter.status = { $in: [JOB_STATUS.POSTED, JOB_STATUS.QUOTING] };
      if (query.lat && query.lng) {
        const lat = Number(query.lat);
        const lng = Number(query.lng);
        const radiusMiles = Number(query.radiusMiles || query.radius || 15);
        if (Number.isFinite(lat) && Number.isFinite(lng) && Number.isFinite(radiusMiles)) {
          nearPoint = { lat, lng };
          filter.location = {
            $near: {
              $geometry: { type: "Point", coordinates: [lng, lat] },
              $maxDistance: milesToMeters(radiusMiles),
            },
          };
        }
      }
      if (query.issueType) {
        filter.issueType = { $in: `${query.issueType}`.split(",") };
      }
      if (query.minPayout) {
        const min = Number(query.minPayout);
        if (Number.isFinite(min)) {
          filter.estimatedPayout = { $gte: min };
        }
      }
    } else if (query.tab === "completed") {
      filter.assignedMechanic = user._id;
      filter.status = JOB_STATUS.COMPLETED;
    } else if (query.tab === "active") {
      filter.assignedMechanic = user._id;
      filter.status = {
        $in: [
          JOB_STATUS.ASSIGNED,
          JOB_STATUS.EN_ROUTE,
          JOB_STATUS.ON_SITE,
          JOB_STATUS.IN_PROGRESS,
          JOB_STATUS.AWAITING_APPROVAL,
        ],
      };
    } else {
      filter.assignedMechanic = user._id;
    }
  }

  if (user.role === ROLES.COMPANY) {
    if (`${query.feed}` === "true") {
      filter.status = { $in: [JOB_STATUS.POSTED, JOB_STATUS.QUOTING] };
      if (query.lat && query.lng) {
        const lat = Number(query.lat);
        const lng = Number(query.lng);
        const radiusMiles = Number(
          query.radiusMiles || query.radius || user.companyProfile?.serviceRadiusMiles || 25
        );
        if (Number.isFinite(lat) && Number.isFinite(lng) && Number.isFinite(radiusMiles)) {
          nearPoint = { lat, lng };
          filter.location = {
            $near: {
              $geometry: { type: "Point", coordinates: [lng, lat] },
              $maxDistance: milesToMeters(radiusMiles),
            },
          };
        }
      }
      if (query.issueType) {
        filter.issueType = { $in: `${query.issueType}`.split(",") };
      }
      if (query.minPayout) {
        const min = Number(query.minPayout);
        if (Number.isFinite(min)) {
          filter.estimatedPayout = { $gte: min };
        }
      }
    } else if (query.tab === "completed") {
      filter.assignedCompany = user._id;
      filter.status = JOB_STATUS.COMPLETED;
    } else if (query.tab === "active" || query.tab === "tracking") {
      filter.assignedCompany = user._id;
      filter.status = {
        $in: [
          JOB_STATUS.ASSIGNED,
          JOB_STATUS.EN_ROUTE,
          JOB_STATUS.ON_SITE,
          JOB_STATUS.IN_PROGRESS,
          JOB_STATUS.AWAITING_APPROVAL,
        ],
      };
    } else {
      filter.assignedCompany = user._id;
    }
  }

  const queryBuilder = Job.find(filter)
    .sort({ createdAt: -1 })
    .skip(skip)
    .limit(limit)
    .populate("fleet", "email fleetProfile.companyName fleetProfile.contactName fleetProfile.phone")
    .populate(
      "assignedCompany",
      "email role companyProfile.companyName companyProfile.contactName companyProfile.phone"
    )
    .populate("assignedMechanic", "email role mechanicProfile.displayName mechanicProfile.phone mechanicProfile.rating")
    .lean();

  if (nearPoint) {
    queryBuilder.select({ distanceMeters: { $meta: "geoNearDistance" } });
  }

  const [items, total] = await Promise.all([
    queryBuilder,
    Job.countDocuments(filter),
  ]);

  const serializedItems = items.map((job) =>
    serializeJobCard(job, user, {
      distanceMiles: roundMiles(job.distanceMeters),
    })
  );

  const insightBase = {
    activeCount: serializedItems.filter(
      (job) => ![JOB_STATUS.COMPLETED, JOB_STATUS.CANCELLED].includes(job.status)
    ).length,
    completedCount: serializedItems.filter(
      (job) => job.status === JOB_STATUS.COMPLETED
    ).length,
  };

  return {
    items: serializedItems,
    meta: {
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit) || 1,
      ...insightBase,
      mode:
        [ROLES.MECHANIC, ROLES.COMPANY].includes(user.role) && `${query.feed}` === "true"
          ? "feed"
          : "list",
    },
  };
};

export const getJobByIdForUser = async (jobId, user) => {
  const job = await Job.findById(jobId)
    .populate("fleet", "email role fleetProfile.companyName fleetProfile.contactName fleetProfile.phone fleetProfile.billingAddress")
    .populate(
      "assignedCompany",
      "email role companyProfile.companyName companyProfile.contactName companyProfile.phone"
    )
    .populate(
      "assignedMechanic",
      "email role mechanicProfile.displayName mechanicProfile.phone mechanicProfile.rating"
    );

  if (!job) throw new AppError("Job not found", 404);
  if (user.role === ROLES.ADMIN) return serializeJobDetail(job.toObject(), user);

  const userId = toObjectIdString(user._id);
  const fleetId = toObjectIdString(job.fleet?._id || job.fleet);
  const companyId = toObjectIdString(job.assignedCompany?._id || job.assignedCompany);
  const mechanicId = toObjectIdString(job.assignedMechanic?._id || job.assignedMechanic);

  if (user.role === ROLES.FLEET && fleetId === userId) {
    return serializeJobDetail(job.toObject(), user);
  }
  if ([ROLES.MECHANIC, ROLES.MECHANIC_EMPLOYEE].includes(user.role) && mechanicId === userId) {
    return serializeJobDetail(job.toObject(), user);
  }
  if (user.role === ROLES.COMPANY && companyId === userId) {
    return serializeJobDetail(job.toObject(), user);
  }

  if (
    [ROLES.MECHANIC, ROLES.COMPANY].includes(user.role) &&
    [JOB_STATUS.POSTED, JOB_STATUS.QUOTING].includes(job.status)
  ) {
    return serializeJobDetail(job.toObject(), user);
  }

  const hasQuote = await Quote.exists({
    job: job._id,
    ...(user.role === ROLES.COMPANY ? { company: user._id } : { mechanic: user._id }),
  });
  if ([ROLES.MECHANIC, ROLES.COMPANY].includes(user.role) && hasQuote) {
    return serializeJobDetail(job.toObject(), user);
  }

  throw new AppError("Forbidden", 403);
};

const transitionAssignedJob = async ({
  jobId,
  user,
  fromStatuses,
  toStatus,
  eventType,
  note,
  payload,
  extraMutation,
}) => {
  const job = await Job.findById(jobId);
  if (!job) throw new AppError("Job not found", 404);

  ensureAssignedMechanic(job, user._id);
  if (!fromStatuses.includes(job.status)) {
    throw new AppError(`Job must be ${fromStatuses.join(" or ")}`, 400);
  }

  const fromStatus = job.status;
  job.status = toStatus;
  if (extraMutation) extraMutation(job);
  await job.save();

  await createJobEvent({
    jobId: job._id,
    actorId: user._id,
    type: eventType,
    fromStatus,
    toStatus,
    note,
    payload,
  });

  emitJobStatusChanged(job, {
    previousStatus: fromStatus,
    changedBy: toObjectIdString(user._id),
  });

  return job;
};

export const startJourney = async (jobId, mechanicUser) =>
  transitionAssignedJob({
    jobId,
    user: mechanicUser,
    fromStatuses: [JOB_STATUS.ASSIGNED],
    toStatus: JOB_STATUS.EN_ROUTE,
    eventType: "JOURNEY_STARTED",
  });

export const arriveAtJob = async (jobId, mechanicUser) =>
  transitionAssignedJob({
    jobId,
    user: mechanicUser,
    fromStatuses: [JOB_STATUS.EN_ROUTE],
    toStatus: JOB_STATUS.ON_SITE,
    eventType: "MECHANIC_ARRIVED",
  });

export const startJobWork = async (jobId, mechanicUser) =>
  transitionAssignedJob({
    jobId,
    user: mechanicUser,
    fromStatuses: [JOB_STATUS.ON_SITE],
    toStatus: JOB_STATUS.IN_PROGRESS,
    eventType: "WORK_STARTED",
  });

export const completeJobWork = async (jobId, mechanicUser, payload) =>
  transitionAssignedJob({
    jobId,
    user: mechanicUser,
    fromStatuses: [JOB_STATUS.IN_PROGRESS],
    toStatus: JOB_STATUS.AWAITING_APPROVAL,
    eventType: "WORK_COMPLETED",
    note: payload.workSummary,
    payload: {
      workSummary: payload.workSummary,
      finalAmount: payload.finalAmount,
    },
    extraMutation: (job) => {
      job.finalAmount = payload.finalAmount ?? job.finalAmount;
      job.completionSummary = payload.workSummary || job.completionSummary;
    },
  });

export const approveJobCompletion = async (jobId, fleetUser, payload) => {
  const job = await Job.findById(jobId)
    .populate("fleet", "fleetProfile")
    .populate("assignedCompany", "companyProfile")
    .populate("assignedMechanic", "mechanicProfile");
  if (!job) throw new AppError("Job not found", 404);

  ensureFleetOwner(job, fleetUser._id);
  if (job.status !== JOB_STATUS.AWAITING_APPROVAL) {
    throw new AppError("Job is not awaiting approval", 400);
  }

  const fromStatus = job.status;
  job.status = JOB_STATUS.COMPLETED;
  job.completedAt = new Date();
  if (payload.finalAmount !== undefined) {
    job.finalAmount = Number(payload.finalAmount);
  }
  await job.save();

  let paymentContext = {
    provider: "MANUAL",
    invoiceStatus: "PAID",
    paymentStatus: "SUCCEEDED",
    paidAt: new Date(),
  };

  const paymentMethodId = `${payload.paymentMethodId || ""}`.trim();
  if (paymentMethodId) {
    const paymentMethod = await PaymentMethod.findOne({
      _id: paymentMethodId,
      user: fleetUser._id,
      isActive: true,
    }).lean();

    if (!paymentMethod) {
      throw new AppError("Payment method not found", 404);
    }

    if (paymentMethod.provider === "STRIPE") {
      const totalAmount =
        Math.round(
          ((Number(job.finalAmount ?? job.acceptedAmount ?? job.estimatedPayout ?? 0) || 0) *
            1.2) *
            100
        ) / 100;

      const paymentIntent = await createStripePaymentIntent({
        amount: totalAmount,
        currency: job.currency || "GBP",
        customerId:
          paymentMethod.providerCustomerId || fleetUser.fleetProfile?.stripeCustomerId,
        paymentMethodId: paymentMethod.providerMethodId,
        metadata: {
          jobId: job._id.toString(),
          fleetId: fleetUser._id.toString(),
          mechanicId: toObjectIdString(job.assignedMechanic),
        },
      });

      const mapped = mapStripePaymentIntentStatus(paymentIntent.status);
      paymentContext = {
        provider: "STRIPE",
        invoiceStatus: mapped.invoiceStatus,
        paymentStatus: mapped.paymentStatus,
        stripeCustomerId:
          paymentMethod.providerCustomerId || fleetUser.fleetProfile?.stripeCustomerId,
        stripePaymentMethodId: paymentMethod.providerMethodId,
        stripePaymentIntentId: paymentIntent.id,
        stripeClientSecret: paymentIntent.client_secret || null,
        lastError: paymentIntent.last_payment_error?.message || null,
        paidAt: mapped.paid ? new Date() : undefined,
      };
    }
  }

  const financials = await upsertFinancialRecordsForCompletedJob(job, paymentContext);

  await createJobEvent({
    jobId: job._id,
    actorId: fleetUser._id,
    type: "JOB_COMPLETED",
    fromStatus,
    toStatus: JOB_STATUS.COMPLETED,
    payload: {
      paymentMethodId: payload.paymentMethodId,
      invoiceId: financials.invoice?._id,
      paymentProvider: paymentContext.provider,
      paymentStatus: paymentContext.paymentStatus,
      stripePaymentIntentId: paymentContext.stripePaymentIntentId,
    },
  });

  emitJobStatusChanged(job, {
    previousStatus: fromStatus,
    changedBy: toObjectIdString(fleetUser._id),
    invoiceId: financials.invoice?._id?.toString?.() || null,
    paymentStatus: paymentContext.paymentStatus,
  });

  return {
    job,
    invoice: financials.invoice,
    earningTransaction: financials.earningTransaction,
  };
};

export const cancelJob = async (jobId, fleetUser, payload = {}) => {
  const job = await Job.findById(jobId);
  if (!job) throw new AppError("Job not found", 404);

  ensureFleetOwner(job, fleetUser._id);
  if ([JOB_STATUS.COMPLETED, JOB_STATUS.CANCELLED].includes(job.status)) {
    throw new AppError("Job cannot be cancelled in current status", 400);
  }

  const fromStatus = job.status;
  const cancellation = computeCancellation(fromStatus);

  job.status = JOB_STATUS.CANCELLED;
  job.cancelledAt = new Date();
  await job.save();

  await Quote.updateMany(
    { job: job._id, status: QUOTE_STATUS.WAITING },
    { $set: { status: QUOTE_STATUS.DECLINED } }
  );

  await createJobEvent({
    jobId: job._id,
    actorId: fleetUser._id,
    type: "JOB_CANCELLED",
    fromStatus,
    toStatus: JOB_STATUS.CANCELLED,
    note: payload.reason,
    payload: {
      reason: payload.reason,
      fee: cancellation.fee,
      currency: cancellation.currency,
    },
  });

  emitJobStatusChanged(job, {
    previousStatus: fromStatus,
    changedBy: toObjectIdString(fleetUser._id),
    cancellation,
  });

  return {
    job,
    cancellation,
  };
};

/** Fleet-only: preview fee/policy before calling PATCH .../cancel */
export const previewJobCancellation = async (jobId, fleetUser) => {
  if (fleetUser.role !== ROLES.FLEET) {
    throw new AppError("Only fleet users can preview cancellation", 403);
  }
  const job = await Job.findById(jobId).select("status fleet jobCode");
  if (!job) throw new AppError("Job not found", 404);
  ensureFleetOwner(job, fleetUser._id);

  const cancellation = computeCancellation(job.status);
  return {
    jobId: job._id,
    jobCode: job.jobCode || null,
    status: job.status,
    preview: {
      ...cancellation,
      summary: cancellation.isFree
        ? "No cancellation fee at this stage — job has not yet moved to en-route or active work."
        : "A £35 GBP cancellation fee applies when the job is already en route, on site, in progress, or awaiting approval.",
    },
  };
};

export const getJobTimeline = async (jobId, user) => {
  await getJobByIdForUser(jobId, user);
  return JobEvent.find({ job: jobId }).sort({ createdAt: -1 }).lean();
};

export const createJobLocationPing = async (jobId, user, payload) => {
  const job = await Job.findById(jobId);
  if (!job) throw new AppError("Job not found", 404);
  ensureAssignedMechanic(job, user._id);

  const { lat, lng, heading, speed, accuracy, etaMinutes } = payload || {};
  const latNum = Number(lat);
  const lngNum = Number(lng);
  if (!Number.isFinite(latNum) || !Number.isFinite(lngNum)) {
    throw new AppError("lat and lng are required", 400);
  }

  const point = { type: "Point", coordinates: [lngNum, latNum] };
  const now = new Date();

  await JobLocationPing.create({
    job: job._id,
    mechanic: user._id,
    point,
    heading,
    speed,
    accuracy,
    pingedAt: now,
  });

  job.tracking = {
    ...(job.tracking || {}),
    latestMechanicLocation: {
      point,
      heading,
      speed,
      accuracy,
      updatedAt: now,
    },
    etaMinutes: Number.isFinite(Number(etaMinutes)) ? Number(etaMinutes) : job.tracking?.etaMinutes,
  };

  await job.save();

  await createJobEvent({
    jobId: job._id,
    actorId: user._id,
    type: "LOCATION_PING",
    payload: {
      lat: latNum,
      lng: lngNum,
      heading,
      speed,
      accuracy,
      etaMinutes,
    },
  });

  emitJobLocationPing(job, {
    lat: latNum,
    lng: lngNum,
    heading,
    speed,
    accuracy,
    etaMinutes,
    updatedAt: now,
  });

  return {
    ok: true,
    updatedAt: now,
  };
};


