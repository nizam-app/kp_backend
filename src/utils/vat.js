import { getStandardVatRate } from "./platformFee.js";

export const UK_STANDARD_VAT_RATE = 0.2;

const roundMoney = (value) => Math.round((Number(value) || 0) * 100) / 100;

const supplierProfileForJob = (job) => {
  if (job?.assignedCompany) {
    return {
      type: "COMPANY",
      user: job.assignedCompany,
      profile: job.assignedCompany.companyProfile || {},
    };
  }

  if (job?.assignedMechanic) {
    return {
      type: "MECHANIC",
      user: job.assignedMechanic,
      profile: job.assignedMechanic.mechanicProfile || {},
    };
  }

  return { type: null, user: null, profile: {} };
};

export const resolveJobVatPolicy = (job) => {
  const supplier = supplierProfileForJob(job);
  const vatRegistered = supplier.profile.vatRegistered === true;
  const rate = getStandardVatRate() || UK_STANDARD_VAT_RATE;

  return {
    supplierType: supplier.type,
    supplierId: supplier.user?._id || supplier.user || null,
    supplierName:
      supplier.profile.companyName ||
      supplier.profile.businessName ||
      supplier.profile.displayName ||
      supplier.user?.email ||
      null,
    vatRegistered,
    vatNumber: vatRegistered ? supplier.profile.vatNumber || null : null,
    vatRate: vatRegistered ? rate : 0,
  };
};

export const calculateJobVat = (job, subtotal) => {
  const normalizedSubtotal = roundMoney(subtotal);
  const policy = resolveJobVatPolicy(job);
  const vatAmount = roundMoney(normalizedSubtotal * policy.vatRate);

  return {
    ...policy,
    subtotal: normalizedSubtotal,
    vatAmount,
    totalAmount: roundMoney(normalizedSubtotal + vatAmount),
  };
};

