import dotenv from "dotenv";
import mongoose from "mongoose";
import { Job } from "../src/modules/job/job.model.js";
import { JobEvent } from "../src/modules/jobEvent/jobEvent.model.js";

dotenv.config();

const apply = process.argv.includes("--apply");

const run = async () => {
  if (!process.env.MONGODB_URL) throw new Error("Missing MONGODB_URL");
  await mongoose.connect(process.env.MONGODB_URL);

  const jobs = await Job.find({
    status: { $in: ["AWAITING_APPROVAL", "COMPLETED"] },
    $or: [
      { completionPhotos: { $exists: false } },
      { completionPhotos: { $size: 0 } },
    ],
  })
    .select("_id jobCode assignedMechanic photos")
    .lean();

  const report = {
    mode: apply ? "APPLY" : "DRY_RUN",
    scanned: jobs.length,
    candidates: 0,
    updated: 0,
    photos: 0,
  };

  for (const job of jobs) {
    const completed = await JobEvent.findOne({
      job: job._id,
      type: "WORK_COMPLETED",
    })
      .sort({ createdAt: -1 })
      .select("createdAt")
      .lean();
    if (!completed) continue;

    const started = await JobEvent.findOne({
      job: job._id,
      type: "WORK_STARTED",
    })
      .sort({ createdAt: -1 })
      .select("createdAt")
      .lean();
    const lowerBound = started?.createdAt || new Date(completed.createdAt.getTime() - 24 * 60 * 60 * 1000);
    const upperBound = new Date(completed.createdAt.getTime() + 5 * 60 * 1000);
    const events = await JobEvent.find({
      job: job._id,
      type: "JOB_PHOTOS_ADDED",
      actor: job.assignedMechanic,
      createdAt: { $gte: lowerBound, $lte: upperBound },
    })
      .sort({ createdAt: 1 })
      .select("payload.photos")
      .lean();

    const jobPhotos = new Set(job.photos || []);
    const photos = [
      ...new Set(
        events
          .flatMap((event) =>
            Array.isArray(event.payload?.photos) ? event.payload.photos : []
          )
          .filter((url) => url && jobPhotos.has(url))
      ),
    ];
    if (!photos.length) continue;

    report.candidates += 1;
    report.photos += photos.length;
    if (apply) {
      const result = await Job.updateOne(
        { _id: job._id },
        { $addToSet: { completionPhotos: { $each: photos } } }
      );
      if (result.modifiedCount) report.updated += 1;
    }
  }

  console.log(JSON.stringify(report, null, 2));
};

run()
  .catch((error) => {
    console.error("Completion-photo migration failed:", error);
    process.exitCode = 1;
  })
  .finally(async () => mongoose.connection.close());
