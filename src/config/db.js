import mongoose from "mongoose";
import { env } from "./env.js";

export const connectDB = async () => {
  // In serverless, the same instance may be reused between invocations.
  // Avoid opening multiple connections.
  if (mongoose.connection?.readyState === 1) return;
  await mongoose.connect(env.MONGODB_URL);
  console.log("✅ MongoDB connected");
};
