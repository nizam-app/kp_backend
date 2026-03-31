import { sendResponse } from "../../utils/sendResponse.js";
import {
  approveMechanic,
  listMechanicReviewQueue,
  rejectMechanic,
  updateUserStatus,
} from "./admin.service.js";

export const mechanicReviewQueueController = async (req, res) => {
  const result = await listMechanicReviewQueue(req.query);
  return sendResponse(res, {
    message: "Mechanic review queue fetched",
    data: result.items,
    meta: result.meta,
  });
};

export const approveMechanicController = async (req, res) => {
  const result = await approveMechanic(req.params.userId, req.body);
  return sendResponse(res, {
    message: "Mechanic approved",
    data: result,
  });
};

export const rejectMechanicController = async (req, res) => {
  const result = await rejectMechanic(req.params.userId, req.body);
  return sendResponse(res, {
    message: "Mechanic rejected",
    data: result,
  });
};

export const updateUserStatusController = async (req, res) => {
  const result = await updateUserStatus(req.params.userId, req.body);
  return sendResponse(res, {
    message: "User status updated",
    data: result,
  });
};
