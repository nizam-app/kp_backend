import { sendResponse } from "../../utils/sendResponse.js";
import {
  approveJobCompletion,
  arriveAtJob,
  cancelJob,
  completeJobWork,
  createJob,
  getJobByIdForUser,
  listJobs,
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
