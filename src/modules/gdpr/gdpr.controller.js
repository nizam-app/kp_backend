import { sendResponse } from "../../utils/sendResponse.js";
import {
  eraseUserGdprData,
  exportUserGdprData,
  getDataRetentionPolicy,
} from "./gdpr.service.js";

export const gdprRetentionPolicyController = async (_req, res) => {
  return sendResponse(res, {
    message: "Data retention policy fetched",
    data: getDataRetentionPolicy(),
  });
};

export const gdprExportUserDataController = async (req, res) => {
  const result = await exportUserGdprData(req.user, req.params.userId);
  return sendResponse(res, {
    message: "GDPR data report generated",
    data: result,
  });
};

export const gdprEraseUserDataController = async (req, res) => {
  const result = await eraseUserGdprData(req.user, req.params.userId, req.body);
  return sendResponse(res, {
    message: "GDPR erasure completed",
    data: result,
  });
};
