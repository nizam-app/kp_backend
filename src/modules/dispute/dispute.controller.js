import { sendResponse } from "../../utils/sendResponse.js";
import {
  addDisputeMessage,
  assignDispute,
  createParticipantDispute,
  decideDispute,
  executeDisputeFinancialAction,
  approveDisputeFinancialAction,
  escalateSupportTicketToDispute,
  getDisputeDetail,
  listDisputesForUser,
  listEligibleDisputeJobs,
  requestDisputeAppeal,
  transitionDispute,
  uploadDisputeEvidence,
  downloadDisputeEvidence,
  reviewDisputeEvidence,
} from "./dispute.service.js";

export const createDisputeController = async (req, res) =>
  sendResponse(res, {
    statusCode: 201,
    message: "Dispute created",
    data: await createParticipantDispute(req.user, req.body),
  });

export const listDisputesController = async (req, res) => {
  const result = await listDisputesForUser(req.user, req.query);
  return sendResponse(res, {
    message: "Disputes fetched",
    data: result.items,
    meta: result.meta,
  });
};

export const listEligibleDisputeJobsController = async (req, res) =>
  sendResponse(res, {
    message: "Eligible dispute jobs fetched",
    data: await listEligibleDisputeJobs(req.user),
  });

export const getDisputeController = async (req, res) =>
  sendResponse(res, {
    message: "Dispute fetched",
    data: await getDisputeDetail(req.user, req.params.disputeId),
  });

export const addDisputeMessageController = async (req, res) =>
  sendResponse(res, {
    statusCode: 201,
    message: req.body.internal ? "Internal note added" : "Message added",
    data: await addDisputeMessage(req.user, req.params.disputeId, req.body),
  });

export const addDisputeEvidenceController = async (req, res) =>
  sendResponse(res, {
    statusCode: 201,
    message: "Evidence uploaded",
    data: await uploadDisputeEvidence(
      req.user,
      req.params.disputeId,
      req.file,
      req.body
    ),
  });

export const downloadDisputeEvidenceController = async (req, res) => {
  const result = await downloadDisputeEvidence(
    req.user,
    req.params.disputeId,
    req.params.evidenceId
  );
  if (result.location.kind === "redirect") return res.redirect(result.location.url);
  return res.download(result.location.path, result.evidence.originalName);
};

export const reviewDisputeEvidenceController = async (req, res) =>
  sendResponse(res, {
    message: "Evidence security status updated",
    data: await reviewDisputeEvidence(
      req.user,
      req.params.disputeId,
      req.params.evidenceId,
      req.body
    ),
  });

export const appealDisputeController = async (req, res) =>
  sendResponse(res, {
    message: "Appeal requested",
    data: await requestDisputeAppeal(req.user, req.params.disputeId, req.body),
  });

export const assignDisputeController = async (req, res) =>
  sendResponse(res, {
    message: "Dispute assigned",
    data: await assignDispute(req.user, req.params.disputeId, req.body),
  });

export const transitionDisputeController = async (req, res) =>
  sendResponse(res, {
    message: "Dispute status updated",
    data: await transitionDispute(req.user, req.params.disputeId, req.body),
  });

export const decideDisputeController = async (req, res) =>
  sendResponse(res, {
    message: "Dispute decision recorded",
    data: await decideDispute(req.user, req.params.disputeId, req.body),
  });

export const executeDisputeFinancialController = async (req, res) =>
  sendResponse(res, {
    message: "Financial action processed",
    data: await executeDisputeFinancialAction(
      req.user,
      req.params.disputeId,
      req.params.actionId
    ),
  });

export const approveDisputeFinancialController = async (req, res) =>
  sendResponse(res, {
    message: "Financial action approved and processed",
    data: await approveDisputeFinancialAction(
      req.user,
      req.params.disputeId,
      req.params.actionId
    ),
  });

export const escalateSupportController = async (req, res) =>
  sendResponse(res, {
    statusCode: 201,
    message: "Support ticket escalated",
    data: await escalateSupportTicketToDispute(req.user, req.params.ticketId, req.body),
  });

// Existing route/controller compatibility.
export const createFleetDisputeController = createDisputeController;
export const listFleetDisputesController = listDisputesController;
export const listMechanicDisputesController = listDisputesController;
export const getMechanicDisputeByIdController = getDisputeController;
export const updateFleetDisputeController = addDisputeMessageController;
export const updateMechanicDisputeController = addDisputeMessageController;
