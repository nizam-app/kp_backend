import { sendResponse } from "../../utils/sendResponse.js";
import {
  createPaymentMethod,
  listPaymentMethods,
  removePaymentMethod,
  setDefaultPaymentMethod,
} from "./billing.service.js";

export const listPaymentMethodsController = async (req, res) => {
  const methods = await listPaymentMethods(req.user);
  return sendResponse(res, {
    message: "Payment methods fetched",
    data: methods,
  });
};

export const createPaymentMethodController = async (req, res) => {
  const method = await createPaymentMethod(req.user, req.body);
  return sendResponse(res, {
    statusCode: 201,
    message: "Payment method added",
    data: method,
  });
};

export const setDefaultPaymentMethodController = async (req, res) => {
  const method = await setDefaultPaymentMethod(req.user, req.params.methodId);
  return sendResponse(res, {
    message: "Default payment method updated",
    data: method,
  });
};

export const removePaymentMethodController = async (req, res) => {
  const result = await removePaymentMethod(req.user, req.params.methodId);
  return sendResponse(res, {
    message: result.message,
  });
};
