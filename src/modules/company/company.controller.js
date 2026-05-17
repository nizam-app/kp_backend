import { sendResponse } from "../../utils/sendResponse.js";
import {
  assignMechanicToCompanyJob,
  cancelCompanyInvite,
  createCompanyInvite,
  getCompanyDashboard,
  getCompanyEarningsSummary,
  getCompanyFeed,
  getCompanyFeedSummary,
  getCompanyQuotes,
  getCompanyJobById,
  getCompanyJobs,
  getCompanyTeam,
  getCompanyTeamMemberById,
  removeCompanyTeamMember,
  listCompanyEarningJobs,
} from "./company.service.js";
import { approveJobCompletionAsCompany } from "../job/job.service.js";

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

export const companyFeedSummaryController = async (req, res) => {
  const data = await getCompanyFeedSummary(req.user, req.query);
  return sendResponse(res, {
    message: "Company feed summary fetched",
    data,
  });
};

export const companyQuotesController = async (req, res) => {
  const result = await getCompanyQuotes(req.user, req.query);
  return sendResponse(res, {
    message: "Company quotes fetched",
    data: result.items,
    meta: result.meta,
  });
};

export const companyJobsController = async (req, res) => {
  const result = await getCompanyJobs(req.user, req.query);
  return sendResponse(res, {
    message: "Company jobs fetched",
    data: result.items,
    meta: {
      ...result.meta,
      summary: result.summary,
    },
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

/** Approve mechanic completion & mark job completed (company dispatcher). */
export const companyApproveJobCompletionController = async (req, res) => {
  const result = await approveJobCompletionAsCompany(req.params.jobId, req.user, req.body);
  return sendResponse(res, {
    message: "Job approved and completed",
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

export const companyTeamMemberByIdController = async (req, res) => {
  const result = await getCompanyTeamMemberById(req.params.mechanicId, req.user);
  return sendResponse(res, {
    message: "Company team member fetched",
    data: result,
  });
};

export const companyRemoveTeamMemberController = async (req, res) => {
  const result = await removeCompanyTeamMember(req.params.mechanicId, req.user);
  return sendResponse(res, {
    message: "Team member removed from company",
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
