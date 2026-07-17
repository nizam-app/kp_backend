import dotenv from "dotenv";
import mongoose from "mongoose";
import { Job } from "../src/modules/job/job.model.js";
import {
  DEFAULT_JOB_CATEGORIES,
  DEFAULT_JOB_CATEGORY_BY_KEY,
} from "../src/modules/jobCategory/jobCategory.defaults.js";
import {
  ensureDefaultJobCategories,
  normalizeJobCategoryKey,
} from "../src/modules/jobCategory/jobCategory.service.js";

dotenv.config();

if (!process.env.MONGODB_URL) {
  console.error("Missing MONGODB_URL in environment");
  process.exit(1);
}

const legacyKeyAliases = {
  BRAKE_PROBLEM: "BRAKE_ISSUES_WARNING_LIGHT",
  ELECTRICAL_ISSUE: "ELECTRICAL_PROBLEM",
  OVERHEATING: "OVERHEATING_COOLANT_LEAK",
  OTHER_DESCRIBE_IN_NOTES: "OTHER_NOT_SURE",
};

const targetForSubtype = (rawSubtype) => {
  const normalized = normalizeJobCategoryKey(rawSubtype);
  const key = legacyKeyAliases[normalized] || normalized;
  return DEFAULT_JOB_CATEGORY_BY_KEY[key] || null;
};

const run = async () => {
  await mongoose.connect(process.env.MONGODB_URL);
  await ensureDefaultJobCategories();

  const knownKeys = [
    ...DEFAULT_JOB_CATEGORIES.map((category) => category.key),
    ...Object.keys(legacyKeyAliases),
  ];
  const jobs = await Job.find({
    issueSubtype: { $in: knownKeys },
  })
    .select("_id issueType issueSubtype")
    .lean();

  const writes = jobs
    .map((job) => {
      const target = targetForSubtype(job.issueSubtype);
      if (!target) return null;
      if (job.issueType === target.issueType && job.issueSubtype === target.key) return null;
      return {
        updateOne: {
          filter: { _id: job._id },
          update: {
            $set: {
              issueType: target.issueType,
              issueSubtype: target.key,
            },
          },
        },
      };
    })
    .filter(Boolean);

  if (writes.length) await Job.bulkWrite(writes, { ordered: false });
  console.log(
    `Seeded ${DEFAULT_JOB_CATEGORIES.length} canonical categories; migrated ${writes.length} jobs`
  );
};

run()
  .catch((error) => {
    console.error("Job category migration failed:", error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await mongoose.connection.close();
  });
