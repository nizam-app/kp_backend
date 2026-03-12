import mongoose from "mongoose";
import AppError from "../../utils/AppError.js";
import { JOB_STATUS, QUOTE_STATUS } from "../../constants/domain.js";
import { Quote } from "./quote.model.js";
import { Job } from "../job/job.model.js";
import { JobEvent } from "../jobEvent/jobEvent.model.js";

const now = () => new Date();
const sessionOptions = (session) => (session ? { session } : {});

const expireWaitingQuotes = async (filter = {}, session = null) =>
  Quote.updateMany(
    {
      ...filter,
      status: QUOTE_STATUS.WAITING,
      expiresAt: { $lte: now() },
    },
    { $set: { status: QUOTE_STATUS.EXPIRED } },
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

export const submitQuote = async (jobId, payload, mechanicUser) => {
  if (!payload.amount) throw new AppError("amount is required", 400);

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
    amount: payload.amount,
    notes: payload.notes,
    availabilityType: payload.availabilityType,
    scheduledAt: payload.scheduledAt,
  });

  if (job.status === JOB_STATUS.POSTED) {
    job.status = JOB_STATUS.QUOTING;
    await job.save();
  }

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

  return quote;
};

export const listJobQuotes = async (jobId, fleetUser) => {
  await ensureFleetJobOwner(jobId, fleetUser._id);
  await expireWaitingQuotes({ job: jobId });
  return Quote.find({ job: jobId })
    .sort({ createdAt: -1 })
    .populate("mechanic", "email mechanicProfile.displayName mechanicProfile.phone")
    .lean();
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
      { $set: { status: QUOTE_STATUS.ACCEPTED } },
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
          assignedMechanic: quote.mechanic,
          acceptedQuote: quote._id,
          assignedAt: now(),
        },
      },
      { new: false, ...sessionOptions(session) }
    );

    if (!jobBeforeUpdate) {
      await Quote.updateOne(
        { _id: quote._id, status: QUOTE_STATUS.ACCEPTED },
        { $set: { status: QUOTE_STATUS.WAITING } },
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
      { $set: { status: QUOTE_STATUS.DECLINED } },
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
          payload: { quoteId: quote._id, mechanicId: quote.mechanic },
        },
      ],
      sessionOptions(session)
    );

    return { quote: acceptedQuote, job };
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
  await quote.save();

  await JobEvent.create({
    job: quote.job,
    actor: fleetUser._id,
    type: "QUOTE_DECLINED",
    payload: { quoteId: quote._id },
  });

  return quote;
};

export const listMechanicQuotes = async (mechanicUser, query) => {
  await expireWaitingQuotes({ mechanic: mechanicUser._id });

  const filter = { mechanic: mechanicUser._id };
  const tab = `${query.tab || "ALL"}`.toUpperCase();

  if (tab === "WAITING") filter.status = QUOTE_STATUS.WAITING;
  if (tab === "ACCEPTED") filter.status = QUOTE_STATUS.ACCEPTED;
  if (tab === "EXPIRED") filter.status = QUOTE_STATUS.EXPIRED;
  if (tab === "DECLINED") filter.status = QUOTE_STATUS.DECLINED;

  const quotes = await Quote.find(filter)
    .sort({ createdAt: -1 })
    .populate("job", "jobCode title urgency status location")
    .lean();

  return quotes;
};
