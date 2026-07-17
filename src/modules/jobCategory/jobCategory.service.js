import AppError from "../../utils/AppError.js";
import {
  ISSUE_TYPES,
  issueTypeValues,
  slugifyJobCategoryKey,
} from "../../constants/domain.js";
import { JobCategory } from "./jobCategory.model.js";
import {
  DEFAULT_JOB_CATEGORIES,
  DEFAULT_JOB_CATEGORY_BY_KEY,
} from "./jobCategory.defaults.js";

const categorySort = { sortOrder: 1, label: 1 };
let defaultSeedPromise;

export const normalizeJobCategoryKey = (value) => slugifyJobCategoryKey(value);

const cleanAliases = (aliases) => {
  if (!Array.isArray(aliases)) return [];
  return [...new Set(aliases.map((value) => `${value || ""}`.trim()).filter(Boolean))];
};

export const ensureDefaultJobCategories = async () => {
  if (!defaultSeedPromise) {
    defaultSeedPromise = JobCategory.bulkWrite(
      DEFAULT_JOB_CATEGORIES.map((category) => ({
        updateOne: {
          filter: { key: category.key },
          update: {
            $setOnInsert: {
              ...category,
              aliases: category.aliases || [],
              isActive: true,
            },
          },
          upsert: true,
        },
      })),
      { ordered: false }
    ).catch((error) => {
      defaultSeedPromise = null;
      throw error;
    });
  }
  await defaultSeedPromise;
};

export const listJobCategories = async ({ includeInactive = false } = {}) => {
  await ensureDefaultJobCategories();
  const filter = includeInactive ? {} : { isActive: true };
  return JobCategory.find(filter).sort(categorySort).lean();
};

export const resolveCanonicalJobCategory = async (raw, { allowInactive = false } = {}) => {
  const input = `${raw || ""}`.trim();
  if (!input) return null;
  await ensureDefaultJobCategories();

  const key = normalizeJobCategoryKey(input);
  const category = await JobCategory.findOne({
    ...(allowInactive ? {} : { isActive: true }),
    $or: [
      { key },
      { label: input },
      { aliases: input },
      ...(key && key !== input ? [{ aliases: key }] : []),
    ],
  })
    .collation({ locale: "en", strength: 2 })
    .lean();

  return category;
};

export const createJobCategory = async (payload = {}) => {
  const key = normalizeJobCategoryKey(payload.key || payload.label);
  const label = `${payload.label || ""}`.trim();
  const issueType = `${payload.issueType || ISSUE_TYPES.OTHER}`.trim().toUpperCase();
  if (!key || !label) throw new AppError("key and label are required", 400);
  if (!issueTypeValues.includes(issueType)) {
    throw new AppError(`Invalid issueType: ${issueType}`, 400);
  }

  try {
    const category = await JobCategory.create({
      key,
      label,
      issueType,
      icon: `${payload.icon || "🔧"}`.trim() || "🔧",
      isActive: payload.isActive ?? true,
      sortOrder: Number.isFinite(Number(payload.sortOrder))
        ? Math.max(0, Number(payload.sortOrder))
        : 0,
      aliases: cleanAliases(payload.aliases),
    });
    return category.toObject();
  } catch (error) {
    if (error?.code === 11000) {
      throw new AppError("A job category with this key already exists", 409);
    }
    throw error;
  }
};

export const updateJobCategory = async (categoryId, payload = {}) => {
  const category = await JobCategory.findById(categoryId);
  if (!category) throw new AppError("Job category not found", 404);

  if (payload.label !== undefined) {
    const label = `${payload.label || ""}`.trim();
    if (!label) throw new AppError("label cannot be empty", 400);
    category.label = label;
  }
  if (payload.issueType !== undefined) {
    const issueType = `${payload.issueType || ""}`.trim().toUpperCase();
    if (!issueTypeValues.includes(issueType)) {
      throw new AppError(`Invalid issueType: ${issueType}`, 400);
    }
    category.issueType = issueType;
  }
  if (payload.icon !== undefined) {
    category.icon = `${payload.icon || ""}`.trim() || "🔧";
  }
  if (payload.isActive !== undefined) category.isActive = Boolean(payload.isActive);
  if (payload.sortOrder !== undefined) {
    const sortOrder = Number(payload.sortOrder);
    if (!Number.isFinite(sortOrder) || sortOrder < 0) {
      throw new AppError("sortOrder must be a non-negative number", 400);
    }
    category.sortOrder = sortOrder;
  }
  if (payload.aliases !== undefined) category.aliases = cleanAliases(payload.aliases);

  await category.save();
  return category.toObject();
};

export const deleteJobCategory = async (categoryId) => {
  const category = await JobCategory.findById(categoryId);
  if (!category) throw new AppError("Job category not found", 404);
  if (DEFAULT_JOB_CATEGORY_BY_KEY[category.key]) {
    throw new AppError("Built-in categories cannot be deleted; deactivate them instead", 409);
  }

  const { Job } = await import("../job/job.model.js");
  const isUsed = await Job.exists({ issueSubtype: category.key });
  if (isUsed) {
    throw new AppError(
      "This category is used by jobs and cannot be deleted; deactivate it instead",
      409
    );
  }

  await category.deleteOne();
  return { _id: category._id, deleted: true };
};
