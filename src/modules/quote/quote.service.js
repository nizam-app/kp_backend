import mongoose from "mongoose";
import AppError from "../../utils/AppError.js";
import { JOB_STATUS, QUOTE_STATUS, ROLES } from "../../constants/domain.js";
import { Quote } from "./quote.model.js";
import { Job } from "../job/job.model.js";
import { JobEvent } from "../jobEvent/jobEvent.model.js";
import { User } from "../user/user.model.js";
import { readMechanicProfileRatingAverage } from "../../utils/mechanicRating.js";
import {
  notifyQuoteAccepted,
  notifyQuoteAmended,
  notifyQuoteDeclined,
  notifyQuoteSubmitted,
  notifyQuotesNotSelected,
  notifyQuoteWithdrawn,
} from "../notification/jobQuoteNotification.service.js";

const now = () => new Date();
const sessionOptions = (session) => (session ? { session } : {});

const diffMinutesFromNow = (value) => {
  if (!value) return null;
  const ms = Date.now() - new Date(value).getTime();
  if (!Number.isFinite(ms)) return null;
  return Math.max(Math.round(ms / 60000), 0);
};

const formatQuoteRelativeAge = (value) => {
  const minutes = diffMinutesFromNow(value);
  if (minutes === null) return null;
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hr${hours === 1 ? "" : "s"} ago`;
  const days = Math.floor(hours / 24);
  return `${days} day${days === 1 ? "" : "s"} ago`;
};

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

/** Matches `user.model` mechanicProfile.skills enum; used for Fleet quote cards. */
const MECHANIC_SKILL_LABELS = {
  TYRES: "Tyres",
  BATTERY: "Battery",
  ENGINE: "Engine",
  BRAKES: "Brakes",
  ELECTRICAL: "Electrical",
  OTHER: "Other",
};

const mechanicSpecialtyFields = (user) => {
  const raw = user?.mechanicProfile?.skills;
  if (!Array.isArray(raw) || !raw.length) {
    return { skills: [], specialtySummary: null };
  }
  const labels = raw.map((s) => MECHANIC_SKILL_LABELS[s] || s);
  return { skills: raw, specialtySummary: labels.join(" & ") };
};

/** Prefer mechanic avatar; company accounts quoting use companyProfile photo. */
const pickUserProfilePhotoUrl = (user) => {
  if (!user || typeof user !== "object") return null;
  const fromMechanic = `${user.mechanicProfile?.profilePhotoUrl ?? ""}`.trim();
  if (fromMechanic) return fromMechanic;
  const fromCompany = `${user.companyProfile?.profilePhotoUrl ?? ""}`.trim();
  return fromCompany || null;
};

const EARTH_RADIUS_KM = 6371;
const toRad = (deg) => (deg * Math.PI) / 180;

const haversineKm = (lng1, lat1, lng2, lat2) => {
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return EARTH_RADIUS_KM * c;
};

/** Distance from mechanic's last known point to job site; requires both GeoJSON points. */
const quoteDistanceKm = (quote) => {
  const jc = quote.job?.location?.coordinates;
  const mc = quote.mechanic?.mechanicProfile?.lastKnownLocation?.coordinates;
  if (!Array.isArray(jc) || jc.length !== 2 || !Array.isArray(mc) || mc.length !== 2) {
    return null;
  }
  const [jlng, jlat] = jc.map(Number);
  const [mlng, mlat] = mc.map(Number);
  if (![jlng, jlat, mlng, mlat].every((n) => Number.isFinite(n))) return null;
  const km = haversineKm(jlng, jlat, mlng, mlat);
  return Math.round(km * 10) / 10;
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
  withdrawnAt: quote.withdrawnAt || null,
  createdAt: quote.createdAt,
  quotedAgoLabel: formatQuoteRelativeAge(quote.createdAt),
  distanceKm: quoteDistanceKm(quote),
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
        rating: readMechanicProfileRatingAverage(quote.mechanic),
        jobsDone: quote.mechanic.mechanicProfile?.stats?.jobsDone ?? null,
        responseMinutesAvg: quote.mechanic.mechanicProfile?.stats?.responseMinutesAvg ?? null,
        verified:
          ["APPROVED", "SUBMITTED", "UNDER_REVIEW"].includes(
            quote.mechanic.mechanicProfile?.verification?.status
          ),
        profilePhotoUrl: pickUserProfilePhotoUrl(quote.mechanic),
        ...mechanicSpecialtyFields(quote.mechanic),
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
        postedAt: quote.job.postedAt || null,
        createdAt: quote.job.createdAt || null,
        location: quote.job.location || null,
        vehicle: quote.job.vehicle || null,
        assignedCompany: quote.job.assignedCompany || null,
        assignedMechanic: quote.job.assignedMechanic || null,
        fleet:
          quote.job.fleet && typeof quote.job.fleet === "object"
            ? {
                _id: quote.job.fleet._id || quote.job.fleet,
                companyName: quote.job.fleet.fleetProfile?.companyName || null,
                rating: quote.job.fleet.fleetProfile?.rating?.average ?? null,
                ratingCount: quote.job.fleet.fleetProfile?.rating?.count ?? null,
              }
            : null,
      }
    : null,
  company: quote.company
    ? {
        _id: quote.company._id || quote.company,
        companyName: quote.company.companyProfile?.companyName || null,
        contactName: quote.company.companyProfile?.contactName || null,
        phone: quote.company.companyProfile?.phone || null,
        profilePhotoUrl: pickUserProfilePhotoUrl(quote.company),
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

/** Waiting quotes end when the job is terminal or when an optional `expiresAt` time passes (legacy). */
const JOB_TERMINAL_FOR_QUOTES = [JOB_STATUS.CANCELLED, JOB_STATUS.COMPLETED];

const expireWaitingQuotes = async (filter = {}, session = null) => {
  const opts = sessionOptions(session);

  await Quote.updateMany(
    {
      ...filter,
      status: QUOTE_STATUS.WAITING,
      expiresAt: { $ne: null, $lte: now() },
    },
    {
      $set: {
        status: QUOTE_STATUS.EXPIRED,
        expiredAt: now(),
      },
    },
    opts
  );

  let closedJobQuery = Job.find({ status: { $in: JOB_TERMINAL_FOR_QUOTES } }).select("_id");
  if (session) closedJobQuery = closedJobQuery.session(session);
  const closedJobs = await closedJobQuery.lean();
  const closedJobIds = closedJobs.map((j) => j._id);
  if (!closedJobIds.length) return;

  await Quote.updateMany(
    {
      ...filter,
      status: QUOTE_STATUS.WAITING,
      job: { $in: closedJobIds },
    },
    {
      $set: {
        status: QUOTE_STATUS.EXPIRED,
        expiredAt: now(),
      },
    },
    opts
  );
};

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
    .populate({
      path: "mechanic",
      // Whole subdocuments — avoid dot-notation select, which often drops sibling keys in populated lean docs.
      select: "email role mechanicProfile companyProfile",
    })
    .populate(
      "company",
      "email role companyProfile.companyName companyProfile.contactName companyProfile.phone companyProfile.contactRole companyProfile.profilePhotoUrl"
    )
    .populate({
      path: "submittedBy",
      select: "email role mechanicProfile companyProfile",
    })
    .populate({
      path: "job",
      select:
        "jobCode title description urgency status location vehicle photos issueType fleet assignedCompany assignedMechanic createdAt postedAt",
      populate: {
        path: "fleet",
        select:
          "email fleetProfile.companyName fleetProfile.contactName fleetProfile.phone fleetProfile.rating",
      },
    })
    .populate("fleet", "email fleetProfile.companyName fleetProfile.contactName fleetProfile.phone");

/** `populate().lean()` can omit nested fields (e.g. profilePhotoUrl) even when they exist on User — merge from DB. */
const quoteMechanicIdKey = (q) => {
  const m = q?.mechanic;
  if (!m) return null;
  const id = m._id ?? m;
  return id?.toString?.() || null;
};

const quoteCompanyIdKey = (q) => {
  const c = q?.company;
  if (!c) return null;
  const id = c._id ?? c;
  return id?.toString?.() || null;
};

const quoteSubmittedByIdKey = (q) => {
  const s = q?.submittedBy;
  if (!s) return null;
  const id = s._id ?? s;
  return id?.toString?.() || null;
};

const mergeQuoteActorsProfileExtrasFromDb = async (quotesLean) => {
  const list = Array.isArray(quotesLean) ? quotesLean : [quotesLean];
  const userIds = [
    ...new Set(
      [
        ...list.map(quoteMechanicIdKey),
        ...list.map(quoteCompanyIdKey),
        ...list.map(quoteSubmittedByIdKey),
      ].filter(Boolean)
    ),
  ];
  if (!userIds.length) return;

  const users = await User.find({ _id: { $in: userIds } })
    .select(
      "mechanicProfile.profilePhotoUrl mechanicProfile.lastKnownLocation companyProfile.profilePhotoUrl"
    )
    .lean();

  const byId = Object.fromEntries(users.map((u) => [u._id.toString(), u]));

  for (const q of list) {
    const mid = quoteMechanicIdKey(q);
    if (mid && byId[mid]) {
      const src = byId[mid];
      if (!q.mechanic || typeof q.mechanic !== "object") {
        q.mechanic = { _id: q.mechanic || mid };
      }
      q.mechanic.mechanicProfile = {
        ...(q.mechanic.mechanicProfile || {}),
        profilePhotoUrl:
          src.mechanicProfile?.profilePhotoUrl ?? q.mechanic.mechanicProfile?.profilePhotoUrl,
        lastKnownLocation:
          src.mechanicProfile?.lastKnownLocation ?? q.mechanic.mechanicProfile?.lastKnownLocation,
      };
      q.mechanic.companyProfile = {
        ...(q.mechanic.companyProfile || {}),
        profilePhotoUrl:
          src.companyProfile?.profilePhotoUrl ?? q.mechanic.companyProfile?.profilePhotoUrl,
      };
    }

    const cid = quoteCompanyIdKey(q);
    if (cid && byId[cid]) {
      const src = byId[cid];
      if (!q.company || typeof q.company !== "object") {
        q.company = { _id: q.company || cid };
      }
      q.company.companyProfile = {
        ...(q.company.companyProfile || {}),
        profilePhotoUrl:
          src.companyProfile?.profilePhotoUrl ?? q.company.companyProfile?.profilePhotoUrl,
      };
    }

    const sid = quoteSubmittedByIdKey(q);
    if (sid && byId[sid]) {
      const src = byId[sid];
      if (!q.submittedBy || typeof q.submittedBy !== "object") {
        q.submittedBy = { _id: q.submittedBy || sid };
      }
      q.submittedBy.mechanicProfile = {
        ...(q.submittedBy.mechanicProfile || {}),
        profilePhotoUrl:
          src.mechanicProfile?.profilePhotoUrl ?? q.submittedBy.mechanicProfile?.profilePhotoUrl,
        lastKnownLocation:
          src.mechanicProfile?.lastKnownLocation ?? q.submittedBy.mechanicProfile?.lastKnownLocation,
      };
      q.submittedBy.companyProfile = {
        ...(q.submittedBy.companyProfile || {}),
        profilePhotoUrl:
          src.companyProfile?.profilePhotoUrl ?? q.submittedBy.companyProfile?.profilePhotoUrl,
      };
    }
  }
};

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
  await mergeQuoteActorsProfileExtrasFromDb([populated]);

  await notifyQuoteSubmitted(job, quote, mechanicUser);

  return serializeQuote(populated);
};

export const listJobQuotes = async (jobId, fleetUser) => {
  await ensureFleetJobOwner(jobId, fleetUser._id);
  await expireWaitingQuotes({ job: jobId });
  const quotes = await baseQuotePopulate(
    Quote.find({ job: jobId }).sort({ amount: 1, createdAt: -1 })
  ).lean();
  await mergeQuoteActorsProfileExtrasFromDb(quotes);
  return quotes.map(serializeQuote);
};

export const getQuoteByIdForUser = async (quoteId, user) => {
  await expireWaitingQuotes({ _id: quoteId });
  const quote = await baseQuotePopulate(Quote.findById(quoteId)).lean();
  await mergeQuoteActorsProfileExtrasFromDb([quote]);
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
          profilePhotoUrl: pickUserProfilePhotoUrl(quote.submittedBy),
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

    const otherWaitingQuotes = await Quote.find(
      {
        job: quote.job,
        _id: { $ne: quote._id },
        status: QUOTE_STATUS.WAITING,
      },
      null,
      sessionOptions(session)
    ).lean();

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
    await mergeQuoteActorsProfileExtrasFromDb([populated]);

    await notifyQuoteAccepted(job, quote);
    await notifyQuotesNotSelected(job, otherWaitingQuotes);

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

  const job = await Job.findById(quote.job).lean();

  await JobEvent.create({
    job: quote.job,
    actor: fleetUser._id,
    type: "QUOTE_DECLINED",
    payload: { quoteId: quote._id },
  });

  const populated = await baseQuotePopulate(Quote.findById(quote._id)).lean();
  await mergeQuoteActorsProfileExtrasFromDb([populated]);

  if (job) await notifyQuoteDeclined(job, quote);

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

  quote.expiresAt = null;
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

  const job = await Job.findById(quote.job).lean();
  if (job) await notifyQuoteAmended(job, quote);

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
  await mergeQuoteActorsProfileExtrasFromDb([populated]);

  const job = await Job.findById(quote.job).lean();
  if (job) await notifyQuoteWithdrawn(job, quote);

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

  if (tab === "WAITING" || tab === "PENDING") filter.status = QUOTE_STATUS.WAITING;
  if (tab === "ACCEPTED") filter.status = QUOTE_STATUS.ACCEPTED;
  if (tab === "EXPIRED") filter.status = QUOTE_STATUS.EXPIRED;
  if (tab === "DECLINED" || tab === "REJECTED") filter.status = QUOTE_STATUS.DECLINED;

  const quotes = await baseQuotePopulate(
    Quote.find(filter).sort({ createdAt: -1 })
  ).lean();

  await mergeQuoteActorsProfileExtrasFromDb(quotes);
  return quotes.map(serializeQuote);
};

const parseQuotePage = (value) => {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 1;
};

const parseQuoteLimit = (value) => {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return 20;
  return Math.min(Math.floor(n), 100);
};

export const countOwnerQuotesByStatus = async (ownerUser) => {
  const filter =
    ownerUser.role === ROLES.COMPANY
      ? { company: ownerUser._id }
      : { mechanic: ownerUser._id };
  const rows = await Quote.aggregate([
    { $match: filter },
    { $group: { _id: "$status", count: { $sum: 1 } } },
  ]);
  const counts = {
    WAITING: 0,
    ACCEPTED: 0,
    DECLINED: 0,
    EXPIRED: 0,
    WITHDRAWN: 0,
  };
  for (const r of rows) {
    if (r._id && Object.prototype.hasOwnProperty.call(counts, r._id)) {
      counts[r._id] = r.count;
    }
  }
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  return { ...counts, total };
};

export const listOwnerQuotesPaginated = async (ownerUser, query = {}) => {
  const page = parseQuotePage(query.page);
  const limit = parseQuoteLimit(query.limit);
  const skip = (page - 1) * limit;

  const baseOwnerFilter =
    ownerUser.role === ROLES.COMPANY
      ? { company: ownerUser._id }
      : { mechanic: ownerUser._id };

  await expireWaitingQuotes(baseOwnerFilter);

  const filter = { ...baseOwnerFilter };
  const tab = `${query.tab || query.status || "ALL"}`.toUpperCase();

  if (tab === "WAITING" || tab === "PENDING") filter.status = QUOTE_STATUS.WAITING;
  else if (tab === "ACCEPTED") filter.status = QUOTE_STATUS.ACCEPTED;
  else if (tab === "EXPIRED") filter.status = QUOTE_STATUS.EXPIRED;
  else if (tab === "DECLINED" || tab === "REJECTED") filter.status = QUOTE_STATUS.DECLINED;
  else if (tab === "WITHDRAWN") filter.status = QUOTE_STATUS.WITHDRAWN;

  const [total, quotes] = await Promise.all([
    Quote.countDocuments(filter),
    baseQuotePopulate(Quote.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit)).lean(),
  ]);

  await mergeQuoteActorsProfileExtrasFromDb(quotes);
  const items = quotes.map(serializeQuote);
  return {
    items,
    meta: {
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit) || 1,
      tab: tab === "ALL" || !filter.status ? "ALL" : tab,
      mode: "quotes",
    },
  };
};
