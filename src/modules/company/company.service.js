import crypto from "crypto";
import AppError from "../../utils/AppError.js";
import { ROLES, JOB_STATUS } from "../../constants/domain.js";
import { Job } from "../job/job.model.js";
import { Quote } from "../quote/quote.model.js";
import { Invoice } from "../invoice/invoice.model.js";
import { User } from "../user/user.model.js";
import { JobEvent } from "../jobEvent/jobEvent.model.js";
import { CompanyInvite } from "./companyInvite.model.js";
import { getJobByIdForUser, listJobs } from "../job/job.service.js";

const ACTIVE_JOB_STATUSES = [
  JOB_STATUS.ASSIGNED,
  JOB_STATUS.EN_ROUTE,
  JOB_STATUS.ON_SITE,
  JOB_STATUS.IN_PROGRESS,
  JOB_STATUS.AWAITING_APPROVAL,
];

const ensureCompanyUser = (user) => {
  if (!user?._id || user.role !== ROLES.COMPANY) {
    throw new AppError("Only company users can access this resource", 403);
  }
};

const monthRange = (date = new Date()) => {
  const start = new Date(date.getFullYear(), date.getMonth(), 1);
  const end = new Date(date.getFullYear(), date.getMonth() + 1, 1);
  return { start, end };
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

const serializeInvite = (invite) => ({
  _id: invite._id,
  email: invite.email,
  status: invite.status,
  expiresAt: invite.expiresAt,
  acceptedAt: invite.acceptedAt || null,
  cancelledAt: invite.cancelledAt || null,
  createdAt: invite.createdAt,
});

const serializeTeamMember = (member, stats = {}) => ({
  _id: member._id,
  email: member.email,
  role: member.role,
  status: member.status,
  displayName:
    member.mechanicProfile?.displayName ||
    member.companyProfile?.contactName ||
    member.email,
  phone: member.mechanicProfile?.phone || null,
  businessType: member.mechanicProfile?.businessType || null,
  baseLocationText: member.mechanicProfile?.baseLocationText || null,
  rating: member.mechanicProfile?.rating?.average ?? null,
  jobsCompleted: stats.jobsCompleted || 0,
  activeJobs: stats.activeJobs || 0,
  joinedAt: member.companyMembership?.joinedAt || member.createdAt,
  jobTitle: member.companyMembership?.jobTitle || null,
});

const serializeCompanyInvoiceJob = (job, invoice) => {
  const gross = Number(job.finalAmount ?? job.acceptedAmount ?? job.estimatedPayout ?? 0);
  const platformFee = Math.round(gross * 0.12 * 100) / 100;
  const net = Math.max(Math.round((gross - platformFee) * 100) / 100, 0);

  return {
    _id: job._id,
    jobCode: job.jobCode,
    title: job.title,
    description: job.completionSummary || job.description,
    vehicle: job.vehicle || null,
    location: job.location || null,
    completedAt: job.completedAt || null,
    grossAmount: gross,
    platformFee,
    netAmount: net,
    currency: job.currency || "GBP",
    mechanic: job.assignedMechanic
      ? {
          _id: job.assignedMechanic._id || job.assignedMechanic,
          displayName: job.assignedMechanic.mechanicProfile?.displayName || null,
          rating: job.assignedMechanic.mechanicProfile?.rating?.average ?? null,
        }
      : null,
    fleet: job.fleet
      ? {
          _id: job.fleet._id || job.fleet,
          companyName: job.fleet.fleetProfile?.companyName || null,
        }
      : null,
    invoice: invoice
      ? {
          _id: invoice._id,
          invoiceNo: invoice.invoiceNo,
          pdfUrl: invoice.pdfUrl || null,
          status: invoice.status,
          paidAt: invoice.paidAt || null,
        }
      : null,
  };
};

export const getCompanyDashboard = async (companyUser) => {
  ensureCompanyUser(companyUser);

  const { start, end } = monthRange();

  const [teamCount, activeJobsCount, unassignedJobs, monthRevenueAgg, avgRatingAgg, recentEvents] =
    await Promise.all([
      User.countDocuments({
        role: ROLES.MECHANIC_EMPLOYEE,
        status: { $ne: "BLOCKED" },
        "companyMembership.company": companyUser._id,
        "companyMembership.status": "ACTIVE",
      }),
      Job.countDocuments({
        assignedCompany: companyUser._id,
        status: { $in: ACTIVE_JOB_STATUSES },
      }),
      Job.find({
        assignedCompany: companyUser._id,
        assignedMechanic: { $exists: false },
        status: { $in: [JOB_STATUS.ASSIGNED, JOB_STATUS.EN_ROUTE, JOB_STATUS.ON_SITE, JOB_STATUS.IN_PROGRESS] },
      })
        .sort({ assignedAt: -1, createdAt: -1 })
        .limit(6)
        .select("jobCode title description urgency location vehicle status createdAt assignedAt")
        .lean(),
      Job.aggregate([
        {
          $match: {
            assignedCompany: companyUser._id,
            status: JOB_STATUS.COMPLETED,
            completedAt: { $gte: start, $lt: end },
          },
        },
        {
          $group: {
            _id: null,
            gross: {
              $sum: {
                $ifNull: ["$finalAmount", { $ifNull: ["$acceptedAmount", "$estimatedPayout"] }],
              },
            },
          },
        },
      ]),
      User.aggregate([
        {
          $match: {
            role: ROLES.MECHANIC_EMPLOYEE,
            "companyMembership.company": companyUser._id,
            "companyMembership.status": "ACTIVE",
          },
        },
        {
          $group: {
            _id: null,
            avgRating: { $avg: "$mechanicProfile.rating.average" },
          },
        },
      ]),
      JobEvent.find({ "payload.companyId": companyUser._id })
        .sort({ createdAt: -1 })
        .limit(8)
        .lean(),
    ]);

  return {
    company: {
      _id: companyUser._id,
      companyName: companyUser.companyProfile?.companyName || null,
      contactName: companyUser.companyProfile?.contactName || null,
      phone: companyUser.companyProfile?.phone || null,
    },
    cards: {
      activeJobs: activeJobsCount,
      mechanics: teamCount,
      monthRevenue: monthRevenueAgg[0]?.gross || 0,
      averageRating: Math.round((avgRatingAgg[0]?.avgRating || 0) * 10) / 10,
    },
    unassignedJobs: unassignedJobs.map((job) => ({
      _id: job._id,
      jobCode: job.jobCode,
      title: job.title,
      description: job.description,
      urgency: job.urgency,
      vehicle: job.vehicle || null,
      location: job.location || null,
      status: job.status,
      assignedAt: job.assignedAt || null,
      createdAt: job.createdAt,
    })),
    recentActivity: recentEvents.map((event) => ({
      _id: event._id,
      type: event.type,
      note: event.note || null,
      payload: event.payload || null,
      createdAt: event.createdAt,
    })),
  };
};

export const getCompanyFeed = async (companyUser, query) => {
  ensureCompanyUser(companyUser);
  return listJobs(companyUser, { ...query, feed: "true" });
};

export const getCompanyJobs = async (companyUser, query = {}) => {
  ensureCompanyUser(companyUser);

  const page = parsePage(query.page);
  const limit = parseLimit(query.limit);
  const skip = (page - 1) * limit;
  const tab = `${query.tab || "all"}`.toLowerCase();
  const filter = { assignedCompany: companyUser._id };

  if (tab === "unassigned") {
    filter.assignedMechanic = { $exists: false };
    filter.status = { $in: [JOB_STATUS.ASSIGNED, JOB_STATUS.EN_ROUTE, JOB_STATUS.ON_SITE, JOB_STATUS.IN_PROGRESS] };
  } else if (tab === "assigned") {
    filter.assignedMechanic = { $exists: true, $ne: null };
    filter.status = { $in: [JOB_STATUS.ASSIGNED, JOB_STATUS.EN_ROUTE] };
  } else if (tab === "in_progress") {
    filter.status = { $in: [JOB_STATUS.ON_SITE, JOB_STATUS.IN_PROGRESS] };
  } else if (tab === "pending_review") {
    filter.status = JOB_STATUS.AWAITING_APPROVAL;
  } else if (tab === "completed") {
    filter.status = JOB_STATUS.COMPLETED;
  }

  const [items, total, summary] = await Promise.all([
    Job.find(filter)
      .sort({ updatedAt: -1, createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .populate("fleet", "fleetProfile.companyName")
      .populate("assignedMechanic", "mechanicProfile.displayName mechanicProfile.rating mechanicProfile.phone")
      .lean(),
    Job.countDocuments(filter),
    Promise.all([
      Job.countDocuments({
        assignedCompany: companyUser._id,
        assignedMechanic: { $exists: false },
        status: { $in: [JOB_STATUS.ASSIGNED, JOB_STATUS.EN_ROUTE, JOB_STATUS.ON_SITE, JOB_STATUS.IN_PROGRESS] },
      }),
      Job.countDocuments({
        assignedCompany: companyUser._id,
        assignedMechanic: { $exists: true, $ne: null },
        status: { $in: [JOB_STATUS.ASSIGNED, JOB_STATUS.EN_ROUTE] },
      }),
      Job.countDocuments({
        assignedCompany: companyUser._id,
        status: { $in: [JOB_STATUS.ON_SITE, JOB_STATUS.IN_PROGRESS] },
      }),
      Job.countDocuments({
        assignedCompany: companyUser._id,
        status: JOB_STATUS.AWAITING_APPROVAL,
      }),
    ]),
  ]);

  return {
    items: items.map((job) => ({
      _id: job._id,
      jobCode: job.jobCode,
      title: job.title,
      description: job.completionSummary || job.description,
      status: job.status,
      urgency: job.urgency,
      vehicle: job.vehicle || null,
      location: job.location || null,
      assignedAt: job.assignedAt || null,
      completedAt: job.completedAt || null,
      fleet: job.fleet
        ? {
            _id: job.fleet._id || job.fleet,
            companyName: job.fleet.fleetProfile?.companyName || null,
          }
        : null,
      assignedMechanic: job.assignedMechanic
        ? {
            _id: job.assignedMechanic._id || job.assignedMechanic,
            displayName: job.assignedMechanic.mechanicProfile?.displayName || null,
            rating: job.assignedMechanic.mechanicProfile?.rating?.average ?? null,
            phone: job.assignedMechanic.mechanicProfile?.phone || null,
          }
        : null,
      acceptedAmount: job.acceptedAmount ?? null,
      finalAmount: job.finalAmount ?? null,
    })),
    meta: {
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit) || 1,
      tab,
    },
    summary: {
      unassigned: summary[0],
      assigned: summary[1],
      inProgress: summary[2],
      pendingReview: summary[3],
    },
  };
};

export const getCompanyJobById = async (jobId, companyUser) => {
  ensureCompanyUser(companyUser);
  return getJobByIdForUser(jobId, companyUser);
};

export const assignMechanicToCompanyJob = async (jobId, employeeId, companyUser) => {
  ensureCompanyUser(companyUser);

  const [job, employee] = await Promise.all([
    Job.findById(jobId),
    User.findOne({
      _id: employeeId,
      role: ROLES.MECHANIC_EMPLOYEE,
      "companyMembership.company": companyUser._id,
      "companyMembership.status": "ACTIVE",
    }),
  ]);

  if (!job) throw new AppError("Job not found", 404);
  if (!employee) throw new AppError("Mechanic employee not found", 404);
  if (`${job.assignedCompany || ""}` !== `${companyUser._id}`) {
    throw new AppError("Job is not assigned to this company", 403);
  }
  if ([JOB_STATUS.COMPLETED, JOB_STATUS.CANCELLED].includes(job.status)) {
    throw new AppError("This job can no longer be assigned", 400);
  }

  const previousMechanic = job.assignedMechanic || null;
  job.assignedMechanic = employee._id;
  if (!job.assignedAt) job.assignedAt = new Date();
  await job.save();

  await JobEvent.create({
    job: job._id,
    actor: companyUser._id,
    type: previousMechanic ? "MECHANIC_REASSIGNED" : "MECHANIC_ASSIGNED",
    toStatus: job.status,
    payload: {
      companyId: companyUser._id,
      previousMechanicId: previousMechanic,
      mechanicId: employee._id,
    },
  });

  return {
    _id: job._id,
    jobCode: job.jobCode,
    assignedMechanic: {
      _id: employee._id,
      displayName: employee.mechanicProfile?.displayName || employee.email,
      phone: employee.mechanicProfile?.phone || null,
    },
  };
};

export const getCompanyTeam = async (companyUser) => {
  ensureCompanyUser(companyUser);

  const [members, pendingInvites, activeJobsByMechanic, completedJobsByMechanic] = await Promise.all([
    User.find({
      role: ROLES.MECHANIC_EMPLOYEE,
      "companyMembership.company": companyUser._id,
      "companyMembership.status": "ACTIVE",
    })
      .sort({ createdAt: -1 })
      .lean(),
    CompanyInvite.find({ company: companyUser._id, status: "PENDING" })
      .sort({ createdAt: -1 })
      .lean(),
    Job.aggregate([
      {
        $match: {
          assignedCompany: companyUser._id,
          assignedMechanic: { $ne: null },
          status: { $in: ACTIVE_JOB_STATUSES },
        },
      },
      { $group: { _id: "$assignedMechanic", count: { $sum: 1 } } },
    ]),
    Job.aggregate([
      {
        $match: {
          assignedCompany: companyUser._id,
          assignedMechanic: { $ne: null },
          status: JOB_STATUS.COMPLETED,
        },
      },
      { $group: { _id: "$assignedMechanic", count: { $sum: 1 } } },
    ]),
  ]);

  const activeMap = new Map(activeJobsByMechanic.map((item) => [`${item._id}`, item.count]));
  const completedMap = new Map(
    completedJobsByMechanic.map((item) => [`${item._id}`, item.count])
  );

  return {
    members: members.map((member) =>
      serializeTeamMember(member, {
        activeJobs: activeMap.get(`${member._id}`) || 0,
        jobsCompleted: completedMap.get(`${member._id}`) || 0,
      })
    ),
    pendingInvites: pendingInvites.map(serializeInvite),
  };
};

export const createCompanyInvite = async (companyUser, payload = {}) => {
  ensureCompanyUser(companyUser);

  const email = `${payload.email || ""}`.trim().toLowerCase();
  if (!email) throw new AppError("email is required", 400);

  const existingMember = await User.findOne({
    email,
    "companyMembership.company": companyUser._id,
    "companyMembership.status": "ACTIVE",
  }).lean();
  if (existingMember) {
    throw new AppError("This user is already part of the company", 409);
  }

  const existingInvite = await CompanyInvite.findOne({
    company: companyUser._id,
    email,
    status: "PENDING",
    expiresAt: { $gt: new Date() },
  });

  if (existingInvite) {
    return serializeInvite(existingInvite);
  }

  const invite = await CompanyInvite.create({
    company: companyUser._id,
    email,
    invitedBy: companyUser._id,
    token: crypto.randomBytes(24).toString("hex"),
    expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
  });

  return serializeInvite(invite);
};

export const cancelCompanyInvite = async (inviteId, companyUser) => {
  ensureCompanyUser(companyUser);

  const invite = await CompanyInvite.findOne({
    _id: inviteId,
    company: companyUser._id,
    status: "PENDING",
  });
  if (!invite) throw new AppError("Invite not found", 404);

  invite.status = "CANCELLED";
  invite.cancelledAt = new Date();
  await invite.save();

  return serializeInvite(invite);
};

export const getCompanyEarningsSummary = async (companyUser) => {
  ensureCompanyUser(companyUser);

  const { start, end } = monthRange();

  const [monthAgg, allTimeAgg, completedCount] = await Promise.all([
    Job.aggregate([
      {
        $match: {
          assignedCompany: companyUser._id,
          status: JOB_STATUS.COMPLETED,
          completedAt: { $gte: start, $lt: end },
        },
      },
      {
        $group: {
          _id: null,
          gross: {
            $sum: {
              $ifNull: ["$finalAmount", { $ifNull: ["$acceptedAmount", "$estimatedPayout"] }],
            },
          },
        },
      },
    ]),
    Job.aggregate([
      {
        $match: {
          assignedCompany: companyUser._id,
          status: JOB_STATUS.COMPLETED,
        },
      },
      {
        $group: {
          _id: null,
          gross: {
            $sum: {
              $ifNull: ["$finalAmount", { $ifNull: ["$acceptedAmount", "$estimatedPayout"] }],
            },
          },
        },
      },
    ]),
    Job.countDocuments({
      assignedCompany: companyUser._id,
      status: JOB_STATUS.COMPLETED,
    }),
  ]);

  const monthGross = monthAgg[0]?.gross || 0;
  const allTimeGross = allTimeAgg[0]?.gross || 0;
  const monthNet = Math.max(Math.round(monthGross * 0.88 * 100) / 100, 0);
  const allTimeNet = Math.max(Math.round(allTimeGross * 0.88 * 100) / 100, 0);

  return {
    cards: {
      monthGross,
      monthNet,
      allTimeGross,
      allTimeNet,
      completedJobs: completedCount,
    },
  };
};

export const listCompanyEarningJobs = async (companyUser, query = {}) => {
  ensureCompanyUser(companyUser);

  const page = parsePage(query.page);
  const limit = parseLimit(query.limit);
  const skip = (page - 1) * limit;

  const [jobs, total] = await Promise.all([
    Job.find({
      assignedCompany: companyUser._id,
      status: JOB_STATUS.COMPLETED,
    })
      .sort({ completedAt: -1, updatedAt: -1 })
      .skip(skip)
      .limit(limit)
      .populate("fleet", "fleetProfile.companyName")
      .populate("assignedMechanic", "mechanicProfile.displayName mechanicProfile.rating")
      .lean(),
    Job.countDocuments({
      assignedCompany: companyUser._id,
      status: JOB_STATUS.COMPLETED,
    }),
  ]);

  const invoices = await Invoice.find({
    job: { $in: jobs.map((job) => job._id) },
  })
    .select("_id job invoiceNo pdfUrl status paidAt")
    .lean();

  const invoiceMap = new Map(invoices.map((invoice) => [`${invoice.job}`, invoice]));

  return {
    items: jobs.map((job) => serializeCompanyInvoiceJob(job, invoiceMap.get(`${job._id}`))),
    meta: {
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit) || 1,
    },
  };
};
