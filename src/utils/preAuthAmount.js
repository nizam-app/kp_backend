import AppError from "./AppError.js";

/** Maximum Pre-Auth Budget in major currency units (GBP pounds). */
export const PRE_AUTH_AMOUNT_MAX = 1_000_000;

const INVALID_MSG =
  "Pre-Auth Budget must be a valid amount greater than 0 and no more than £1,000,000";

const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

const invalid = () =>
  new AppError(INVALID_MSG, 400, { code: "INVALID_PRE_AUTH_AMOUNT" });

/**
 * Coerce multipart/form-data string numbers for create/update bodies.
 * - Leaves `undefined` / `null` unchanged
 * - Leaves empty string as "" (rejected later by assertValidOptionalPreAuthAmount)
 * - Converts numeric strings ("500", "500.25") to Number
 * - Leaves non-numeric values as-is for service validation to reject
 */
export const normalizePreAuthAmountInput = (value) => {
  if (value === undefined || value === null) return value;
  if (Array.isArray(value)) {
    return normalizePreAuthAmountInput(value[0]);
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed === "") return "";
    if (/^-?\d+(\.\d+)?$/.test(trimmed)) return Number(trimmed);
    return value;
  }
  return value;
};

/**
 * Validate an optional Pre-Auth Budget amount for create (and update set/replace).
 *
 * Create semantics:
 * - `undefined` / `null` → return `undefined` (field not set)
 * - empty string / invalid → AppError 400
 * - valid finite number in (0, PRE_AUTH_AMOUNT_MAX] → rounded to 2dp
 *
 * Callers that want to clear on update must handle `null` before calling this.
 */
export const assertValidOptionalPreAuthAmount = (value) => {
  if (value === undefined || value === null) return undefined;

  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed === "") throw invalid();
    if (!/^-?\d+(\.\d+)?$/.test(trimmed)) throw invalid();
    value = Number(trimmed);
  }

  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw invalid();
  }

  const rounded = round2(value);
  if (rounded <= 0 || rounded > PRE_AUTH_AMOUNT_MAX) {
    throw invalid();
  }

  return rounded;
};

/** Serialize missing Pre-Auth Budget as null (consistent with sibling money fields). */
export const serializePreAuthAmount = (job) => job?.preAuthAmount ?? null;
