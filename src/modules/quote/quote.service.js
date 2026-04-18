import mongoose from "mongoose";
import AppError from "../../utils/AppError.js";
import { JOB_STATUS, QUOTE_STATUS, ROLES } from "../../constants/domain.js";
import { Quote } from "./quote.model.js";
import { Job } from "../job/job.model.js";
import { JobEvent } from "../jobEvent/jobEvent.model.js";
import { User } from "../user/user.model.js";

const now = () => new Date();
const sessionOptions = (session) => (session ? { session } : {});

const quoteBreakdown = (quote) => {
  const total = Number(quote?.amount) || 0;
  const callOutFee = Math.round(total * 0.2);
  const parts = 0;
  const labour = Math.max(total - callOutFee - parts, 0);
  return { labour, callOutFee, parts, total, currency: quote?.currency || "GBP" };
};

const quoteStatusUi = (status) => {
  const map = {
    WAITING: { label: "Waiting", tone: "amber" },
    ACCEPTED: { label: "Accepted", tone: "green" },
    DECLINED: { label: "Declined", tone: "red" },
    EXPIRED: { label: "Expired", tone: "neutral" },
    WITHDRAWN: { label: "Withdrawn", tone: "neutral" },
  };
  return map[status] || { label: status, tone: "neutral" };
};

const serializeQuote = (quote) => ({
  _id: quote._id,
  amount: quote.amount,
  notes: quote.notes || null,
  availabilityType: quote.availabilityType,
  scheduledAt: quote.scheduledAt || null,
  etaMinutes: quote.etaMinutes ?? null,
  currency: quote.currency,
  status: quote.status,
  statusUi: quoteStatusUi(quote.status),
  expiresAt: quote.expiresAt || null,
  acceptedAt: quote.acceptedAt || null,
  declinedAt: quote.declinedAt || null,
  expiredAt: quote.expiredAt || null,
  createdAt: quote.createdAt,
  breakdown: quoteBreakdown(quote),
  summaryLine:
    quote.status === QUOTE_STATUS.ACCEPTED
      ? "Accepted! Tap to view active job"
      : quote.status === QUOTE_STATUS.WAITING
      ? "Waiting for fleet response"
      : quote.status === QUOTE_STATUS.EXPIRED
      ? "Quote expired"
      : quote.status === QUOTE_STATUS.WITHDRAWN
      ? "Quote withdrawn"
      : null,
  mechanic: quote.mechanic
    ? {
        _id: quote.mechanic._id || quote.mechanic,
        email: quote.mechanic.email || null,
        displayName:
          quote.mechanic.mechanicProfile?.displayName ||
          quote.mechanic.companyProfile?.companyName ||
          null,
        phone:
          quote.mechanic.mechanicProfile?.phone ||
          quote.mechanic.companyProfile?.phone ||
          null,
        rating: quote.mechanic.mechanicProfile?.rating?.average ?? null,
        jobsDone: quote.mechanic.mechanicProfile?.stats?.jobsDone ?? null,
        responseMinutesAvg: quote.mechanic.mechanicProfile?.stats?.responseMinutesAvg ?? null,
        verified:
          ["APPROVED", "SUBMITTED", "UNDER_REVIEW"].includes(
            quote.mechanic.mechanicProfile?.verification?.status
          ),
      }
    : null,
  job: quote.job
    ? {
        _id: quote.job._id || quote.job,
        jobCode: quote.job.jobCode || null,
        title: quote.job.title || null,
        description: quote.job.description || null,
        urgency: quote.job.urgency || null,
        status: quote.job.status || null,
        location: quote.job.location || null,
        vehicle: quote.job.vehicle || null,
      }
    : null,
  company: quote.company
    ? {
        _id: quote.company._id || quote.company,
        companyName: quote.company.companyProfile?.companyName || null,
        contactName: quote.company.companyProfile?.contactName || null,
        phone: quote.company.companyProfile?.phone || null,
      }
    : null,
  actions: {
    canAmend: quote.status === QUOTE_STATUS.WAITING,
    canWithdraw: quote.status === QUOTE_STATUS.WAITING,
    canOpenActiveJob: quote.status === QUOTE_STATUS.ACCEPTED,
    canResubmit: [QUOTE_STATUS.DECLINED, QUOTE_STATUS.EXPIRED, QUOTE_STATUS.WITHDRAWN].includes(
      quote.status
    ),
  },
});

const expireWaitingQuotes = async (filter = {}, session = null) =>
  Quote.updateMany(
    {
      ...filter,
      status: QUOTE_STATUS.WAITING,
      expiresAt: { $lte: now() },
    },
    {
      $set: {
        status: QUOTE_STATUS.EXPIRED,
        expiredAt: now(),
      },
    },
    sessionOptions(session)
  );

const withOptionalTransaction = async (work) => {
  const session = await mongoose.startSession();
  try {
    let result;
    await session.withTransaction(async () => {
      result = await work(session);
    });
    return result;
  } catch (err) {
    if (
      err?.message?.includes("Transaction numbers are only allowed") ||
      err?.message?.includes("replica set")
    ) {
      return work(null);
    }
    throw err;
  } finally {
    await session.endSession();
  }
};

const ensureFleetJobOwner = async (jobId, fleetUserId) => {
  const job = await Job.findById(jobId);
  if (!job) throw new AppError("Job not found", 404);
  if (job.fleet.toString() !== fleetUserId.toString()) {
    throw new AppError("Forbidden", 403);
  }
  return job;
};

const baseQuotePopulate = (query) =>
  query
    .populate(
      "mechanic",
      "email role mechanicProfile.displayName mechanicProfile.phone mechanicProfile.rating mechanicProfile.stats mechanicProfile.verification companyProfile.companyName companyProfile.phone"
    )
    .populate(
      "company",
      "email role companyProfile.companyName companyProfile.contactName companyProfile.phone companyProfile.contactRole"
    )
    .populate("submittedBy", "email role mechanicProfile.displayName companyProfile.companyName")
    .populate("job", "jobCode title description urgency status location vehicle photos issueType fleet")
    .populate("fleet", "email fleetProfile.companyName fleetProfile.contactName fleetProfile.phone");

const ensureQuoteAccess = (quote, user) => {
  if (!quote) throw new AppError("Quote not found", 404);
  if (user.role === ROLES.ADMIN) return;
  const fleetId = quote.fleet?._id?.toString?.() || quote.fleet?.toString?.();
  const mechanicId = quote.mechanic?._id?.toString?.() || quote.mechanic?.toString?.();
  const companyId = quote.company?._id?.toString?.() || quote.company?.toString?.();
  if ([fleetId, mechanicId, companyId].includes(user._id.toString())) return;
  throw new AppError("Forbidden", 403);
};

export const submitQuote = async (jobId, payload, mechanicUser) => {
  if (!payload.amount) throw new AppError("amount is required", 400);
  if (![ROLES.MECHANIC, ROLES.MECHANIC_EMPLOYEE, ROLES.COMPANY].includes(mechanicUser.role)) {
    throw new AppError("Only mechanics or companies can submit quotes", 403);
  }

  const job = await Job.findById(jobId);
  if (!job) throw new AppError("Job not found", 404);
  if (![JOB_STATUS.POSTED, JOB_STATUS.QUOTING].includes(job.status)) {
    throw new AppError("Quotes are closed for this job", 400);
  }

  if (job.fleet.toString() === mechanicUser._id.toString()) {
    throw new AppError("Cannot quote your own job", 400);
  }

  await expireWaitingQuotes({ job: job._id });

  const existing = await Quote.findOne({
    job: job._id,
    mechanic: mechanicUser._id,
    status: QUOTE_STATUS.WAITING,
  });
  if (existing) throw new AppError("You already have a waiting quote", 409);

  const quote = await Quote.create({
    job: job._id,
    fleet: job.fleet,
    mechanic: mechanicUser._id,
    company:
      mechanicUser.role === "COMPANY"
        ? mechanicUser._id
        : mechanicUser.companyMembership?.company || undefined,
    submittedBy: mechanicUser._id,
    amount: payload.amount,
    notes: payload.notes,
    availabilityType: payload.availabilityType,
    scheduledAt: payload.scheduledAt,
    etaMinutes: payload.etaMinutes,
  });

  if (job.status === JOB_STATUS.POSTED) {
    job.status = JOB_STATUS.QUOTING;
  }
  job.quoteCount = (job.quoteCount || 0) + 1;
  job.estimatedPayout = Number(job.estimatedPayout || quote.amount);
  await job.save();

  await JobEvent.create({
    job: job._id,
    actor: mechanicUser._id,
    type: "QUOTE_SUBMITTED",
    toStatus: job.status,
    payload: {
      quoteId: quote._id,
      amount: quote.amount,
    },
  });

  const populated = await baseQuotePopulate(Quote.findById(quote._id)).lean();

  return serializeQuote(populated);
};

export const listJobQuotes = async (jobId, fleetUser) => {
  await ensureFleetJobOwner(jobId, fleetUser._id);
  await expireWaitingQuotes({ job: jobId });
  const quotes = await baseQuotePopulate(
    Quote.find({ job: jobId }).sort({ amount: 1, createdAt: -1 })
  ).lean();
  return quotes.map(serializeQuote);
};

export const getQuoteByIdForUser = async (quoteId, user) => {
  await expireWaitingQuotes({ _id: quoteId });
  const quote = await baseQuotePopulate(Quote.findById(quoteId)).lean();
  ensureQuoteAccess(quote, user);
  return {
    ...serializeQuote(quote),
    fleet: quote.fleet
      ? {
          _id: quote.fleet._id || quote.fleet,
          companyName: quote.fleet.fleetProfile?.companyName || null,
          contactName: quote.fleet.fleetProfile?.contactName || null,
          phone: quote.fleet.fleetProfile?.phone || null,
        }
      : null,
    job: quote.job
      ? {
          ...serializeQuote(quote).job,
          photos: quote.job.photos || [],
          issueType: quote.job.issueType || null,
        }
      : null,
    submittedBy: quote.submittedBy
      ? {
          _id: quote.submittedBy._id || quote.submittedBy,
          role: quote.submittedBy.role || null,
          displayName:
            quote.submittedBy.mechanicProfile?.displayName ||
            quote.submittedBy.companyProfile?.companyName ||
            quote.submittedBy.email ||
            null,
        }
      : null,
    cancellationPolicy: {
      freeBeforeEnRoute: true,
      feePercentAfterEnRoute: 10,
    },
  };
};

export const acceptQuote = async (quoteId, fleetUser) => {
  return withOptionalTransaction(async (session) => {
    await expireWaitingQuotes({}, session);

    const quote = await Quote.findById(quoteId, null, sessionOptions(session));
    if (!quote) throw new AppError("Quote not found", 404);
    if (quote.fleet.toString() !== fleetUser._id.toString()) {
      throw new AppError("Forbidden", 403);
    }
    if (quote.status !== QUOTE_STATUS.WAITING) {
      throw new AppError("Only waiting quotes can be accepted", 400);
    }

    const acceptedQuote = await Quote.findOneAndUpdate(
      { _id: quote._id, status: QUOTE_STATUS.WAITING },
      { $set: { status: QUOTE_STATUS.ACCEPTED, acceptedAt: now() } },
      { new: true, ...sessionOptions(session) }
    );
    if (!acceptedQuote) {
      throw new AppError("Quote is no longer available", 409);
    }

    const jobBeforeUpdate = await Job.findOneAndUpdate(
      {
        _id: quote.job,
        status: { $in: [JOB_STATUS.POSTED, JOB_STATUS.QUOTING] },
      },
      {
        $set: {
          status: JOB_STATUS.ASSIGNED,
          assignedMechanic:
            quote.company && quote.mechanic?.toString() === quote.company?.toString()
              ? undefined
              : quote.mechanic,
          assignedCompany: quote.company || undefined,
          acceptedQuote: quote._id,
          assignedAt: now(),
          acceptedAmount: quote.amount,
          estimatedPayout: quote.amount,
        },
      },
      { new: false, ...sessionOptions(session) }
    );

    if (!jobBeforeUpdate) {
      await Quote.updateOne(
        { _id: quote._id, status: QUOTE_STATUS.ACCEPTED },
        { $set: { status: QUOTE_STATUS.WAITING, acceptedAt: undefined } },
        sessionOptions(session)
      );
      throw new AppError("Job is not available for quote acceptance", 400);
    }

    const job = await Job.findById(quote.job, null, sessionOptions(session));

    await Quote.updateMany(
      {
        job: quote.job,
        _id: { $ne: quote._id },
        status: QUOTE_STATUS.WAITING,
      },
      { $set: { status: QUOTE_STATUS.DECLINED, declinedAt: now() } },
      sessionOptions(session)
    );

    await JobEvent.create(
      [
        {
          job: job._id,
          actor: fleetUser._id,
          type: "QUOTE_ACCEPTED",
          fromStatus: jobBeforeUpdate.status,
          toStatus: JOB_STATUS.ASSIGNED,
          payload: {
            quoteId: quote._id,
            mechanicId: quote.mechanic,
            companyId: quote.company || null,
            submittedById: quote.submittedBy || quote.mechanic,
          },
        },
      ],
      sessionOptions(session)
    );

    const populated = await baseQuotePopulate(Quote.findById(acceptedQuote._id)).lean();

    return { quote: serializeQuote(populated), job };
  });
};

export const declineQuote = async (quoteId, fleetUser) => {
  await expireWaitingQuotes({});

  const quote = await Quote.findById(quoteId);
  if (!quote) throw new AppError("Quote not found", 404);
  if (quote.fleet.toString() !== fleetUser._id.toString()) {
    throw new AppError("Forbidden", 403);
  }
  if (quote.status !== QUOTE_STATUS.WAITING) {
    throw new AppError("Only waiting quotes can be declined", 400);
  }

  quote.status = QUOTE_STATUS.DECLINED;
  quote.declinedAt = now();
  await quote.save();

  await JobEvent.create({
    job: quote.job,
    actor: fleetUser._id,
    type: "QUOTE_DECLINED",
    payload: { quoteId: quote._id },
  });

  const populated = await baseQuotePopulate(Quote.findById(quote._id)).lean();

  return serializeQuote(populated);
};

export const amendQuote = async (quoteId, payload, mechanicUser) => {
  await expireWaitingQuotes({
    _id: quoteId,
    ...(mechanicUser.role === ROLES.COMPANY
      ? { company: mechanicUser._id }
      : { mechanic: mechanicUser._id }),
  });

  const quote = await Quote.findById(quoteId);
  if (!quote) throw new AppError("Quote not found", 404);

  const ownsQuote =
    quote.mechanic.toString() === mechanicUser._id.toString() ||
    (mechanicUser.role === ROLES.COMPANY &&
      quote.company?.toString() === mechanicUser._id.toString());

  if (!ownsQuote) {
    throw new AppError("Forbidden", 403);
  }
  if (quote.status !== QUOTE_STATUS.WAITING) {
    throw new AppError("Only waiting quotes can be amended", 400);
  }

  if (payload.amount !== undefined) {
    if (!Number.isFinite(Number(payload.amount)) || Number(payload.amount) <= 0) {
      throw new AppError("amount must be greater than zero", 400);
    }
    quote.amount = Number(payload.amount);
  }

  if (payload.notes !== undefined) {
    quote.notes = `${payload.notes || ""}`.trim() || undefined;
  }

  if (payload.availabilityType !== undefined) {
    quote.availabilityType = payload.availabilityType;
  }

  if (payload.scheduledAt !== undefined) {
    quote.scheduledAt = payload.scheduledAt || undefined;
  }

  if (payload.etaMinutes !== undefined) {
    quote.etaMinutes =
      payload.etaMinutes === null || payload.etaMinutes === ""
        ? undefined
        : Number(payload.etaMinutes);
  }

  quote.expiresAt = new Date(Date.now() + 30 * 60 * 1000);
  await quote.save();

  await JobEvent.create({
    job: quote.job,
    actor: mechanicUser._id,
    type: "QUOTE_AMENDED",
    payload: {
      quoteId: quote._id,
      amount: quote.amount,
      etaMinutes: quote.etaMinutes ?? null,
    },
  });

  const populated = await baseQuotePopulate(Quote.findById(quote._id)).lean();

  return serializeQuote(populated);
};

export const withdrawQuote = async (quoteId, mechanicUser) => {
  await expireWaitingQuotes({
    _id: quoteId,
    ...(mechanicUser.role === ROLES.COMPANY
      ? { company: mechanicUser._id }
      : { mechanic: mechanicUser._id }),
  });

  const quote = await Quote.findById(quoteId);
  if (!quote) throw new AppError("Quote not found", 404);

  const ownsQuote =
    quote.mechanic.toString() === mechanicUser._id.toString() ||
    (mechanicUser.role === ROLES.COMPANY &&
      quote.company?.toString() === mechanicUser._id.toString());

  if (!ownsQuote) {
    throw new AppError("Forbidden", 403);
  }
  if (quote.status !== QUOTE_STATUS.WAITING) {
    throw new AppError("Only waiting quotes can be withdrawn", 400);
  }

  quote.status = QUOTE_STATUS.WITHDRAWN;
  quote.withdrawnAt = now();
  await quote.save();

  await JobEvent.create({
    job: quote.job,
    actor: mechanicUser._id,
    type: "QUOTE_WITHDRAWN",
    payload: { quoteId: quote._id },
  });

  const populated = await baseQuotePopulate(Quote.findById(quote._id)).lean();

  return serializeQuote(populated);
};

export const listMechanicQuotes = async (mechanicUser, query) => {
  const baseOwnerFilter =
    mechanicUser.role === ROLES.COMPANY
      ? { company: mechanicUser._id }
      : { mechanic: mechanicUser._id };

  await expireWaitingQuotes(baseOwnerFilter);

  const filter = { ...baseOwnerFilter };
  const tab = `${query.tab || "ALL"}`.toUpperCase();

  if (tab === "WAITING") filter.status = QUOTE_STATUS.WAITING;
  if (tab === "ACCEPTED") filter.status = QUOTE_STATUS.ACCEPTED;
  if (tab === "EXPIRED") filter.status = QUOTE_STATUS.EXPIRED;
  if (tab === "DECLINED") filter.status = QUOTE_STATUS.DECLINED;

  const quotes = await baseQuotePopulate(
    Quote.find(filter).sort({ createdAt: -1 })
  ).lean();

  return quotes.map(serializeQuote);
};
