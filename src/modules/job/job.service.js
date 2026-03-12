import AppError from "../../utils/AppError.js";
import { ROLES, JOB_STATUS, QUOTE_STATUS } from "../../constants/domain.js";
import { Job } from "./job.model.js";
import { Quote } from "../quote/quote.model.js";
import { JobEvent } from "../jobEvent/jobEvent.model.js";

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

const generateJobCode = async () => {
  for (let i = 0; i < 8; i += 1) {
    const random = Math.floor(1000 + Math.random() * 9000);
    const jobCode = `TF-${random}`;
    const exists = await Job.exists({ jobCode });
    if (!exists) return jobCode;
  }
  throw new AppError("Unable to generate job code", 500);
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

export const createJob = async (payload, fleetUser) => {
  if (!payload.title || !payload.description) {
    throw new AppError("title and description are required", 400);
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
    } else if (query.tab === "active") {
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

  if (user.role === ROLES.MECHANIC) {
    if (`${query.feed}` === "true") {
      filter.status = { $in: [JOB_STATUS.POSTED, JOB_STATUS.QUOTING] };
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

  const [items, total] = await Promise.all([
    Job.find(filter)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .populate("assignedMechanic", "email role mechanicProfile.displayName")
      .lean(),
    Job.countDocuments(filter),
  ]);

  return {
    items,
    meta: { page, limit, total, totalPages: Math.ceil(total / limit) || 1 },
  };
};

export const getJobByIdForUser = async (jobId, user) => {
  const job = await Job.findById(jobId)
    .populate("fleet", "email role fleetProfile.companyName fleetProfile.contactName")
    .populate(
      "assignedMechanic",
      "email role mechanicProfile.displayName mechanicProfile.phone"
    );

  if (!job) throw new AppError("Job not found", 404);
  if (user.role === ROLES.ADMIN) return job;

  const userId = toObjectIdString(user._id);
  const fleetId = toObjectIdString(job.fleet?._id || job.fleet);
  const mechanicId = toObjectIdString(job.assignedMechanic?._id || job.assignedMechanic);

  if (user.role === ROLES.FLEET && fleetId === userId) return job;
  if (user.role === ROLES.MECHANIC && mechanicId === userId) return job;

  if (
    user.role === ROLES.MECHANIC &&
    [JOB_STATUS.POSTED, JOB_STATUS.QUOTING].includes(job.status)
  ) {
    return job;
  }

  const hasQuote = await Quote.exists({ job: job._id, mechanic: user._id });
  if (user.role === ROLES.MECHANIC && hasQuote) return job;

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
  });

export const approveJobCompletion = async (jobId, fleetUser, payload) => {
  const job = await Job.findById(jobId);
  if (!job) throw new AppError("Job not found", 404);

  ensureFleetOwner(job, fleetUser._id);
  if (job.status !== JOB_STATUS.AWAITING_APPROVAL) {
    throw new AppError("Job is not awaiting approval", 400);
  }

  const fromStatus = job.status;
  job.status = JOB_STATUS.COMPLETED;
  job.completedAt = new Date();
  await job.save();

  await createJobEvent({
    jobId: job._id,
    actorId: fleetUser._id,
    type: "JOB_COMPLETED",
    fromStatus,
    toStatus: JOB_STATUS.COMPLETED,
    payload: {
      paymentMethodId: payload.paymentMethodId,
    },
  });

  return job;
};

export const cancelJob = async (jobId, fleetUser, payload = {}) => {
  const job = await Job.findById(jobId);
  if (!job) throw new AppError("Job not found", 404);

  ensureFleetOwner(job, fleetUser._id);
  if ([JOB_STATUS.COMPLETED, JOB_STATUS.CANCELLED].includes(job.status)) {
    throw new AppError("Job cannot be cancelled in current status", 400);
  }

  const fromStatus = job.status;
  const isFreeCancellation = [
    JOB_STATUS.POSTED,
    JOB_STATUS.QUOTING,
    JOB_STATUS.ASSIGNED,
  ].includes(fromStatus);

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
      fee: isFreeCancellation ? 0 : 35,
      currency: "GBP",
    },
  });

  return {
    job,
    cancellation: {
      isFree: isFreeCancellation,
      fee: isFreeCancellation ? 0 : 35,
      currency: "GBP",
    },
  };
};
