import mongoose from "mongoose";
import AppError from "../../utils/AppError.js";
import { Vehicle } from "./vehicle.model.js";
import { Job } from "../job/job.model.js";
import { JOB_STATUS } from "../../constants/domain.js";
import { readMechanicProfileRatingAverage } from "../../utils/mechanicRating.js";

const normalizeRegistration = (value) =>
  `${value || ""}`.trim().toUpperCase();

const filterObject = (payload, allowedFields) =>
  Object.fromEntries(
    Object.entries(payload).filter(([key, value]) => {
      if (!allowedFields.includes(key)) return false;
      return value !== undefined;
    })
  );

const normalizeCurrentMileageKm = (value) => {
  if (value === undefined || value === null || value === "") return undefined;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) {
    throw new AppError("currentMileageKm must be a non-negative number", 400);
  }
  return Math.round(n);
};

export const createVehicle = async (fleetUser, payload) => {
  const registration = normalizeRegistration(payload.registration);
  if (!registration) {
    throw new AppError("registration is required", 400);
  }

  const existing = await Vehicle.findOne({
    fleet: fleetUser._id,
    registration,
  });
  if (existing) {
    throw new AppError("Vehicle registration already exists", 409);
  }

  const currentMileageKm = normalizeCurrentMileageKm(payload.currentMileageKm);

  return Vehicle.create({
    fleet: fleetUser._id,
    registration,
    type: payload.type,
    make: payload.make,
    model: payload.model,
    year: payload.year,
    vin: payload.vin,
    ...(currentMileageKm !== undefined ? { currentMileageKm } : {}),
  });
};

/** Days since last completed job after which a vehicle is flagged “due service”. */
const SERVICE_DUE_AFTER_DAYS = 180;

const daysBetween = (from, to = new Date()) => {
  const a = new Date(from).getTime();
  const b = new Date(to).getTime();
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.floor((b - a) / (24 * 60 * 60 * 1000));
};

const enrichVehiclesWithJobStats = async (fleetId, vehicles) => {
  if (!vehicles.length) return [];

  const regs = vehicles.map((v) => normalizeRegistration(v.registration)).filter(Boolean);
  const ids = vehicles.map((v) => `${v._id}`);

  const jobs = await Job.find({
    fleet: fleetId,
    $or: [
      { "vehicle.vehicleId": { $in: ids } },
      ...(regs.length
        ? regs.map((reg) => ({
            "vehicle.registration": { $regex: new RegExp(`^${escapeRegex(reg)}$`, "i") },
          }))
        : []),
    ],
  })
    .select("vehicle status completedAt postedAt createdAt")
    .lean();

  const byKey = new Map();
  const pushJob = (key, job) => {
    if (!key) return;
    const list = byKey.get(key) || [];
    list.push(job);
    byKey.set(key, list);
  };

  for (const job of jobs) {
    const vid = job.vehicle?.vehicleId ? `${job.vehicle.vehicleId}` : null;
    const reg = normalizeRegistration(job.vehicle?.registration);
    if (vid) pushJob(`id:${vid}`, job);
    if (reg) pushJob(`reg:${reg}`, job);
  }

  const dedupeJobs = (lists) => {
    const seen = new Set();
    const out = [];
    for (const list of lists) {
      for (const job of list || []) {
        const id = `${job._id}`;
        if (seen.has(id)) continue;
        seen.add(id);
        out.push(job);
      }
    }
    return out;
  };

  return vehicles.map((vehicle) => {
    const vid = `${vehicle._id}`;
    const reg = normalizeRegistration(vehicle.registration);
    const matched = dedupeJobs([byKey.get(`id:${vid}`), byKey.get(`reg:${reg}`)]);
    const completed = matched
      .filter((j) => j.status === JOB_STATUS.COMPLETED && j.completedAt)
      .sort((a, b) => new Date(b.completedAt) - new Date(a.completedAt));
    const lastServiceAt = completed[0]?.completedAt || null;
    const daysSince = lastServiceAt != null ? daysBetween(lastServiceAt) : null;
    const serviceDue =
      !lastServiceAt || (daysSince != null && daysSince >= SERVICE_DUE_AFTER_DAYS);

    return {
      ...vehicle,
      recentJobsCount: matched.length,
      lastServiceAt,
      serviceDue,
      serviceDueAfterDays: SERVICE_DUE_AFTER_DAYS,
      daysSinceLastService: daysSince,
    };
  });
};

const parsePage = (value) => {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 1;
};

const parseLimit = (value) => {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return 12;
  return Math.min(Math.floor(n), 100);
};

export const listVehicles = async (fleetUser, query) => {
  const includeInactive = `${query.includeInactive}` === "true";
  const pagingRequested = query.page !== undefined || query.limit !== undefined;
  const page = parsePage(query.page);
  const limit = parseLimit(query.limit);
  const skip = (page - 1) * limit;
  const status = `${query.status || "all"}`.trim().toLowerCase();
  const q = `${query.q || query.search || ""}`.trim().toLowerCase();

  const filter = { fleet: fleetUser._id };
  if (!includeInactive) filter.isActive = true;
  if (status === "active") filter.isActive = true;
  if (status === "maintenance") filter.isActive = false;

  if (q) {
    const rx = new RegExp(escapeRegex(q), "i");
    filter.$or = [
      { registration: rx },
      { make: rx },
      { model: rx },
      { type: rx },
      { vin: rx },
    ];
  }

  // Fleet-wide stats (ignore list search/status so cards stay stable)
  const statsFilter = { fleet: fleetUser._id };
  const [statsVehicles, total, pageVehicles] = await Promise.all([
    Vehicle.find(statsFilter).sort({ createdAt: -1 }).lean(),
    Vehicle.countDocuments(filter),
    pagingRequested
      ? Vehicle.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).lean()
      : Vehicle.find(filter).sort({ createdAt: -1 }).lean(),
  ]);

  const [statsEnriched, items] = await Promise.all([
    enrichVehiclesWithJobStats(fleetUser._id, statsVehicles),
    enrichVehiclesWithJobStats(fleetUser._id, pageVehicles),
  ]);

  const activeCount = statsEnriched.filter((v) => v.isActive !== false).length;
  const maintenanceCount = statsEnriched.filter((v) => v.isActive === false).length;
  const dueServiceCount = statsEnriched.filter(
    (v) => v.isActive !== false && v.serviceDue
  ).length;

  const effectiveLimit = pagingRequested ? limit : items.length || limit;
  const effectiveTotal = pagingRequested ? total : items.length;

  return {
    items,
    stats: {
      total: statsEnriched.length,
      active: activeCount,
      maintenance: maintenanceCount,
      dueService: dueServiceCount,
      serviceDueAfterDays: SERVICE_DUE_AFTER_DAYS,
    },
    meta: {
      page: pagingRequested ? page : 1,
      limit: effectiveLimit,
      total: effectiveTotal,
      totalPages: Math.ceil(effectiveTotal / effectiveLimit) || 1,
    },
  };
};

const parseRecentJobsLimit = (query) => {
  const raw = query?.recentJobsLimit ?? query?.recentLimit ?? query?.jobsLimit;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return 10;
  return Math.min(Math.floor(n), 50);
};

const recentJobStatusUi = (status) => {
  const map = {
    [JOB_STATUS.POSTED]: { label: "POSTED", tone: "red" },
    [JOB_STATUS.QUOTING]: { label: "QUOTING", tone: "amber" },
    [JOB_STATUS.ASSIGNED]: { label: "ASSIGNED", tone: "blue" },
    [JOB_STATUS.EN_ROUTE]: { label: "EN ROUTE", tone: "amber" },
    [JOB_STATUS.ON_SITE]: { label: "ON SITE", tone: "green" },
    [JOB_STATUS.IN_PROGRESS]: { label: "IN PROGRESS", tone: "amber" },
    [JOB_STATUS.AWAITING_APPROVAL]: { label: "AWAITING APPROVAL", tone: "yellow" },
    [JOB_STATUS.COMPLETED]: { label: "COMPLETE", tone: "green" },
    [JOB_STATUS.CANCELLED]: { label: "CANCELLED", tone: "red" },
  };
  return map[status] || { label: status, tone: "neutral" };
};

const serializeRecentJobForVehicle = (job) => {
  const mechanic = job.assignedMechanic;
  const displayName = mechanic?.mechanicProfile?.displayName || null;
  return {
    _id: job._id,
    jobCode: job.jobCode,
    title: job.title,
    issueType: job.issueType,
    status: job.status,
    statusUi: recentJobStatusUi(job.status),
    postedAt: job.postedAt || job.createdAt,
    completedAt: job.completedAt || null,
    updatedAt: job.updatedAt,
    mechanicName: displayName,
    assignedMechanic: mechanic
      ? {
          _id: mechanic._id || mechanic,
          displayName,
          phone: mechanic.mechanicProfile?.phone || null,
          profilePhotoUrl: mechanic.mechanicProfile?.profilePhotoUrl || null,
          rating: readMechanicProfileRatingAverage(mechanic),
        }
      : null,
  };
};

const escapeRegex = (s) => `${s || ""}`.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const buildVehicleJobFilter = (fleetId, vehicle) => {
  const vid = `${vehicle._id}`;
  const reg = normalizeRegistration(vehicle.registration);
  return {
    fleet: fleetId,
    $or: [
      { "vehicle.vehicleId": vid },
      { "vehicle.registration": { $regex: new RegExp(`^${escapeRegex(reg)}$`, "i") } },
    ],
  };
};

export const getVehicleByIdForFleet = async (fleetUser, vehicleId, query = {}) => {
  if (!mongoose.Types.ObjectId.isValid(vehicleId)) {
    throw new AppError("Invalid vehicle id", 400);
  }

  const vehicle = await Vehicle.findOne({
    _id: vehicleId,
    fleet: fleetUser._id,
  }).lean();

  if (!vehicle) throw new AppError("Vehicle not found", 404);

  const jobFilter = buildVehicleJobFilter(fleetUser._id, vehicle);
  const limit = parseRecentJobsLimit(query);

  const [recentJobs, recentJobsTotal, enriched] = await Promise.all([
    Job.find(jobFilter)
      .sort({ updatedAt: -1, createdAt: -1 })
      .limit(limit)
      .populate(
        "assignedMechanic",
        "email role mechanicProfile.displayName mechanicProfile.phone mechanicProfile.rating mechanicProfile.profilePhotoUrl"
      )
      .lean(),
    Job.countDocuments(jobFilter),
    enrichVehiclesWithJobStats(fleetUser._id, [vehicle]),
  ]);

  return {
    vehicle: enriched[0] || vehicle,
    recentJobs: recentJobs.map(serializeRecentJobForVehicle),
    meta: {
      recentJobsTotal,
      recentJobsLimit: limit,
    },
  };
};

export const updateVehicle = async (fleetUser, vehicleId, payload) => {
  const vehicle = await Vehicle.findOne({
    _id: vehicleId,
    fleet: fleetUser._id,
  });
  if (!vehicle) throw new AppError("Vehicle not found", 404);

  const patch = filterObject(payload, [
    "registration",
    "type",
    "make",
    "model",
    "year",
    "vin",
    "currentMileageKm",
    "isActive",
  ]);

  if (patch.currentMileageKm !== undefined) {
    patch.currentMileageKm = normalizeCurrentMileageKm(patch.currentMileageKm);
  }

  if (patch.registration !== undefined) {
    patch.registration = normalizeRegistration(patch.registration);
    if (!patch.registration) {
      throw new AppError("registration cannot be empty", 400);
    }

    const duplicate = await Vehicle.findOne({
      _id: { $ne: vehicle._id },
      fleet: fleetUser._id,
      registration: patch.registration,
    });
    if (duplicate) {
      throw new AppError("Vehicle registration already exists", 409);
    }
  }

  Object.assign(vehicle, patch);
  await vehicle.save();
  return vehicle;
};

export const deleteVehicle = async (fleetUser, vehicleId) => {
  const vehicle = await Vehicle.findOne({
    _id: vehicleId,
    fleet: fleetUser._id,
  });
  if (!vehicle) throw new AppError("Vehicle not found", 404);

  vehicle.isActive = false;
  await vehicle.save({ validateBeforeSave: false });

  return {
    _id: vehicle._id,
    registration: vehicle.registration,
    isActive: vehicle.isActive,
  };
};
