import { sendResponse } from "../../utils/sendResponse.js";
import {
  addJobPhotos,
  addJobAttachments,
  approveJobCompletion,
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

export const createJobController = async (req, res) => {
  const job = await createJob(req.body, req.user);
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

export const completeWorkController = async (req, res) => {
  const job = await completeJobWork(req.params.jobId, req.user, req.body);
  return sendResponse(res, {
    message: "Work completed and awaiting approval",
    data: job,
  });
};

export const approveCompletionController = async (req, res) => {
  const job = await approveJobCompletion(req.params.jobId, req.user, req.body);
  return sendResponse(res, {
    message: "Job approved and completed",
    data: job,
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

