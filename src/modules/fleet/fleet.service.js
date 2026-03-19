import AppError from "../../utils/AppError.js";
import { Job } from "../job/job.model.js";
import { JOB_STATUS } from "../../constants/domain.js";

const parsePage = (value) => {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 1;
};

const parseLimit = (value) => {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return 10;
  return Math.min(Math.floor(n), 50);
};

const getMonthRange = (d = new Date()) => {
  const start = new Date(d.getFullYear(), d.getMonth(), 1);
  const end = new Date(d.getFullYear(), d.getMonth() + 1, 1);
  return { start, end };
};

export const getFleetDashboard = async (fleetUser, query) => {
  if (!fleetUser?._id) throw new AppError("Unauthorized", 401);

  const { start, end } = getMonthRange();
  const page = parsePage(query.page);
  const limit = parseLimit(query.limit);
  const skip = (page - 1) * limit;

  const activeStatuses = [
    JOB_STATUS.POSTED,
    JOB_STATUS.QUOTING,
    JOB_STATUS.ASSIGNED,
    JOB_STATUS.EN_ROUTE,
    JOB_STATUS.ON_SITE,
    JOB_STATUS.IN_PROGRESS,
    JOB_STATUS.AWAITING_APPROVAL,
  ];

  const [activeCount, awaitingCount, monthCompletedCount, activeJobs, completedJobs, completedTotal] =
    await Promise.all([
      Job.countDocuments({ fleet: fleetUser._id, status: { $in: activeStatuses } }),
      Job.countDocuments({ fleet: fleetUser._id, status: JOB_STATUS.AWAITING_APPROVAL }),
      Job.countDocuments({
        fleet: fleetUser._id,
        status: JOB_STATUS.COMPLETED,
        completedAt: { $gte: start, $lt: end },
      }),
      Job.find({ fleet: fleetUser._id, status: { $in: activeStatuses } })
        .sort({ createdAt: -1 })
        .limit(10)
        .populate("assignedMechanic", "email role mechanicProfile.displayName")
        .lean(),
      Job.find({ fleet: fleetUser._id, status: JOB_STATUS.COMPLETED })
        .sort({ completedAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      Job.countDocuments({ fleet: fleetUser._id, status: JOB_STATUS.COMPLETED }),
    ]);

  const profileCompletion = {
    percentage: fleetUser.fleetProfile?.profileCompleted ? 100 : 60,
    missing: fleetUser.fleetProfile?.profileCompleted
      ? []
      : ["Company Details", "Contact Person", "Billing & Payment"],
  };

  return {
    cards: {
      activeCount,
      awaitingCount,
      monthCompletedCount,
    },
    lists: {
      activeJobs,
      completedJobs,
    },
    meta: {
      completedPage: page,
      completedLimit: limit,
      completedTotal,
      completedTotalPages: Math.ceil(completedTotal / limit) || 1,
    },
    flags: {
      hasPendingApprovals: awaitingCount > 0,
      profileCompletion,
    },
  };
};
