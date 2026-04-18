import { sendResponse } from "../../utils/sendResponse.js";
import {
  assignMechanicToCompanyJob,
  cancelCompanyInvite,
  createCompanyInvite,
  getCompanyDashboard,
  getCompanyEarningsSummary,
  getCompanyFeed,
  getCompanyJobById,
  getCompanyJobs,
  getCompanyTeam,
  listCompanyEarningJobs,
} from "./company.service.js";

export const companyDashboardController = async (req, res) => {
  const result = await getCompanyDashboard(req.user);
  return sendResponse(res, {
    message: "Company dashboard fetched",
    data: result,
  });
};

export const companyFeedController = async (req, res) => {
  const result = await getCompanyFeed(req.user, req.query);
  return sendResponse(res, {
    message: "Company feed fetched",
    data: result.items,
    meta: result.meta,
  });
};

export const companyJobsController = async (req, res) => {
  const result = await getCompanyJobs(req.user, req.query);
  return sendResponse(res, {
    message: "Company jobs fetched",
    data: result.items,
    meta: result.meta,
    extra: { summary: result.summary },
  });
};

export const companyJobByIdController = async (req, res) => {
  const result = await getCompanyJobById(req.params.jobId, req.user);
  return sendResponse(res, {
    message: "Company job fetched",
    data: result,
  });
};

export const companyAssignMechanicController = async (req, res) => {
  const result = await assignMechanicToCompanyJob(
    req.params.jobId,
    req.body.mechanicId,
    req.user
  );
  return sendResponse(res, {
    message: "Mechanic assigned to company job",
    data: result,
  });
};

export const companyTeamController = async (req, res) => {
  const result = await getCompanyTeam(req.user);
  return sendResponse(res, {
    message: "Company team fetched",
    data: result,
  });
};

export const companyCreateInviteController = async (req, res) => {
  const result = await createCompanyInvite(req.user, req.body);
  return sendResponse(res, {
    statusCode: 201,
    message: "Company invite created",
    data: result,
  });
};

export const companyCancelInviteController = async (req, res) => {
  const result = await cancelCompanyInvite(req.params.inviteId, req.user);
  return sendResponse(res, {
    message: "Company invite cancelled",
    data: result,
  });
};

export const companyEarningsSummaryController = async (req, res) => {
  const result = await getCompanyEarningsSummary(req.user);
  return sendResponse(res, {
    message: "Company earnings summary fetched",
    data: result,
  });
};

export const companyEarningJobsController = async (req, res) => {
  const result = await listCompanyEarningJobs(req.user, req.query);
  return sendResponse(res, {
    message: "Company earning jobs fetched",
    data: result.items,
    meta: result.meta,
  });
};
