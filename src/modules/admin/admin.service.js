import AppError from "../../utils/AppError.js";
import {
  MECHANIC_VERIFICATION_STATUS,
  ROLES,
  USER_STATUS,
  userStatusValues,
} from "../../constants/domain.js";
import { User } from "../user/user.model.js";

const parsePage = (value) => {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 1;
};

const parseLimit = (value) => {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return 20;
  return Math.min(Math.floor(n), 100);
};

const serializeMechanicReviewItem = (user) => ({
  _id: user._id,
  email: user.email,
  status: user.status,
  profilePhotoUrl: user.mechanicProfile?.profilePhotoUrl || null,
  displayName: user.mechanicProfile?.displayName || null,
  businessName: user.mechanicProfile?.businessName || null,
  businessType: user.mechanicProfile?.businessType || null,
  phone: user.mechanicProfile?.phone || null,
  baseLocationText: user.mechanicProfile?.baseLocationText || null,
  basePostcode: user.mechanicProfile?.basePostcode || null,
  hourlyRate: user.mechanicProfile?.hourlyRate ?? null,
  emergencyRate: user.mechanicProfile?.emergencyRate ?? null,
  callOutFee: user.mechanicProfile?.callOutFee ?? null,
  serviceRadiusMiles: user.mechanicProfile?.serviceRadiusMiles ?? null,
  skills: user.mechanicProfile?.skills || [],
  verification: {
    status: user.mechanicProfile?.verification?.status || null,
    submittedAt: user.mechanicProfile?.verification?.submittedAt || null,
    reviewedAt: user.mechanicProfile?.verification?.reviewedAt || null,
    reviewNotes: user.mechanicProfile?.verification?.reviewNotes || null,
  },
  createdAt: user.createdAt,
  updatedAt: user.updatedAt,
});

const findMechanicById = async (userId) => {
  const user = await User.findOne({ _id: userId, role: ROLES.MECHANIC });
  if (!user) throw new AppError("Mechanic not found", 404);
  return user;
};

export const listMechanicReviewQueue = async (query = {}) => {
  const page = parsePage(query.page);
  const limit = parseLimit(query.limit);
  const skip = (page - 1) * limit;

  const filter = {
    role: ROLES.MECHANIC,
    status: USER_STATUS.PENDING_REVIEW,
  };

  if (query.status) {
    filter["mechanicProfile.verification.status"] = `${query.status}`
      .trim()
      .toUpperCase();
  } else {
    filter["mechanicProfile.verification.status"] = {
      $in: [
        MECHANIC_VERIFICATION_STATUS.SUBMITTED,
        MECHANIC_VERIFICATION_STATUS.UNDER_REVIEW,
        MECHANIC_VERIFICATION_STATUS.REJECTED,
      ],
    };
  }

  const [items, total] = await Promise.all([
    User.find(filter)
      .sort({
        "mechanicProfile.verification.submittedAt": 1,
        createdAt: 1,
      })
      .skip(skip)
      .limit(limit)
      .lean(),
    User.countDocuments(filter),
  ]);

  return {
    items: items.map(serializeMechanicReviewItem),
    meta: {
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit) || 1,
    },
  };
};

export const approveMechanic = async (userId, payload = {}) => {
  const mechanic = await findMechanicById(userId);

  mechanic.status = USER_STATUS.ACTIVE;
  mechanic.mechanicProfile = {
    ...(mechanic.mechanicProfile || {}),
    verification: {
      ...(mechanic.mechanicProfile?.verification || {}),
      status: MECHANIC_VERIFICATION_STATUS.APPROVED,
      reviewedAt: new Date(),
      reviewNotes: `${payload.notes || ""}`.trim() || undefined,
    },
  };

  await mechanic.save();
  return serializeMechanicReviewItem(mechanic);
};

export const rejectMechanic = async (userId, payload = {}) => {
  const mechanic = await findMechanicById(userId);
  const reason = `${payload.reason || payload.notes || ""}`.trim();
  if (!reason) throw new AppError("reason is required", 400);

  mechanic.status = USER_STATUS.PENDING_REVIEW;
  mechanic.mechanicProfile = {
    ...(mechanic.mechanicProfile || {}),
    verification: {
      ...(mechanic.mechanicProfile?.verification || {}),
      status: MECHANIC_VERIFICATION_STATUS.REJECTED,
      reviewedAt: new Date(),
      reviewNotes: reason,
    },
  };

  await mechanic.save();
  return serializeMechanicReviewItem(mechanic);
};

export const updateUserStatus = async (userId, payload = {}) => {
  const nextStatus = `${payload.status || ""}`.trim().toUpperCase();
  if (!userStatusValues.includes(nextStatus)) {
    throw new AppError(
      `status must be one of ${userStatusValues.join(", ")}`,
      400
    );
  }

  const user = await User.findById(userId);
  if (!user) throw new AppError("User not found", 404);

  user.status = nextStatus;

  if (user.role === ROLES.MECHANIC && nextStatus === USER_STATUS.ACTIVE) {
    user.mechanicProfile = {
      ...(user.mechanicProfile || {}),
      verification: {
        ...(user.mechanicProfile?.verification || {}),
        status:
          user.mechanicProfile?.verification?.status ===
          MECHANIC_VERIFICATION_STATUS.APPROVED
            ? MECHANIC_VERIFICATION_STATUS.APPROVED
            : MECHANIC_VERIFICATION_STATUS.UNDER_REVIEW,
        reviewedAt: new Date(),
        reviewNotes:
          `${payload.notes || ""}`.trim() ||
          user.mechanicProfile?.verification?.reviewNotes,
      },
    };
  }

  await user.save();

  return {
    _id: user._id,
    email: user.email,
    role: user.role,
    status: user.status,
    updatedAt: user.updatedAt,
  };
};
