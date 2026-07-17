import dotenv from "dotenv";
import mongoose from "mongoose";
import { reportSystemHealthAlert } from "../src/modules/notification/adminNotification.service.js";

dotenv.config();

if (!process.env.MONGODB_URL) {
  console.error("Missing MONGODB_URL in environment");
  process.exit(1);
}

const message = process.argv.slice(2).join(" ").trim();
if (!message) {
  console.error('Usage: npm run notify:system-health -- "Service name is unhealthy"');
  process.exit(1);
}

const run = async () => {
  await mongoose.connect(process.env.MONGODB_URL);
  const result = await reportSystemHealthAlert({
    title: "TruckFix system health alert",
    body: message,
    data: { source: "external-monitor" },
  });
  if (result?.failed) throw new Error("System health event could not be dispatched");
  console.log(JSON.stringify(result, null, 2));
};

run()
  .catch((error) => {
    console.error("System health alert failed:", error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await mongoose.connection.close();
  });
