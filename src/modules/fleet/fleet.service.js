import AppError from "../../utils/AppError.js";
import { Job } from "../job/job.model.js";
import { Invoice } from "../invoice/invoice.model.js";
import { JOB_STATUS } from "../../constants/domain.js";
import { getProfileCompletionSummary } from "../user/user.service.js";

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

const statusUi = (status) => {
  const map = {
    [JOB_STATUS.POSTED]: { label: "POSTED", tone: "red" },
    [JOB_STATUS.QUOTING]: { label: "QUOTING", tone: "amber" },
    [JOB_STATUS.ASSIGNED]: { label: "ASSIGNED", tone: "blue" },
    [JOB_STATUS.EN_ROUTE]: { label: "EN ROUTE", tone: "amber" },
    [JOB_STATUS.ON_SITE]: { label: "ON SITE", tone: "green" },
    [JOB_STATUS.IN_PROGRESS]: { label: "IN PROGRESS", tone: "amber" },
    [JOB_STATUS.AWAITING_APPROVAL]: { label: "AWAITING APPROVAL", tone: "yellow" },
    [JOB_STATUS.COMPLETED]: { label: "DONE", tone: "green" },
    [JOB_STATUS.CANCELLED]: { label: "CANCELLED", tone: "red" },
  };
  return map[status] || { label: status, tone: "neutral" };
};

const serializeDashboardJob = (job, invoice = null) => ({
  _id: job._id,
  jobCode: job.jobCode,
  title: job.title,
  description: job.completionSummary || job.description,
  urgency: job.urgency,
  status: job.status,
  statusUi: statusUi(job.status),
  vehicle: job.vehicle || null,
  location: job.location || null,
  currency: job.currency || "GBP",
  amount: job.finalAmount ?? job.acceptedAmount ?? job.estimatedPayout ?? null,
  etaMinutes: job.tracking?.etaMinutes ?? null,
  postedAt: job.postedAt || job.createdAt,
  completedAt: job.completedAt || null,
  assignedMechanic: job.assignedMechanic
    ? {
        _id: job.assignedMechanic._id || job.assignedMechanic,
        displayName: job.assignedMechanic.mechanicProfile?.displayName || null,
        phone: job.assignedMechanic.mechanicProfile?.phone || null,
        rating: job.assignedMechanic.mechanicProfile?.rating?.average ?? null,
      }
    : null,
  actions: {
    canApproveCompletion: job.status === JOB_STATUS.AWAITING_APPROVAL,
    canTrack: [
      JOB_STATUS.ASSIGNED,
      JOB_STATUS.EN_ROUTE,
      JOB_STATUS.ON_SITE,
      JOB_STATUS.IN_PROGRESS,
      JOB_STATUS.AWAITING_APPROVAL,
    ].includes(job.status),
    canViewInvoice: Boolean(invoice),
    canDownloadPdf: Boolean(invoice?.pdfUrl || invoice?._id),
  },
  invoice: invoice
    ? {
        _id: invoice._id,
        invoiceNo: invoice.invoiceNo,
        pdfUrl: invoice.pdfUrl || null,
      }
    : null,
});

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

  const [
    activeCount,
    awaitingCount,
    monthCompletedCount,
    activeJobs,
    completedJobs,
    completedTotal,
    profileState,
  ] = await Promise.all([
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
      .populate(
        "assignedMechanic",
        "email role mechanicProfile.displayName mechanicProfile.phone mechanicProfile.rating"
      )
      .lean(),
    Job.find({ fleet: fleetUser._id, status: JOB_STATUS.COMPLETED })
      .sort({ completedAt: -1 })
      .skip(skip)
      .limit(limit)
      .populate(
        "assignedMechanic",
        "email role mechanicProfile.displayName mechanicProfile.phone mechanicProfile.rating"
      )
      .lean(),
    Job.countDocuments({ fleet: fleetUser._id, status: JOB_STATUS.COMPLETED }),
    getProfileCompletionSummary(fleetUser),
  ]);

  const invoiceJobIds = completedJobs.map((job) => job._id);
  const invoices = await Invoice.find({
    fleet: fleetUser._id,
    job: { $in: invoiceJobIds },
  })
    .select("_id job invoiceNo pdfUrl")
    .lean();

  const invoiceByJobId = new Map(
    invoices.map((invoice) => [invoice.job.toString(), invoice])
  );

  const awaitingApprovalJob = activeJobs.find(
    (job) => job.status === JOB_STATUS.AWAITING_APPROVAL
  );

  return {
    cards: {
      activeCount,
      awaitingCount,
      monthCompletedCount,
    },
    shortcuts: {
      awaitingApproval: awaitingApprovalJob
        ? serializeDashboardJob(awaitingApprovalJob)
        : null,
      postJob: {
        enabled: profileState.profileCompletion?.isComplete || false,
        profileCompletion: profileState.profileCompletion,
      },
    },
    lists: {
      activeJobs: activeJobs.map((job) => serializeDashboardJob(job)),
      completedJobs: completedJobs.map((job) =>
        serializeDashboardJob(job, invoiceByJobId.get(job._id.toString()) || null)
      ),
    },
    meta: {
      completedPage: page,
      completedLimit: limit,
      completedTotal,
      completedTotalPages: Math.ceil(completedTotal / limit) || 1,
    },
    flags: {
      hasPendingApprovals: awaitingCount > 0,
      profileCompletion: profileState.profileCompletion,
    },
  };
};
