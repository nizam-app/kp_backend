/**
 * Ensures every FLEET user can post jobs:
 * - fills missing fleetProfile fields required by profile completion
 * - creates a default MANUAL card payment method if none exists
 *
 * Usage: node scripts/ensureFleetCanPost.js
 */
import dotenv from "dotenv";
import mongoose from "mongoose";
import { User } from "../src/modules/user/user.model.js";
import { PaymentMethod } from "../src/modules/billing/paymentMethod.model.js";
import { ROLES } from "../src/constants/domain.js";

dotenv.config();

const must = (key) => {
  const v = `${process.env[key] || ""}`.trim();
  if (!v) throw new Error(`Missing ${key} in environment`);
  return v;
};

const PROFILE_DEFAULTS = {
  companyName: "Fleet Operator Ltd",
  regNumber: "REG-0001",
  vatNumber: "GB000000000",
  contactName: "Fleet Manager",
  contactRole: "Fleet Manager",
  phone: "+44 7700 900000",
  billingAddress: "1 Fleet Street, London EC4Y 1AA",
  fleetSize: "1–10 vehicles",
};

async function ensureDefaultCard(user) {
  const existing = await PaymentMethod.findOne({
    user: user._id,
    isActive: true,
    isDefault: true,
  });
  if (existing) return { created: false, method: existing };

  await PaymentMethod.updateMany(
    { user: user._id, isActive: true },
    { $set: { isDefault: false } }
  );

  const method = await PaymentMethod.create({
    user: user._id,
    ownerType: "FLEET",
    methodType: "CARD",
    provider: "MANUAL",
    providerMethodId: `manual_dev_${user._id}`,
    card: {
      brand: "visa",
      last4: "4242",
      expMonth: 12,
      expYear: new Date().getFullYear() + 3,
    },
    billingAddress: user.fleetProfile?.billingAddress || PROFILE_DEFAULTS.billingAddress,
    isDefault: true,
    isActive: true,
  });

  return { created: true, method };
}

async function ensureFleetProfile(user) {
  const fp = user.fleetProfile || {};
  const patch = {};
  for (const [key, fallback] of Object.entries(PROFILE_DEFAULTS)) {
    if (!fp[key]) patch[`fleetProfile.${key}`] = fallback;
  }
  if (!Object.keys(patch).length) return { updated: false };

  await User.updateOne({ _id: user._id }, { $set: { ...patch, "fleetProfile.profileCompleted": true } });
  return { updated: true, fields: Object.keys(patch) };
}

async function run() {
  await mongoose.connect(must("MONGODB_URL"));

  const fleets = await User.find({ role: ROLES.FLEET });
  if (!fleets.length) {
    console.log("No FLEET users found.");
    return;
  }

  for (const user of fleets) {
    const profile = await ensureFleetProfile(user);
    const refreshed = profile.updated
      ? await User.findById(user._id)
      : user;
    const payment = await ensureDefaultCard(refreshed);

    console.log(
      `✓ ${user.email}: profile ${profile.updated ? `filled (${profile.fields.join(", ")})` : "ok"}, payment ${
        payment.created ? "created" : "ok"
      }`
    );
  }

  console.log(`\nDone. ${fleets.length} fleet user(s) can post jobs.`);
}

run()
  .catch((err) => {
    console.error("❌ Failed:", err?.message || err);
    process.exitCode = 1;
  })
  .finally(async () => {
    try {
      await mongoose.connection.close();
    } catch {
      // ignore
    }
  });
