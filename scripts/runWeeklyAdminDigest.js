import dotenv from "dotenv";
import mongoose from "mongoose";
import { sendWeeklyAdminDigest } from "../src/modules/notification/adminDigest.service.js";

dotenv.config();

if (!process.env.MONGODB_URL) {
  console.error("Missing MONGODB_URL in environment");
  process.exit(1);
}

const run = async () => {
  await mongoose.connect(process.env.MONGODB_URL);
  const result = await sendWeeklyAdminDigest();
  console.log(JSON.stringify(result, null, 2));
};

run()
  .catch((error) => {
    console.error("Weekly admin digest failed:", error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await mongoose.connection.close();
  });
