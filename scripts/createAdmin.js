import dotenv from "dotenv";
import mongoose from "mongoose";
import { User } from "../src/modules/user/user.model.js";
import { ROLES, USER_STATUS } from "../src/constants/domain.js";

dotenv.config();

const [, , emailArg, passwordArg] = process.argv;

const email = `${emailArg || process.env.ADMIN_EMAIL || ""}`.trim().toLowerCase();
const password = `${passwordArg || process.env.ADMIN_PASSWORD || ""}`.trim();

if (!process.env.MONGODB_URL) {
  console.error("Missing MONGODB_URL in environment");
  process.exit(1);
}

if (!email || !password) {
  console.error(
    "Usage: npm run create:admin -- <email> <password>\nOr set ADMIN_EMAIL and ADMIN_PASSWORD in .env"
  );
  process.exit(1);
}

if (password.length < 8) {
  console.error("Password must be at least 8 characters");
  process.exit(1);
}

const run = async () => {
  await mongoose.connect(process.env.MONGODB_URL);

  const existing = await User.findOne({ email });
  if (existing) {
    existing.role = ROLES.ADMIN;
    existing.status = USER_STATUS.ACTIVE;
    if (password) existing.password = password;
    await existing.save();
    console.log(`Updated existing user as ADMIN: ${email}`);
    return;
  }

  await User.create({
    email,
    password,
    role: ROLES.ADMIN,
    status: USER_STATUS.ACTIVE,
  });

  console.log(`Created ADMIN user: ${email}`);
};

run()
  .catch((error) => {
    console.error("Failed to create admin:", error.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    await mongoose.connection.close();
  });
