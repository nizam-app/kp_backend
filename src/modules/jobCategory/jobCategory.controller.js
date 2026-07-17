import { sendResponse } from "../../utils/sendResponse.js";
import {
  createJobCategory,
  deleteJobCategory,
  listJobCategories,
  updateJobCategory,
} from "./jobCategory.service.js";

export const listActiveJobCategoriesController = async (_req, res) => {
  const items = await listJobCategories();
  return sendResponse(res, {
    message: "Job categories fetched",
    data: { items },
  });
};

export const listAdminJobCategoriesController = async (_req, res) => {
  const items = await listJobCategories({ includeInactive: true });
  return sendResponse(res, {
    message: "Admin job categories fetched",
    data: { items },
  });
};

export const createAdminJobCategoryController = async (req, res) => {
  const result = await createJobCategory(req.body);
  return sendResponse(res, {
    statusCode: 201,
    message: "Job category created",
    data: result,
  });
};

export const updateAdminJobCategoryController = async (req, res) => {
  const result = await updateJobCategory(req.params.categoryId, req.body);
  return sendResponse(res, {
    message: "Job category updated",
    data: result,
  });
};

export const deleteAdminJobCategoryController = async (req, res) => {
  const result = await deleteJobCategory(req.params.categoryId);
  return sendResponse(res, {
    message: "Job category deleted",
    data: result,
  });
};
