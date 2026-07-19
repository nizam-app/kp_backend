import dotenv from "dotenv";
import mongoose from "mongoose";
import { DisputeEvidence } from "../src/modules/dispute/disputeEvidence.model.js";
import { DisputeEvent } from "../src/modules/dispute/disputeEvent.model.js";

dotenv.config();

const apply = process.argv.includes("--apply");

const run = async () => {
  if (!process.env.MONGODB_URL) throw new Error("Missing MONGODB_URL");
  await mongoose.connect(process.env.MONGODB_URL);

  const groups = await DisputeEvidence.aggregate([
    { $match: { source: "JOB_ATTACHMENT" } },
    {
      $group: {
        _id: "$dispute",
        evidence: {
          $push: {
            evidenceId: "$_id",
            url: "$storageKey",
            name: "$originalName",
            mimeType: "$mimeType",
            sha256: "$sha256",
            sealedAt: "$sealedAt",
          },
        },
      },
    },
  ]);

  const report = {
    mode: apply ? "APPLY" : "DRY_RUN",
    disputes: groups.length,
    legacyEvidence: groups.reduce(
      (total, group) => total + group.evidence.length,
      0
    ),
    migrated: 0,
    removed: 0,
  };

  if (apply) {
    for (const group of groups) {
      const references = [...new Map(
        group.evidence.map((item) => [item.url, item])
      ).values()];
      await DisputeEvent.updateOne(
        {
          dispute: group._id,
          correlationId: `sealed-job-evidence:${group._id}`,
        },
        {
          $setOnInsert: {
            dispute: group._id,
            source: "SYSTEM",
            type: "JOB_EVIDENCE_SEALED",
            correlationId: `sealed-job-evidence:${group._id}`,
            payload: {
              count: references.length,
              references,
              migratedFromLegacyEvidence: true,
              sealedAt: new Date(),
            },
          },
        },
        { upsert: true }
      );
      const result = await DisputeEvidence.deleteMany({
        dispute: group._id,
        source: "JOB_ATTACHMENT",
      });
      report.migrated += 1;
      report.removed += result.deletedCount || 0;
    }
  }

  console.log(JSON.stringify(report, null, 2));
};

run()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => mongoose.connection.close());
