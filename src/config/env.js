import dotenv from "dotenv";
import path from "path";
import fs from "fs";

// Force-load this project's `.env` from the current working directory and
// override any injected environment variables (some environments pre-inject a
// different .env path).
const envPath = path.resolve(process.cwd(), ".env");
if (fs.existsSync(envPath)) {
  const parsed = dotenv.parse(fs.readFileSync(envPath));
  Object.entries(parsed).forEach(([key, value]) => {
    // On Render/hosting, platform env wins — do not overwrite injected secrets.
    if (process.env[key] === undefined) {
      process.env[key] = value;
    }
  });
}

const required = (key) => {
  if (!process.env[key]) throw new Error(`Missing env: ${key}`);
  return process.env[key];
};

export const env = {
  NODE_ENV: process.env.NODE_ENV || "development",
  HOST: process.env.HOST || "0.0.0.0",
  PORT: Number(process.env.PORT) || 7000,
  MONGODB_URL: required("MONGODB_URL"),
  JWT_SECRET: required("JWT_SECRET"),
  JWT_EXPIRES_IN: process.env.JWT_EXPIRES_IN || "7d",
  JWT_REFRESH_SECRET: process.env.JWT_REFRESH_SECRET || required("JWT_SECRET"),
  JWT_REFRESH_EXPIRES_IN: process.env.JWT_REFRESH_EXPIRES_IN || "30d",
  STRIPE_SECRET_KEY: process.env.STRIPE_SECRET_KEY || "",
  STRIPE_PUBLISHABLE_KEY: process.env.STRIPE_PUBLISHABLE_KEY || "",
  STRIPE_WEBHOOK_SECRET: process.env.STRIPE_WEBHOOK_SECRET || "",
  /** Optional; required only for POST /api/v1/media/profile-image */
  CLOUDINARY_URL: process.env.CLOUDINARY_URL || "",
  CLOUDINARY_CLOUD_NAME: process.env.CLOUDINARY_CLOUD_NAME || "",
  CLOUDINARY_API_KEY: process.env.CLOUDINARY_API_KEY || "",
  CLOUDINARY_API_SECRET: process.env.CLOUDINARY_API_SECRET || "",
  /** Optional. Public web app origin for deep links (e.g. mechanic employee signup after company invite). No trailing slash. */
  APP_PUBLIC_URL: (process.env.APP_PUBLIC_URL || "").trim().replace(/\/$/, ""),
  /**
   * Optional — Firebase Cloud Messaging (server push). Provide one of:
   * - FIREBASE_SERVICE_ACCOUNT_PATH: path to the service account JSON file (relative to cwd or absolute)
   * - FIREBASE_SERVICE_ACCOUNT_JSON: raw JSON string of the service account (e.g. for containers)
   */
  FIREBASE_SERVICE_ACCOUNT_PATH: (process.env.FIREBASE_SERVICE_ACCOUNT_PATH || "").trim(),
  FIREBASE_SERVICE_ACCOUNT_JSON: (process.env.FIREBASE_SERVICE_ACCOUNT_JSON || "").trim(),
  /** Resend — transactional email (forgot password, invites). */
  RESEND_API_KEY: (process.env.RESEND_API_KEY || "").trim(),
  EMAIL_FROM: (process.env.EMAIL_FROM || "").trim(),
  /**
   * Optional full URL for reset page (no trailing slash on base path before query).
   * Falls back to APP_PUBLIC_URL + /reset-password?token=...
   */
  PASSWORD_RESET_URL: (process.env.PASSWORD_RESET_URL || "").trim(),
};
