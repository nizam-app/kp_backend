import { sendResponse } from "../../utils/sendResponse.js";
import {
  createFleetDispute,
  listMechanicDisputes,
  listFleetDisputes,
  updateMechanicDispute,
  updateFleetDispute,
} from "./dispute.service.js";

export const createFleetDisputeController = async (req, res) => {
  const dispute = await createFleetDispute(req.user, req.body);
  return sendResponse(res, {
    statusCode: 201,
    message: "Dispute created",
    data: dispute,
  });
};

export const listFleetDisputesController = async (req, res) => {
  const result = await listFleetDisputes(req.user, req.query);
  return sendResponse(res, {
    message: "Disputes fetched",
    data: result.items,
    meta: result.meta,
  });
};

export const updateFleetDisputeController = async (req, res) => {
  const dispute = await updateFleetDispute(req.user, req.params.disputeId, req.body);
  return sendResponse(res, {
    message: "Dispute updated",
    data: dispute,
  });
};

export const listMechanicDisputesController = async (req, res) => {
  const result = await listMechanicDisputes(req.user, req.query);
  return sendResponse(res, {
    message: "Mechanic disputes fetched",
    data: result.items,
    meta: result.meta,
  });
};

export const updateMechanicDisputeController = async (req, res) => {
  const dispute = await updateMechanicDispute(req.user, req.params.disputeId, req.body);
  return sendResponse(res, {
    message: "Mechanic dispute updated",
    data: dispute,
  });
};
