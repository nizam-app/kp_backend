import dotenv from "dotenv";
import mongoose from "mongoose";
import { runDisputeOperations } from "../src/modules/dispute/disputeOperations.service.js";

dotenv.config();

const run = async () => {
  if (!process.env.MONGODB_URL) throw new Error("Missing MONGODB_URL");
  await mongoose.connect(process.env.MONGODB_URL);
  console.log(JSON.stringify(await runDisputeOperations(), null, 2));
};

run()
  .catch((error) => {
    console.error("Dispute operations failed:", error);
    process.exitCode = 1;
  })
  .finally(async () => mongoose.connection.close());
