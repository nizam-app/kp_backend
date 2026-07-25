import { PlatformSettings } from "../modules/platformSettings/platformSettings.model.js";

const DEFAULT_FEE_PERCENT = 12;
const DEFAULT_VAT_RATE = 0.2;
const CACHE_TTL_MS = 60_000;

let cache = {
  platformFeePercent: DEFAULT_FEE_PERCENT,
  standardVatRate: DEFAULT_VAT_RATE,
  enforceProviderQuoteReadiness: false,
  expiresAt: 0,
  loaded: false,
};

const normalizeEnforceProviderQuoteReadiness = (value) => value === true;

const roundMoney = (value) => Math.round((Number(value) || 0) * 100) / 100;

const normalizeFeePercent = (value) => {
  const n = Number(value);
  if (!Number.isFinite(n)) return DEFAULT_FEE_PERCENT;
  return Math.min(100, Math.max(0, Math.round(n * 10) / 10));
};

const normalizeVatRate = (value) => {
  const n = Number(value);
  if (!Number.isFinite(n)) return DEFAULT_VAT_RATE;
  // Accept 20 (percent) or 0.2 (fraction)
  const fraction = n > 1 ? n / 100 : n;
  return Math.min(1, Math.max(0, Math.round(fraction * 10000) / 10000));
};

/**
 * Ensure a singleton PlatformSettings document exists and refresh the in-memory cache.
 */
export const getOrCreatePlatformSettings = async () => {
  let doc = await PlatformSettings.findOne({ key: "default" });
  if (!doc) {
    doc = await PlatformSettings.create({
      key: "default",
      platformFeePercent: DEFAULT_FEE_PERCENT,
      standardVatRate: DEFAULT_VAT_RATE,
    });
  }
  cache = {
    platformFeePercent: normalizeFeePercent(doc.platformFeePercent),
    standardVatRate: normalizeVatRate(doc.standardVatRate),
    enforceProviderQuoteReadiness: normalizeEnforceProviderQuoteReadiness(
      doc.enforceProviderQuoteReadiness
    ),
    expiresAt: Date.now() + CACHE_TTL_MS,
    loaded: true,
  };
  return doc;
};

export const refreshPlatformSettingsCache = async () => {
  await getOrCreatePlatformSettings();
  return getCachedPlatformPolicy();
};

export const getCachedPlatformPolicy = () => ({
  platformFeePercent: cache.platformFeePercent,
  /** Fraction 0–1 for fee math */
  platformFeeRate: cache.platformFeePercent / 100,
  standardVatRate: cache.standardVatRate,
  enforceProviderQuoteReadiness: cache.enforceProviderQuoteReadiness === true,
});

/** Sync read for hot paths. Falls back to defaults until cache is warmed. */
export const getPlatformFeePercent = () => cache.platformFeePercent;

export const getPlatformFeeRate = () => cache.platformFeePercent / 100;

export const getStandardVatRate = () => cache.standardVatRate;

/**
 * Sync read for quote readiness enforcement.
 * Missing/unset setting and unwarmed cache both resolve to false (legacy behaviour).
 */
export const getEnforceProviderQuoteReadiness = () =>
  cache.enforceProviderQuoteReadiness === true;

/**
 * Test-only: replace the in-memory platform settings cache.
 * Not for production use.
 */
export const _setPlatformSettingsCacheForTests = (partial = {}) => {
  cache = {
    platformFeePercent: DEFAULT_FEE_PERCENT,
    standardVatRate: DEFAULT_VAT_RATE,
    enforceProviderQuoteReadiness: false,
    expiresAt: Date.now() + CACHE_TTL_MS,
    loaded: true,
    ...partial,
    enforceProviderQuoteReadiness:
      partial.enforceProviderQuoteReadiness === true,
  };
};

export const computePlatformFee = (gross, feePercent = cache.platformFeePercent) => {
  const g = Math.max(Number(gross) || 0, 0);
  const rate = normalizeFeePercent(feePercent) / 100;
  return roundMoney(g * rate);
};

export const computePlatformFeeNet = (gross, feePercent = cache.platformFeePercent) => {
  const g = Math.max(Number(gross) || 0, 0);
  const platformFee = computePlatformFee(g, feePercent);
  return {
    platformFeePercent: normalizeFeePercent(feePercent),
    grossAmount: roundMoney(g),
    platformFee,
    netAmount: Math.max(roundMoney(g - platformFee), 0),
  };
};

export const updatePlatformCommercialSettings = async (payload = {}, adminUser = null) => {
  const doc = await getOrCreatePlatformSettings();
  let changed = false;

  if (payload.platformFeePercent !== undefined) {
    doc.platformFeePercent = normalizeFeePercent(payload.platformFeePercent);
    changed = true;
  }
  if (payload.standardVatRate !== undefined) {
    doc.standardVatRate = normalizeVatRate(payload.standardVatRate);
    changed = true;
  }
  if (payload.enforceProviderQuoteReadiness !== undefined) {
    doc.enforceProviderQuoteReadiness = normalizeEnforceProviderQuoteReadiness(
      payload.enforceProviderQuoteReadiness
    );
    changed = true;
  }
  if (changed) {
    if (adminUser?._id) doc.updatedBy = adminUser._id;
    await doc.save();
    cache = {
      platformFeePercent: normalizeFeePercent(doc.platformFeePercent),
      standardVatRate: normalizeVatRate(doc.standardVatRate),
      enforceProviderQuoteReadiness: normalizeEnforceProviderQuoteReadiness(
        doc.enforceProviderQuoteReadiness
      ),
      expiresAt: Date.now() + CACHE_TTL_MS,
      loaded: true,
    };
  } else if (!cache.loaded || Date.now() >= cache.expiresAt) {
    await refreshPlatformSettingsCache();
  }

  return {
    platformFeePercent: normalizeFeePercent(doc.platformFeePercent),
    standardVatRate: normalizeVatRate(doc.standardVatRate),
    enforceProviderQuoteReadiness: normalizeEnforceProviderQuoteReadiness(
      doc.enforceProviderQuoteReadiness
    ),
    updatedAt: doc.updatedAt,
  };
};

export const serializePlatformCommercial = async () => {
  if (!cache.loaded || Date.now() >= cache.expiresAt) {
    await refreshPlatformSettingsCache();
  }
  return {
    platformFeePercent: cache.platformFeePercent,
    standardVatRate: cache.standardVatRate,
    /** UI-friendly percent, e.g. 20 */
    standardVatPercent: Math.round(cache.standardVatRate * 1000) / 10,
    enforceProviderQuoteReadiness: cache.enforceProviderQuoteReadiness === true,
  };
};

// Warm cache on module load (best-effort; ignore boot races).
void refreshPlatformSettingsCache().catch(() => {});
