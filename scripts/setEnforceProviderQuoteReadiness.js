/**
 * Group 5 — Toggle enforceProviderQuoteReadiness on the singleton PlatformSettings.
 *
 * Usage:
 *   node scripts/setEnforceProviderQuoteReadiness.js            # print current value
 *   node scripts/setEnforceProviderQuoteReadiness.js --enable
 *   node scripts/setEnforceProviderQuoteReadiness.js --disable   # rollback (no redeploy)
 *
 * Writes only the commercial flag. Prints no secrets, emails, or Stripe IDs.
 */
import dotenv from "dotenv";
import mongoose from "mongoose";
import {
  getEnforceProviderQuoteReadiness,
  getOrCreatePlatformSettings,
  updatePlatformCommercialSettings,
} from "../src/utils/platformFee.js";

dotenv.config();

const must = (key) => {
  const v = `${process.env[key] || ""}`.trim();
  if (!v) throw new Error(`Missing ${key} in environment`);
  return v;
};

async function run() {
  const enable = process.argv.includes("--enable");
  const disable = process.argv.includes("--disable");
  if (enable && disable) {
    throw new Error("Pass only one of --enable or --disable");
  }

  must("MONGODB_URL");
  await mongoose.connect(process.env.MONGODB_URL);

  await getOrCreatePlatformSettings();
  const before = getEnforceProviderQuoteReadiness();
  console.log(`enforceProviderQuoteReadiness (before): ${before}`);

  if (!enable && !disable) {
    await mongoose.disconnect();
    return;
  }

  const next = enable === true;
  await updatePlatformCommercialSettings({
    enforceProviderQuoteReadiness: next,
  });
  const after = getEnforceProviderQuoteReadiness();
  console.log(`enforceProviderQuoteReadiness (after):  ${after}`);
  if (after !== next) {
    throw new Error(`Flag did not update to ${next}`);
  }
  console.log(next ? "Enabled." : "Disabled (rollback).");

  await mongoose.disconnect();
}

run().catch(async (err) => {
  console.error(err?.message || err);
  try {
    await mongoose.disconnect();
  } catch {
    /* ignore */
  }
  process.exit(1);
});
