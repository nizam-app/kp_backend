import AppError from "../../utils/AppError.js";
import { ROLES, JOB_STATUS, QUOTE_STATUS } from "../../constants/domain.js";
import { Job } from "./job.model.js";
import { Quote } from "../quote/quote.model.js";
import { JobEvent } from "../jobEvent/jobEvent.model.js";
import { JobLocationPing } from "../jobLocationPing/jobLocationPing.model.js";
import { Invoice } from "../invoice/invoice.model.js";
import { EarningTransaction } from "../earning/earningTransaction.model.js";
import { PaymentMethod } from "../billing/paymentMethod.model.js";
import { createStripePaymentIntent } from "../billing/stripe.service.js";
import { getProfileCompletionSummary } from "../user/user.service.js";

const toObjectIdString = (value) => (value?._id || value)?.toString();

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
    currency: job.currency || "GBP",
    estimatedPayout: job.estimatedPayout ?? job.acceptedAmount ?? job.finalAmount ?? null,
    acceptedAmount: job.acceptedAmount ?? null,
    finalAmount: job.finalAmount ?? null,
    quoteCount: job.quoteCount || 0,
    scheduledFor: job.scheduledFor || null,
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
    actions: {
      canTrack:
        viewer.role === ROLES.FLEET &&
        [JOB_STATUS.ASSIGNED, JOB_STATUS.EN_ROUTE, JOB_STATUS.ON_SITE, JOB_STATUS.IN_PROGRESS, JOB_STATUS.AWAITING_APPROVAL].includes(job.status),
      canApproveCompletion:
        viewer.role === ROLES.FLEET && job.status === JOB_STATUS.AWAITING_APPROVAL,
      canStartJourney:
        viewer.role === ROLES.MECHANIC && job.status === JOB_STATUS.ASSIGNED,
      canArrive:
        viewer.role === ROLES.MECHANIC && job.status === JOB_STATUS.EN_ROUTE,
      canStartWork:
        viewer.role === ROLES.MECHANIC && job.status === JOB_STATUS.ON_SITE,
      canCompleteWork:
        viewer.role === ROLES.MECHANIC && job.status === JOB_STATUS.IN_PROGRESS,
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

const createJobEvent = async ({
  jobId,
  actorId,
  type,
  fromStatus,
  toStatus,
  note,
  payload,
}) =>
  JobEvent.create({
    job: jobId,
    actor: actorId,
    type,
    fromStatus,
    toStatus,
    note,
    payload,
  });

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
    scheduledFor: payload.scheduledFor,
  });

  await createJobEvent({
    jobId: job._id,
    actorId: fleetUser._id,
    type: "JOB_POSTED",
    toStatus: JOB_STATUS.POSTED,
  });

  return job;
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
  if (user.role === ROLES.MECHANIC) {
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

  const queryBuilder = Job.find(filter)
    .sort({ createdAt: -1 })
    .skip(skip)
    .limit(limit)
    .populate("fleet", "email fleetProfile.companyName fleetProfile.contactName fleetProfile.phone")
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
      mode: user.role === ROLES.MECHANIC && `${query.feed}` === "true" ? "feed" : "list",
    },
  };
};

export const getJobByIdForUser = async (jobId, user) => {
  const job = await Job.findById(jobId)
    .populate("fleet", "email role fleetProfile.companyName fleetProfile.contactName fleetProfile.phone fleetProfile.billingAddress")
    .populate(
      "assignedMechanic",
      "email role mechanicProfile.displayName mechanicProfile.phone mechanicProfile.rating"
    );

  if (!job) throw new AppError("Job not found", 404);
  if (user.role === ROLES.ADMIN) return serializeJobDetail(job.toObject(), user);

  const userId = toObjectIdString(user._id);
  const fleetId = toObjectIdString(job.fleet?._id || job.fleet);
  const mechanicId = toObjectIdString(job.assignedMechanic?._id || job.assignedMechanic);

  if (user.role === ROLES.FLEET && fleetId === userId) {
    return serializeJobDetail(job.toObject(), user);
  }
  if (user.role === ROLES.MECHANIC && mechanicId === userId) {
    return serializeJobDetail(job.toObject(), user);
  }

  if (
    user.role === ROLES.MECHANIC &&
    [JOB_STATUS.POSTED, JOB_STATUS.QUOTING].includes(job.status)
  ) {
    return serializeJobDetail(job.toObject(), user);
  }

  const hasQuote = await Quote.exists({ job: job._id, mechanic: user._id });
  if (user.role === ROLES.MECHANIC && hasQuote) return serializeJobDetail(job.toObject(), user);

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

  return {
    job,
    cancellation,
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

  return {
    ok: true,
    updatedAt: now,
  };
};


