import { sendResponse } from "../../utils/sendResponse.js";
import {
  createFleetReview,
  listFleetReviews,
  listMechanicReviews,
} from "./review.service.js";

export const createFleetReviewController = async (req, res) => {
  const review = await createFleetReview(req.user, req.body);
  return sendResponse(res, {
    statusCode: 201,
    message: "Review created",
    data: review,
  });
};

export const listFleetReviewsController = async (req, res) => {
  const result = await listFleetReviews(req.user, req.query);
  return sendResponse(res, {
    message: "Reviews fetched",
    data: result.items,
    meta: result.meta,
  });
};

export const listMechanicReviewsController = async (req, res) => {
  const result = await listMechanicReviews(req.user, req.query);
  return sendResponse(res, {
    message: "Mechanic reviews fetched",
    data: result.items,
    meta: result.meta,
  });
};
