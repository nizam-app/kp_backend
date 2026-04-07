import { sendResponse } from "../../utils/sendResponse.js";
import {
  attachStripeCardPaymentMethod,
  createPaymentMethod,
  createStripeSetupIntentForUser,
  getStripeBillingConfig,
  handleStripeWebhook,
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

export const stripeBillingConfigController = async (_req, res) => {
  const config = await getStripeBillingConfig();
  return sendResponse(res, {
    message: "Stripe billing config fetched",
    data: config,
  });
};

export const createStripeSetupIntentController = async (req, res) => {
  const setupIntent = await createStripeSetupIntentForUser(req.user);
  return sendResponse(res, {
    message: "Stripe setup intent created",
    data: setupIntent,
  });
};

export const attachStripePaymentMethodController = async (req, res) => {
  const method = await attachStripeCardPaymentMethod(req.user, req.body);
  return sendResponse(res, {
    statusCode: 201,
    message: "Stripe payment method attached",
    data: method,
  });
};

export const stripeWebhookController = async (req, res) => {
  const result = await handleStripeWebhook(
    req.body,
    req.headers["stripe-signature"]
  );
  return sendResponse(res, {
    message: "Stripe webhook processed",
    data: result,
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
