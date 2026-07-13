/**
 * Resets support tickets stuck IN_PROGRESS with no admin engagement back to OPEN.
 *
 * Usage: node scripts/reconcileSupportTickets.js
 */
import dotenv from "dotenv";
import mongoose from "mongoose";
import { reconcileMisfiledSupportTickets } from "../src/modules/supportTicket/supportTicket.service.js";

dotenv.config();

const must = (key) => {
  const v = `${process.env[key] || ""}`.trim();
  if (!v) throw new Error(`Missing ${key} in environment`);
  return v;
};

async function main() {
  await mongoose.connect(must("MONGODB_URL"));
  const result = await reconcileMisfiledSupportTickets();
  console.log(
    JSON.stringify(
      {
        ok: true,
        inProgressScanned: result.matched,
        resetToWaiting: result.fixed,
        ticketRefs: result.ticketRefs,
      },
      null,
      2
    )
  );
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await mongoose.disconnect().catch(() => {});
  });
