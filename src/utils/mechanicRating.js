/**
 * Normalise mechanic profile `rating` (schema: { average, count }) and legacy flat numbers.
 * @param {Record<string, unknown>|null|undefined} mechanicUser - lean User with mechanicProfile
 * @returns {number|null}
 */
export const readMechanicProfileRatingAverage = (mechanicUser) => {
  if (!mechanicUser?.mechanicProfile) return null;
  const r = mechanicUser.mechanicProfile.rating;
  if (r == null) return null;
  if (typeof r === "number" && Number.isFinite(r)) return r;
  if (typeof r === "object" && Number.isFinite(r.average)) return r.average;
  return null;
};

/**
 * Prefer invoice-time snapshot (matches PDF / billing), then populated mechanic profile.
 * @param {Record<string, unknown>|null|undefined} invoice
 * @param {Record<string, unknown>|null|undefined} mechanicUser
 */
export const resolveMechanicRatingForInvoiceContext = (invoice, mechanicUser) => {
  const snap = invoice?.mechanicSnapshot?.rating;
  if (typeof snap === "number" && Number.isFinite(snap)) return snap;
  return readMechanicProfileRatingAverage(mechanicUser);
};
