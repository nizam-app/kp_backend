import dotenv from "dotenv";
import mongoose from "mongoose";
import { User } from "../src/modules/user/user.model.js";
import { Job } from "../src/modules/job/job.model.js";
import { Quote } from "../src/modules/quote/quote.model.js";
import { Invoice } from "../src/modules/invoice/invoice.model.js";

dotenv.config();

const apply = process.argv.includes("--apply");

const run = async () => {
  if (!process.env.MONGODB_URL) throw new Error("Missing MONGODB_URL");
  await mongoose.connect(process.env.MONGODB_URL);

  const filters = {
    providerProfiles: {
      $or: [
        {
          role: { $in: ["MECHANIC", "MECHANIC_EMPLOYEE"] },
          "mechanicProfile.rateCurrency": { $ne: "GBP" },
        },
        {
          role: "COMPANY",
          "companyProfile.rateCurrency": { $ne: "GBP" },
        },
      ],
    },
    jobs: { currency: { $ne: "GBP" } },
    quotes: { currency: { $ne: "GBP" } },
    invoices: { currency: { $ne: "GBP" } },
  };

  const report = {
    mode: apply ? "APPLY" : "DRY_RUN",
    providerProfiles: await User.countDocuments(filters.providerProfiles),
    jobs: await Job.countDocuments(filters.jobs),
    quotes: await Quote.countDocuments(filters.quotes),
    invoices: await Invoice.countDocuments(filters.invoices),
  };

  if (apply) {
    await Promise.all([
      User.updateMany(
        { role: { $in: ["MECHANIC", "MECHANIC_EMPLOYEE"] } },
        { $set: { "mechanicProfile.rateCurrency": "GBP" } }
      ),
      User.updateMany(
        { role: "COMPANY" },
        { $set: { "companyProfile.rateCurrency": "GBP" } }
      ),
      Job.updateMany(filters.jobs, { $set: { currency: "GBP" } }),
      Quote.updateMany(filters.quotes, { $set: { currency: "GBP" } }),
      Invoice.updateMany(filters.invoices, { $set: { currency: "GBP" } }),
    ]);
  }

  console.log(JSON.stringify(report, null, 2));
};

run()
  .catch((error) => {
    console.error("GBP currency migration failed:", error);
    process.exitCode = 1;
  })
  .finally(async () => mongoose.connection.close());
