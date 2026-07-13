import AppError from "./AppError.js";

/**
 * Normalize a phone string: keep digits and a single leading +.
 * Returns empty string when blank.
 */
export function normalizePhone(value) {
  const raw = `${value || ""}`.trim();
  if (!raw) return "";
  const hasPlus = raw.includes("+");
  const digits = raw.replace(/\D/g, "");
  if (!digits) return "";
  return hasPlus ? `+${digits}` : digits;
}

/**
 * Empty is allowed. Otherwise require 7–15 digits.
 * Returns normalized phone or throws AppError.
 */
export function assertValidOptionalPhone(value, fieldLabel = "Phone") {
  const raw = `${value || ""}`.trim();
  if (!raw) return "";

  if (/[a-zA-Z]/.test(raw)) {
    throw new AppError(`${fieldLabel} must be a valid phone number`, 400);
  }

  const normalized = normalizePhone(raw);
  const digits = normalized.replace(/\D/g, "");
  if (digits.length < 7 || digits.length > 15) {
    throw new AppError(`${fieldLabel} must be a valid phone number`, 400);
  }
  return normalized;
}
