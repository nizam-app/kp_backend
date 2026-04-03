import AppError from "../../utils/AppError.js";
import { PaymentMethod } from "./paymentMethod.model.js";
import {
  attachStripePaymentMethodToCustomer,
  createStripeSetupIntent,
  ensureStripeCustomerForUser,
  getStripePublicConfig,
  retrieveStripePaymentMethod,
} from "./stripe.service.js";

const methodTypeValues = ["CARD", "BANK_ACCOUNT"];

const maskLast4 = (value) => {
  const digits = `${value || ""}`.replace(/\D/g, "");
  return digits.slice(-4) || null;
};

const maskAccount = (value) => {
  const last4 = maskLast4(value);
  return last4 ? `**** **** ${last4}` : null;
};

const maskSortCode = (value) => {
  const digits = `${value || ""}`.replace(/\D/g, "");
  if (digits.length < 6) return `${value || ""}`.trim() || null;
  return `${digits.slice(0, 2)}-${digits.slice(2, 4)}-${digits.slice(4, 6)}`;
};

const toPaymentMethodResponse = (method) => ({
  _id: method._id,
  methodType: method.methodType,
  ownerType: method.ownerType,
  provider: method.provider,
  providerMethodId: method.providerMethodId,
  providerCustomerId: method.providerCustomerId || null,
  card: method.card || null,
  bank: method.bank || null,
  billingAddress: method.billingAddress || null,
  setupIntentId: method.setupIntentId || null,
  isDefault: method.isDefault,
  isActive: method.isActive,
  createdAt: method.createdAt,
  updatedAt: method.updatedAt,
  displayLabel:
    method.methodType === "CARD"
      ? `${method.card?.brand || "CARD"} **** ${method.card?.last4 || ""}`.trim()
      : `${method.bank?.bankName || "Bank"} ${method.bank?.accountMasked || ""}`.trim(),
});

const normalizeCardPayload = (payload) => {
  if (`${payload.provider || "MANUAL"}`.trim() === "STRIPE") {
    return {
      card: {
        brand: `${payload.card?.brand || "CARD"}`.trim(),
        last4: `${payload.card?.last4 || ""}`.trim(),
        expMonth: Number(payload.card?.expMonth) || undefined,
        expYear: Number(payload.card?.expYear) || undefined,
        fingerprint: `${payload.card?.fingerprint || ""}`.trim() || undefined,
      },
      bank: undefined,
    };
  }

  if (!payload.card?.last4 && !payload.cardNumber) {
    throw new AppError("card.last4 or cardNumber is required for cards", 400);
  }

  return {
    card: {
      brand: `${payload.card?.brand || payload.brand || "CARD"}`.trim(),
      last4: `${payload.card?.last4 || maskLast4(payload.cardNumber) || ""}`.trim(),
      expMonth: Number(payload.card?.expMonth || payload.expMonth) || undefined,
      expYear: Number(payload.card?.expYear || payload.expYear) || undefined,
    },
    bank: undefined,
  };
};

const normalizeBankPayload = (payload) => {
  const accountMasked =
    payload.bank?.accountMasked || maskAccount(payload.accountNumber);
  if (!accountMasked) {
    throw new AppError(
      "bank.accountMasked or accountNumber is required for bank accounts",
      400
    );
  }

  return {
    card: undefined,
    bank: {
      bankName: `${payload.bank?.bankName || payload.bankName || ""}`.trim(),
      accountMasked,
      sortCodeMasked:
        payload.bank?.sortCodeMasked || maskSortCode(payload.sortCode),
    },
  };
};

const ensureRelatedPaymentMethod = async (methodId, userId) => {
  const method = await PaymentMethod.findOne({
    _id: methodId,
    user: userId,
    isActive: true,
  });
  if (!method) throw new AppError("Payment method not found", 404);
  return method;
};

export const listPaymentMethods = async (user) => {
  const methods = await PaymentMethod.find({
    user: user._id,
    isActive: true,
  })
    .sort({ isDefault: -1, createdAt: -1 })
    .lean();

  return methods.map(toPaymentMethodResponse);
};

export const createPaymentMethod = async (user, payload = {}) => {
  const methodType = `${payload.methodType || ""}`.trim();
  if (!methodTypeValues.includes(methodType)) {
    throw new AppError(
      `methodType must be one of ${methodTypeValues.join(", ")}`,
      400
    );
  }

  const providerMethodId = `${payload.providerMethodId || ""}`.trim();
  if (!providerMethodId) {
    throw new AppError("providerMethodId is required", 400);
  }

  const ownerType = user.role;
  const provider = `${payload.provider || "MANUAL"}`.trim();
  const normalizedPayload =
    methodType === "CARD"
      ? normalizeCardPayload(payload)
      : normalizeBankPayload(payload);

  const alreadyExists = await PaymentMethod.findOne({
    provider,
    providerMethodId,
  });
  if (alreadyExists) {
    throw new AppError("Payment method already exists", 409);
  }

  const hasAnyActiveMethod = await PaymentMethod.exists({
    user: user._id,
    isActive: true,
  });
  const isDefault = payload.isDefault === true || !hasAnyActiveMethod;

  if (isDefault) {
    await PaymentMethod.updateMany(
      { user: user._id, isActive: true },
      { $set: { isDefault: false } }
    );
  }

  const created = await PaymentMethod.create({
    user: user._id,
    ownerType,
    methodType,
    provider,
    providerMethodId,
    providerCustomerId: payload.providerCustomerId || undefined,
    billingAddress: `${payload.billingAddress || ""}`.trim() || undefined,
    setupIntentId: payload.setupIntentId || undefined,
    isDefault,
    ...normalizedPayload,
  });

  return toPaymentMethodResponse(created);
};

export const getStripeBillingConfig = async () => getStripePublicConfig();

export const createStripeSetupIntentForUser = async (user) => {
  const result = await createStripeSetupIntent(user);
  return {
    ...result,
    ...getStripePublicConfig(),
  };
};

export const attachStripeCardPaymentMethod = async (user, payload = {}) => {
  if (user.role !== "FLEET") {
    throw new AppError("Only fleet users can attach Stripe card methods", 400);
  }

  const paymentMethodId = `${payload.paymentMethodId || payload.providerMethodId || ""}`.trim();
  if (!paymentMethodId) {
    throw new AppError("paymentMethodId is required", 400);
  }

  const customerId = await ensureStripeCustomerForUser(user);
  const attachedPaymentMethod = await attachStripePaymentMethodToCustomer({
    customerId,
    paymentMethodId,
  });

  const stripePaymentMethod = await retrieveStripePaymentMethod(attachedPaymentMethod.id);

  return createPaymentMethod(user, {
    methodType: "CARD",
    provider: "STRIPE",
    providerMethodId: stripePaymentMethod.id,
    providerCustomerId: customerId,
    setupIntentId: `${payload.setupIntentId || ""}`.trim() || undefined,
    billingAddress:
      `${payload.billingAddress || user.fleetProfile?.billingAddress || ""}`.trim() ||
      undefined,
    isDefault: payload.isDefault !== false,
    card: {
      brand: stripePaymentMethod.card?.brand || "CARD",
      last4: stripePaymentMethod.card?.last4 || "",
      expMonth: stripePaymentMethod.card?.exp_month || undefined,
      expYear: stripePaymentMethod.card?.exp_year || undefined,
      fingerprint: stripePaymentMethod.card?.fingerprint || undefined,
    },
  });
};

export const setDefaultPaymentMethod = async (user, methodId) => {
  const method = await ensureRelatedPaymentMethod(methodId, user._id);

  await PaymentMethod.updateMany(
    { user: user._id, isActive: true },
    { $set: { isDefault: false } }
  );

  method.isDefault = true;
  await method.save({ validateBeforeSave: false });

  return toPaymentMethodResponse(method);
};

export const removePaymentMethod = async (user, methodId) => {
  const method = await ensureRelatedPaymentMethod(methodId, user._id);
  method.isActive = false;
  method.isDefault = false;
  await method.save({ validateBeforeSave: false });

  const nextDefault = await PaymentMethod.findOne({
    user: user._id,
    isActive: true,
  }).sort({ createdAt: -1 });

  if (nextDefault) {
    nextDefault.isDefault = true;
    await nextDefault.save({ validateBeforeSave: false });
  }

  return { message: "Payment method removed" };
};
