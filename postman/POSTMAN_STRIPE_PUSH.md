# Postman — Stripe + Push collection

## Import

1. **Import** these two files in Postman:
   - `TruckFix.Stripe-Push.postman_collection.json`
   - `TruckFix.Stripe-Push.postman_environment.json`
2. Select environment **TruckFix — Stripe + Push** (top-right).
3. Set **`baseUrl`**:
   - Local: `http://127.0.0.1:5000`
   - Render: `https://kp-backend-1.onrender.com`

Regenerate collection after edits:

```bash
npm run postman:stripe-push
```

## Run order

| Folder | Purpose |
|--------|---------|
| **00 — Setup** | Login fleet/company/mechanic + resolve job IDs |
| **01 — Stripe (Fleet)** | Full card + approve flow |
| **02 — Stripe (Company)** | Company approve (Stripe required) |
| **03 — Stripe (Mechanic)** | Connect onboarding |
| **04 — Push** | Device tokens + notifications |
| **05 — Trigger push** | Chat message → FCM |

## Before Stripe attach

Set **`stripePmId`** to a **real** Stripe `pm_...` from your account:

```bash
npm run test:stripe
```

Copy `paymentMethodId` from **POSTMAN COPY** output into collection variable `stripePmId`.

**Do not** use `pm_1QxYzAbCdEfGhIjKl` (fake doc example).

## ID cheat sheet

| Variable | What it is |
|----------|------------|
| `stripePmId` | Stripe `pm_...` → **attach** body |
| `fleetPaymentMethodDbId` | Mongo `_id` → **job approve** body |
| `paymentMethodId` (approve) | Same as `fleetPaymentMethodDbId` |

## Push on a real phone

1. Get FCM token from Flutter/Firebase on device.
2. Set env var **`fcmDeviceToken`**.
3. Run **POST /notifications/device-tokens** (fleet login).
4. Run **05 — Trigger push** (chat message).

Placeholder token only tests the API — no delivery.

## Seed data

```bash
npm run seed:fake
```

Accounts: `fleet@truckfix.dev`, `company@truckfix.dev`, `mechanic@truckfix.dev` / `Password123!`

Job codes: `TF-8823` (awaiting approval), `TF-8819` (posted, for chat).
