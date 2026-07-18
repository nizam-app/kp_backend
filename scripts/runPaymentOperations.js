import dotenv from "dotenv";
import mongoose from "mongoose";
import { runPaymentOperations } from "../src/modules/billing/paymentOperations.service.js";

dotenv.config();

const run = async () => {
  if (!process.env.MONGODB_URL) throw new Error("Missing MONGODB_URL");
  await mongoose.connect(process.env.MONGODB_URL);
  const result = await runPaymentOperations();
  console.log(JSON.stringify(result, null, 2));
};

run()
  .catch((err) => {
    console.error("Payment operations failed:", err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await mongoose.connection.close();
  });
