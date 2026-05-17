import dotenv from "dotenv";
import mongoose from "mongoose";
import bcrypt from "bcryptjs";
import crypto from "crypto";
import { User } from "../src/modules/user/user.model.js";
import { Vehicle } from "../src/modules/vehicle/vehicle.model.js";
import { Job } from "../src/modules/job/job.model.js";
import { Quote } from "../src/modules/quote/quote.model.js";
import { Notification } from "../src/modules/notification/notification.model.js";
import { JobEvent } from "../src/modules/jobEvent/jobEvent.model.js";
import { CompanyInvite } from "../src/modules/company/companyInvite.model.js";
import { Invoice } from "../src/modules/invoice/invoice.model.js";
import { EarningTransaction } from "../src/modules/earning/earningTransaction.model.js";
import { Review } from "../src/modules/review/review.model.js";
import { JobLocationPing } from "../src/modules/jobLocationPing/jobLocationPing.model.js";
import { ChatMessage } from "../src/modules/chat/chat.model.js";
import {
  ROLES,
  USER_STATUS,
  JOB_STATUS,
  JOB_URGENCY,
  ISSUE_TYPES,
  QUOTE_STATUS,
  QUOTE_AVAILABILITY,
  MECHANIC_AVAILABILITY,
} from "../src/constants/domain.js";

const must = (key) => {
  const v = `${process.env[key] || ""}`.trim();
  if (!v) throw new Error(`Missing ${key} in environment`);
  return v;
};

const minutesAgo = (m) => new Date(Date.now() - m * 60_000);
const hoursFromNow = (h) => new Date(Date.now() + h * 3_600_000);
/** Midday on the 15th of the previous calendar month (dashboard MoM revenue demo). */
const prevMonthNoon = () => {
  const d = new Date();
  return new Date(d.getFullYear(), d.getMonth() - 1, 15, 12, 0, 0, 0);
};

async function upsertUser({ email, password, role, status = USER_STATUS.ACTIVE, profile = {} }) {
  // findOneAndUpdate bypasses User schema pre("save") — password must be bcrypt-hashed here
  // or loginUser.comparePassword will fail (401 Invalid credentials).
  const passwordHash = await bcrypt.hash(password, 12);
  const update = {
    email: email.toLowerCase(),
    password: passwordHash,
    role,
    status,
    ...(role === ROLES.FLEET ? { fleetProfile: profile } : {}),
    ...(role === ROLES.MECHANIC ? { mechanicProfile: profile } : {}),
    ...(role === ROLES.COMPANY ? { companyProfile: profile } : {}),
  };

  const doc = await User.findOneAndUpdate(
    { email: update.email },
    { $set: update },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );
  return doc;
}

async function upsertMechanicEmployee({
  email,
  password,
  companyId,
  displayName,
  phone,
  availability = MECHANIC_AVAILABILITY.ONLINE,
  skills = ["ENGINE", "BRAKES", "ELECTRICAL"],
  rating = { average: 4.8, count: 40 },
  stats = { jobsDone: 40, responseMinutesAvg: 12 },
  joinedAt,
  jobTitle = "Field technician",
  employeeDisplayRef,
  profilePhotoUrl = "https://i.pravatar.cc/150?img=33",
  lastKnownLocation = null,
}) {
  const passwordHash = await bcrypt.hash(password, 12);
  const membership = {
    company: companyId,
    status: "ACTIVE",
    joinedAt: joinedAt ?? minutesAgo(60 * 24 * 120),
    jobTitle,
  };
  if (employeeDisplayRef) {
    membership.employeeDisplayRef = `${employeeDisplayRef}`.trim().slice(0, 16);
  }
  const profile = {
    displayName,
    phone,
    profilePhotoUrl,
    baseLocationText: "Manchester",
    basePostcode: "M1 1AE",
    hourlyRate: 72,
    emergencyRate: 95,
    callOutFee: 35,
    serviceRadiusMiles: 25,
    profileCompleted: true,
    availability,
    skills,
    rating,
    stats,
    ...(lastKnownLocation ? { lastKnownLocation } : {}),
  };
  return User.findOneAndUpdate(
    { email: email.toLowerCase() },
    {
      $set: {
        email: email.toLowerCase(),
        password: passwordHash,
        role: ROLES.MECHANIC_EMPLOYEE,
        status: USER_STATUS.ACTIVE,
        mechanicProfile: profile,
        companyMembership: membership,
      },
    },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );
}

async function ensureCompanyInvite({ company, email, invitedBy }) {
  const lower = email.toLowerCase();
  const token = crypto.randomBytes(24).toString("hex");
  return CompanyInvite.findOneAndUpdate(
    { company: company._id, email: lower },
    {
      $set: {
        company: company._id,
        email: lower,
        invitedBy: invitedBy._id,
        token,
        status: "PENDING",
        expiresAt: hoursFromNow(24 * 7),
      },
    },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );
}

async function ensureInvoiceForJob({ invoiceNo, job, fleet, mechanic, extra = {} }) {
  const jobBase = Number(job?.finalAmount ?? job?.acceptedAmount ?? job?.estimatedPayout ?? 0);
  const defaultSubtotal = Number.isFinite(jobBase) && jobBase > 0 ? jobBase : 160;
  const subtotal =
    extra.subtotal !== undefined && extra.subtotal !== null ? Number(extra.subtotal) : defaultSubtotal;
  const vatAmount =
    extra.vatAmount !== undefined && extra.vatAmount !== null ? Number(extra.vatAmount) : 0;
  const totalAmount =
    extra.totalAmount !== undefined && extra.totalAmount !== null
      ? Number(extra.totalAmount)
      : Math.round((Number(subtotal) + Number(vatAmount)) * 100) / 100;
  const paidAtForRecords = extra.paidAt ?? job?.completedAt ?? minutesAgo(40);
  const invoiceStatus = extra.status || "PAID";
  const fleetCompany =
    fleet?.fleetProfile?.companyName || fleet?.email || "TruckFix Client";

  const invoice = await Invoice.findOneAndUpdate(
    { invoiceNo },
    {
      $set: {
        invoiceNo,
        job: job._id,
        fleet: fleet._id,
        mechanic: mechanic._id,
        subtotal,
        vatAmount,
        totalAmount,
        currency: extra.currency || "GBP",
        status: invoiceStatus,
        paidAt: invoiceStatus === "PAID" ? paidAtForRecords : undefined,
        pdfUrl: extra.pdfUrl ?? null,
        lineItems: extra.lineItems || [
          { description: "Labour and parts (seed)", quantity: 1, unitAmount: subtotal, totalAmount: subtotal },
        ],
        billedToSnapshot: {
          companyName: extra.billedCompanyName || fleetCompany,
          vatNumber: fleet?.fleetProfile?.vatNumber || "GB-SEED",
          address: fleet?.fleetProfile?.billingAddress || "Seed billing",
        },
        mechanicSnapshot: {
          displayName: mechanic?.mechanicProfile?.displayName || "James Mitchell",
          businessName: mechanic?.mechanicProfile?.businessName || "Mitchell Roadside Repairs",
          rating: mechanic?.mechanicProfile?.rating?.average ?? 4.9,
        },
      },
    },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );

  /** Mirror `upsertFinancialRecordsForCompletedJob` so GET /earnings/* is populated for demos. */
  if (invoiceStatus === "PAID" && job?._id && mechanic?._id) {
    const platformFee = Math.round(subtotal * 0.12 * 100) / 100;
    const netAmount = Math.max(Math.round((subtotal - platformFee) * 100) / 100, 0);
    await EarningTransaction.findOneAndUpdate(
      { mechanic: mechanic._id, job: job._id },
      {
        $set: {
          grossAmount: subtotal,
          platformFee,
          netAmount,
          currency: extra.currency || "GBP",
          paidAt: paidAtForRecords,
          notes: job?.completionSummary || job?.description || "Seed paid job",
        },
        $setOnInsert: { type: "JOB_PAYMENT" },
      },
      { upsert: true }
    );
  }

  return invoice;
}

async function ensureReviewForSeedJob({ job, fleet, mechanic, rating = 5, comment = null }) {
  if (!job?._id) return;
  const companyName = fleet?.fleetProfile?.companyName || "TruckFix Client";
  const setDoc = {
    fleet: fleet._id,
    mechanic: mechanic._id,
    job: job._id,
    customerName: fleet?.fleetProfile?.contactName || "Fleet operator",
    companyName,
    serviceLabel: job.title,
    mechanicName: mechanic?.mechanicProfile?.displayName || "Mechanic",
    rating,
    status: "PUBLISHED",
  };
  if (comment) setDoc.comment = comment;
  await Review.findOneAndUpdate(
    { job: job._id },
    {
      $set: setDoc,
    },
    { upsert: true, setDefaultsOnInsert: true }
  );
}

const shouldForce = () => `${process.env.SEED_FORCE || ""}`.trim() === "true";

async function upsertJobByCode({ jobCode, build }) {
  const existing = await Job.findOne({ jobCode }).lean();
  if (existing && !shouldForce()) {
    return await Job.findById(existing._id);
  }
  const payload = build();
  return await Job.findOneAndUpdate(
    { jobCode },
    { $setOnInsert: { jobCode }, $set: payload },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );
}

async function ensureQuote({ job, fleet, mechanic, company, submittedBy, data }) {
  const filter = { job: job._id, mechanic: mechanic._id };
  const existing = await Quote.findOne(filter).lean();
  if (existing && !shouldForce()) {
    return await Quote.findById(existing._id);
  }
  return await Quote.findOneAndUpdate(
    filter,
    {
      $set: {
        job: job._id,
        fleet: fleet._id,
        mechanic: mechanic._id,
        company: company?._id || undefined,
        submittedBy: submittedBy?._id || mechanic._id,
        ...data,
      },
    },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );
}

/**
 * Replace job chat messages for Postman / Messages UI demos.
 * @param {{ job, fleet, mechanic, lines: Array<{ from: 'fleet'|'mechanic', text: string, minutesAgo: number, readByOther?: boolean }> }} opts
 */
async function seedJobChatThread({ job, fleet, mechanic, lines }) {
  if (!job?._id || !fleet?._id || !mechanic?._id || !lines?.length) return 0;

  await ChatMessage.deleteMany({ job: job._id });

  const docs = lines.map((line) => {
    const sender = line.from === "fleet" ? fleet._id : mechanic._id;
    const createdAt = minutesAgo(line.minutesAgo);
    const readBy = [{ user: sender, readAt: createdAt }];
    if (line.readByOther) {
      const other = line.from === "fleet" ? mechanic._id : fleet._id;
      readBy.push({ user: other, readAt: createdAt });
    }
    return {
      job: job._id,
      sender,
      text: line.text,
      attachments: line.attachments || [],
      readBy,
      createdAt,
    };
  });

  await ChatMessage.insertMany(docs);
  return docs.length;
}

async function ensureAtLeastNotifications(userId, minCount, factory) {
  const count = await Notification.countDocuments({ user: userId });
  const need = Math.max(0, minCount - count);
  for (let i = 0; i < need; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    await Notification.create(factory(i));
  }
}

async function run() {
  // Load local .env for CLI runs.
  dotenv.config();

  // Safety: never seed in production.
  const nodeEnv = `${process.env.NODE_ENV || "development"}`.trim();
  if (nodeEnv === "production") {
    throw new Error("Refusing to seed fake data when NODE_ENV=production");
  }

  await mongoose.connect(must("MONGODB_URL"));

  // Users
  const fleet = await upsertUser({
    email: "fleet@truckfix.dev",
    password: "Password123!",
    role: ROLES.FLEET,
    profile: {
      profilePhotoUrl: "https://i.pravatar.cc/150?img=12",
      companyName: "Logistix Transport (Pty) Ltd",
      contactName: "John Khumalo",
      contactRole: "Fleet Manager",
      phone: "+44 7712 345 678",
      regNumber: "2019/223456/07",
      vatNumber: "4120889456",
      fleetSize: "21–50 vehicles",
      billingAddress: "123 Logistics Ave, JHB",
      profileCompleted: true,
      rating: { average: 4.7, count: 156 },
    },
  });

  const james = await upsertUser({
    email: "mechanic@truckfix.dev",
    password: "Password123!",
    role: ROLES.MECHANIC,
    profile: {
      displayName: "James Mitchell",
      businessName: "Mitchell Roadside Repairs",
      phone: "+44 7700 900111",
      baseLocationText: "Manchester",
      basePostcode: "M1 1AE",
      serviceRadiusMiles: 25,
      callOutFee: 35,
      hourlyRate: 75,
      skills: ["TYRES", "BRAKES"],
      profilePhotoUrl: "https://i.pravatar.cc/150?img=11",
      lastKnownLocation: {
        type: "Point",
        coordinates: [-1.8284, 52.4862],
        updatedAt: new Date(),
      },
      profileCompleted: true,
      availability: "ONLINE",
      rating: { average: 4.9, count: 184 },
      stats: { jobsDone: 211, responseMinutesAvg: 12 },
      billingAddress: "14 Workshop Lane, Manchester M1 2AB",
      bankDisplayName: "Barclays",
      bankAccountMasked: "•••• •••• 4521",
      bankSortCode: "20-14-55",
      vatNumber: "GB 345 7821 00",
      vatRegistered: true,
    },
  });

  const tom = await upsertUser({
    email: "mechanic2@truckfix.dev",
    password: "Password123!",
    role: ROLES.MECHANIC,
    profile: {
      displayName: "Tom Stevens",
      businessName: "Stevens HGV Services",
      phone: "+44 7700 900333",
      baseLocationText: "Birmingham",
      basePostcode: "B1 1AA",
      serviceRadiusMiles: 30,
      callOutFee: 35,
      hourlyRate: 70,
      skills: ["TYRES", "BATTERY"],
      profilePhotoUrl: "https://i.pravatar.cc/150?img=12",
      lastKnownLocation: {
        type: "Point",
        coordinates: [-1.7753, 52.4862],
        updatedAt: new Date(),
      },
      profileCompleted: true,
      availability: "ONLINE",
      rating: { average: 4.7, count: 163 },
      stats: { jobsDone: 163, responseMinutesAvg: 18 },
    },
  });

  const paul = await upsertUser({
    email: "mechanic3@truckfix.dev",
    password: "Password123!",
    role: ROLES.MECHANIC,
    profile: {
      displayName: "Paul Davies",
      businessName: "Davies Roadside",
      phone: "+44 7700 900444",
      baseLocationText: "Leeds",
      basePostcode: "LS1 1AA",
      serviceRadiusMiles: 40,
      callOutFee: 30,
      hourlyRate: 65,
      skills: ["ENGINE", "ELECTRICAL"],
      profilePhotoUrl: "https://i.pravatar.cc/150?img=13",
      lastKnownLocation: {
        type: "Point",
        coordinates: [-1.7134, 52.4862],
        updatedAt: new Date(),
      },
      profileCompleted: true,
      availability: "OFFLINE",
      rating: { average: 4.5, count: 98 },
      stats: { jobsDone: 98, responseMinutesAvg: 25 },
    },
  });

  const company = await upsertUser({
    email: "company@truckfix.dev",
    password: "Password123!",
    role: ROLES.COMPANY,
    profile: {
      profilePhotoUrl: "https://i.pravatar.cc/150?img=68",
      companyName: "Swift Mechanics Ltd",
      contactName: "Admin",
      contactRole: "Dispatcher",
      phone: "+44 7700 900222",
      regNumber: "12345678",
      vatNumber: "Not registered",
      billingAddress: "45 Industrial Park, Birmingham B12 8QT",
      baseLocationText: "Birmingham, UK",
      serviceRadiusMiles: 50,
      teamSize: 4,
      profileCompleted: true,
      bankDisplayName: "Barclays Business",
      bankAccountMasked: "**** **** 9876",
      bankSortCode: "20-45-99",
      profileMetricsOverride: {
        totalJobs: 156,
        avgRating: 4.8,
        responseMinutesAvg: 8,
      },
    },
  });

  /** Same demo company — alternate login used in docs / Postman (`company@swiftmechanics.co.uk`). Own team until you assign shared data. */
  await upsertUser({
    email: "company@swiftmechanics.co.uk",
    password: "Password123!",
    role: ROLES.COMPANY,
    profile: {
      profilePhotoUrl: "https://i.pravatar.cc/150?img=68",
      companyName: "Swift Mechanics Ltd",
      contactName: "Admin",
      contactRole: "Dispatcher",
      phone: "+44 7700 900222",
      regNumber: "12345678",
      vatNumber: "Not registered",
      billingAddress: "45 Industrial Park, Birmingham B12 8QT",
      baseLocationText: "Birmingham, UK",
      serviceRadiusMiles: 50,
      teamSize: 0,
      profileCompleted: true,
      bankDisplayName: "Barclays Business",
      bankAccountMasked: "**** **** 9876",
      bankSortCode: "20-45-99",
      profileMetricsOverride: {
        totalJobs: 0,
        avgRating: 4.8,
        responseMinutesAvg: 8,
      },
    },
  });

  const johnCompany = await upsertUser({
    email: "johncompany@truckfix.dev",
    password: "Password123!",
    role: ROLES.COMPANY,
    profile: {
      profilePhotoUrl: "https://i.pravatar.cc/150?img=69",
      companyName: "John Mechanic Repairs",
      contactName: "John Mechanic",
      contactRole: "Owner",
      phone: "+27123456789",
      regNumber: "ZA-SEED-1001",
      vatNumber: "ZA4125889001",
      billingAddress: "12 Workshop Rd, Johannesburg",
      baseLocationText: "Johannesburg",
      serviceRadiusMiles: 40,
      teamSize: 3,
      profileCompleted: true,
    },
  });

  await upsertMechanicEmployee({
    email: "employee@truckfix.dev",
    password: "Password123!",
    companyId: company._id,
    displayName: "Alex Taylor",
    phone: "+44 7700 900501",
    availability: MECHANIC_AVAILABILITY.OFFLINE,
    skills: ["TYRES", "BATTERY"],
    rating: { average: 4.6, count: 18 },
    stats: { jobsDone: 12, responseMinutesAvg: 25 },
    joinedAt: new Date("2025-06-01T09:00:00.000Z"),
    employeeDisplayRef: "M-004",
    profilePhotoUrl: "https://i.pravatar.cc/150?img=14",
  });

  const empJohnSmith = await upsertMechanicEmployee({
    email: "employee.jsmith@truckfix.dev",
    password: "Password123!",
    companyId: company._id,
    displayName: "John Smith",
    phone: "+44 7700 900502",
    availability: MECHANIC_AVAILABILITY.ONLINE,
    skills: ["ENGINE", "ELECTRICAL", "BRAKES"],
    rating: { average: 4.8, count: 41 },
    stats: { jobsDone: 45, responseMinutesAvg: 10 },
    joinedAt: new Date("2024-01-10T10:00:00.000Z"),
    employeeDisplayRef: "M-001",
    profilePhotoUrl: "https://i.pravatar.cc/150?img=15",
    lastKnownLocation: {
      type: "Point",
      coordinates: [-1.905, 52.475],
      updatedAt: new Date(),
    },
  });

  const empMikeJohnson = await upsertMechanicEmployee({
    email: "employee.mjohnson@truckfix.dev",
    password: "Password123!",
    companyId: company._id,
    displayName: "Mike Johnson",
    phone: "+44 7700 900503",
    availability: MECHANIC_AVAILABILITY.ONLINE,
    skills: ["ELECTRICAL", "AIR_SYSTEMS", "TRANSMISSION"],
    rating: { average: 4.9, count: 52 },
    stats: { jobsDone: 38, responseMinutesAvg: 9 },
    joinedAt: new Date("2024-03-05T11:30:00.000Z"),
    employeeDisplayRef: "M-002",
    profilePhotoUrl: "https://i.pravatar.cc/150?img=16",
    lastKnownLocation: {
      type: "Point",
      coordinates: [-1.882, 52.468],
      updatedAt: new Date(),
    },
  });

  const empDaveWilson = await upsertMechanicEmployee({
    email: "employee.dwilson@truckfix.dev",
    password: "Password123!",
    companyId: company._id,
    displayName: "Dave Wilson",
    phone: "+44 7700 900504",
    availability: MECHANIC_AVAILABILITY.ONLINE,
    skills: ["ENGINE", "BRAKES", "TYRES"],
    rating: { average: 4.7, count: 60 },
    stats: { jobsDone: 52, responseMinutesAvg: 14 },
    joinedAt: new Date("2023-11-20T08:00:00.000Z"),
    employeeDisplayRef: "M-003",
    profilePhotoUrl: "https://i.pravatar.cc/150?img=17",
    lastKnownLocation: {
      type: "Point",
      coordinates: [-2.24, 53.48],
      updatedAt: new Date(),
    },
  });

  await upsertMechanicEmployee({
    email: "employee.johnco@truckfix.dev",
    password: "Password123!",
    companyId: johnCompany._id,
    displayName: "Sam Ndlovu",
    phone: "+27 82 555 0199",
    skills: ["ENGINE", "OTHER"],
    rating: { average: 4.5, count: 8 },
    stats: { jobsDone: 6, responseMinutesAvg: 30 },
    joinedAt: new Date("2025-02-01T12:00:00.000Z"),
    employeeDisplayRef: "M-001",
    profilePhotoUrl: "https://i.pravatar.cc/150?img=18",
  });

  // Vehicles (Fleet)
  await Vehicle.findOneAndUpdate(
    { fleet: fleet._id, registration: "CA 456-789" },
    {
      $set: {
        fleet: fleet._id,
        registration: "CA 456-789",
        type: "Tautliner",
        make: "DAF",
        model: "XF",
        year: 2021,
        vin: "FAKEVIN12345678901",
        currentMileageKm: 284500,
        isActive: true,
      },
    },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );

  await Vehicle.findOneAndUpdate(
    { fleet: fleet._id, registration: "GP 112-033" },
    {
      $set: {
        fleet: fleet._id,
        registration: "GP 112-033",
        type: "Rigid Truck",
        make: "Scania",
        model: "R450",
        year: 2020,
        vin: "FAKEVIN22345678901",
        currentMileageKm: 195300,
        isActive: true,
      },
    },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );

  await Vehicle.findOneAndUpdate(
    { fleet: fleet._id, registration: "KZN 78-99" },
    {
      $set: {
        fleet: fleet._id,
        registration: "KZN 78-99",
        type: "Tanker",
        make: "Volvo",
        model: "FH16",
        year: 2019,
        vin: "FAKEVIN32345678901",
        currentMileageKm: 312800,
        isActive: true,
      },
    },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );

  await Vehicle.findOneAndUpdate(
    { fleet: fleet._id, registration: "WC 234-567" },
    {
      $set: {
        fleet: fleet._id,
        registration: "WC 234-567",
        type: "Flatbed",
        make: "Mercedes",
        model: "Actros",
        year: 2018,
        vin: "FAKEVIN42345678901",
        currentMileageKm: 156700,
        isActive: true,
      },
    },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );

  const scheduledFar = hoursFromNow(30); // >24h (matches Fleet cancellation demo)
  const scheduledSoon = hoursFromNow(6); // <24h

  // ── Jobs (mirror Fleet dashboard cards / mechanic feed variety) ────────────
  // Legacy: posted tyre demo used TF-8819; TF-8819 is now the “Battery replacement”
  // pending-review card. Migrate old POSTED TF-8819 so re-seed does not leave duplicates.
  const legacyPosted8819 = await Job.findOne({ jobCode: "TF-8819" });
  if (legacyPosted8819?.status === JOB_STATUS.POSTED) {
    await Quote.deleteMany({ job: legacyPosted8819._id });
    await Invoice.deleteMany({ job: legacyPosted8819._id });
    await Job.deleteOne({ _id: legacyPosted8819._id });
  }

  const jobPosted = await upsertJobByCode({
    jobCode: "TF-8825",
    build: () => ({
      fleet: fleet._id,
      assignedMechanic: null,
      assignedCompany: null,
      acceptedQuote: null,
      vehicle: {
        registration: "GP 112-033",
        make: "Scania",
        model: "R450",
        type: "Rigid Truck",
      },
      issueType: ISSUE_TYPES.TYRES,
      title: "Left rear tyre blowout",
      description: "Left rear tyre blowout — N14 off-ramp",
      urgency: JOB_URGENCY.CRITICAL,
      mode: "EMERGENCY",
      location: {
        type: "Point",
        coordinates: [-1.8904, 52.4862], // Birmingham-ish
        address: "M6 Motorway, Corley Services, Warwickshire",
      },
      status: JOB_STATUS.POSTED,
      postedAt: minutesAgo(18),
      quoteCount: 3,
      estimatedPayout: 95,
      currency: "GBP",
    }),
  });

  // Open job on Postman default coords (Manchester) — company/mechanic `?feed=true` uses POSTED|QUOTING + radius
  await upsertJobByCode({
    jobCode: "TF-MCR01",
    build: () => ({
      fleet: fleet._id,
      assignedMechanic: null,
      assignedCompany: null,
      acceptedQuote: null,
      vehicle: {
        registration: "KZN 78-99",
        make: "Volvo",
        model: "FH16",
        type: "Tanker",
      },
      issueType: ISSUE_TYPES.ENGINE,
      title: "AdBlue fault — limp mode",
      description: "AdBlue warning and power loss — Piccadilly area, need company quote",
      urgency: JOB_URGENCY.HIGH,
      mode: "EMERGENCY",
      location: {
        type: "Point",
        coordinates: [-2.2426, 53.4808],
        address: "Piccadilly, Manchester M1",
      },
      status: JOB_STATUS.POSTED,
      postedAt: minutesAgo(9),
      quoteCount: 0,
      estimatedPayout: 118,
      currency: "GBP",
    }),
  });

  const jobCompanyFeedQuote1 = await upsertJobByCode({
    jobCode: "TF-FEEDQ1",
    build: () => ({
      fleet: fleet._id,
      assignedMechanic: null,
      assignedCompany: null,
      acceptedQuote: null,
      vehicle: { registration: "DAF 8898", make: "DAF", model: "CF", type: "Rigid Truck" },
      issueType: ISSUE_TYPES.OVERHEATING,
      title: "Oil leak",
      description: "Company “My quotes” tab — pending quote (WAITING).",
      urgency: JOB_URGENCY.HIGH,
      mode: "EMERGENCY",
      location: {
        type: "Point",
        coordinates: [-2.28, 53.49],
        address: "M6 Services",
      },
      status: JOB_STATUS.QUOTING,
      postedAt: minutesAgo(130),
      quoteCount: 1,
      estimatedPayout: 320,
      currency: "GBP",
    }),
  });

  const jobCompanyFeedQuote2 = await upsertJobByCode({
    jobCode: "TF-FEEDQ2",
    build: () => ({
      fleet: fleet._id,
      assignedMechanic: null,
      assignedCompany: company._id,
      acceptedQuote: null,
      vehicle: { registration: "IV 8899", make: "Iveco", model: "Stralis", type: "Truck" },
      issueType: ISSUE_TYPES.BATTERY_FAILURE_JUMP_START,
      title: "Battery dead",
      description: "Accepted company quote — assign mechanic (ACCEPTED).",
      urgency: JOB_URGENCY.MEDIUM,
      mode: "EMERGENCY",
      location: {
        type: "Point",
        coordinates: [-1.89, 52.48],
        address: "Birmingham",
      },
      status: JOB_STATUS.ASSIGNED,
      postedAt: minutesAgo(250),
      assignedAt: minutesAgo(240),
      quoteCount: 1,
      acceptedAmount: 180,
      currency: "GBP",
    }),
  });

  const jobCompanyFeedQuote3 = await upsertJobByCode({
    jobCode: "TF-FEEDQ3",
    build: () => ({
      fleet: fleet._id,
      assignedMechanic: null,
      assignedCompany: null,
      acceptedQuote: null,
      vehicle: { registration: "RN 8897", make: "Renault", model: "T-High", type: "Truck" },
      issueType: ISSUE_TYPES.BREAKDOWN_UNKNOWN_ISSUE,
      title: "Suspension fault",
      description: "Fleet declined company quote (DECLINED).",
      urgency: JOB_URGENCY.MEDIUM,
      mode: "EMERGENCY",
      location: {
        type: "Point",
        coordinates: [-2.25, 53.48],
        address: "Manchester",
      },
      status: JOB_STATUS.POSTED,
      postedAt: minutesAgo(1500),
      quoteCount: 1,
      estimatedPayout: 540,
      currency: "GBP",
    }),
  });

  const jobAssignedCompanyNoMechanic = await upsertJobByCode({
    jobCode: "TF-8819C",
    build: () => ({
      fleet: fleet._id,
      assignedMechanic: null,
      assignedCompany: company._id,
      acceptedQuote: null,
      vehicle: {
        registration: "GP 112-033",
        make: "Scania",
        model: "R450",
        type: "Rigid Truck",
      },
      issueType: ISSUE_TYPES.TYRES,
      title: "Tyre blowout — company booked",
      description: "Left rear tyre blowout — scheduled via company dispatch",
      urgency: JOB_URGENCY.HIGH,
      mode: "SCHEDULABLE",
      scheduledFor: scheduledFar,
      location: {
        type: "Point",
        coordinates: [-1.9048, 52.4826],
        address: "M6 Services (northbound)",
      },
      status: JOB_STATUS.ASSIGNED,
      postedAt: minutesAgo(120),
      assignedAt: minutesAgo(60),
      quoteCount: 1,
      acceptedAmount: 95,
      currency: "GBP",
    }),
  });

  await upsertJobByCode({
    jobCode: "TF-8819D",
    build: () => ({
      fleet: fleet._id,
      assignedMechanic: null,
      assignedCompany: company._id,
      acceptedQuote: null,
      vehicle: {
        registration: "LD 100-AA",
        make: "Iveco",
        model: "Daily",
        type: "Van",
      },
      issueType: ISSUE_TYPES.BRAKES,
      title: "Hydraulics warning — company booked",
      description: "Second unassigned company job for dashboard / Jobs tab badge.",
      urgency: JOB_URGENCY.MEDIUM,
      mode: "SCHEDULABLE",
      scheduledFor: scheduledFar,
      location: {
        type: "Point",
        coordinates: [-1.91, 52.49],
        address: "M6 Corley area",
      },
      status: JOB_STATUS.ASSIGNED,
      postedAt: minutesAgo(100),
      assignedAt: minutesAgo(55),
      quoteCount: 0,
      acceptedAmount: 120,
      currency: "GBP",
    }),
  });

  const jobEnRoute = await upsertJobByCode({
    jobCode: "TF-8821",
    build: () => ({
      fleet: fleet._id,
      assignedMechanic: james._id,
      assignedCompany: company._id,
      vehicle: {
        registration: "CA 456-789",
        make: "DAF",
        model: "XF",
        type: "Tautliner",
      },
      issueType: ISSUE_TYPES.ENGINE,
      title: "Engine overheating",
      description: "Engine overheating — coolant leak suspected",
      urgency: JOB_URGENCY.HIGH,
      mode: "EMERGENCY",
      location: {
        type: "Point",
        coordinates: [-2.2426, 53.4808],
        address: "M1 Motorway, Junction 24 — Leicester Services",
      },
      status: JOB_STATUS.EN_ROUTE,
      postedAt: minutesAgo(35),
      assignedAt: minutesAgo(28),
      tracking: { etaMinutes: 18 },
      quoteCount: 1,
      acceptedAmount: 165,
      currency: "GBP",
    }),
  });

  const jobScheduledEnRoute = await upsertJobByCode({
    jobCode: "TF-8822",
    build: () => ({
      fleet: fleet._id,
      assignedMechanic: james._id,
      assignedCompany: company._id,
      vehicle: {
        registration: "KZN 78-99",
        make: "Volvo",
        model: "FH16",
        type: "Tanker",
      },
      issueType: ISSUE_TYPES.BRAKES,
      title: "Air brake fault",
      description: "Air brake fault — A1 Leeds",
      urgency: JOB_URGENCY.HIGH,
      mode: "SCHEDULABLE",
      scheduledFor: scheduledSoon,
      location: {
        type: "Point",
        coordinates: [-1.5491, 53.8008],
        address: "A1 Leeds area",
      },
      status: JOB_STATUS.EN_ROUTE,
      postedAt: minutesAgo(200),
      assignedAt: minutesAgo(120),
      tracking: { etaMinutes: 12 },
      quoteCount: 1,
      acceptedAmount: 310,
      currency: "GBP",
    }),
  });

  const jobOnSite = await upsertJobByCode({
    jobCode: "TF-8814",
    build: () => ({
      fleet: fleet._id,
      assignedMechanic: paul._id,
      assignedCompany: company._id,
      vehicle: {
        registration: "WC 234-567",
        make: "Mercedes",
        model: "Actros",
        type: "Flatbed",
      },
      issueType: ISSUE_TYPES.ENGINE,
      title: "Fuel leak suspected",
      description: "Fuel leak suspected — M25 London",
      urgency: JOB_URGENCY.MEDIUM,
      mode: "EMERGENCY",
      location: {
        type: "Point",
        coordinates: [-0.1278, 51.5074],
        address: "M25 London corridor",
      },
      status: JOB_STATUS.ON_SITE,
      postedAt: minutesAgo(400),
      assignedAt: minutesAgo(360),
      quoteCount: 1,
      acceptedAmount: 185,
      currency: "GBP",
    }),
  });

  const jobAwaitingApproval = await upsertJobByCode({
    jobCode: "TF-8823",
    build: () => ({
      fleet: fleet._id,
      assignedMechanic: james._id,
      assignedCompany: company._id,
      vehicle: {
        registration: "WC 234-567",
        make: "Mercedes",
        model: "Actros",
        type: "Flatbed",
      },
      issueType: ISSUE_TYPES.BRAKES,
      title: "Brake system repair — awaiting approval",
      description: "Brake system repair — awaiting your approval",
      urgency: JOB_URGENCY.MEDIUM,
      mode: "EMERGENCY",
      location: {
        type: "Point",
        coordinates: [-2.5964, 51.4556],
        address: "M5 Sedgemoor Services, Somerset",
      },
      tracking: {
        etaMinutes: 9,
        latestMechanicLocation: {
          point: { type: "Point", coordinates: [-2.62, 51.44] },
          heading: 315,
          speed: 0,
          accuracy: 11,
          updatedAt: minutesAgo(25),
        },
      },
      status: JOB_STATUS.AWAITING_APPROVAL,
      postedAt: minutesAgo(900),
      assignedAt: minutesAgo(860),
      completionSummary: "Pads replaced, fluid topped up, test drive OK.",
      finalAmount: 275,
      currency: "GBP",
    }),
  });

  const jobAwaitingApproval2 = await upsertJobByCode({
    jobCode: "TF-8824",
    build: () => ({
      fleet: fleet._id,
      assignedMechanic: paul._id,
      assignedCompany: company._id,
      vehicle: {
        registration: "SN 441-TP",
        make: "Scania",
        model: "R450",
        type: "Tractor",
      },
      issueType: ISSUE_TYPES.ELECTRICAL,
      title: "Trailer ABS / EBS warning",
      description: "Intermittent trailer ABS fault — additional Pending Review demo.",
      urgency: JOB_URGENCY.MEDIUM,
      mode: "EMERGENCY",
      location: {
        type: "Point",
        coordinates: [-0.5, 51.95],
        address: "M1 Toddington Services",
      },
      status: JOB_STATUS.AWAITING_APPROVAL,
      postedAt: minutesAgo(380),
      assignedAt: minutesAgo(360),
      completedAt: minutesAgo(90),
      completionSummary: "Wiring harness repaired; lamp test clear.",
      finalAmount: 312,
      acceptedAmount: 312,
      currency: "GBP",
    }),
  });

  await upsertJobByCode({
    jobCode: "TF-8819",
    build: () => ({
      fleet: fleet._id,
      assignedMechanic: empMikeJohnson._id,
      assignedCompany: company._id,
      acceptedQuote: null,
      vehicle: {
        registration: "IV 998-AA",
        make: "Iveco",
        model: "Stralis",
        type: "Truck",
      },
      issueType: ISSUE_TYPES.BATTERY_FAILURE_JUMP_START,
      title: "Battery replacement",
      description: "Battery replacement — Birmingham Depot",
      urgency: JOB_URGENCY.MEDIUM,
      mode: "EMERGENCY",
      location: {
        type: "Point",
        coordinates: [-1.9, 52.48],
        address: "Birmingham Depot",
      },
      tracking: {
        etaMinutes: 6,
        latestMechanicLocation: {
          point: { type: "Point", coordinates: [-1.88, 52.47] },
          heading: 95,
          speed: 0,
          accuracy: 9,
          updatedAt: minutesAgo(20),
        },
      },
      status: JOB_STATUS.AWAITING_APPROVAL,
      postedAt: minutesAgo(500),
      assignedAt: minutesAgo(480),
      completedAt: minutesAgo(240),
      completionSummary: "Battery swapped; start/stop verified.",
      finalAmount: 228.75,
      acceptedAmount: 228.75,
      currency: "GBP",
    }),
  });

  await upsertJobByCode({
    jobCode: "TF-8999",
    build: () => ({
      fleet: fleet._id,
      assignedMechanic: empJohnSmith._id,
      assignedCompany: company._id,
      vehicle: {
        registration: "GB SEED 99",
        make: "DAF",
        model: "XF",
        type: "Tautliner",
      },
      issueType: ISSUE_TYPES.DIAGNOSTIC_CHECK,
      title: "Demo — awaiting approval (API tests)",
      description: "Seed job for PATCH /jobs/:id/complete/approve or /company/jobs/:id/complete/approve.",
      urgency: JOB_URGENCY.MEDIUM,
      mode: "EMERGENCY",
      location: {
        type: "Point",
        coordinates: [-1.89, 52.48],
        address: "Birmingham (seed demo)",
      },
      status: JOB_STATUS.AWAITING_APPROVAL,
      postedAt: minutesAgo(200),
      assignedAt: minutesAgo(180),
      completedAt: minutesAgo(20),
      completionSummary: "Seed demo completion — approve to close.",
      finalAmount: 228.75,
      acceptedAmount: 228.75,
      currency: "GBP",
    }),
  });

  const jobCompanyCompletedMonth = await upsertJobByCode({
    jobCode: "TF-8890C",
    build: () => ({
      fleet: fleet._id,
      assignedMechanic: james._id,
      assignedCompany: company._id,
      acceptedQuote: null,
      vehicle: {
        registration: "LD 100-AA",
        make: "Iveco",
        model: "Daily",
        type: "Van",
      },
      issueType: ISSUE_TYPES.BATTERY,
      title: "Battery swap — completed (company earnings demo)",
      description: "Completed this month for GET /company/earnings/* and dashboard revenue.",
      urgency: JOB_URGENCY.MEDIUM,
      mode: "EMERGENCY",
      location: {
        type: "Point",
        coordinates: [-1.9048, 52.4826],
        address: "Manchester industrial estate",
      },
      status: JOB_STATUS.COMPLETED,
      postedAt: minutesAgo(9000),
      assignedAt: minutesAgo(8900),
      completedAt: minutesAgo(36),
      finalAmount: 185,
      acceptedAmount: 185,
      currency: "GBP",
      completionSummary: "Battery replaced; charging verified.",
    }),
  });

  await upsertJobByCode({
    jobCode: "TF-8700P",
    build: () => ({
      fleet: fleet._id,
      assignedMechanic: tom._id,
      assignedCompany: company._id,
      acceptedQuote: null,
      vehicle: {
        registration: "XX 001-AA",
        make: "DAF",
        model: "XF",
        type: "Truck",
      },
      issueType: ISSUE_TYPES.ENGINE,
      title: "Prior month revenue (dashboard MoM demo)",
      description: "Completed in the previous calendar month.",
      urgency: JOB_URGENCY.LOW,
      mode: "EMERGENCY",
      location: {
        type: "Point",
        coordinates: [-1.55, 52.4],
        address: "Seed prior month",
      },
      status: JOB_STATUS.COMPLETED,
      postedAt: new Date(new Date().getFullYear(), new Date().getMonth() - 1, 5, 10, 0, 0, 0),
      assignedAt: new Date(new Date().getFullYear(), new Date().getMonth() - 1, 6, 10, 0, 0, 0),
      completedAt: prevMonthNoon(),
      finalAmount: 2400,
      acceptedAmount: 2400,
      currency: "GBP",
      completionSummary: "Prior month seed completion.",
    }),
  });

  const jobPendingReview8820 = await upsertJobByCode({
    jobCode: "TF-8820",
    build: () => ({
      fleet: fleet._id,
      assignedMechanic: empJohnSmith._id,
      assignedCompany: company._id,
      acceptedQuote: null,
      vehicle: {
        registration: "MN 77-TGX",
        make: "MAN",
        model: "TGX",
        type: "Truck",
      },
      issueType: ISSUE_TYPES.BREAKDOWN_UNKNOWN_ISSUE,
      title: "Hydraulic system fault",
      description: "Hydraulic system fault — M6 Services",
      urgency: JOB_URGENCY.HIGH,
      mode: "EMERGENCY",
      location: {
        type: "Point",
        coordinates: [-2.31, 53.52],
        address: "M6 Services",
      },
      status: JOB_STATUS.AWAITING_APPROVAL,
      postedAt: minutesAgo(420),
      assignedAt: minutesAgo(400),
      completedAt: minutesAgo(120),
      finalAmount: 397.5,
      acceptedAmount: 397.5,
      currency: "GBP",
      completionSummary: "Hydraulics repaired; pressure test OK.",
    }),
  });

  const jobJohnUnassigned = await upsertJobByCode({
    jobCode: "TF-JC01",
    build: () => ({
      fleet: fleet._id,
      assignedMechanic: null,
      assignedCompany: johnCompany._id,
      acceptedQuote: null,
      vehicle: {
        registration: "ZA 900-001",
        make: "Volvo",
        model: "FH",
        type: "Truck",
      },
      issueType: ISSUE_TYPES.ENGINE,
      title: "John Co — dispatch queue (no mechanic yet)",
      description: "Use GET /company/jobs?tab=unassigned and dashboard unassigned list.",
      urgency: JOB_URGENCY.HIGH,
      mode: "EMERGENCY",
      location: {
        type: "Point",
        coordinates: [28.0473, -26.2041],
        address: "Johannesburg depot",
      },
      status: JOB_STATUS.ASSIGNED,
      postedAt: minutesAgo(220),
      assignedAt: minutesAgo(140),
      quoteCount: 0,
      acceptedAmount: 210,
      currency: "GBP",
    }),
  });

  const jobJohnCompleted = await upsertJobByCode({
    jobCode: "TF-JC02",
    build: () => ({
      fleet: fleet._id,
      assignedMechanic: james._id,
      assignedCompany: johnCompany._id,
      acceptedQuote: null,
      vehicle: {
        registration: "ZA 900-002",
        make: "Mercedes",
        model: "Actros",
        type: "Truck",
      },
      issueType: ISSUE_TYPES.TYRES,
      title: "John Co — completed tyre job (earnings row)",
      description: "Completed this month for John Mechanic Repairs company account.",
      urgency: JOB_URGENCY.MEDIUM,
      mode: "EMERGENCY",
      location: {
        type: "Point",
        coordinates: [27.855689, -26.110949],
        address: "Krugersdorp",
      },
      status: JOB_STATUS.COMPLETED,
      postedAt: minutesAgo(9200),
      assignedAt: minutesAgo(9100),
      completedAt: minutesAgo(72),
      finalAmount: 220,
      acceptedAmount: 220,
      currency: "GBP",
      completionSummary: "Tyre replaced and torqued.",
    }),
  });

  /** James — paid completed jobs for GET /earnings/jobs + summary (EarningTransaction synced in ensureInvoiceForJob). */
  const completedAt8810 = new Date(2026, 2, 7, 11, 15, 0, 0);
  const jobEarning8810 = await upsertJobByCode({
    jobCode: "TF-8810",
    build: () => ({
      fleet: fleet._id,
      assignedMechanic: james._id,
      assignedCompany: company._id,
      acceptedQuote: null,
      vehicle: {
        registration: "GP 221-560",
        make: "Scania",
        model: "R450",
        type: "Rigid 8T",
      },
      issueType: ISSUE_TYPES.ENGINE,
      title: "Fuel system fault",
      description: "Fuel pressure / rail fault — roadside repair.",
      urgency: JOB_URGENCY.MEDIUM,
      mode: "EMERGENCY",
      location: {
        type: "Point",
        coordinates: [-2.24, 53.48],
        address: "M62 corridor",
      },
      status: JOB_STATUS.COMPLETED,
      postedAt: new Date(2026, 2, 6, 9, 0, 0, 0),
      assignedAt: new Date(completedAt8810.getTime() - 105 * 60 * 1000),
      completedAt: completedAt8810,
      finalAmount: 185,
      acceptedAmount: 185,
      currency: "GBP",
      completionSummary: "Fuel system fault",
    }),
  });

  const completedAt8797 = new Date(2026, 2, 5, 14, 0, 0, 0);
  const jobEarning8797 = await upsertJobByCode({
    jobCode: "TF-8797",
    build: () => ({
      fleet: fleet._id,
      assignedMechanic: james._id,
      assignedCompany: company._id,
      acceptedQuote: null,
      vehicle: {
        registration: "WC 334-112",
        make: "Mercedes",
        model: "Actros",
        type: "Flatbed",
      },
      issueType: ISSUE_TYPES.TYRES,
      title: "Tyre replacement x2",
      description: "Dual tyre replacement — near side rear.",
      urgency: JOB_URGENCY.MEDIUM,
      mode: "EMERGENCY",
      location: {
        type: "Point",
        coordinates: [-1.9, 52.45],
        address: "M6 Knutsford",
      },
      status: JOB_STATUS.COMPLETED,
      postedAt: new Date(2026, 2, 4, 10, 0, 0, 0),
      assignedAt: new Date(completedAt8797.getTime() - 88 * 60 * 1000),
      completedAt: completedAt8797,
      finalAmount: 140,
      acceptedAmount: 140,
      currency: "GBP",
      completionSummary: "Tyre replacement x2",
    }),
  });

  const completedAt8775 = new Date(2026, 1, 18, 16, 0, 0, 0);
  const jobEarning8775 = await upsertJobByCode({
    jobCode: "TF-8775",
    build: () => ({
      fleet: fleet._id,
      assignedMechanic: james._id,
      assignedCompany: company._id,
      acceptedQuote: null,
      vehicle: {
        registration: "CA 456-789",
        make: "DAF",
        model: "XF",
        type: "Tautliner",
      },
      issueType: ISSUE_TYPES.BRAKES,
      title: "Brake chamber replacement",
      description: "NSF brake chamber — completed Feb demo.",
      urgency: JOB_URGENCY.MEDIUM,
      mode: "EMERGENCY",
      location: {
        type: "Point",
        coordinates: [-2.1, 53.4],
        address: "M1 Leicester",
      },
      status: JOB_STATUS.COMPLETED,
      postedAt: new Date(2026, 1, 17, 9, 0, 0, 0),
      assignedAt: new Date(completedAt8775.getTime() - 120 * 60 * 1000),
      completedAt: completedAt8775,
      finalAmount: 1100,
      acceptedAmount: 1100,
      currency: "GBP",
      completionSummary: "Chamber replaced; brake test OK.",
    }),
  });

  const completedAt8761 = new Date(2026, 0, 14, 13, 30, 0, 0);
  const jobEarning8761 = await upsertJobByCode({
    jobCode: "TF-8761",
    build: () => ({
      fleet: fleet._id,
      assignedMechanic: james._id,
      assignedCompany: company._id,
      acceptedQuote: null,
      vehicle: {
        registration: "KZN 78-99",
        make: "Volvo",
        model: "FH16",
        type: "Tanker",
      },
      issueType: ISSUE_TYPES.ELECTRICAL,
      title: "Lighting harness repair",
      description: "Trailer lighting fault — Jan demo earnings.",
      urgency: JOB_URGENCY.LOW,
      mode: "EMERGENCY",
      location: {
        type: "Point",
        coordinates: [-1.55, 53.8],
        address: "A1 Leeds",
      },
      status: JOB_STATUS.COMPLETED,
      postedAt: new Date(2026, 0, 13, 10, 0, 0, 0),
      assignedAt: new Date(completedAt8761.getTime() - 95 * 60 * 1000),
      completedAt: completedAt8761,
      finalAmount: 960,
      acceptedAmount: 960,
      currency: "GBP",
      completionSummary: "Harness repaired; lamp check OK.",
    }),
  });

  await ensureInvoiceForJob({
    invoiceNo: "INV-SEED-SWIFT-8890C",
    job: jobCompanyCompletedMonth,
    fleet,
    mechanic: james,
  });

  await ensureInvoiceForJob({
    invoiceNo: "INV-SEED-JOHN-JC02",
    job: jobJohnCompleted,
    fleet,
    mechanic: james,
  });

  await ensureInvoiceForJob({
    invoiceNo: "INV-TF-8810",
    job: jobEarning8810,
    fleet,
    mechanic: james,
    extra: {
      lineItems: [
        { description: "Labour", quantity: 1, unitAmount: 102, totalAmount: 102 },
        { description: "Call-out Fee", quantity: 1, unitAmount: 35, totalAmount: 35 },
        { description: "Parts & Materials", quantity: 1, unitAmount: 46, totalAmount: 46 },
      ],
      subtotal: 185,
      vatAmount: 37,
      totalAmount: 222,
      billedCompanyName: "Logistix Transport (Pty) Ltd",
    },
  });

  await ensureInvoiceForJob({
    invoiceNo: "INV-TF-8797",
    job: jobEarning8797,
    fleet,
    mechanic: james,
  });

  await ensureInvoiceForJob({
    invoiceNo: "INV-TF-8775",
    job: jobEarning8775,
    fleet,
    mechanic: james,
  });

  await ensureInvoiceForJob({
    invoiceNo: "INV-TF-8761",
    job: jobEarning8761,
    fleet,
    mechanic: james,
  });

  await ensureReviewForSeedJob({ job: jobCompanyCompletedMonth, fleet, mechanic: james });
  await ensureReviewForSeedJob({ job: jobJohnCompleted, fleet, mechanic: james });
  await ensureReviewForSeedJob({
    job: jobEarning8810,
    fleet,
    mechanic: james,
    comment: "Great communication and fast fix on the roadside.",
  });
  await ensureReviewForSeedJob({
    job: jobEarning8797,
    fleet,
    mechanic: james,
    comment: "Professional service — tyres fitted quickly.",
  });
  await ensureReviewForSeedJob({ job: jobEarning8775, fleet, mechanic: james });
  await ensureReviewForSeedJob({ job: jobEarning8761, fleet, mechanic: james });

  await ensureCompanyInvite({ company, email: "pending.join+swift@truckfix.dev", invitedBy: company });
  await ensureCompanyInvite({ company: johnCompany, email: "pending.join+john@truckfix.dev", invitedBy: johnCompany });

  // ── Quotes ───────────────────────────────────────────────────────────────────
  // Posted job: multiple competing quotes (Fleet “quotes received” demo)
  await ensureQuote({
    job: jobPosted,
    fleet,
    mechanic: james,
    company,
    submittedBy: james,
    data: {
      amount: 145,
      notes: "Fastest response — includes call-out + tyre change estimate.",
      etaMinutes: 12,
      availabilityType: QUOTE_AVAILABILITY.NOW,
      currency: "GBP",
      status: QUOTE_STATUS.WAITING,
      expiresAt: null,
    },
  });
  await ensureQuote({
    job: jobPosted,
    fleet,
    mechanic: tom,
    company,
    submittedBy: tom,
    data: {
      amount: 135,
      notes: "Can attend within 22 minutes.",
      etaMinutes: 22,
      availabilityType: QUOTE_AVAILABILITY.IN_30_MIN,
      currency: "GBP",
      status: QUOTE_STATUS.WAITING,
      expiresAt: null,
    },
  });
  await ensureQuote({
    job: jobPosted,
    fleet,
    mechanic: paul,
    company,
    submittedBy: paul,
    data: {
      amount: 118,
      notes: "Available but farther away — lower labour estimate.",
      etaMinutes: 31,
      availabilityType: QUOTE_AVAILABILITY.IN_1_HOUR,
      currency: "GBP",
      status: QUOTE_STATUS.WAITING,
      expiresAt: null,
    },
  });

  // Accepted quote for EN_ROUTE job (ties mechanic + accepted pricing)
  const q8821 = await ensureQuote({
    job: jobEnRoute,
    fleet,
    mechanic: james,
    company,
    submittedBy: james,
    data: {
      amount: 165,
      notes: "Accepted quote — en route now.",
      etaMinutes: 18,
      availabilityType: QUOTE_AVAILABILITY.NOW,
      currency: "GBP",
      status: QUOTE_STATUS.ACCEPTED,
      acceptedAt: minutesAgo(26),
      expiresAt: null,
    },
  });
  await Job.updateOne(
    { _id: jobEnRoute._id },
    { $set: { acceptedQuote: q8821._id, acceptedAmount: 165, quoteCount: 1 } }
  );

  await ensureQuote({
    job: jobScheduledEnRoute,
    fleet,
    mechanic: james,
    company,
    submittedBy: james,
    data: {
      amount: 310,
      notes: "Scheduled booking — travel included.",
      etaMinutes: 12,
      availabilityType: QUOTE_AVAILABILITY.SCHEDULED,
      scheduledAt: scheduledSoon,
      currency: "GBP",
      status: QUOTE_STATUS.ACCEPTED,
      acceptedAt: minutesAgo(150),
    },
  });

  await ensureQuote({
    job: jobOnSite,
    fleet,
    mechanic: paul,
    company,
    submittedBy: paul,
    data: {
      amount: 185,
      notes: "On site — diagnosis + temporary seal applied.",
      currency: "GBP",
      status: QUOTE_STATUS.ACCEPTED,
      acceptedAt: minutesAgo(300),
    },
  });

  await ensureQuote({
    job: jobAwaitingApproval,
    fleet,
    mechanic: james,
    company,
    submittedBy: james,
    data: {
      amount: 275,
      notes: "Work completed — awaiting fleet approval to release payment.",
      currency: "GBP",
      status: QUOTE_STATUS.ACCEPTED,
      acceptedAt: minutesAgo(700),
    },
  });

  // Company-assigned job (simple accepted quote; assignment happens outside quote flow in product)
  await ensureQuote({
    job: jobAssignedCompanyNoMechanic,
    fleet,
    mechanic: tom,
    company,
    submittedBy: tom,
    data: {
      amount: 95,
      notes: "Company dispatch slot booked.",
      currency: "GBP",
      status: QUOTE_STATUS.ACCEPTED,
      acceptedAt: minutesAgo(90),
    },
  });

  await Quote.findOneAndUpdate(
    { job: jobCompanyFeedQuote1._id, mechanic: company._id },
    {
      $set: {
        job: jobCompanyFeedQuote1._id,
        fleet: fleet._id,
        mechanic: company._id,
        company: company._id,
        submittedBy: company._id,
        amount: 320,
        currency: "GBP",
        status: QUOTE_STATUS.WAITING,
        notes: "Swift company dispatch quote (seed)",
        availabilityType: QUOTE_AVAILABILITY.NOW,
        etaMinutes: 35,
        expiresAt: null,
      },
    },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );
  await Quote.findOneAndUpdate(
    { job: jobCompanyFeedQuote2._id, mechanic: company._id },
    {
      $set: {
        job: jobCompanyFeedQuote2._id,
        fleet: fleet._id,
        mechanic: company._id,
        company: company._id,
        submittedBy: company._id,
        amount: 180,
        currency: "GBP",
        status: QUOTE_STATUS.ACCEPTED,
        notes: "Accepted — assign a mechanic from Team",
        availabilityType: QUOTE_AVAILABILITY.NOW,
        etaMinutes: 20,
        acceptedAt: minutesAgo(240),
        expiresAt: null,
      },
    },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );
  await Quote.findOneAndUpdate(
    { job: jobCompanyFeedQuote3._id, mechanic: company._id },
    {
      $set: {
        job: jobCompanyFeedQuote3._id,
        fleet: fleet._id,
        mechanic: company._id,
        company: company._id,
        submittedBy: company._id,
        amount: 540,
        currency: "GBP",
        status: QUOTE_STATUS.DECLINED,
        notes: "Fleet selected another provider",
        availabilityType: QUOTE_AVAILABILITY.NOW,
        etaMinutes: 40,
        declinedAt: minutesAgo(1400),
        expiresAt: null,
      },
    },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );

  // ── Job events (company dashboard "recent activity") ───────────────────────
  await JobEvent.deleteMany({ "payload.seedTag": "company-dashboard-demo" });
  await JobEvent.insertMany([
    {
      job: jobPendingReview8820._id,
      actor: empJohnSmith._id,
      type: "JOB_COMPLETED",
      note: "Mechanic completed TF-8820 — pending invoice review",
      toStatus: JOB_STATUS.AWAITING_APPROVAL,
      payload: {
        companyId: company._id,
        seedTag: "company-dashboard-demo",
        jobCode: "TF-8820",
        ui: { title: "Pending review", detail: "TF-8820 — John Smith", icon: "CHECK" },
      },
      createdAt: minutesAgo(5),
    },
    {
      job: jobScheduledEnRoute._id,
      actor: company._id,
      type: "MECHANIC_ASSIGNED",
      note: "Mike Johnson assigned to TF-8822",
      toStatus: JOB_STATUS.EN_ROUTE,
      payload: {
        companyId: company._id,
        mechanicId: empMikeJohnson._id,
        seedTag: "company-dashboard-demo",
        jobCode: "TF-8822",
        ui: { title: "New job assigned", detail: "TF-8822 to Mike Johnson", icon: "BRIEFCASE" },
      },
      createdAt: minutesAgo(25),
    },
    {
      job: jobScheduledEnRoute._id,
      actor: empDaveWilson._id,
      type: "SHIFT_STARTED",
      note: "Dave Wilson started shift",
      payload: {
        companyId: company._id,
        seedTag: "company-dashboard-demo",
        ui: { title: "Mechanic online", detail: "Dave Wilson started shift", icon: "PERSON" },
      },
      createdAt: minutesAgo(60),
    },
    {
      job: jobAssignedCompanyNoMechanic._id,
      actor: company._id,
      type: "COMPANY_JOB_BOOKED",
      note: "Company job TF-8819C — assign a mechanic",
      toStatus: JOB_STATUS.ASSIGNED,
      payload: {
        companyId: company._id,
        seedTag: "company-dashboard-demo",
        jobCode: "TF-8819C",
      },
      createdAt: minutesAgo(58),
    },
    {
      job: jobEnRoute._id,
      actor: james._id,
      type: "MECHANIC_EN_ROUTE",
      note: "James en route for TF-8821",
      toStatus: JOB_STATUS.EN_ROUTE,
      payload: { companyId: company._id, seedTag: "company-dashboard-demo", jobCode: "TF-8821" },
      createdAt: minutesAgo(28),
    },
    {
      job: jobOnSite._id,
      actor: paul._id,
      type: "MECHANIC_ON_SITE",
      note: "Paul on site — TF-8814",
      toStatus: JOB_STATUS.ON_SITE,
      payload: { companyId: company._id, seedTag: "company-dashboard-demo", jobCode: "TF-8814" },
      createdAt: minutesAgo(120),
    },
    {
      job: jobCompanyCompletedMonth._id,
      actor: james._id,
      type: "JOB_COMPLETED",
      note: "Swift company — TF-8890C completed (earnings demo)",
      toStatus: JOB_STATUS.COMPLETED,
      payload: { companyId: company._id, seedTag: "company-dashboard-demo", jobCode: "TF-8890C" },
      createdAt: minutesAgo(35),
    },
    {
      job: jobJohnUnassigned._id,
      actor: johnCompany._id,
      type: "COMPANY_JOB_BOOKED",
      note: "John Co — TF-JC01 awaiting mechanic",
      toStatus: JOB_STATUS.ASSIGNED,
      payload: { companyId: johnCompany._id, seedTag: "company-dashboard-demo", jobCode: "TF-JC01" },
      createdAt: minutesAgo(44),
    },
    {
      job: jobJohnCompleted._id,
      actor: james._id,
      type: "JOB_COMPLETED",
      note: "John Co — TF-JC02 completed",
      toStatus: JOB_STATUS.COMPLETED,
      payload: { companyId: johnCompany._id, seedTag: "company-dashboard-demo", jobCode: "TF-JC02" },
      createdAt: minutesAgo(70),
    },
  ]);

  // ── Notifications (lightweight UI parity) ───────────────────────────────────
  await ensureAtLeastNotifications(fleet._id, 2, (i) => ({
    user: fleet._id,
    type: i === 0 ? "QUOTE_RECEIVED" : "JOB_UPDATE",
    title: i === 0 ? "New quote received" : "Mechanic is en route",
    body:
      i === 0
        ? "James Mitchell quoted £145 on TF-8825"
        : "James Mitchell is en route for TF-8821",
    data: { jobCode: i === 0 ? "TF-8825" : "TF-8821" },
    isRead: false,
  }));

  await ensureAtLeastNotifications(james._id, 2, (i) => ({
    user: james._id,
    type: i === 0 ? "NEW_JOB" : "JOB_ASSIGNED",
    title: i === 0 ? "New breakdown nearby" : "You’ve been assigned",
    body:
      i === 0
        ? "New posted job TF-8825 within your radius"
        : "You’re assigned to TF-8821",
    data: { jobCode: i === 0 ? "TF-8825" : "TF-8821" },
    isRead: false,
  }));

  // Keep dashboard MoM + revenue rows aligned even when jobs were first inserted under SEED_FORCE=false
  await Job.updateOne({ jobCode: "TF-8890C" }, { $set: { finalAmount: 185, acceptedAmount: 185 } });

  // Company Job Management “Pending review” cards (TF-8820 / TF-8819): always sync so
  // GET /company/jobs matches the prototype UI even when SEED_FORCE=false skipped upserts.
  const companyPendingReview8820 = {
    status: JOB_STATUS.AWAITING_APPROVAL,
    fleet: fleet._id,
    assignedCompany: company._id,
    assignedMechanic: empJohnSmith._id,
    vehicle: {
      registration: "MN 77-TGX",
      make: "MAN",
      model: "TGX",
      type: "Truck",
    },
    issueType: ISSUE_TYPES.BREAKDOWN_UNKNOWN_ISSUE,
    title: "Hydraulic system fault",
    description: "Hydraulic system fault — M6 Services",
    completionSummary: "Hydraulics repaired; pressure test OK.",
    urgency: JOB_URGENCY.HIGH,
    location: {
      type: "Point",
      coordinates: [-2.31, 53.52],
      address: "M6 Services",
    },
    finalAmount: 397.5,
    acceptedAmount: 397.5,
    currency: "GBP",
    assignedAt: minutesAgo(400),
    completedAt: minutesAgo(120),
    postedAt: minutesAgo(420),
  };
  await Job.updateOne({ jobCode: "TF-8820" }, { $set: companyPendingReview8820 });

  const companyPendingReview8819 = {
    status: JOB_STATUS.AWAITING_APPROVAL,
    fleet: fleet._id,
    assignedCompany: company._id,
    assignedMechanic: empMikeJohnson._id,
    vehicle: {
      registration: "IV 998-AA",
      make: "Iveco",
      model: "Stralis",
      type: "Truck",
    },
    issueType: ISSUE_TYPES.BATTERY_FAILURE_JUMP_START,
    title: "Battery replacement",
    description: "Battery replacement — Birmingham Depot",
    completionSummary: "Battery swapped; start/stop verified.",
    urgency: JOB_URGENCY.MEDIUM,
    location: {
      type: "Point",
      coordinates: [-1.9, 52.48],
      address: "Birmingham Depot",
    },
    tracking: {
      etaMinutes: 6,
      latestMechanicLocation: {
        point: { type: "Point", coordinates: [-1.88, 52.47] },
        heading: 95,
        speed: 0,
        accuracy: 9,
        updatedAt: minutesAgo(20),
      },
    },
    finalAmount: 228.75,
    acceptedAmount: 228.75,
    currency: "GBP",
    postedAt: minutesAgo(500),
    assignedAt: minutesAgo(480),
    completedAt: minutesAgo(240),
  };
  await Job.updateOne({ jobCode: "TF-8819" }, { $set: companyPendingReview8819 });

  const job8819Doc = await Job.findOne({ jobCode: "TF-8819" }).select("_id assignedMechanic").lean();
  if (job8819Doc?._id && job8819Doc.assignedMechanic) {
    await JobLocationPing.deleteMany({ job: job8819Doc._id });
    await JobLocationPing.create({
      job: job8819Doc._id,
      mechanic: job8819Doc.assignedMechanic,
      point: { type: "Point", coordinates: [-1.875, 52.465] },
      heading: 88,
      speed: 0,
      accuracy: 10,
      pingedAt: minutesAgo(22),
    });
  }

  const pendingReviewDemoIds = await Job.find({ jobCode: { $in: ["TF-8820", "TF-8819"] } })
    .select("_id")
    .lean();
  const demoJobObjectIds = pendingReviewDemoIds.map((j) => j._id).filter(Boolean);
  if (demoJobObjectIds.length) {
    await Invoice.deleteMany({ job: { $in: demoJobObjectIds } });
  }
  await Invoice.deleteMany({ invoiceNo: "INV-SEED-SWIFT-8820" });

  await Job.updateOne({ jobCode: "TF-8700P" }, { $set: { finalAmount: 2400, acceptedAmount: 2400, completedAt: prevMonthNoon() } });
  await Job.updateOne(
    { jobCode: "TF-8999" },
    {
      $set: {
        status: JOB_STATUS.AWAITING_APPROVAL,
        fleet: fleet._id,
        assignedCompany: company._id,
        assignedMechanic: empJohnSmith._id,
        finalAmount: 228.75,
        acceptedAmount: 228.75,
        completedAt: minutesAgo(20),
        completionSummary: "Seed demo completion — approve to close.",
        currency: "GBP",
      },
    }
  );

  const awaitingApprovalJobs = await Job.find({ status: JOB_STATUS.AWAITING_APPROVAL })
    .select("jobCode _id")
    .sort({ jobCode: 1 })
    .lean();

  await User.updateOne(
    { email: "company@truckfix.dev" },
    {
      $set: {
        "companyProfile.profileMetricsOverride": {
          totalJobs: 156,
          avgRating: 4.8,
          responseMinutesAvg: 8,
        },
      },
    }
  );

  // —— Job chat threads (GET /api/v1/chat/threads) ——
  await Job.updateOne(
    { jobCode: "TF-8810" },
    { $set: { title: "Brake inspection", issueType: ISSUE_TYPES.BRAKES } }
  );
  const jobChat8810 = await Job.findOne({ jobCode: "TF-8810" }).lean();
  const jobChat8821 = await Job.findOne({ jobCode: "TF-8821" }).lean();
  const jobChat8823 = await Job.findOne({ jobCode: "TF-8823" }).lean();

  if (jobChat8810) {
    await seedJobChatThread({
      job: jobChat8810,
      fleet,
      mechanic: james,
      lines: [
        {
          from: "fleet",
          text: "Hi — are you still able to attend today?",
          minutesAgo: 60 * 26,
          readByOther: true,
        },
        {
          from: "mechanic",
          text: "Yes, on my way. ETA about 25 minutes.",
          minutesAgo: 60 * 26 - 2,
          readByOther: true,
        },
        {
          from: "fleet",
          text: "Thanks — invoice received. Appreciated the fast turnaround.",
          minutesAgo: 60 * 28,
          readByOther: false,
        },
      ],
    });
  }

  if (jobChat8821) {
    await seedJobChatThread({
      job: jobChat8821,
      fleet,
      mechanic: james,
      lines: [
        {
          from: "fleet",
          text: "Hi — are you still able to attend today?",
          minutesAgo: 180,
          readByOther: true,
        },
        {
          from: "mechanic",
          text: "Yes, on my way. ETA about 25 minutes.",
          minutesAgo: 178,
          readByOther: true,
        },
      ],
    });
  }

  if (jobChat8823) {
    await seedJobChatThread({
      job: jobChat8823,
      fleet,
      mechanic: james,
      lines: [
        {
          from: "mechanic",
          text: "Work is complete — please review and approve when you can.",
          minutesAgo: 45,
          readByOther: false,
        },
      ],
    });
  }

  console.log("✅ Seeded fake data (dev only)");
  console.log("Fleet login:", "fleet@truckfix.dev / Password123!");
  console.log("Mechanic logins:");
  console.log(" - James:", "mechanic@truckfix.dev / Password123!");
  console.log(" - Tom:", "mechanic2@truckfix.dev / Password123!");
  console.log(" - Paul:", "mechanic3@truckfix.dev / Password123!");
  console.log("Company logins:");
  console.log(" - Swift (UK):", "company@truckfix.dev / Password123!");
  console.log(" - Swift (docs / Postman alias):", "company@swiftmechanics.co.uk / Password123!");
  console.log(" - John Mechanic Repairs (ZA demo):", "johncompany@truckfix.dev / Password123!");
  console.log(
    "Swift mechanic employees (4 on team, 3 online):",
    "employee@truckfix.dev / employee.jsmith@truckfix.dev / employee.mjohnson@truckfix.dev / employee.dwilson@truckfix.dev / Password123!"
  );
  console.log("John Co mechanic employee:", "employee.johnco@truckfix.dev / Password123!");
  console.log(
    "Seeded jobCodes:",
    [
      "TF-8819",
      "TF-8819C",
      "TF-8819D",
      "TF-8821",
      "TF-8822",
      "TF-8814",
      "TF-8823",
      "TF-8824",
      "TF-8825",
      "TF-8999",
      "TF-8890C",
      "TF-8700P",
      "TF-8820",
      "TF-JC01",
      "TF-JC02",
      "TF-MCR01",
      "TF-FEEDQ1",
      "TF-FEEDQ2",
      "TF-FEEDQ3",
    ].join(", ")
  );
  console.log("AWAITING_APPROVAL jobs — use Mongo _id as {{jobId}} for approve routes:");
  for (const j of awaitingApprovalJobs) {
    console.log(`  ${j.jobCode} -> ${j._id}`);
  }
  console.log("GET /company/jobs/:jobId try: TF-8821 or TF-JC01 (use Mongo _id from list endpoint in real clients).");
  console.log(
    "GET /company/feed (Postman defaults): lat=53.4808 lng=-2.2426 — seeded open job TF-MCR01 at those coords."
  );
  console.log(
    "Company feed UI: GET /company/feed/summary?lat=53.4808&lng=-2.2426&radiusMiles=25 — tab counts; GET /company/quotes?page=1&limit=20&tab=ALL|pending|accepted|rejected"
  );
  console.log("Tip: set SEED_FORCE=true to overwrite seeded jobs/quotes on re-run.");
  console.log("Chat (Postman): GET /api/v1/chat/threads — mechanic@truckfix.dev or fleet@truckfix.dev");
  if (jobChat8821?._id) {
    console.log(`  Job thread TF-8821 (active): GET/POST /api/v1/chat/jobs/${jobChat8821._id}/messages`);
  }
  if (jobChat8810?._id) {
    console.log(`  Job thread TF-8810 (completed): GET /api/v1/chat/jobs/${jobChat8810._id}/messages`);
  }
}

run()
  .catch((err) => {
    console.error("❌ Seed failed:", err?.message || err);
    process.exitCode = 1;
  })
  .finally(async () => {
    try {
      await mongoose.connection.close();
    } catch {
      // ignore
    }
  });

