import { sendResponse } from "../../utils/sendResponse.js";
import AppError from "../../utils/AppError.js";
import { ROLES } from "../../constants/domain.js";
import { uploadJobPhotoBuffer } from "../media/media.service.js";
import {
  addJobPhotos,
  addJobAttachments,
  approveJobCompletion,
  approveJobCompletionAsCompany,
  arriveAtJob,
  cancelJob,
  completeJobWork,
  createJob,
  removeJobPhoto,
  removeJobAttachment,
  getJobByIdForUser,
  getJobTimeline,
  createJobLocationPing,
  listJobs,
  previewJobCancellation,
  startJobWork,
  startJourney,
} from "./job.service.js";
import { createMechanicReviewOfFleet } from "../review/review.service.js";

const parseJsonIfString = (value, fieldName) => {
  if (value === undefined || value === null) return value;
  if (typeof value !== "string") return value;
  const raw = value.trim();
  if (!raw) return value;
  try {
    return JSON.parse(raw);
  } catch {
    throw new AppError(`${fieldName} must be valid JSON`, 400);
  }
};

const normalizeCreateJobBody = (body = {}) => {
  const out = { ...(body || {}) };
  // When using multipart/form-data, nested objects arrive as strings.
  if (typeof out.location === "string") out.location = parseJsonIfString(out.location, "location");
  if (typeof out.availabilityWindow === "string") {
    out.availabilityWindow = parseJsonIfString(out.availabilityWindow, "availabilityWindow");
  }
  if (typeof out.photos === "string") out.photos = parseJsonIfString(out.photos, "photos");
  if (typeof out.tyreDetails === "string") {
    out.tyreDetails = parseJsonIfString(out.tyreDetails, "tyreDetails");
  }
  return out;
};

export const createJobController = async (req, res) => {
  const payload = normalizeCreateJobBody(req.body || {});

  const pickFirstNonEmptyFieldValue = (fieldName) => {
    const keys = Object.keys(req.body || {});
    const target = `${fieldName}`.toLowerCase();
    const hitKey = keys.find((k) => `${k}`.trim().toLowerCase() === target);
    if (!hitKey) return undefined;
    const v = req.body[hitKey];
    if (v === undefined || v === null) return undefined;
    const s = `${Array.isArray(v) ? v[0] : v}`.trim();
    return s || undefined;
  };

  // Multer form-data fields can sometimes arrive as non-string values depending on client.
  // Normalize the core required fields to trimmed strings for consistent validation.
  payload.title =
    pickFirstNonEmptyFieldValue("title") ??
    (payload.title !== undefined ? `${payload.title}`.trim() : undefined);
  payload.description =
    pickFirstNonEmptyFieldValue("description") ??
    pickFirstNonEmptyFieldValue("notes") ??
    (payload.description !== undefined ? `${payload.description}`.trim() : undefined);

  // Normalize enums from form-data (sometimes arrive with casing/whitespace).
  if (payload.issueType !== undefined) {
    payload.issueType = `${payload.issueType}`.trim().toUpperCase();
  }
  if (payload.urgency !== undefined) {
    payload.urgency = `${payload.urgency}`.trim().toUpperCase();
  }
  if (payload.mode !== undefined) {
    payload.mode = `${payload.mode}`.trim().toUpperCase();
  }

  // Driver details (optional UI fields).
  const dn = pickFirstNonEmptyFieldValue("driverName");
  const dp = pickFirstNonEmptyFieldValue("driverPhone");
  if (dn) payload.driverName = dn;
  if (dp) payload.driverPhone = dp;

  const incomingFiles = Array.isArray(req.files) ? req.files : [];
  const imageFiles = incomingFiles.filter(
    (f) => f && f.mimetype && `${f.mimetype}`.startsWith("image/")
  );
  const photoFiles = imageFiles.filter((f) =>
    `${f.fieldname || ""}`.toLowerCase().startsWith("photos")
  );
  const chosenFiles = (photoFiles.length ? photoFiles : imageFiles).slice(0, 5);

  if (chosenFiles.length) {
    const uploads = await Promise.all(
      chosenFiles.map((file) => uploadJobPhotoBuffer(file.buffer, file.mimetype))
    );
    const urls = uploads.map((u) => u.url).filter(Boolean);
    payload.photos = [...(Array.isArray(payload.photos) ? payload.photos : []), ...urls];
  }

  if (!payload.title || !payload.description) {
    const contentType = `${req.headers["content-type"] || ""}`.trim();
    const bodyKeys = Object.keys(req.body || {});
    const fileCount = Array.isArray(req.files) ? req.files.length : 0;
    const titlePreview = payload.title ? `${payload.title}`.slice(0, 80) : "";
    const descPreview = payload.description ? `${payload.description}`.slice(0, 80) : "";
    throw new AppError(
      `title and description are required (content-type="${contentType}", bodyKeys=[${bodyKeys.join(
        ", "
      )}], files=${fileCount}, title="${titlePreview}", description="${descPreview}")`,
      400
    );
  }

  const job = await createJob(payload, req.user);
  return sendResponse(res, {
    statusCode: 201,
    message: "Job posted successfully",
    data: job,
  });
};

export const listJobsController = async (req, res) => {
  const result = await listJobs(req.user, req.query);
  return sendResponse(res, {
    message: "Jobs fetched",
    data: result.items,
    meta: result.meta,
  });
};

export const getJobByIdController = async (req, res) => {
  const job = await getJobByIdForUser(req.params.jobId, req.user);
  return sendResponse(res, {
    message: "Job fetched",
    data: job,
  });
};

export const startJourneyController = async (req, res) => {
  const job = await startJourney(req.params.jobId, req.user);
  return sendResponse(res, {
    message: "Journey started",
    data: job,
  });
};

export const arriveAtJobController = async (req, res) => {
  const job = await arriveAtJob(req.params.jobId, req.user);
  return sendResponse(res, {
    message: "Arrived on site",
    data: job,
  });
};

export const startWorkController = async (req, res) => {
  const job = await startJobWork(req.params.jobId, req.user);
  return sendResponse(res, {
    message: "Work started",
    data: job,
  });
};

const normalizeCompletionPhotoEntries = (raw) => {
  if (!raw) return [];
  const arr = Array.isArray(raw) ? raw : [];
  return arr.map((p) => {
    if (typeof p !== "string") return p;
    const s = p.trim();
    if (s.startsWith("data:")) return { dataUrl: s };
    return { url: s };
  });
};

/**
 * PATCH /jobs/:id/work/complete — JSON or multipart/form-data.
 * Multipart: text fields + optional image files (field names `photos`, `completionPhotos`, … or any image file).
 * Repair notes: `repairNotes` or `repair_notes` (alias for `workSummary`).
 */
export const completeWorkController = async (req, res) => {
  const body = req.body && typeof req.body === "object" ? { ...req.body } : {};
  const payload = body;

  if (typeof payload.invoice === "string") {
    payload.invoice = parseJsonIfString(payload.invoice, "invoice");
  }
  if (typeof payload.attachmentItems === "string") {
    payload.attachmentItems = parseJsonIfString(payload.attachmentItems, "attachmentItems");
  }
  if (typeof payload.attachments === "string") {
    payload.attachments = parseJsonIfString(payload.attachments, "attachments");
  }
  if (typeof payload.photos === "string") {
    payload.photos = parseJsonIfString(payload.photos, "photos");
  }

  const pickTrim = (key) => {
    const v = body[key];
    if (v === undefined || v === null) return undefined;
    const s = `${Array.isArray(v) ? v[0] : v}`.trim();
    return s || undefined;
  };

  const repairNotes = pickTrim("repairNotes") ?? pickTrim("repair_notes");
  const workSummary = pickTrim("workSummary");
  payload.workSummary = workSummary || repairNotes || payload.workSummary;

  if (payload.finalAmount !== undefined && payload.finalAmount !== null && `${payload.finalAmount}`.trim() !== "") {
    payload.finalAmount = Number(payload.finalAmount);
    if (!Number.isFinite(payload.finalAmount)) {
      throw new AppError("finalAmount must be a number", 400);
    }
  }

  const incomingFiles = Array.isArray(req.files) ? req.files : [];
  const imageFiles = incomingFiles.filter((f) => f?.mimetype && `${f.mimetype}`.startsWith("image/"));
  const photoFiles = imageFiles.filter((f) =>
    /^(photos|completionphotos|repairphotos)/i.test(`${f.fieldname || ""}`)
  );
  const chosenFiles = (photoFiles.length ? photoFiles : imageFiles).slice(0, 5);

  const existingPhotos = normalizeCompletionPhotoEntries(
    Array.isArray(payload.photos) ? payload.photos : []
  );

  if (chosenFiles.length) {
    const uploads = await Promise.all(
      chosenFiles.map((file) => uploadJobPhotoBuffer(file.buffer, file.mimetype))
    );
    const urls = uploads.map((u) => u.url).filter(Boolean);
    payload.photos = [...existingPhotos, ...urls.map((url) => ({ url }))];
  } else if (existingPhotos.length) {
    payload.photos = existingPhotos;
  }

  const raw = await completeJobWork(req.params.jobId, req.user, payload);
  const completionInvoice = raw?.completionInvoice;
  const detail = await getJobByIdForUser(req.params.jobId, req.user);
  return sendResponse(res, {
    message: "Work completed and awaiting approval",
    data: {
      ...detail,
      ...(completionInvoice ? { completionInvoice } : {}),
    },
  });
};

export const approveCompletionController = async (req, res) => {
  const data =
    req.user.role === ROLES.COMPANY
      ? await approveJobCompletionAsCompany(req.params.jobId, req.user, req.body)
      : await approveJobCompletion(req.params.jobId, req.user, req.body);
  return sendResponse(res, {
    message: "Job approved and completed",
    data,
  });
};

export const cancelJobController = async (req, res) => {
  const result = await cancelJob(req.params.jobId, req.user, req.body);
  return sendResponse(res, {
    message: "Job cancelled",
    data: result,
  });
};

export const previewJobCancellationController = async (req, res) => {
  const data = await previewJobCancellation(req.params.jobId, req.user);
  return sendResponse(res, {
    message: "Cancellation preview",
    data,
  });
};

export const jobTimelineController = async (req, res) => {
  const timeline = await getJobTimeline(req.params.jobId, req.user);
  return sendResponse(res, {
    message: "Job timeline fetched",
    data: timeline,
  });
};

export const jobLocationPingController = async (req, res) => {
  const result = await createJobLocationPing(req.params.jobId, req.user, req.body);
  return sendResponse(res, {
    message: "Location ping recorded",
    data: result,
  });
};

export const addJobPhotosController = async (req, res) => {
  const result = await addJobPhotos(req.params.jobId, req.user, req.body);
  return sendResponse(res, {
    statusCode: 201,
    message: "Job photos uploaded",
    data: result,
  });
};

export const removeJobPhotoController = async (req, res) => {
  const result = await removeJobPhoto(req.params.jobId, req.user, req.body);
  return sendResponse(res, {
    message: "Job photo removed",
    data: result,
  });
};

export const addJobAttachmentsController = async (req, res) => {
  const result = await addJobAttachments(req.params.jobId, req.user, req.body);
  return sendResponse(res, {
    statusCode: 201,
    message: "Job attachments added",
    data: result,
  });
};

export const removeJobAttachmentController = async (req, res) => {
  const result = await removeJobAttachment(
    req.params.jobId,
    req.user,
    req.params.attachmentId
  );
  return sendResponse(res, {
    message: "Job attachment removed",
    data: result,
  });
};

export const createMechanicReviewOfFleetController = async (req, res) => {
  const review = await createMechanicReviewOfFleet(
    req.user,
    req.params.jobId,
    req.body
  );
  return sendResponse(res, {
    statusCode: 201,
    message: "Fleet review created",
    data: review,
  });
};

