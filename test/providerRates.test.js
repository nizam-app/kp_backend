import test from "node:test";
import assert from "node:assert/strict";
import { ROLES } from "../src/constants/domain.js";
import {
  applyCompanyRatesToMechanicProfile,
  getProviderRateProfile,
  payloadContainsCompanyControlledRates,
  resolveBillingRates,
  resolveInvoiceCommercialRates,
} from "../src/utils/providerRates.js";

test("getProviderRateProfile uses companyProfile for COMPANY", () => {
  const profile = getProviderRateProfile({
    role: ROLES.COMPANY,
    companyProfile: { hourlyRate: 80, callOutFee: 40 },
    mechanicProfile: { hourlyRate: 10 },
  });
  assert.equal(profile.hourlyRate, 80);
  assert.equal(profile.callOutFee, 40);
});

test("getProviderRateProfile uses mechanicProfile for independent mechanic", () => {
  const profile = getProviderRateProfile({
    role: ROLES.MECHANIC,
    mechanicProfile: { hourlyRate: 70, emergencyRate: 95, callOutFee: 35 },
  });
  assert.equal(profile.hourlyRate, 70);
  assert.equal(profile.emergencyRate, 95);
});

test("resolveBillingRates prefers emergency rate on emergency jobs", () => {
  const rates = resolveBillingRates({
    profile: { hourlyRate: 70, emergencyRate: 95, callOutFee: 35 },
    jobMode: "EMERGENCY",
  });
  assert.equal(rates.hourlyRate, 95);
  assert.equal(rates.callOutFee, 35);
  assert.equal(rates.rateType, "EMERGENCY");
});

test("resolveBillingRates falls back to hourly when emergency rate missing", () => {
  const rates = resolveBillingRates({
    profile: { hourlyRate: 70, callOutFee: 35 },
    jobMode: "EMERGENCY",
  });
  assert.equal(rates.hourlyRate, 70);
  assert.equal(rates.rateType, "EMERGENCY");
});

test("resolveInvoiceCommercialRates prefers quote snapshot", () => {
  const rates = resolveInvoiceCommercialRates({
    acceptedQuotePricing: { hourlyRate: 90, callOutFee: 50, rateType: "STANDARD" },
    provider: {
      role: ROLES.COMPANY,
      companyProfile: { hourlyRate: 80, callOutFee: 40 },
    },
    jobMode: "STANDARD",
  });
  assert.equal(rates.source, "QUOTE_SNAPSHOT");
  assert.equal(rates.hourlyRate, 90);
  assert.equal(rates.callOutFee, 50);
});

test("resolveInvoiceCommercialRates falls back to company profile", () => {
  const rates = resolveInvoiceCommercialRates({
    provider: {
      role: ROLES.COMPANY,
      companyProfile: { hourlyRate: 80, emergencyRate: 110, callOutFee: 40 },
    },
    jobMode: "EMERGENCY",
  });
  assert.equal(rates.source, "PROFILE_FALLBACK");
  assert.equal(rates.hourlyRate, 110);
  assert.equal(rates.callOutFee, 40);
});

test("payloadContainsCompanyControlledRates detects nested and flat keys", () => {
  assert.equal(payloadContainsCompanyControlledRates({ hourlyRate: 10 }), true);
  assert.equal(
    payloadContainsCompanyControlledRates({
      mechanicProfile: { callOutFee: 5 },
    }),
    true
  );
  assert.equal(payloadContainsCompanyControlledRates({ displayName: "A" }), false);
});

test("applyCompanyRatesToMechanicProfile overlays employer rates", () => {
  const next = applyCompanyRatesToMechanicProfile(
    { displayName: "Alex", hourlyRate: 1, callOutFee: 2 },
    { hourlyRate: 75, emergencyRate: 100, callOutFee: 45 }
  );
  assert.equal(next.displayName, "Alex");
  assert.equal(next.hourlyRate, 75);
  assert.equal(next.emergencyRate, 100);
  assert.equal(next.callOutFee, 45);
});
