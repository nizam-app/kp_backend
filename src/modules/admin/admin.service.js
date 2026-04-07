import AppError from "../../utils/AppError.js";
import {
  JOB_STATUS,
  MECHANIC_VERIFICATION_STATUS,
  ROLES,
  USER_STATUS,
  userStatusValues,
} from "../../constants/domain.js";
import { User } from "../user/user.model.js";
import { Job } from "../job/job.model.js";
import { Invoice } from "../invoice/invoice.model.js";
import { Vehicle } from "../vehicle/vehicle.model.js";
import { SupportTicket } from "../supportTicket/supportTicket.model.js";
import { JobLocationPing } from "../jobLocationPing/jobLocationPing.model.js";
import { Notification } from "../notification/notification.model.js";
import { Dispute } from "../dispute/dispute.model.js";
import { ServiceCatalog } from "../serviceCatalog/serviceCatalog.model.js";
import { Promotion } from "../promotion/promotion.model.js";
import { Review } from "../review/review.model.js";
import { AuditLog } from "../auditLog/auditLog.model.js";

const serviceRequestBucketFromJobStatus = (status) => {
  if ([JOB_STATUS.COMPLETED].includes(status)) return "COMPLETED";
  if ([JOB_STATUS.CANCELLED].includes(status)) return "CANCELLED";
  if (
    [
      JOB_STATUS.ASSIGNED,
      JOB_STATUS.EN_ROUTE,
      JOB_STATUS.ON_SITE,
      JOB_STATUS.IN_PROGRESS,
      JOB_STATUS.AWAITING_APPROVAL,
    ].includes(status)
  ) {
    return "IN_PROGRESS";
  }
  return "PENDING";
};

const serviceRequestToneFromBucket = (bucket) => {
  const map = {
    PENDING: "amber",
    IN_PROGRESS: "blue",
    COMPLETED: "green",
    CANCELLED: "red",
  };
  return map[bucket] || "neutral";
};

const formatMonthLabel = (date) =>
  date.toLocaleString("en-US", { month: "short" });

const safeRegex = (value) =>
  new RegExp(`${`${value || ""}`.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, "i");

const parseRoleFilter = (value) => `${value || ""}`.trim().toUpperCase();
const parsePriority = (value) => `${value || ""}`.trim().toUpperCase();
const parseStatus = (value) => `${value || ""}`.trim().toUpperCase();

const supportPriorityFromTicket = (ticket) => {
  const text = `${ticket.subject || ""} ${ticket.message || ""}`.toLowerCase();
  if (text.includes("urgent") || text.includes("payment") || text.includes("invoice")) {
    return "HIGH";
  }
  if (text.includes("cannot") || text.includes("issue") || text.includes("problem")) {
    return "MEDIUM";
  }
  return "LOW";
};

const supportStatusTone = (status) => {
  const map = {
    OPEN: "amber",
    IN_PROGRESS: "blue",
    RESOLVED: "green",
    CLOSED: "neutral",
  };
  return map[status] || "neutral";
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

const getAdminActorLabel = (adminUser) =>
  adminUser?.adminProfile?.fullName || adminUser?.email || "Admin";

const writeAuditLog = async (adminUser, action, target, category) => {
  try {
    await AuditLog.create({
      userLabel: getAdminActorLabel(adminUser),
      action,
      target,
      category,
    });
  } catch {
    // Audit logging should not block primary admin actions.
  }
};

const normalizeRegistration = (value) => `${value || ""}`.trim().toUpperCase();
const normalizeAdminEmail = (value) => `${value || ""}`.trim().toLowerCase();

const mapAdminRole = (value) => {
  const normalized = `${value || ""}`.trim().toUpperCase();
  if (["COMPANY", "COMPANIES", ROLES.FLEET].includes(normalized)) return ROLES.FLEET;
  if (["TECHNICIAN", "TECHNICIANS", ROLES.MECHANIC].includes(normalized))
    return ROLES.MECHANIC;
  if (["ADMIN", "ADMINS", ROLES.ADMIN].includes(normalized)) return ROLES.ADMIN;
  return normalized;
};

const generateAdminInvoiceNo = async () => {
  for (let i = 0; i < 8; i += 1) {
    const random = Math.floor(1000 + Math.random() * 9000);
    const invoiceNo = `INV-${new Date().getFullYear()}-${random}`;
    const exists = await Invoice.exists({ invoiceNo });
    if (!exists) return invoiceNo;
  }
  throw new AppError("Unable to generate invoice number", 500);
};

const serializeMechanicReviewItem = (user) => ({
  _id: user._id,
  email: user.email,
  status: user.status,
  profilePhotoUrl: user.mechanicProfile?.profilePhotoUrl || null,
  displayName: user.mechanicProfile?.displayName || null,
  businessName: user.mechanicProfile?.businessName || null,
  businessType: user.mechanicProfile?.businessType || null,
  phone: user.mechanicProfile?.phone || null,
  baseLocationText: user.mechanicProfile?.baseLocationText || null,
  basePostcode: user.mechanicProfile?.basePostcode || null,
  hourlyRate: user.mechanicProfile?.hourlyRate ?? null,
  emergencyRate: user.mechanicProfile?.emergencyRate ?? null,
  callOutFee: user.mechanicProfile?.callOutFee ?? null,
  serviceRadiusMiles: user.mechanicProfile?.serviceRadiusMiles ?? null,
  skills: user.mechanicProfile?.skills || [],
  verification: {
    status: user.mechanicProfile?.verification?.status || null,
    submittedAt: user.mechanicProfile?.verification?.submittedAt || null,
    reviewedAt: user.mechanicProfile?.verification?.reviewedAt || null,
    reviewNotes: user.mechanicProfile?.verification?.reviewNotes || null,
  },
  createdAt: user.createdAt,
  updatedAt: user.updatedAt,
});

const serializeDashboardJob = (job) => ({
  _id: job._id,
  requestId: job.jobCode,
  truck:
    [job.vehicle?.make, job.vehicle?.model, job.vehicle?.registration]
      .filter(Boolean)
      .join(" - ") || job.title,
  issue: job.completionSummary || job.description || job.title,
  status: serviceRequestBucketFromJobStatus(job.status),
  rawStatus: job.status,
  time:
    job.createdAt || job.postedAt
      ? `${Math.max(
          Math.round((Date.now() - new Date(job.createdAt || job.postedAt).getTime()) / 3600000),
          0
        )} hours ago`
      : null,
});

const serializeServiceRequest = (job) => {
  const bucket = serviceRequestBucketFromJobStatus(job.status);
  return {
    _id: job._id,
    requestId: job.jobCode,
    truckDetails: {
      registration: job.vehicle?.registration || null,
      label:
        [job.vehicle?.make, job.vehicle?.model, job.vehicle?.registration]
          .filter(Boolean)
          .join(" ") || job.title,
      type: job.vehicle?.type || null,
    },
    driver: {
      name: job.fleet?.fleetProfile?.contactName || null,
      phone: job.fleet?.fleetProfile?.phone || null,
      companyName: job.fleet?.fleetProfile?.companyName || null,
    },
    issue: {
      title: job.title,
      description: job.completionSummary || job.description,
      type: job.issueType,
    },
    priority: {
      value: job.urgency,
      label: `${job.urgency || "MEDIUM"}`.replace("_", " "),
    },
    status: {
      value: bucket,
      label: bucket.replace("_", " "),
      tone: serviceRequestToneFromBucket(bucket),
      raw: job.status,
    },
    assignedTo: job.assignedMechanic
      ? {
          _id: job.assignedMechanic._id || job.assignedMechanic,
          name: job.assignedMechanic.mechanicProfile?.displayName || null,
          phone: job.assignedMechanic.mechanicProfile?.phone || null,
        }
      : null,
    amount: job.finalAmount ?? job.acceptedAmount ?? job.estimatedPayout ?? null,
    currency: job.currency || "GBP",
    quoteCount: job.quoteCount || 0,
    postedAt: job.postedAt || job.createdAt,
    updatedAt: job.updatedAt,
  };
};

const serializeAdminUser = (user) => {
  const isFleet = user.role === ROLES.FLEET;
  const isMechanic = user.role === ROLES.MECHANIC;
  return {
    _id: user._id,
    name:
      user.fleetProfile?.companyName ||
      user.mechanicProfile?.displayName ||
      user.email,
    email: user.email,
    phone:
      user.fleetProfile?.phone || user.mechanicProfile?.phone || null,
    role: isFleet ? "COMPANY" : isMechanic ? "TECHNICIAN" : user.role,
    status: user.status,
    joinDate: user.createdAt,
    company: user.fleetProfile?.companyName || user.mechanicProfile?.businessName || null,
    activity: isFleet
      ? {
          kind: "trucks",
          value: 0,
        }
      : isMechanic
      ? {
          kind: "jobs",
          value: user.mechanicProfile?.stats?.jobsDone ?? 0,
        }
      : null,
  };
};

const serializeFleetManagementItem = (fleet, vehicles = []) => ({
  _id: fleet._id,
  companyName: fleet.fleetProfile?.companyName || fleet.email,
  companyStatus: fleet.status,
  contact: {
    name: fleet.fleetProfile?.contactName || null,
    email: fleet.email,
    phone: fleet.fleetProfile?.phone || null,
  },
  counts: {
    totalTrucks: vehicles.length,
    activeTrucks: vehicles.filter((vehicle) => vehicle.isActive).length,
  },
  vehicles: vehicles.map((vehicle) => ({
    _id: vehicle._id,
    registration: vehicle.registration,
    make: vehicle.make || null,
    model: vehicle.model || null,
    year: vehicle.year || null,
    status: vehicle.isActive ? "ACTIVE" : "INACTIVE",
  })),
});

const serializeSupportTicketForAdmin = (ticket) => {
  const priority = supportPriorityFromTicket(ticket);
  return {
    _id: ticket._id,
    subject: ticket.subject,
    message: ticket.message,
    category: ticket.category,
    status: {
      value: ticket.status,
      label: ticket.status.replace("_", " "),
      tone: supportStatusTone(ticket.status),
    },
    priority,
    user: ticket.user
      ? {
          _id: ticket.user._id || ticket.user,
          email: ticket.user.email || null,
          companyName: ticket.user.fleetProfile?.companyName || null,
          displayName: ticket.user.mechanicProfile?.displayName || null,
        }
      : null,
    assignedTo: ticket.assignedTo
      ? {
          _id: ticket.assignedTo._id || ticket.assignedTo,
          email: ticket.assignedTo.email || null,
        }
      : null,
    createdAt: ticket.createdAt,
    updatedAt: ticket.updatedAt,
  };
};

const serializeDispute = (dispute) => ({
  _id: dispute._id,
  title: dispute.title,
  description: dispute.description || null,
  priority: dispute.priority,
  status: dispute.status,
  amount: dispute.amount,
  currency: dispute.currency || "GBP",
  company: dispute.company
    ? {
        _id: dispute.company._id || dispute.company,
        companyName: dispute.company.fleetProfile?.companyName || null,
        email: dispute.company.email || null,
      }
    : null,
  customerName: dispute.customerName || null,
  mechanic: dispute.mechanic
    ? {
        _id: dispute.mechanic._id || dispute.mechanic,
        displayName: dispute.mechanic.mechanicProfile?.displayName || null,
        email: dispute.mechanic.email || null,
      }
    : null,
  serviceLabel: dispute.serviceLabel || null,
  reason: dispute.reason || null,
  createdAt: dispute.createdAt,
  updatedAt: dispute.updatedAt,
});

const findMechanicById = async (userId) => {
  const user = await User.findOne({ _id: userId, role: ROLES.MECHANIC });
  if (!user) throw new AppError("Mechanic not found", 404);
  return user;
};

export const listMechanicReviewQueue = async (query = {}) => {
  const page = parsePage(query.page);
  const limit = parseLimit(query.limit);
  const skip = (page - 1) * limit;

  const filter = {
    role: ROLES.MECHANIC,
    status: USER_STATUS.PENDING_REVIEW,
  };

  if (query.status) {
    filter["mechanicProfile.verification.status"] = `${query.status}`
      .trim()
      .toUpperCase();
  } else {
    filter["mechanicProfile.verification.status"] = {
      $in: [
        MECHANIC_VERIFICATION_STATUS.SUBMITTED,
        MECHANIC_VERIFICATION_STATUS.UNDER_REVIEW,
        MECHANIC_VERIFICATION_STATUS.REJECTED,
      ],
    };
  }

  const [items, total] = await Promise.all([
    User.find(filter)
      .sort({
        "mechanicProfile.verification.submittedAt": 1,
        createdAt: 1,
      })
      .skip(skip)
      .limit(limit)
      .lean(),
    User.countDocuments(filter),
  ]);

  return {
    items: items.map(serializeMechanicReviewItem),
    meta: {
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit) || 1,
    },
  };
};

export const getAdminDashboard = async () => {
  const now = new Date();
  const seriesStart = new Date(now.getFullYear(), now.getMonth() - 5, 1);
  const months = Array.from({ length: 6 }, (_, index) => {
    const date = new Date(now.getFullYear(), now.getMonth() - (5 - index), 1);
    return {
      year: date.getFullYear(),
      month: date.getMonth() + 1,
      label: formatMonthLabel(date),
    };
  });

  const [paidInvoicesAgg, activeUsersCount, serviceRequestsCount, fleetVehicleCount, jobStatusAgg, revenueAgg, recentJobs] =
    await Promise.all([
      Invoice.aggregate([
        { $match: { status: "PAID" } },
        { $group: { _id: null, totalRevenue: { $sum: "$totalAmount" } } },
      ]),
      User.countDocuments({
        role: { $in: [ROLES.FLEET, ROLES.MECHANIC] },
        status: USER_STATUS.ACTIVE,
      }),
      Job.countDocuments({}),
      Vehicle.countDocuments({ isActive: true }),
      Job.aggregate([
        {
          $group: {
            _id: "$status",
            count: { $sum: 1 },
          },
        },
      ]),
      Invoice.aggregate([
        {
          $match: {
            paidAt: { $gte: seriesStart },
            status: "PAID",
          },
        },
        {
          $group: {
            _id: {
              year: { $year: "$paidAt" },
              month: { $month: "$paidAt" },
            },
            total: { $sum: "$totalAmount" },
          },
        },
      ]),
      Job.find({})
        .sort({ createdAt: -1 })
        .limit(8)
        .lean(),
    ]);

  const revenueMap = new Map(
    revenueAgg.map((entry) => [`${entry._id.year}-${entry._id.month}`, entry.total])
  );

  const overview = months.map((month) => ({
    month: month.label,
    revenue: revenueMap.get(`${month.year}-${month.month}`) || 0,
  }));

  const statusDistributionBase = {
    PENDING: 0,
    IN_PROGRESS: 0,
    COMPLETED: 0,
    CANCELLED: 0,
  };

  for (const item of jobStatusAgg) {
    const bucket = serviceRequestBucketFromJobStatus(item._id);
    statusDistributionBase[bucket] += item.count;
  }

  return {
    cards: {
      totalRevenue: paidInvoicesAgg[0]?.totalRevenue || 0,
      activeUsers: activeUsersCount,
      serviceRequests: serviceRequestsCount,
      fleetSize: fleetVehicleCount,
    },
    revenueOverview: overview,
    serviceStatusDistribution: [
      { label: "Pending", value: statusDistributionBase.PENDING },
      { label: "In Progress", value: statusDistributionBase.IN_PROGRESS },
      { label: "Completed", value: statusDistributionBase.COMPLETED },
      { label: "Cancelled", value: statusDistributionBase.CANCELLED },
    ],
    recentServiceRequests: recentJobs.map(serializeDashboardJob),
  };
};

export const listAdminServiceRequests = async (query = {}) => {
  const page = parsePage(query.page);
  const limit = parseLimit(query.limit);
  const skip = (page - 1) * limit;

  const filter = {};

  if (query.status) {
    const status = `${query.status}`.trim().toUpperCase();
    if (status === "PENDING") {
      filter.status = { $in: [JOB_STATUS.POSTED, JOB_STATUS.QUOTING] };
    } else if (status === "IN_PROGRESS") {
      filter.status = {
        $in: [
          JOB_STATUS.ASSIGNED,
          JOB_STATUS.EN_ROUTE,
          JOB_STATUS.ON_SITE,
          JOB_STATUS.IN_PROGRESS,
          JOB_STATUS.AWAITING_APPROVAL,
        ],
      };
    } else if (status === "COMPLETED") {
      filter.status = JOB_STATUS.COMPLETED;
    } else if (status === "CANCELLED") {
      filter.status = JOB_STATUS.CANCELLED;
    }
  }

  if (query.priority) {
    filter.urgency = `${query.priority}`.trim().toUpperCase();
  }

  if (query.search) {
    const searchRegex = safeRegex(query.search);
    filter.$or = [
      { jobCode: searchRegex },
      { title: searchRegex },
      { description: searchRegex },
      { "vehicle.registration": searchRegex },
      { "vehicle.make": searchRegex },
      { "vehicle.model": searchRegex },
    ];
  }

  const [items, total, allStatusAgg] = await Promise.all([
    Job.find(filter)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .populate("fleet", "email fleetProfile.companyName fleetProfile.contactName fleetProfile.phone")
      .populate("assignedMechanic", "email mechanicProfile.displayName mechanicProfile.phone")
      .lean(),
    Job.countDocuments(filter),
    Job.aggregate([
      {
        $group: {
          _id: "$status",
          count: { $sum: 1 },
        },
      },
    ]),
  ]);

  const counters = {
    totalRequests: allStatusAgg.reduce((sum, item) => sum + item.count, 0),
    pending: 0,
    inProgress: 0,
    completed: 0,
  };

  for (const item of allStatusAgg) {
    const bucket = serviceRequestBucketFromJobStatus(item._id);
    if (bucket === "PENDING") counters.pending += item.count;
    if (bucket === "IN_PROGRESS") counters.inProgress += item.count;
    if (bucket === "COMPLETED") counters.completed += item.count;
  }

  return {
    items: items.map(serializeServiceRequest),
    meta: {
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit) || 1,
    },
    stats: counters,
  };
};

export const updateAdminServiceRequest = async (jobId, payload = {}, adminUser) => {
  const job = await Job.findById(jobId)
    .populate("assignedMechanic", "email mechanicProfile.displayName mechanicProfile.phone")
    .populate("fleet", "email fleetProfile.companyName fleetProfile.contactName fleetProfile.phone");
  if (!job) throw new AppError("Service request not found", 404);

  if (payload.priority) {
    job.urgency = parsePriority(payload.priority);
  }

  if (payload.status) {
    const nextStatus = parseStatus(payload.status);
    if (!jobStatusValues.includes(nextStatus)) {
      throw new AppError(`status must be one of ${jobStatusValues.join(", ")}`, 400);
    }
    job.status = nextStatus;
    if (nextStatus === JOB_STATUS.COMPLETED && !job.completedAt) {
      job.completedAt = new Date();
    }
    if (nextStatus === JOB_STATUS.CANCELLED && !job.cancelledAt) {
      job.cancelledAt = new Date();
    }
  }

  if (payload.assignedMechanicId !== undefined) {
    if (!payload.assignedMechanicId) {
      job.assignedMechanic = undefined;
      job.assignedAt = undefined;
      if ([JOB_STATUS.ASSIGNED, JOB_STATUS.EN_ROUTE, JOB_STATUS.ON_SITE, JOB_STATUS.IN_PROGRESS].includes(job.status)) {
        job.status = JOB_STATUS.POSTED;
      }
    } else {
      const mechanic = await User.findOne({
        _id: payload.assignedMechanicId,
        role: ROLES.MECHANIC,
      }).select("email mechanicProfile.displayName mechanicProfile.phone");
      if (!mechanic) throw new AppError("Assigned mechanic not found", 404);
      job.assignedMechanic = mechanic._id;
      job.assignedAt = job.assignedAt || new Date();
      if ([JOB_STATUS.POSTED, JOB_STATUS.QUOTING].includes(job.status)) {
        job.status = JOB_STATUS.ASSIGNED;
      }
    }
  }

  if (payload.etaMinutes !== undefined) {
    job.tracking = {
      ...(job.tracking || {}),
      etaMinutes: payload.etaMinutes === null ? undefined : payload.etaMinutes,
    };
  }

  if (payload.completionSummary !== undefined) {
    job.completionSummary = `${payload.completionSummary || ""}`.trim() || undefined;
  }

  await job.save();
  await writeAuditLog(
    adminUser,
    "Updated Service Request",
    job.jobCode || job._id.toString(),
    "Service Management"
  );

  const refreshedJob = await Job.findById(job._id)
    .populate("fleet", "email fleetProfile.companyName fleetProfile.contactName fleetProfile.phone")
    .populate("assignedMechanic", "email mechanicProfile.displayName mechanicProfile.phone")
    .lean();

  return serializeServiceRequest(refreshedJob);
};

export const listAdminUsers = async (query = {}) => {
  const page = parsePage(query.page);
  const limit = parseLimit(query.limit);
  const skip = (page - 1) * limit;
  const filter = {};
  const roleFilter = parseRoleFilter(query.role);

  if (roleFilter === "COMPANIES" || roleFilter === "COMPANY") {
    filter.role = ROLES.FLEET;
  } else if (roleFilter === "TECHNICIANS" || roleFilter === "TECHNICIAN") {
    filter.role = ROLES.MECHANIC;
  } else if (roleFilter === "ADMINS" || roleFilter === "ADMIN") {
    filter.role = ROLES.ADMIN;
  } else if (roleFilter === "DRIVERS" || roleFilter === "DRIVER") {
    filter.role = "__NO_DRIVER_ROLE__";
  }

  if (query.search) {
    const searchRegex = safeRegex(query.search);
    filter.$or = [
      { email: searchRegex },
      { "fleetProfile.companyName": searchRegex },
      { "fleetProfile.contactName": searchRegex },
      { "mechanicProfile.displayName": searchRegex },
      { "mechanicProfile.businessName": searchRegex },
      { "fleetProfile.phone": searchRegex },
      { "mechanicProfile.phone": searchRegex },
    ];
  }

  const [users, total, totalCompanies, totalMembers, activeTechnicians] = await Promise.all([
    User.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
    User.countDocuments(filter),
    User.countDocuments({ role: ROLES.FLEET }),
    User.countDocuments({ role: { $in: [ROLES.FLEET, ROLES.MECHANIC] } }),
    User.countDocuments({ role: ROLES.MECHANIC, status: USER_STATUS.ACTIVE }),
  ]);

  const fleetIds = users
    .filter((user) => user.role === ROLES.FLEET)
    .map((user) => user._id);

  const vehicleCountsAgg = fleetIds.length
    ? await Vehicle.aggregate([
        {
          $match: {
            fleet: { $in: fleetIds },
          },
        },
        {
          $group: {
            _id: "$fleet",
            count: { $sum: 1 },
          },
        },
      ])
    : [];

  const vehicleCountMap = new Map(
    vehicleCountsAgg.map((entry) => [entry._id.toString(), entry.count])
  );

  const items = users.map((user) => {
    const item = serializeAdminUser(user);
    if (user.role === ROLES.FLEET) {
      item.activity = {
        kind: "trucks",
        value: vehicleCountMap.get(user._id.toString()) || 0,
      };
    }
    return item;
  });

  return {
    items,
    meta: {
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit) || 1,
    },
    stats: {
      totalCompanies,
      totalMembers,
      activeTechnicians,
      activeDrivers: 0,
    },
  };
};

export const createAdminUserOrCompany = async (payload = {}, adminUser) => {
  const role = mapAdminRole(payload.role || payload.entityType);
  if (![ROLES.FLEET, ROLES.MECHANIC, ROLES.ADMIN].includes(role)) {
    throw new AppError("role must be FLEET, MECHANIC, or ADMIN", 400);
  }

  const email = normalizeAdminEmail(payload.email);
  if (!email) throw new AppError("email is required", 400);
  if (!payload.password) throw new AppError("password is required", 400);

  const exists = await User.findOne({ email });
  if (exists) throw new AppError("Email already in use", 409);

  const userData = {
    email,
    password: payload.password,
    role,
    status: payload.status ? `${payload.status}`.trim().toUpperCase() : USER_STATUS.ACTIVE,
  };

  if (role === ROLES.FLEET) {
    userData.fleetProfile = {
      companyName: payload.companyName,
      contactName: payload.contactName || payload.fullName,
      contactRole: payload.contactRole,
      phone: payload.phone,
      regNumber: payload.regNumber,
      vatNumber: payload.vatNumber,
      fleetSize: payload.fleetSize,
      billingAddress: payload.billingAddress,
    };
  }

  if (role === ROLES.MECHANIC) {
    userData.mechanicProfile = {
      displayName: payload.displayName || payload.fullName,
      businessName: payload.businessName,
      businessType: payload.businessType,
      phone: payload.phone,
      baseLocationText: payload.baseLocationText,
      basePostcode: payload.basePostcode,
      hourlyRate: payload.hourlyRate,
      emergencyRate: payload.emergencyRate,
      callOutFee: payload.callOutFee,
      serviceRadiusMiles: payload.serviceRadiusMiles,
      skills: payload.skills || [],
      verification: {
        status:
          userData.status === USER_STATUS.ACTIVE
            ? MECHANIC_VERIFICATION_STATUS.APPROVED
            : MECHANIC_VERIFICATION_STATUS.SUBMITTED,
        reviewedAt:
          userData.status === USER_STATUS.ACTIVE ? new Date() : undefined,
      },
    };
  }

  if (role === ROLES.ADMIN) {
    userData.adminProfile = {
      fullName: payload.fullName || email.split("@")[0],
      phoneNumber: payload.phoneNumber || payload.phone,
      profilePhotoUrl: payload.profilePhotoUrl,
    };
    userData.adminSettings = {
      timeZone: payload.timeZone || "GMT",
      language: payload.language || "English",
      billingEmail: payload.billingEmail || email,
    };
  }

  const user = await User.create(userData);
  await writeAuditLog(
    adminUser,
    "Created User",
    `${role}:${email}`,
    "User Management"
  );

  return serializeAdminUser(user.toObject());
};

export const updateAdminUser = async (userId, payload = {}, adminUser) => {
  const user = await User.findById(userId);
  if (!user) throw new AppError("User not found", 404);

  if (payload.email !== undefined) {
    const email = normalizeAdminEmail(payload.email);
    if (!email) throw new AppError("email cannot be empty", 400);
    const duplicate = await User.findOne({ _id: { $ne: user._id }, email });
    if (duplicate) throw new AppError("Email already in use", 409);
    user.email = email;
  }

  if (payload.status !== undefined) {
    const nextStatus = `${payload.status}`.trim().toUpperCase();
    if (!userStatusValues.includes(nextStatus)) {
      throw new AppError(`status must be one of ${userStatusValues.join(", ")}`, 400);
    }
    user.status = nextStatus;
  }

  if (user.role === ROLES.FLEET) {
    user.fleetProfile = {
      ...(user.fleetProfile || {}),
      ...Object.fromEntries(
        Object.entries({
          companyName: payload.companyName,
          contactName: payload.contactName,
          contactRole: payload.contactRole,
          phone: payload.phone,
          regNumber: payload.regNumber,
          vatNumber: payload.vatNumber,
          fleetSize: payload.fleetSize,
          billingAddress: payload.billingAddress,
        }).filter(([, value]) => value !== undefined)
      ),
    };
  }

  if (user.role === ROLES.MECHANIC) {
    user.mechanicProfile = {
      ...(user.mechanicProfile || {}),
      ...Object.fromEntries(
        Object.entries({
          displayName: payload.displayName,
          businessName: payload.businessName,
          phone: payload.phone,
          baseLocationText: payload.baseLocationText,
          basePostcode: payload.basePostcode,
          hourlyRate: payload.hourlyRate,
          emergencyRate: payload.emergencyRate,
          callOutFee: payload.callOutFee,
          serviceRadiusMiles: payload.serviceRadiusMiles,
          skills: payload.skills,
        }).filter(([, value]) => value !== undefined)
      ),
    };
  }

  if (user.role === ROLES.ADMIN) {
    user.adminProfile = {
      ...(user.adminProfile || {}),
      ...Object.fromEntries(
        Object.entries({
          fullName: payload.fullName,
          phoneNumber: payload.phoneNumber,
          profilePhotoUrl: payload.profilePhotoUrl,
        }).filter(([, value]) => value !== undefined)
      ),
    };
  }

  await user.save();
  await writeAuditLog(
    adminUser,
    "Updated User",
    `${user.role}:${user.email}`,
    "User Management"
  );

  return serializeAdminUser(user.toObject());
};

export const listAdminFleet = async (query = {}) => {
  const companyFilter = { role: ROLES.FLEET };

  if (query.status) {
    companyFilter.status = `${query.status}`.trim().toUpperCase();
  }

  if (query.search) {
    const searchRegex = safeRegex(query.search);
    companyFilter.$or = [
      { email: searchRegex },
      { "fleetProfile.companyName": searchRegex },
      { "fleetProfile.contactName": searchRegex },
      { "fleetProfile.phone": searchRegex },
    ];
  }

  const fleets = await User.find(companyFilter)
    .sort({ createdAt: -1 })
    .lean();

  const fleetIds = fleets.map((fleet) => fleet._id);
  const vehicles = fleetIds.length
    ? await Vehicle.find({ fleet: { $in: fleetIds } })
        .sort({ createdAt: -1 })
        .lean()
    : [];

  const vehiclesByFleet = new Map();
  for (const vehicle of vehicles) {
    const key = vehicle.fleet.toString();
    const list = vehiclesByFleet.get(key) || [];
    list.push(vehicle);
    vehiclesByFleet.set(key, list);
  }

  const items = fleets.map((fleet) =>
    serializeFleetManagementItem(
      fleet,
      vehiclesByFleet.get(fleet._id.toString()) || []
    )
  );

  return {
    items,
    stats: {
      totalCompanies: fleets.length,
      totalFleet: vehicles.length,
      activeTrucks: vehicles.filter((vehicle) => vehicle.isActive).length,
      suspendedCompanies: fleets.filter(
        (fleet) => fleet.status === USER_STATUS.SUSPENDED
      ).length,
    },
  };
};

export const createAdminFleetCompany = async (payload = {}, adminUser) =>
  createAdminUserOrCompany(
    {
      role: ROLES.FLEET,
      email: payload.email,
      password: payload.password,
      status: payload.status,
      companyName: payload.companyName,
      contactName: payload.contactName,
      contactRole: payload.contactRole,
      phone: payload.phone,
      regNumber: payload.regNumber,
      vatNumber: payload.vatNumber,
      fleetSize: payload.fleetSize,
      billingAddress: payload.billingAddress,
    },
    adminUser
  );

export const updateAdminFleetCompany = async (fleetId, payload = {}, adminUser) => {
  const fleet = await User.findOne({ _id: fleetId, role: ROLES.FLEET });
  if (!fleet) throw new AppError("Fleet company not found", 404);

  fleet.fleetProfile = {
    ...(fleet.fleetProfile || {}),
    ...Object.fromEntries(
      Object.entries({
        companyName: payload.companyName,
        contactName: payload.contactName,
        contactRole: payload.contactRole,
        phone: payload.phone,
        regNumber: payload.regNumber,
        vatNumber: payload.vatNumber,
        fleetSize: payload.fleetSize,
        billingAddress: payload.billingAddress,
      }).filter(([, value]) => value !== undefined)
    ),
  };

  if (payload.status !== undefined) {
    const nextStatus = `${payload.status}`.trim().toUpperCase();
    if (!userStatusValues.includes(nextStatus)) {
      throw new AppError(`status must be one of ${userStatusValues.join(", ")}`, 400);
    }
    fleet.status = nextStatus;
  }

  await fleet.save();
  await writeAuditLog(
    adminUser,
    "Updated Fleet",
    fleet.fleetProfile?.companyName || fleet.email,
    "Fleet Management"
  );

  const vehicles = await Vehicle.find({ fleet: fleet._id }).sort({ createdAt: -1 }).lean();
  return serializeFleetManagementItem(fleet.toObject(), vehicles);
};

export const createAdminFleetVehicle = async (fleetId, payload = {}, adminUser) => {
  const fleet = await User.findOne({ _id: fleetId, role: ROLES.FLEET }).lean();
  if (!fleet) throw new AppError("Fleet company not found", 404);

  const registration = normalizeRegistration(payload.registration);
  if (!registration) throw new AppError("registration is required", 400);

  const duplicate = await Vehicle.findOne({ fleet: fleetId, registration });
  if (duplicate) throw new AppError("Vehicle registration already exists", 409);

  const vehicle = await Vehicle.create({
    fleet: fleetId,
    registration,
    type: payload.type,
    make: payload.make,
    model: payload.model,
    year: payload.year,
    vin: payload.vin,
    isActive: payload.isActive ?? true,
  });

  await writeAuditLog(
    adminUser,
    "Added Fleet Vehicle",
    `${fleet.fleetProfile?.companyName || fleet.email}:${registration}`,
    "Fleet Management"
  );

  return vehicle.toObject();
};

export const updateAdminFleetVehicle = async (
  fleetId,
  vehicleId,
  payload = {},
  adminUser
) => {
  const vehicle = await Vehicle.findOne({ _id: vehicleId, fleet: fleetId });
  if (!vehicle) throw new AppError("Vehicle not found", 404);

  if (payload.registration !== undefined) {
    const registration = normalizeRegistration(payload.registration);
    if (!registration) throw new AppError("registration cannot be empty", 400);
    const duplicate = await Vehicle.findOne({
      _id: { $ne: vehicle._id },
      fleet: fleetId,
      registration,
    });
    if (duplicate) throw new AppError("Vehicle registration already exists", 409);
    vehicle.registration = registration;
  }

  for (const field of ["type", "make", "model", "year", "vin", "isActive"]) {
    if (payload[field] !== undefined) vehicle[field] = payload[field];
  }

  await vehicle.save();
  await writeAuditLog(
    adminUser,
    "Updated Fleet Vehicle",
    vehicle.registration,
    "Fleet Management"
  );

  return vehicle.toObject();
};

export const getAdminFinancialOverview = async (query = {}) => {
  const statusFilter = `${query.status || ""}`.trim().toUpperCase();
  const search = `${query.search || ""}`.trim();
  const invoiceFilter = {};

  if (statusFilter) {
    invoiceFilter.status = statusFilter;
  }

  if (search) {
    const searchRegex = safeRegex(search);
    invoiceFilter.$or = [{ invoiceNo: searchRegex }];
  }

  const [invoices, summaryAgg] = await Promise.all([
    Invoice.find(invoiceFilter)
      .sort({ issuedAt: -1, createdAt: -1 })
      .populate("fleet", "email fleetProfile.companyName")
      .populate("job", "title jobCode")
      .lean(),
    Invoice.aggregate([
      {
        $group: {
          _id: null,
          totalRevenue: { $sum: "$totalAmount" },
          pendingPayments: {
            $sum: {
              $cond: [{ $eq: ["$status", "ISSUED"] }, "$totalAmount", 0],
            },
          },
          overdueAmount: {
            $sum: {
              $cond: [
                {
                  $and: [
                    { $eq: ["$status", "ISSUED"] },
                    {
                      $lt: [
                        "$issuedAt",
                        new Date(Date.now() - 14 * 24 * 60 * 60 * 1000),
                      ],
                    },
                  ],
                },
                "$totalAmount",
                0,
              ],
            },
          },
          totalInvoices: { $sum: 1 },
        },
      },
    ]),
  ]);

  return {
    cards: {
      totalRevenue: summaryAgg[0]?.totalRevenue || 0,
      pendingPayments: summaryAgg[0]?.pendingPayments || 0,
      overdueAmount: summaryAgg[0]?.overdueAmount || 0,
      totalInvoices: summaryAgg[0]?.totalInvoices || 0,
    },
    items: invoices.map((invoice) => ({
      _id: invoice._id,
      invoiceNo: invoice.invoiceNo,
      company: invoice.fleet?.fleetProfile?.companyName || invoice.fleet?.email || null,
      service: invoice.job?.title || invoice.job?.jobCode || null,
      amount: invoice.totalAmount,
      currency: invoice.currency,
      paymentMethod: "Stored Method",
      status: invoice.status === "PAID" ? "PAID" : invoice.status === "ISSUED" ? "PENDING" : invoice.status,
      date: invoice.paidAt || invoice.issuedAt,
    })),
  };
};

export const createAdminFinancialInvoice = async (payload = {}, adminUser) => {
  if (!payload.fleetId || !payload.mechanicId) {
    throw new AppError("fleetId and mechanicId are required", 400);
  }

  const subtotal = Number(payload.subtotal ?? payload.totalAmount);
  if (!Number.isFinite(subtotal) || subtotal <= 0) {
    throw new AppError("subtotal or totalAmount must be greater than zero", 400);
  }

  const vatAmount = Number.isFinite(Number(payload.vatAmount))
    ? Number(payload.vatAmount)
    : Math.round(subtotal * 0.2 * 100) / 100;
  const totalAmount = Number.isFinite(Number(payload.totalAmount))
    ? Number(payload.totalAmount)
    : Math.round((subtotal + vatAmount) * 100) / 100;

  const invoice = await Invoice.create({
    invoiceNo: await generateAdminInvoiceNo(),
    job: payload.jobId,
    fleet: payload.fleetId,
    mechanic: payload.mechanicId,
    subtotal,
    vatAmount,
    totalAmount,
    currency: payload.currency || "GBP",
    status: `${payload.status || "ISSUED"}`.trim().toUpperCase(),
    issuedAt: payload.issuedAt ? new Date(payload.issuedAt) : new Date(),
    paidAt: payload.paidAt ? new Date(payload.paidAt) : undefined,
    payment: {
      provider: payload.provider || "MANUAL",
      status: `${payload.paymentStatus || "PENDING"}`.trim().toUpperCase(),
      updatedAt: new Date(),
    },
    lineItems:
      payload.lineItems?.length
        ? payload.lineItems
        : [
            {
              description: payload.description || "Admin created invoice",
              quantity: 1,
              unitAmount: subtotal,
              totalAmount: subtotal,
            },
          ],
    billedToSnapshot: {
      companyName: payload.companyName,
      vatNumber: payload.vatNumber,
      address: payload.billingAddress,
    },
    mechanicSnapshot: {
      displayName: payload.mechanicName,
      businessName: payload.mechanicBusinessName,
      rating: payload.mechanicRating,
    },
  });

  await writeAuditLog(
    adminUser,
    "Created Invoice",
    `${invoice.invoiceNo} (${invoice.totalAmount})`,
    "Financial"
  );

  return invoice.toObject();
};

export const exportAdminFinancialOverview = async (query = {}) => {
  const format = `${query.format || "CSV"}`.trim().toUpperCase();
  const overview = await getAdminFinancialOverview(query);
  return {
    format,
    generatedAt: new Date(),
    filters: {
      status: query.status || null,
      search: query.search || null,
    },
    summary: overview.summary,
    count: overview.items.length,
    items: overview.items,
    downloadUrl: null,
  };
};

export const getAdminLiveTracking = async () => {
  const mechanics = await User.find({ role: ROLES.MECHANIC, status: USER_STATUS.ACTIVE })
    .sort({ createdAt: -1 })
    .lean();

  const mechanicIds = mechanics.map((mechanic) => mechanic._id);
  const [activeJobs, latestPings] = await Promise.all([
    Job.find({
      assignedMechanic: { $in: mechanicIds },
      status: {
        $in: [
          JOB_STATUS.ASSIGNED,
          JOB_STATUS.EN_ROUTE,
          JOB_STATUS.ON_SITE,
          JOB_STATUS.IN_PROGRESS,
          JOB_STATUS.AWAITING_APPROVAL,
        ],
      },
    })
      .sort({ updatedAt: -1 })
      .populate("fleet", "fleetProfile.companyName")
      .lean(),
    JobLocationPing.aggregate([
      { $sort: { pingedAt: -1 } },
      {
        $group: {
          _id: "$mechanic",
          point: { $first: "$point" },
          pingedAt: { $first: "$pingedAt" },
          job: { $first: "$job" },
        },
      },
    ]),
  ]);

  const latestPingMap = new Map(
    latestPings.map((entry) => [entry._id.toString(), entry])
  );
  const activeJobMap = new Map(
    activeJobs.map((job) => [job.assignedMechanic.toString(), job])
  );

  const items = mechanics.map((mechanic) => {
    const job = activeJobMap.get(mechanic._id.toString()) || null;
    const ping = latestPingMap.get(mechanic._id.toString()) || null;
    const state =
      job?.status === JOB_STATUS.EN_ROUTE
        ? "EN_ROUTE"
        : job
        ? "ON_JOB"
        : mechanic.mechanicProfile?.availability === "ONLINE"
        ? "AVAILABLE"
        : "OFFLINE";

    return {
      _id: mechanic._id,
      displayName: mechanic.mechanicProfile?.displayName || mechanic.email,
      baseLocationText: mechanic.mechanicProfile?.baseLocationText || null,
      state,
      currentJob: job
        ? {
            _id: job._id,
            jobCode: job.jobCode,
            title: job.title,
            fleetCompanyName: job.fleet?.fleetProfile?.companyName || null,
            etaMinutes: job.tracking?.etaMinutes ?? null,
          }
        : null,
      latestLocation: ping
        ? {
            point: ping.point,
            pingedAt: ping.pingedAt,
          }
        : null,
    };
  });

  return {
    cards: {
      activeMechanics: items.filter((item) => item.state !== "OFFLINE").length,
      onJob: items.filter((item) => item.state === "ON_JOB").length,
      enRoute: items.filter((item) => item.state === "EN_ROUTE").length,
      available: items.filter((item) => item.state === "AVAILABLE").length,
    },
    items,
  };
};

export const listAdminSupportTickets = async (query = {}) => {
  const page = parsePage(query.page);
  const limit = parseLimit(query.limit);
  const skip = (page - 1) * limit;
  const filter = {};

  if (query.status) {
    filter.status = `${query.status}`.trim().toUpperCase();
  }

  const priority = parsePriority(query.priority);
  const search = `${query.search || ""}`.trim();

  const [tickets, total, allTickets] = await Promise.all([
    SupportTicket.find(filter)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .populate("user", "email fleetProfile.companyName mechanicProfile.displayName")
      .populate("assignedTo", "email")
      .lean(),
    SupportTicket.countDocuments(filter),
    SupportTicket.find({})
      .populate("user", "email fleetProfile.companyName mechanicProfile.displayName")
      .lean(),
  ]);

  let items = tickets;
  if (search) {
    const searchRegex = safeRegex(search);
    items = items.filter(
      (ticket) =>
        searchRegex.test(ticket.subject) ||
        searchRegex.test(ticket.message) ||
        searchRegex.test(ticket.user?.email || "") ||
        searchRegex.test(ticket.user?.fleetProfile?.companyName || "") ||
        searchRegex.test(ticket.user?.mechanicProfile?.displayName || "")
    );
  }
  if (priority) {
    items = items.filter((ticket) => supportPriorityFromTicket(ticket) === priority);
  }

  const stats = {
    open: allTickets.filter((ticket) => ticket.status === "OPEN").length,
    inProgress: allTickets.filter((ticket) => ticket.status === "IN_PROGRESS").length,
    resolved: allTickets.filter((ticket) => ticket.status === "RESOLVED").length,
    highPriority: allTickets.filter(
      (ticket) => supportPriorityFromTicket(ticket) === "HIGH"
    ).length,
  };

  return {
    items: items.map(serializeSupportTicketForAdmin),
    meta: {
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit) || 1,
    },
    stats,
  };
};

export const updateAdminSupportTicket = async (ticketId, payload = {}) => {
  const ticket = await SupportTicket.findById(ticketId);
  if (!ticket) throw new AppError("Support ticket not found", 404);

  if (payload.status) {
    ticket.status = `${payload.status}`.trim().toUpperCase();
  }
  if (payload.resolution !== undefined) {
    ticket.resolution = `${payload.resolution || ""}`.trim() || undefined;
  }
  if (ticket.status === "RESOLVED" && !ticket.resolvedAt) {
    ticket.resolvedAt = new Date();
  }

  await ticket.save();
  return ticket;
};

export const listAdminDisputes = async (query = {}) => {
  const page = parsePage(query.page);
  const limit = parseLimit(query.limit);
  const skip = (page - 1) * limit;
  const filter = {};

  if (query.status) {
    filter.status = `${query.status}`.trim().toUpperCase();
  }
  if (query.priority) {
    filter.priority = parsePriority(query.priority);
  }
  if (query.search) {
    const searchRegex = safeRegex(query.search);
    filter.$or = [
      { title: searchRegex },
      { description: searchRegex },
      { customerName: searchRegex },
      { serviceLabel: searchRegex },
      { reason: searchRegex },
    ];
  }

  const [items, total, allItems] = await Promise.all([
    Dispute.find(filter)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .populate("company", "email fleetProfile.companyName")
      .populate("mechanic", "email mechanicProfile.displayName")
      .lean(),
    Dispute.countDocuments(filter),
    Dispute.find({}).lean(),
  ]);

  return {
    items: items.map(serializeDispute),
    meta: {
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit) || 1,
    },
    stats: {
      open: allItems.filter((item) => item.status === "OPEN").length,
      inReview: allItems.filter((item) => item.status === "IN_REVIEW").length,
      resolved: allItems.filter((item) => item.status === "RESOLVED").length,
      amountAtRisk: allItems.reduce((sum, item) => sum + (item.amount || 0), 0),
    },
  };
};

export const createAdminDispute = async (payload = {}) => {
  if (!payload.title) throw new AppError("title is required", 400);
  const dispute = await Dispute.create({
    title: payload.title,
    description: payload.description,
    company: payload.companyId,
    customerName: payload.customerName,
    mechanic: payload.mechanicId,
    serviceLabel: payload.serviceLabel,
    amount: payload.amount,
    currency: payload.currency || "GBP",
    reason: payload.reason,
    priority: payload.priority || "MEDIUM",
    status: payload.status || "OPEN",
    notes: payload.notes,
  });
  return dispute;
};

export const updateAdminDispute = async (disputeId, payload = {}) => {
  const dispute = await Dispute.findById(disputeId);
  if (!dispute) throw new AppError("Dispute not found", 404);

  const fields = [
    "title",
    "description",
    "customerName",
    "serviceLabel",
    "amount",
    "currency",
    "reason",
    "notes",
  ];

  for (const field of fields) {
    if (payload[field] !== undefined) dispute[field] = payload[field];
  }
  if (payload.companyId !== undefined) dispute.company = payload.companyId || undefined;
  if (payload.mechanicId !== undefined) dispute.mechanic = payload.mechanicId || undefined;
  if (payload.priority) dispute.priority = `${payload.priority}`.trim().toUpperCase();
  if (payload.status) dispute.status = `${payload.status}`.trim().toUpperCase();
  if (dispute.status === "RESOLVED" && !dispute.resolvedAt) {
    dispute.resolvedAt = new Date();
  }

  await dispute.save();
  return dispute;
};

export const listAdminNotifications = async () => {
  const notifications = await Notification.find({})
    .sort({ createdAt: -1 })
    .limit(50)
    .populate("user", "email")
    .lean();

  return {
    items: notifications.map((item) => ({
      _id: item._id,
      type: item.type,
      title: item.title,
      body: item.body,
      isRead: item.isRead,
      user: item.user?.email || null,
      createdAt: item.createdAt,
    })),
    stats: {
      total: notifications.length,
      unread: notifications.filter((item) => !item.isRead).length,
      urgent: notifications.filter((item) => item.type?.toUpperCase().includes("ALERT")).length,
      today: notifications.filter(
        (item) => new Date(item.createdAt).toDateString() === new Date().toDateString()
      ).length,
    },
  };
};

export const markAdminNotificationRead = async (notificationId, adminUser) => {
  const notification = await Notification.findById(notificationId);
  if (!notification) throw new AppError("Notification not found", 404);

  notification.isRead = true;
  notification.readAt = notification.readAt || new Date();
  await notification.save();

  await writeAuditLog(
    adminUser,
    "Marked Notification Read",
    notification.title || notification._id.toString(),
    "Notifications"
  );

  return {
    _id: notification._id,
    isRead: notification.isRead,
    readAt: notification.readAt,
  };
};

export const markAllAdminNotificationsRead = async (adminUser) => {
  const unreadNotifications = await Notification.find({ isRead: false }).select("_id title");
  if (!unreadNotifications.length) {
    return { updatedCount: 0 };
  }

  const ids = unreadNotifications.map((item) => item._id);
  await Notification.updateMany(
    { _id: { $in: ids } },
    { $set: { isRead: true, readAt: new Date() } }
  );

  await writeAuditLog(
    adminUser,
    "Marked All Notifications Read",
    `${ids.length} notifications`,
    "Notifications"
  );

  return { updatedCount: ids.length };
};

export const removeAdminNotification = async (notificationId, adminUser) => {
  const notification = await Notification.findById(notificationId);
  if (!notification) throw new AppError("Notification not found", 404);

  await Notification.deleteOne({ _id: notification._id });
  await writeAuditLog(
    adminUser,
    "Deleted Notification",
    notification.title || notification._id.toString(),
    "Notifications"
  );

  return { _id: notification._id, deleted: true };
};

export const listAdminServiceCatalog = async (query = {}) => {
  const filter = {};
  if (query.category) {
    filter.category = safeRegex(query.category);
  }
  if (query.search) {
    filter.name = safeRegex(query.search);
  }

  const [items, statsAgg] = await Promise.all([
    ServiceCatalog.find(filter).sort({ createdAt: -1 }).lean(),
    ServiceCatalog.aggregate([
      {
        $group: {
          _id: null,
          totalServices: { $sum: 1 },
          avgBasePrice: { $avg: "$basePrice" },
          totalBookings: { $sum: "$bookingsCount" },
          categories: { $addToSet: "$category" },
        },
      },
    ]),
  ]);

  return {
    items,
    stats: {
      totalServices: statsAgg[0]?.totalServices || 0,
      avgBasePrice: Math.round((statsAgg[0]?.avgBasePrice || 0) * 100) / 100,
      totalBookings: statsAgg[0]?.totalBookings || 0,
      categories: statsAgg[0]?.categories?.length || 0,
    },
  };
};

export const createAdminServiceCatalogItem = async (payload = {}) => {
  if (!payload.name || !payload.category) {
    throw new AppError("name and category are required", 400);
  }
  return ServiceCatalog.create({
    name: payload.name,
    category: payload.category,
    description: payload.description,
    basePrice: payload.basePrice,
    currency: payload.currency || "GBP",
    durationLabel: payload.durationLabel,
    isActive: payload.isActive ?? true,
    bookingsCount: payload.bookingsCount ?? 0,
  });
};

export const updateAdminServiceCatalogItem = async (serviceId, payload = {}) => {
  const item = await ServiceCatalog.findById(serviceId);
  if (!item) throw new AppError("Service catalog item not found", 404);

  const fields = [
    "name",
    "category",
    "description",
    "basePrice",
    "currency",
    "durationLabel",
    "isActive",
    "bookingsCount",
  ];
  for (const field of fields) {
    if (payload[field] !== undefined) item[field] = payload[field];
  }
  await item.save();
  return item;
};

export const listAdminPromotions = async (query = {}) => {
  const filter = {};
  if (query.status) filter.status = parseStatus(query.status);
  if (query.search) filter.code = safeRegex(query.search);

  const [items, statsAgg] = await Promise.all([
    Promotion.find(filter).sort({ createdAt: -1 }).lean(),
    Promotion.aggregate([
      {
        $group: {
          _id: null,
          activePromotions: {
            $sum: { $cond: [{ $eq: ["$status", "ACTIVE"] }, 1, 0] },
          },
          totalUsage: { $sum: "$usageCount" },
          avgDiscount: { $avg: "$discountValue" },
        },
      },
    ]),
  ]);

  return {
    items,
    stats: {
      activePromotions: statsAgg[0]?.activePromotions || 0,
      totalUsage: statsAgg[0]?.totalUsage || 0,
      avgDiscount: Math.round((statsAgg[0]?.avgDiscount || 0) * 100) / 100,
    },
  };
};

export const createAdminPromotion = async (payload = {}) => {
  if (!payload.code || payload.discountValue === undefined) {
    throw new AppError("code and discountValue are required", 400);
  }
  return Promotion.create({
    code: payload.code,
    discountType: payload.discountType || "PERCENTAGE",
    discountValue: payload.discountValue,
    minAmount: payload.minAmount ?? 0,
    currency: payload.currency || "GBP",
    usageCount: payload.usageCount ?? 0,
    usageLimit: payload.usageLimit ?? 100,
    status: payload.status || "ACTIVE",
    expiresAt: payload.expiresAt,
  });
};

export const updateAdminPromotion = async (promotionId, payload = {}) => {
  const item = await Promotion.findById(promotionId);
  if (!item) throw new AppError("Promotion not found", 404);
  const fields = [
    "code",
    "discountType",
    "discountValue",
    "minAmount",
    "currency",
    "usageCount",
    "usageLimit",
    "status",
    "expiresAt",
  ];
  for (const field of fields) {
    if (payload[field] !== undefined) item[field] = payload[field];
  }
  await item.save();
  return item;
};

export const listAdminReviews = async (query = {}) => {
  const filter = {};
  if (query.status) filter.status = parseStatus(query.status);
  if (query.rating) filter.rating = Number(query.rating);
  if (query.search) {
    const searchRegex = safeRegex(query.search);
    filter.$or = [
      { customerName: searchRegex },
      { companyName: searchRegex },
      { serviceLabel: searchRegex },
      { mechanicName: searchRegex },
      { comment: searchRegex },
    ];
  }

  const [items, statsAgg] = await Promise.all([
    Review.find(filter).sort({ createdAt: -1 }).lean(),
    Review.aggregate([
      {
        $group: {
          _id: null,
          averageRating: { $avg: "$rating" },
          fiveStarReviews: {
            $sum: { $cond: [{ $eq: ["$rating", 5] }, 1, 0] },
          },
          fourStarReviews: {
            $sum: { $cond: [{ $eq: ["$rating", 4] }, 1, 0] },
          },
          flaggedReviews: {
            $sum: { $cond: [{ $eq: ["$status", "FLAGGED"] }, 1, 0] },
          },
          total: { $sum: 1 },
        },
      },
    ]),
  ]);

  return {
    items,
    stats: {
      averageRating: Math.round((statsAgg[0]?.averageRating || 0) * 10) / 10,
      fiveStarReviews: statsAgg[0]?.fiveStarReviews || 0,
      fourStarReviews: statsAgg[0]?.fourStarReviews || 0,
      flaggedReviews: statsAgg[0]?.flaggedReviews || 0,
      total: statsAgg[0]?.total || 0,
    },
  };
};

export const updateAdminReview = async (reviewId, payload = {}) => {
  const review = await Review.findById(reviewId);
  if (!review) throw new AppError("Review not found", 404);
  if (payload.status) review.status = parseStatus(payload.status);
  if (payload.comment !== undefined) review.comment = payload.comment;
  await review.save();
  return review;
};

export const listAdminAuditLogs = async (query = {}) => {
  const filter = {};
  if (query.category) filter.category = safeRegex(query.category);
  if (query.search) {
    const searchRegex = safeRegex(query.search);
    filter.$or = [
      { userLabel: searchRegex },
      { action: searchRegex },
      { target: searchRegex },
      { category: searchRegex },
      { ipAddress: searchRegex },
    ];
  }

  const items = await AuditLog.find(filter).sort({ createdAt: -1 }).limit(100).lean();
  const today = new Date().toDateString();
  const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

  return {
    items,
    stats: {
      totalActions: items.length,
      today: items.filter((item) => new Date(item.createdAt).toDateString() === today).length,
      thisWeek: items.filter((item) => new Date(item.createdAt) >= weekAgo).length,
      activeAdmins: new Set(items.map((item) => item.userLabel)).size,
    },
  };
};

export const getAdminReports = async (query = {}) => {
  const reportType = `${query.type || "REVENUE"}`.trim().toUpperCase();

  const [invoiceAgg, jobsAgg, topCompaniesAgg, mechanicAgg, serviceAgg] = await Promise.all([
    Invoice.aggregate([
      {
        $group: {
          _id: null,
          totalRevenue: { $sum: "$totalAmount" },
          totalInvoices: { $sum: 1 },
          avgServiceValue: { $avg: "$totalAmount" },
        },
      },
    ]),
    Job.aggregate([
      {
        $group: {
          _id: null,
          totalServices: { $sum: 1 },
        },
      },
    ]),
    Invoice.aggregate([
      {
        $group: {
          _id: "$fleet",
          revenue: { $sum: "$totalAmount" },
          count: { $sum: 1 },
        },
      },
      { $sort: { revenue: -1 } },
      { $limit: 5 },
    ]),
    User.find({ role: ROLES.MECHANIC })
      .sort({ "mechanicProfile.stats.jobsDone": -1 })
      .limit(5)
      .lean(),
    ServiceCatalog.find({}).sort({ bookingsCount: -1 }).limit(5).lean(),
  ]);

  const topCompanyIds = topCompaniesAgg.map((item) => item._id).filter(Boolean);
  const topCompanies = topCompanyIds.length
    ? await User.find({ _id: { $in: topCompanyIds } })
        .select("fleetProfile.companyName email")
        .lean()
    : [];
  const topCompanyMap = new Map(topCompanies.map((item) => [item._id.toString(), item]));

  return {
    reportType,
    summary: {
      totalRevenue: invoiceAgg[0]?.totalRevenue || 0,
      totalServices: jobsAgg[0]?.totalServices || 0,
      activeCompanies: await User.countDocuments({ role: ROLES.FLEET, status: USER_STATUS.ACTIVE }),
      avgServiceValue: Math.round((invoiceAgg[0]?.avgServiceValue || 0) * 100) / 100,
    },
    monthlyRevenueTrend: ["Jan", "Feb", "Mar"].map((month, index) => ({
      month,
      revenue: [45000, 52000, 48000][index],
      services: [125, 148, 132][index],
    })),
    topServices: serviceAgg.map((item) => ({
      name: item.name,
      count: item.bookingsCount,
      revenue: item.basePrice * item.bookingsCount,
    })),
    topCompanies: topCompaniesAgg.map((item) => ({
      companyName:
        topCompanyMap.get(item._id?.toString?.() || "")?.fleetProfile?.companyName ||
        topCompanyMap.get(item._id?.toString?.() || "")?.email ||
        "Unknown Company",
      services: item.count,
      revenue: item.revenue,
    })),
    mechanicPerformance: mechanicAgg.map((item) => ({
      mechanicName: item.mechanicProfile?.displayName || item.email,
      services: item.mechanicProfile?.stats?.jobsDone || 0,
      rating: item.mechanicProfile?.rating?.average || 0,
      revenue: 0,
    })),
    exportFormat: `${query.format || "PDF"}`.trim().toUpperCase(),
  };
};

export const exportAdminReports = async (query = {}) => {
  const report = await getAdminReports(query);
  return {
    generatedAt: new Date(),
    format: `${query.format || report.exportFormat || "PDF"}`.trim().toUpperCase(),
    report,
    downloadUrl: null,
  };
};

export const getAdminSettings = async (adminUser) => {
  const freshAdmin = await User.findById(adminUser._id).lean();
  if (!freshAdmin) throw new AppError("Admin not found", 404);

  return {
    profile: {
      _id: freshAdmin._id,
      email: freshAdmin.email,
      fullName:
        freshAdmin.adminProfile?.fullName ||
        freshAdmin.email.split("@")[0],
      phoneNumber: freshAdmin.adminProfile?.phoneNumber || null,
      role: freshAdmin.role,
      profilePhotoUrl: freshAdmin.adminProfile?.profilePhotoUrl || null,
    },
    preferences: {
      timeZone: freshAdmin.adminSettings?.timeZone || "GMT",
      language: freshAdmin.adminSettings?.language || "English",
      notificationsEnabled:
        freshAdmin.adminSettings?.notificationsEnabled ?? true,
      securityAlertsEnabled:
        freshAdmin.adminSettings?.securityAlertsEnabled ?? true,
      regionalFormat: freshAdmin.adminSettings?.regionalFormat || "en-GB",
      billingEmail: freshAdmin.adminSettings?.billingEmail || freshAdmin.email,
      privacyMode: freshAdmin.adminSettings?.privacyMode || "STANDARD",
    },
  };
};

export const updateAdminSettings = async (adminUser, payload = {}) => {
  const admin = await User.findById(adminUser._id);
  if (!admin) throw new AppError("Admin not found", 404);

  admin.adminProfile = {
    ...(admin.adminProfile || {}),
    ...(payload.profile || {}),
  };

  if (payload.profile?.fullName !== undefined) {
    admin.adminProfile.fullName = `${payload.profile.fullName || ""}`.trim() || undefined;
  }
  if (payload.profile?.phoneNumber !== undefined) {
    admin.adminProfile.phoneNumber =
      `${payload.profile.phoneNumber || ""}`.trim() || undefined;
  }
  if (payload.profile?.profilePhotoUrl !== undefined) {
    admin.adminProfile.profilePhotoUrl =
      `${payload.profile.profilePhotoUrl || ""}`.trim() || undefined;
  }

  admin.adminSettings = {
    ...(admin.adminSettings || {}),
    ...(payload.preferences || {}),
  };

  if (payload.preferences?.timeZone !== undefined) {
    admin.adminSettings.timeZone =
      `${payload.preferences.timeZone || ""}`.trim() || "GMT";
  }
  if (payload.preferences?.language !== undefined) {
    admin.adminSettings.language =
      `${payload.preferences.language || ""}`.trim() || "English";
  }
  if (payload.preferences?.regionalFormat !== undefined) {
    admin.adminSettings.regionalFormat =
      `${payload.preferences.regionalFormat || ""}`.trim() || "en-GB";
  }
  if (payload.preferences?.billingEmail !== undefined) {
    admin.adminSettings.billingEmail =
      `${payload.preferences.billingEmail || ""}`.trim().toLowerCase() || undefined;
  }
  if (payload.preferences?.privacyMode !== undefined) {
    admin.adminSettings.privacyMode =
      `${payload.preferences.privacyMode || ""}`.trim().toUpperCase() || "STANDARD";
  }
  if (payload.preferences?.notificationsEnabled !== undefined) {
    admin.adminSettings.notificationsEnabled = Boolean(
      payload.preferences.notificationsEnabled
    );
  }
  if (payload.preferences?.securityAlertsEnabled !== undefined) {
    admin.adminSettings.securityAlertsEnabled = Boolean(
      payload.preferences.securityAlertsEnabled
    );
  }

  await admin.save();
  await writeAuditLog(
    adminUser,
    "Updated Admin Settings",
    admin.email,
    "Settings"
  );

  return getAdminSettings(admin);
};

export const approveMechanic = async (userId, payload = {}) => {
  const mechanic = await findMechanicById(userId);

  mechanic.status = USER_STATUS.ACTIVE;
  mechanic.mechanicProfile = {
    ...(mechanic.mechanicProfile || {}),
    verification: {
      ...(mechanic.mechanicProfile?.verification || {}),
      status: MECHANIC_VERIFICATION_STATUS.APPROVED,
      reviewedAt: new Date(),
      reviewNotes: `${payload.notes || ""}`.trim() || undefined,
    },
  };

  await mechanic.save();
  return serializeMechanicReviewItem(mechanic);
};

export const rejectMechanic = async (userId, payload = {}) => {
  const mechanic = await findMechanicById(userId);
  const reason = `${payload.reason || payload.notes || ""}`.trim();
  if (!reason) throw new AppError("reason is required", 400);

  mechanic.status = USER_STATUS.PENDING_REVIEW;
  mechanic.mechanicProfile = {
    ...(mechanic.mechanicProfile || {}),
    verification: {
      ...(mechanic.mechanicProfile?.verification || {}),
      status: MECHANIC_VERIFICATION_STATUS.REJECTED,
      reviewedAt: new Date(),
      reviewNotes: reason,
    },
  };

  await mechanic.save();
  return serializeMechanicReviewItem(mechanic);
};

export const updateUserStatus = async (userId, payload = {}) => {
  const nextStatus = `${payload.status || ""}`.trim().toUpperCase();
  if (!userStatusValues.includes(nextStatus)) {
    throw new AppError(
      `status must be one of ${userStatusValues.join(", ")}`,
      400
    );
  }

  const user = await User.findById(userId);
  if (!user) throw new AppError("User not found", 404);

  user.status = nextStatus;

  if (user.role === ROLES.MECHANIC && nextStatus === USER_STATUS.ACTIVE) {
    user.mechanicProfile = {
      ...(user.mechanicProfile || {}),
      verification: {
        ...(user.mechanicProfile?.verification || {}),
        status:
          user.mechanicProfile?.verification?.status ===
          MECHANIC_VERIFICATION_STATUS.APPROVED
            ? MECHANIC_VERIFICATION_STATUS.APPROVED
            : MECHANIC_VERIFICATION_STATUS.UNDER_REVIEW,
        reviewedAt: new Date(),
        reviewNotes:
          `${payload.notes || ""}`.trim() ||
          user.mechanicProfile?.verification?.reviewNotes,
      },
    };
  }

  await user.save();

  return {
    _id: user._id,
    email: user.email,
    role: user.role,
    status: user.status,
    updatedAt: user.updatedAt,
  };
};
