import { sendResponse } from "../../utils/sendResponse.js";
import {
  getEarningsSummary,
  getEarningsStatement,
  getPayoutInfo,
  listEarningJobs,
} from "./earning.service.js";

export const earningSummaryController = async (req, res) => {
  const result = await getEarningsSummary(req.user);
  return sendResponse(res, {
    message: "Earnings summary fetched",
    data: result,
  });
};

export const earningJobsController = async (req, res) => {
  const result = await listEarningJobs(req.user, req.query);
  return sendResponse(res, {
    message: "Earning jobs fetched",
    data: result.items,
    meta: result.meta,
  });
};

export const earningPayoutInfoController = async (req, res) => {
  const data = await getPayoutInfo(req.user);
  return sendResponse(res, {
    message: "Payout info fetched",
    data,
  });
};

export const earningStatementController = async (req, res) => {
  const data = await getEarningsStatement(req.user, req.query);
  return sendResponse(res, {
    message: "Earnings statement",
    data,
  });
};
