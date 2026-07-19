import dotenv from "dotenv";
import mongoose from "mongoose";
import { Job } from "../src/modules/job/job.model.js";

dotenv.config();

const apply = process.argv.includes("--apply");

const run = async () => {
  if (!process.env.MONGODB_URL) throw new Error("Missing MONGODB_URL");
  await mongoose.connect(process.env.MONGODB_URL);

  const missingPostedFilter = {
    $or: [{ postedAt: { $exists: false } }, { postedAt: null }],
  };
  const missingCompletedFilter = {
    status: "COMPLETED",
    $or: [{ completedAt: { $exists: false } }, { completedAt: null }],
  };

  const report = {
    mode: apply ? "APPLY" : "DRY_RUN",
    missingPostedAt: await Job.countDocuments(missingPostedFilter),
    missingCompletedAt: await Job.countDocuments(missingCompletedFilter),
  };

  if (apply) {
    const [postedResult, completedResult] = await Promise.all([
      Job.collection.updateMany(missingPostedFilter, [
        { $set: { postedAt: { $ifNull: ["$createdAt", "$updatedAt"] } } },
      ]),
      Job.collection.updateMany(missingCompletedFilter, [
        { $set: { completedAt: { $ifNull: ["$updatedAt", "$createdAt"] } } },
      ]),
    ]);
    report.postedAtUpdated = postedResult.modifiedCount;
    report.completedAtUpdated = completedResult.modifiedCount;
    await Job.createIndexes();
    report.indexesEnsured = true;
  }

  console.log(JSON.stringify(report, null, 2));
};

run()
  .catch((error) => {
    console.error("Job ordering timestamp migration failed:", error);
    process.exitCode = 1;
  })
  .finally(async () => mongoose.connection.close());
