import AppError from "../../utils/AppError.js";
import { Dispute } from "./dispute.model.js";
import { Job } from "../job/job.model.js";
import { Invoice } from "../invoice/invoice.model.js";
import { ROLES } from "../../constants/domain.js";
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

const serializeDispute = (dispute) => ({
  _id: dispute._id,
  title: dispute.title,
  description: dispute.description || null,
  company: dispute.company
    ? {
        _id: dispute.company._id || dispute.company,
        companyName: dispute.company.fleetProfile?.companyName || null,
      }
    : null,
  mechanic: dispute.mechanic
    ? {
        _id: dispute.mechanic._id || dispute.mechanic,
        displayName: dispute.mechanic.mechanicProfile?.displayName || null,
      }
    : null,
  job: dispute.job
    ? {
        _id: dispute.job._id || dispute.job,
        jobCode: dispute.job.jobCode || null,
        title: dispute.job.title || null,
      }
    : null,
  invoice: dispute.invoice
    ? {
        _id: dispute.invoice._id || dispute.invoice,
        invoiceNo: dispute.invoice.invoiceNo || null,
      }
    : null,
  customerName: dispute.customerName || null,
  serviceLabel: dispute.serviceLabel || null,
  amount: dispute.amount,
  currency: dispute.currency || "GBP",
  reason: dispute.reason || null,
  priority: dispute.priority,
  status: dispute.status,
  notes: dispute.notes || null,
  resolvedAt: dispute.resolvedAt || null,
  createdAt: dispute.createdAt,
  updatedAt: dispute.updatedAt,
});

const ensureFleetUser = (user) => {
  if (user.role !== ROLES.FLEET) {
    throw new AppError("Only fleet users can manage disputes", 403);
  }
};

export const createFleetDispute = async (fleetUser, payload = {}) => {
  ensureFleetUser(fleetUser);

  const title = `${payload.title || ""}`.trim();
  if (!title) throw new AppError("title is required", 400);

  let job = null;
  let invoice = null;

  if (payload.jobId) {
    job = await Job.findById(payload.jobId)
      .populate("assignedMechanic", "mechanicProfile.displayName")
      .lean();
    if (!job) throw new AppError("Job not found", 404);
    if (job.fleet.toString() !== fleetUser._id.toString()) {
      throw new AppError("Forbidden", 403);
    }
  }

  if (payload.invoiceId) {
    invoice = await Invoice.findById(payload.invoiceId)
      .populate("mechanic", "mechanicProfile.displayName")
      .populate("job", "jobCode title")
      .lean();
    if (!invoice) throw new AppError("Invoice not found", 404);
    if (invoice.fleet.toString() !== fleetUser._id.toString()) {
      throw new AppError("Forbidden", 403);
    }
  }

  const dispute = await Dispute.create({
    title,
    description: payload.description,
    company: fleetUser._id,
    job: job?._id,
    invoice: invoice?._id,
    customerName:
      fleetUser.fleetProfile?.contactName ||
      fleetUser.fleetProfile?.companyName ||
      fleetUser.email,
    mechanic:
      invoice?.mechanic?._id ||
      job?.assignedMechanic?._id ||
      undefined,
    serviceLabel:
      payload.serviceLabel ||
      invoice?.job?.title ||
      job?.title ||
      undefined,
    amount: Number(payload.amount) || 0,
    currency: payload.currency || "GBP",
    reason: payload.reason,
    priority: `${payload.priority || "MEDIUM"}`.trim().toUpperCase(),
    status: "OPEN",
    notes: payload.notes,
  });

  if (dispute.mechanic) {
    await createNotification({
      user: dispute.mechanic,
      type: "DISPUTE_CREATED",
      title: `Fleet dispute opened for ${dispute.serviceLabel || title}`,
      body: dispute.reason || "A fleet operator opened a dispute requiring review.",
      data: {
        disputeId: dispute._id.toString(),
        jobId: job?._id?.toString?.() || null,
        invoiceId: invoice?._id?.toString?.() || null,
      },
    });
  }

  const populated = await Dispute.findById(dispute._id)
    .populate("company", "fleetProfile.companyName")
    .populate("mechanic", "mechanicProfile.displayName")
    .populate("job", "jobCode title")
    .populate("invoice", "invoiceNo")
    .lean();

  return serializeDispute(populated);
};

export const listFleetDisputes = async (fleetUser, query = {}) => {
  ensureFleetUser(fleetUser);

  const page = parsePage(query.page);
  const limit = parseLimit(query.limit);
  const skip = (page - 1) * limit;

  const filter = { company: fleetUser._id };
  if (query.status) filter.status = `${query.status}`.trim().toUpperCase();

  const [items, total] = await Promise.all([
    Dispute.find(filter)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .populate("company", "fleetProfile.companyName")
      .populate("mechanic", "mechanicProfile.displayName")
      .populate("job", "jobCode title")
      .populate("invoice", "invoiceNo")
      .lean(),
    Dispute.countDocuments(filter),
  ]);

  return {
    items: items.map(serializeDispute),
    meta: {
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit) || 1,
    },
  };
};

export const updateFleetDispute = async (fleetUser, disputeId, payload = {}) => {
  ensureFleetUser(fleetUser);

  const dispute = await Dispute.findOne({
    _id: disputeId,
    company: fleetUser._id,
  });
  if (!dispute) throw new AppError("Dispute not found", 404);

  const editableFields = ["title", "description", "reason", "notes", "serviceLabel"];
  for (const field of editableFields) {
    if (payload[field] !== undefined) dispute[field] = payload[field];
  }
  if (payload.amount !== undefined) dispute.amount = Number(payload.amount) || 0;
  if (payload.priority) dispute.priority = `${payload.priority}`.trim().toUpperCase();
  if (payload.status) {
    const nextStatus = `${payload.status}`.trim().toUpperCase();
    if (!["OPEN", "CLOSED"].includes(nextStatus)) {
      throw new AppError("status must be OPEN or CLOSED for fleet users", 400);
    }
    dispute.status = nextStatus;
    if (nextStatus === "CLOSED") {
      dispute.resolvedAt = dispute.resolvedAt || new Date();
    }
  }

  await dispute.save();

  if (dispute.mechanic) {
    await createNotification({
      user: dispute.mechanic,
      type: "DISPUTE_UPDATED",
      title: `Dispute updated: ${dispute.title}`,
      body: `Fleet changed dispute status to ${dispute.status}.`,
      data: {
        disputeId: dispute._id.toString(),
        status: dispute.status,
      },
    });
  }

  const populated = await Dispute.findById(dispute._id)
    .populate("company", "fleetProfile.companyName")
    .populate("mechanic", "mechanicProfile.displayName")
    .populate("job", "jobCode title")
    .populate("invoice", "invoiceNo")
    .lean();

  return serializeDispute(populated);
};

export const listMechanicDisputes = async (mechanicUser, query = {}) => {
  if (mechanicUser.role !== ROLES.MECHANIC) {
    throw new AppError("Only mechanic users can view mechanic disputes", 403);
  }

  const page = parsePage(query.page);
  const limit = parseLimit(query.limit);
  const skip = (page - 1) * limit;

  const filter = { mechanic: mechanicUser._id };
  if (query.status) filter.status = `${query.status}`.trim().toUpperCase();

  const [items, total] = await Promise.all([
    Dispute.find(filter)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .populate("company", "fleetProfile.companyName")
      .populate("mechanic", "mechanicProfile.displayName")
      .populate("job", "jobCode title")
      .populate("invoice", "invoiceNo")
      .lean(),
    Dispute.countDocuments(filter),
  ]);

  return {
    items: items.map(serializeDispute),
    meta: {
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit) || 1,
    },
  };
};

export const getMechanicDisputeById = async (mechanicUser, disputeId) => {
  if (mechanicUser.role !== ROLES.MECHANIC) {
    throw new AppError("Only mechanic users can view this dispute", 403);
  }

  const dispute = await Dispute.findOne({
    _id: disputeId,
    mechanic: mechanicUser._id,
  })
    .populate("company", "fleetProfile.companyName fleetProfile.contactName")
    .populate("mechanic", "mechanicProfile.displayName")
    .populate("job", "jobCode title status")
    .populate("invoice", "invoiceNo totalAmount currency status")
    .lean();

  if (!dispute) throw new AppError("Dispute not found", 404);

  return serializeDispute(dispute);
};

export const updateMechanicDispute = async (
  mechanicUser,
  disputeId,
  payload = {}
) => {
  if (mechanicUser.role !== ROLES.MECHANIC) {
    throw new AppError("Only mechanic users can update mechanic disputes", 403);
  }

  const dispute = await Dispute.findOne({
    _id: disputeId,
    mechanic: mechanicUser._id,
  });
  if (!dispute) throw new AppError("Dispute not found", 404);

  if (payload.notes !== undefined) {
    dispute.notes = `${payload.notes || ""}`.trim() || undefined;
  }

  if (payload.status) {
    const nextStatus = `${payload.status}`.trim().toUpperCase();
    if (!["OPEN", "IN_REVIEW", "RESOLVED"].includes(nextStatus)) {
      throw new AppError(
        "status must be OPEN, IN_REVIEW, or RESOLVED for mechanic users",
        400
      );
    }
    dispute.status = nextStatus;
    if (nextStatus === "RESOLVED") {
      dispute.resolvedAt = dispute.resolvedAt || new Date();
    }
  }

  await dispute.save();

  if (dispute.company) {
    await createNotification({
      user: dispute.company,
      type: "DISPUTE_UPDATED",
      title: `Mechanic updated dispute: ${dispute.title}`,
      body: `Dispute status is now ${dispute.status}.`,
      data: {
        disputeId: dispute._id.toString(),
        status: dispute.status,
      },
    });
  }

  const populated = await Dispute.findById(dispute._id)
    .populate("company", "fleetProfile.companyName")
    .populate("mechanic", "mechanicProfile.displayName")
    .populate("job", "jobCode title")
    .populate("invoice", "invoiceNo")
    .lean();

  return serializeDispute(populated);
};
