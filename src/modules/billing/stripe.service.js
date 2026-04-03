import { env } from "../../config/env.js";
import AppError from "../../utils/AppError.js";
import { User } from "../user/user.model.js";

const STRIPE_API_BASE = "https://api.stripe.com/v1";

const ensureStripeConfigured = () => {
  if (!env.STRIPE_SECRET_KEY) {
    throw new AppError("Stripe is not configured on the server", 400);
  }
};

const appendFormValue = (searchParams, key, value) => {
  if (value === undefined || value === null || value === "") return;

  if (Array.isArray(value)) {
    value.forEach((item) => appendFormValue(searchParams, `${key}[]`, item));
    return;
  }

  if (typeof value === "object") {
    Object.entries(value).forEach(([childKey, childValue]) => {
      appendFormValue(searchParams, `${key}[${childKey}]`, childValue);
    });
    return;
  }

  searchParams.append(key, `${value}`);
};

const stripeRequest = async (path, { method = "GET", body } = {}) => {
  ensureStripeConfigured();

  const headers = {
    Authorization: `Bearer ${env.STRIPE_SECRET_KEY}`,
  };

  const requestInit = { method, headers };

  if (body) {
    const params = new URLSearchParams();
    Object.entries(body).forEach(([key, value]) => appendFormValue(params, key, value));
    headers["Content-Type"] = "application/x-www-form-urlencoded";
    requestInit.body = params.toString();
  }

  const response = await fetch(`${STRIPE_API_BASE}${path}`, requestInit);
  const json = await response.json();

  if (!response.ok) {
    throw new AppError(
      json?.error?.message || "Stripe request failed",
      response.status >= 400 && response.status < 500 ? 400 : 502
    );
  }

  return json;
};

const getStripeCustomerId = (user) =>
  user.role === "FLEET"
    ? user.fleetProfile?.stripeCustomerId || null
    : null;

export const ensureStripeCustomerForUser = async (user) => {
  if (user.role !== "FLEET") {
    throw new AppError("Stripe customer setup is only available for fleet users", 400);
  }

  const existingCustomerId = getStripeCustomerId(user);
  if (existingCustomerId) return existingCustomerId;

  const customer = await stripeRequest("/customers", {
    method: "POST",
    body: {
      email: user.email,
      name: user.fleetProfile?.companyName || user.fleetProfile?.contactName || user.email,
      phone: user.fleetProfile?.phone || undefined,
      address: user.fleetProfile?.billingAddress
        ? {
            line1: user.fleetProfile.billingAddress,
          }
        : undefined,
      metadata: {
        userId: user._id.toString(),
        role: user.role,
      },
    },
  });

  await User.updateOne(
    { _id: user._id },
    { $set: { "fleetProfile.stripeCustomerId": customer.id } }
  );

  return customer.id;
};

export const getStripePublicConfig = () => ({
  enabled: Boolean(env.STRIPE_SECRET_KEY && env.STRIPE_PUBLISHABLE_KEY),
  publishableKey: env.STRIPE_PUBLISHABLE_KEY || null,
});

export const createStripeSetupIntent = async (user) => {
  const customerId = await ensureStripeCustomerForUser(user);

  const setupIntent = await stripeRequest("/setup_intents", {
    method: "POST",
    body: {
      customer: customerId,
      usage: "off_session",
      payment_method_types: ["card"],
      metadata: {
        userId: user._id.toString(),
        role: user.role,
      },
    },
  });

  return {
    customerId,
    setupIntentId: setupIntent.id,
    clientSecret: setupIntent.client_secret,
    status: setupIntent.status,
  };
};

export const retrieveStripePaymentMethod = async (paymentMethodId) =>
  stripeRequest(`/payment_methods/${paymentMethodId}`);

export const attachStripePaymentMethodToCustomer = async ({
  customerId,
  paymentMethodId,
}) =>
  stripeRequest(`/payment_methods/${paymentMethodId}/attach`, {
    method: "POST",
    body: { customer: customerId },
  });

export const createStripePaymentIntent = async ({
  amount,
  currency = "GBP",
  customerId,
  paymentMethodId,
  metadata = {},
}) => {
  const amountInMinor = Math.round(Number(amount || 0) * 100);
  if (!Number.isFinite(amountInMinor) || amountInMinor <= 0) {
    throw new AppError("Stripe payment amount must be greater than zero", 400);
  }

  return stripeRequest("/payment_intents", {
    method: "POST",
    body: {
      amount: amountInMinor,
      currency: `${currency}`.toLowerCase(),
      customer: customerId,
      payment_method: paymentMethodId,
      confirm: true,
      off_session: true,
      metadata,
    },
  });
};

