import AppError from "../../utils/AppError.js";
import { Review } from "./review.model.js";
import { Job } from "../job/job.model.js";
import { User } from "../user/user.model.js";
import { JOB_STATUS, REVIEW_KIND, ROLES } from "../../constants/domain.js";
import { createNotification } from "../notification/notification.service.js";

const parsePage = (value) => {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 1;
};

const parseLimit = (value) => {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return 20;
  return Math.min(Math.floor(n), 100);
};

const toIdString = (value) => (value?._id || value)?.toString?.() ?? `${value}`;

const fleetRatesMechanicClause = () => ({
  $or: [
    { reviewKind: REVIEW_KIND.FLEET_RATES_MECHANIC },
    { reviewKind: { $exists: false } },
  ],
});

const serializeReview = (review) => ({
  _id: review._id,
  reviewKind: review.reviewKind || REVIEW_KIND.FLEET_RATES_MECHANIC,
  fleet: review.fleet
    ? {
        _id: review.fleet._id || review.fleet,
        companyName: review.fleet.fleetProfile?.companyName || review.companyName || null,
      }
    : null,
  mechanic: review.mechanic
    ? {
        _id: review.mechanic._id || review.mechanic,
        displayName:
          review.mechanic.mechanicProfile?.displayName || review.mechanicName || null,
      }
    : null,
  job: review.job
    ? {
        _id: review.job._id || review.job,
        jobCode: review.job.jobCode || null,
        title: review.job.title || review.serviceLabel || null,
      }
    : null,
  customerName: review.customerName,
  companyName: review.companyName || null,
  serviceLabel: review.serviceLabel || null,
  mechanicName: review.mechanicName || null,
  rating: review.rating,
  comment: review.comment || null,
  status: review.status,
  createdAt: review.createdAt,
  updatedAt: review.updatedAt,
});

const ensureFleetUser = (user) => {
  if (user.role !== ROLES.FLEET) {
    throw new AppError("Only fleet users can manage reviews", 403);
  }
};

const updateMechanicRating = async (mechanicId) => {
  if (!mechanicId) return;

  const [stats] = await Review.aggregate([
    {
      $match: {
        mechanic: mechanicId,
        status: "PUBLISHED",
        ...fleetRatesMechanicClause(),
      },
    },
    {
      $group: {
        _id: null,
        average: { $avg: "$rating" },
        count: { $sum: 1 },
      },
    },
  ]);

  await User.updateOne(
    { _id: mechanicId },
    {
      $set: {
        "mechanicProfile.rating.average":
          Math.round(((stats?.average || 0) * 10)) / 10,
        "mechanicProfile.rating.count": stats?.count || 0,
      },
    }
  );
};

const updateFleetRating = async (fleetId) => {
  if (!fleetId) return;

  const [stats] = await Review.aggregate([
    {
      $match: {
        fleet: fleetId,
        status: "PUBLISHED",
        reviewKind: REVIEW_KIND.MECHANIC_RATES_FLEET,
      },
    },
    {
      $group: {
        _id: null,
        average: { $avg: "$rating" },
        count: { $sum: 1 },
      },
    },
  ]);

  await User.updateOne(
    { _id: fleetId },
    {
      $set: {
        "fleetProfile.rating.average":
          Math.round(((stats?.average || 0) * 10)) / 10,
        "fleetProfile.rating.count": stats?.count || 0,
      },
    }
  );
};

const ensureMechanicReviewer = (user) => {
  if (![ROLES.MECHANIC, ROLES.MECHANIC_EMPLOYEE].includes(user.role)) {
    throw new AppError("Only mechanics can rate fleet operators", 403);
  }
};

export const createMechanicReviewOfFleet = async (mechanicUser, jobId, payload = {}) => {
  ensureMechanicReviewer(mechanicUser);

  const rating = Number(payload.rating);
  if (!Number.isFinite(rating) || rating < 1 || rating > 5) {
    throw new AppError("rating must be between 1 and 5", 400);
  }
  if (!jobId) throw new AppError("jobId is required", 400);

  const job = await Job.findById(jobId)
    .populate("assignedMechanic", "mechanicProfile.displayName mechanicProfile.contactName email")
    .populate("fleet", "fleetProfile.companyName fleetProfile.contactName email")
    .lean();

  if (!job) throw new AppError("Job not found", 404);

  const assignedId = toIdString(job.assignedMechanic?._id || job.assignedMechanic);
  if (!assignedId) throw new AppError("No mechanic assigned to this job", 400);
  if (assignedId !== toIdString(mechanicUser._id)) {
    throw new AppError("Forbidden", 403);
  }
  const mechanicReviewFleetAllowedStatuses = new Set([
    JOB_STATUS.AWAITING_APPROVAL,
    JOB_STATUS.COMPLETED,
  ]);
  if (!mechanicReviewFleetAllowedStatuses.has(job.status)) {
    throw new AppError(
      "Reviews can only be left when the job is awaiting fleet approval or completed",
      400
    );
  }

  const fleetId = job.fleet?._id || job.fleet;
  if (!fleetId) throw new AppError("Job has no fleet operator", 400);

  const existing = await Review.findOne({
    job: job._id,
    reviewKind: REVIEW_KIND.MECHANIC_RATES_FLEET,
  });
  if (existing) throw new AppError("You have already rated this fleet for this job", 409);

  const mechanicDoc = job.assignedMechanic;
  const customerName =
    mechanicDoc?.mechanicProfile?.displayName ||
    mechanicUser.mechanicProfile?.displayName ||
    mechanicUser.email;

  const review = await Review.create({
    fleet: fleetId,
    mechanic: mechanicUser._id,
    job: job._id,
    reviewKind: REVIEW_KIND.MECHANIC_RATES_FLEET,
    customerName,
    companyName:
      job.fleet?.fleetProfile?.companyName ||
      job.fleet?.companyName ||
      null,
    serviceLabel: job.title || job.description,
    mechanicName:
      mechanicDoc?.mechanicProfile?.displayName ||
      mechanicUser.mechanicProfile?.displayName ||
      null,
    rating,
    comment: payload.comment,
    status: "PUBLISHED",
  });

  await updateFleetRating(fleetId);

  await createNotification({
    user: fleetId,
    type: "REVIEW_CREATED",
    title: `New mechanic review for ${job.jobCode}`,
    body:
      rating >= 4
        ? `You received a ${rating}-star review from the assigned mechanic.`
        : `The assigned mechanic left a ${rating}-star review for this completed job.`,
    data: {
      jobId: job._id.toString(),
      reviewId: review._id.toString(),
      rating,
      reviewKind: REVIEW_KIND.MECHANIC_RATES_FLEET,
    },
  });

  const populated = await Review.findById(review._id)
    .populate("fleet", "fleetProfile.companyName")
    .populate("mechanic", "mechanicProfile.displayName")
    .populate("job", "jobCode title")
    .lean();

  return serializeReview(populated);
};

export const createFleetReview = async (fleetUser, payload = {}) => {
  ensureFleetUser(fleetUser);

  const rating = Number(payload.rating);
  if (!Number.isFinite(rating) || rating < 1 || rating > 5) {
    throw new AppError("rating must be between 1 and 5", 400);
  }
  if (!payload.jobId) throw new AppError("jobId is required", 400);

  const job = await Job.findById(payload.jobId)
    .populate("assignedMechanic", "mechanicProfile.displayName")
    .populate("fleet", "fleetProfile.companyName fleetProfile.contactName")
    .lean();

  if (!job) throw new AppError("Job not found", 404);
  if (job.fleet?._id?.toString?.() !== fleetUser._id.toString()) {
    throw new AppError("Forbidden", 403);
  }
  if (job.status !== JOB_STATUS.COMPLETED) {
    throw new AppError("Reviews can only be left for completed jobs", 400);
  }
  if (!job.assignedMechanic?._id && !job.assignedMechanic) {
    throw new AppError("No mechanic assigned to this job", 400);
  }

  const existing = await Review.findOne({
    job: job._id,
    ...fleetRatesMechanicClause(),
  });
  if (existing) throw new AppError("A review already exists for this job", 409);

  const review = await Review.create({
    fleet: fleetUser._id,
    mechanic: job.assignedMechanic._id || job.assignedMechanic,
    job: job._id,
    reviewKind: REVIEW_KIND.FLEET_RATES_MECHANIC,
    customerName:
      job.fleet?.fleetProfile?.contactName ||
      fleetUser.fleetProfile?.contactName ||
      fleetUser.email,
    companyName:
      job.fleet?.fleetProfile?.companyName ||
      fleetUser.fleetProfile?.companyName ||
      null,
    serviceLabel: job.title || job.description,
    mechanicName:
      job.assignedMechanic?.mechanicProfile?.displayName || null,
    rating,
    comment: payload.comment,
    status: "PUBLISHED",
  });

  await updateMechanicRating(review.mechanic);

  await createNotification({
    user: review.mechanic,
    type: "REVIEW_CREATED",
    title: `New fleet review for ${job.jobCode}`,
    body:
      rating >= 4
        ? `You received a ${rating}-star review from the fleet operator.`
        : `A fleet operator left a ${rating}-star review for this completed job.`,
    data: {
      jobId: job._id.toString(),
      reviewId: review._id.toString(),
      rating,
    },
  });

  const populated = await Review.findById(review._id)
    .populate("fleet", "fleetProfile.companyName")
    .populate("mechanic", "mechanicProfile.displayName")
    .populate("job", "jobCode title")
    .lean();

  return serializeReview(populated);
};

export const listFleetReviews = async (fleetUser, query = {}) => {
  ensureFleetUser(fleetUser);

  const page = parsePage(query.page);
  const limit = parseLimit(query.limit);
  const skip = (page - 1) * limit;

  const filter = { fleet: fleetUser._id, ...fleetRatesMechanicClause() };
  if (query.status) filter.status = `${query.status}`.trim().toUpperCase();

  const [items, total] = await Promise.all([
    Review.find(filter)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .populate("fleet", "fleetProfile.companyName")
      .populate("mechanic", "mechanicProfile.displayName")
      .populate("job", "jobCode title")
      .lean(),
    Review.countDocuments(filter),
  ]);

  return {
    items: items.map(serializeReview),
    meta: {
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit) || 1,
    },
  };
};

export const listMechanicReviews = async (mechanicUser, query = {}) => {
  if (mechanicUser.role !== ROLES.MECHANIC) {
    throw new AppError("Only mechanic users can view mechanic reviews", 403);
  }

  const page = parsePage(query.page);
  const limit = parseLimit(query.limit);
  const skip = (page - 1) * limit;

  const filter = {
    mechanic: mechanicUser._id,
    ...fleetRatesMechanicClause(),
  };
  if (query.status) filter.status = `${query.status}`.trim().toUpperCase();

  const [items, total] = await Promise.all([
    Review.find(filter)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .populate("fleet", "fleetProfile.companyName")
      .populate("mechanic", "mechanicProfile.displayName")
      .populate("job", "jobCode title")
      .lean(),
    Review.countDocuments(filter),
  ]);

  return {
    items: items.map(serializeReview),
    meta: {
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit) || 1,
    },
  };
};

export const getMechanicReviewById = async (mechanicUser, reviewId) => {
  if (mechanicUser.role !== ROLES.MECHANIC) {
    throw new AppError("Only mechanic users can view this review", 403);
  }

  const review = await Review.findOne({
    _id: reviewId,
    mechanic: mechanicUser._id,
    ...fleetRatesMechanicClause(),
  })
    .populate("fleet", "fleetProfile.companyName fleetProfile.contactName")
    .populate("mechanic", "mechanicProfile.displayName")
    .populate("job", "jobCode title description completedAt")
    .lean();

  if (!review) throw new AppError("Review not found", 404);

  return serializeReview(review);
};
