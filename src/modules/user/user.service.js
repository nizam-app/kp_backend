import AppError from "../../utils/AppError.js";
import { User } from "./user.model.js";
import { PaymentMethod } from "../billing/paymentMethod.model.js";
import {
  MECHANIC_AVAILABILITY,
  mechanicAvailabilityValues,
} from "../../constants/domain.js";

const filterObject = (payload, allowedFields) =>
  Object.fromEntries(
    Object.entries(payload).filter(([key, value]) => {
      if (!allowedFields.includes(key)) return false;
      return value !== undefined;
    })
  );

const parseBoolean = (value) => {
  if (value === undefined) return undefined;
  return Boolean(value);
};

const normalizeEmail = (value) => `${value || ""}`.trim().toLowerCase();

const normalizePoint = (value) => {
  if (!value) return undefined;

  if (Array.isArray(value.coordinates) && value.coordinates.length === 2) {
    const [lng, lat] = value.coordinates.map(Number);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
      throw new AppError("lastKnownLocation.coordinates must be [lng, lat]", 400);
    }

    return {
      type: "Point",
      coordinates: [lng, lat],
      updatedAt: value.updatedAt ? new Date(value.updatedAt) : new Date(),
    };
  }

  const lat = Number(value.lat);
  const lng = Number(value.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    throw new AppError("lastKnownLocation requires lat and lng", 400);
  }

  return {
    type: "Point",
    coordinates: [lng, lat],
    updatedAt: value.updatedAt ? new Date(value.updatedAt) : new Date(),
  };
};

const maskCardLabel = (method) => {
  if (!method?.card?.last4) return null;
  const brand = method.card.brand || "CARD";
  const last4 = method.card.last4;
  return `${brand} •••• ${last4}`;
};

const buildFleetCompletion = (user, defaultPaymentMethod) => {
  const fleetProfile = user.fleetProfile || {};
  const companyDetailsComplete = Boolean(
    fleetProfile.companyName && fleetProfile.regNumber && fleetProfile.vatNumber
  );
  const contactPersonComplete = Boolean(
    fleetProfile.contactName &&
      fleetProfile.contactRole &&
      fleetProfile.phone &&
      user.email
  );
  const billingPaymentComplete = Boolean(
    defaultPaymentMethod && fleetProfile.billingAddress
  );

  const items = [
    {
      key: "companyDetails",
      label: "Company Details",
      complete: companyDetailsComplete,
      fields: ["companyName", "regNumber", "vatNumber"],
    },
    {
      key: "contactPerson",
      label: "Contact Person",
      complete: contactPersonComplete,
      fields: ["contactName", "contactRole", "phone", "email"],
    },
    {
      key: "billingPayment",
      label: "Billing & Payment",
      complete: billingPaymentComplete,
      fields: ["billingAddress", "defaultPaymentMethod"],
    },
  ];

  const completeCount = items.filter((item) => item.complete).length;

  return {
    percentage: Math.round((completeCount / items.length) * 100),
    isComplete: completeCount === items.length,
    items,
    missing: items.filter((item) => !item.complete).map((item) => item.label),
  };
};

const buildMechanicCompletion = (user, defaultPaymentMethod) => {
  const mechanicProfile = user.mechanicProfile || {};
  const identityComplete = Boolean(
    mechanicProfile.displayName && mechanicProfile.phone && user.email
  );
  const ratesCoverageComplete = Boolean(
    Number.isFinite(mechanicProfile.hourlyRate) &&
      Number.isFinite(mechanicProfile.emergencyRate) &&
      Number.isFinite(mechanicProfile.callOutFee) &&
      Number.isFinite(mechanicProfile.serviceRadiusMiles) &&
      mechanicProfile.baseLocationText
  );
  const payoutComplete = Boolean(defaultPaymentMethod);

  const items = [
    {
      key: "identity",
      label: "Personal Details",
      complete: identityComplete,
      fields: ["displayName", "phone", "email"],
    },
    {
      key: "ratesCoverage",
      label: "Rates & Coverage",
      complete: ratesCoverageComplete,
      fields: [
        "hourlyRate",
        "emergencyRate",
        "callOutFee",
        "serviceRadiusMiles",
        "baseLocationText",
      ],
    },
    {
      key: "payout",
      label: "Bank & Billing",
      complete: payoutComplete,
      fields: ["defaultPaymentMethod"],
    },
  ];

  const completeCount = items.filter((item) => item.complete).length;

  return {
    percentage: Math.round((completeCount / items.length) * 100),
    isComplete: completeCount === items.length,
    items,
    missing: items.filter((item) => !item.complete).map((item) => item.label),
  };
};

export const getProfileCompletionSummary = async (user) => {
  const defaultPaymentMethod = await PaymentMethod.findOne({
    user: user._id,
    isDefault: true,
    isActive: true,
  }).lean();

  if (user.role === "FLEET") {
    return {
      defaultPaymentMethod,
      profileCompletion: buildFleetCompletion(user, defaultPaymentMethod),
    };
  }

  if (user.role === "MECHANIC") {
    return {
      defaultPaymentMethod,
      profileCompletion: buildMechanicCompletion(user, defaultPaymentMethod),
    };
  }

  return {
    defaultPaymentMethod,
    profileCompletion: null,
  };
};

const buildProfileResponse = async (user) => {
  const { defaultPaymentMethod, profileCompletion } =
    await getProfileCompletionSummary(user);

  const base = user.toObject();
  const response = {
    ...base,
    termsAcceptance: {
      accepted: Boolean(base.termsAcceptance?.acceptedAt),
      acceptedAt: base.termsAcceptance?.acceptedAt || null,
      version: base.termsAcceptance?.version || null,
      source: base.termsAcceptance?.source || null,
    },
    paymentSummary: defaultPaymentMethod
      ? {
          methodType: defaultPaymentMethod.methodType,
          provider: defaultPaymentMethod.provider,
          cardLabel: maskCardLabel(defaultPaymentMethod),
          bankName: defaultPaymentMethod.bank?.bankName || null,
          accountMasked: defaultPaymentMethod.bank?.accountMasked || null,
          sortCodeMasked: defaultPaymentMethod.bank?.sortCodeMasked || null,
          billingAddress:
            defaultPaymentMethod.billingAddress ||
            base.fleetProfile?.billingAddress ||
            null,
        }
      : null,
  };

  if (profileCompletion) response.profileCompletion = profileCompletion;

  return response;
};

export const findUserById = async (userId) => {
  const user = await User.findById(userId);
  if (!user) throw new AppError("User not found", 404);
  return user;
};

export const getOwnProfile = async (userId) => {
  const user = await findUserById(userId);
  return buildProfileResponse(user);
};

export const updateOwnProfile = async (user, payload) => {
  if (payload.email !== undefined) {
    const email = normalizeEmail(payload.email);
    if (!email) throw new AppError("email cannot be empty", 400);

    const duplicate = await User.findOne({
      _id: { $ne: user._id },
      email,
    });
    if (duplicate) throw new AppError("Email already in use", 409);
    user.email = email;
  }

  if (user.role === "FLEET") {
    const patch = filterObject(payload, [
      "profilePhotoUrl",
      "companyName",
      "contactName",
      "contactRole",
      "phone",
      "regNumber",
      "vatNumber",
      "fleetSize",
      "defaultAddress",
      "billingAddress",
      "profileCompleted",
    ]);
    user.fleetProfile = {
      ...(user.fleetProfile || {}),
      ...patch,
    };
  }

  if (user.role === "MECHANIC") {
    const patch = filterObject(payload, [
      "businessType",
      "displayName",
      "businessName",
      "phone",
      "baseLocationText",
      "basePostcode",
      "hourlyRate",
      "emergencyRate",
      "emergencySurcharge",
      "callOutFee",
      "callOutCharge",
      "rateCurrency",
      "serviceRadiusMiles",
      "coverageRadius",
      "skills",
      "availability",
      "lastKnownLocation",
      "profileCompleted",
      "profilePhotoUrl",
    ]);

    const normalizedPatch = {
      ...patch,
      callOutFee: patch.callOutCharge ?? patch.callOutFee,
      serviceRadiusMiles: patch.coverageRadius ?? patch.serviceRadiusMiles,
    };

    if (payload.lastKnownLocation !== undefined) {
      normalizedPatch.lastKnownLocation = normalizePoint(payload.lastKnownLocation);
    }

    delete normalizedPatch.callOutCharge;
    delete normalizedPatch.coverageRadius;

    user.mechanicProfile = {
      ...(user.mechanicProfile || {}),
      ...normalizedPatch,
    };
  }

  const { profileCompletion } = await getProfileCompletionSummary(user);
  if (user.role === "FLEET") {
    user.fleetProfile = {
      ...(user.fleetProfile || {}),
      profileCompleted: profileCompletion?.isComplete || false,
    };
  }

  if (user.role === "MECHANIC") {
    user.mechanicProfile = {
      ...(user.mechanicProfile || {}),
      profileCompleted: profileCompletion?.isComplete || false,
    };
  }

  await user.save();
  return buildProfileResponse(user);
};

export const updateMechanicAvailability = async (user, payload) => {
  if (user.role !== "MECHANIC") {
    throw new AppError("Only mechanics can update availability", 403);
  }

  const availability =
    payload.availability !== undefined ? `${payload.availability}`.trim() : undefined;
  if (
    availability !== undefined &&
    !mechanicAvailabilityValues.includes(availability)
  ) {
    throw new AppError(
      `availability must be one of ${mechanicAvailabilityValues.join(", ")}`,
      400
    );
  }

  user.mechanicProfile = {
    ...(user.mechanicProfile || {}),
    availability:
      availability || user.mechanicProfile?.availability || MECHANIC_AVAILABILITY.OFFLINE,
    lastKnownLocation:
      payload.lastKnownLocation !== undefined
        ? normalizePoint(payload.lastKnownLocation)
        : user.mechanicProfile?.lastKnownLocation,
  };

  const { profileCompletion } = await getProfileCompletionSummary(user);
  user.mechanicProfile.profileCompleted = profileCompletion?.isComplete || false;

  await user.save();
  return buildProfileResponse(user);
};

export const updateUserPreferences = async (user, payload) => {
  const nextNotifications = {
    ...(user.preferences?.notifications || {}),
    ...filterObject(payload.notifications || {}, [
      "newBreakdownJobs",
      "jobAcceptedDeclined",
      "paymentReceived",
      "systemAlerts",
    ]),
  };

  const alertRadius =
    payload.alertRadiusMiles !== undefined
      ? Number(payload.alertRadiusMiles)
      : user.preferences?.alertRadiusMiles;

  if (!Number.isFinite(alertRadius) || alertRadius < 1) {
    throw new AppError("alertRadiusMiles must be at least 1", 400);
  }

  user.preferences = {
    ...(user.preferences || {}),
    pushEnabled:
      parseBoolean(payload.pushEnabled) ?? user.preferences?.pushEnabled ?? true,
    alertRadiusMiles: alertRadius,
    notifications: nextNotifications,
  };

  await user.save();
  return buildProfileResponse(user);
};

export const acceptUserTerms = async (user, payload = {}) => {
  user.termsAcceptance = {
    acceptedAt: new Date(),
    version: `${payload.version || "2026-03-09"}`,
    source: `${payload.source || "mobile-app"}`,
  };

  await user.save({ validateBeforeSave: false });
  return buildProfileResponse(user);
};
