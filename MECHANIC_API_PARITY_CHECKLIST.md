# Mechanic Mobile/Web App -> Backend API Parity Checklist

Status legend:
- `Done`: backend route/service clearly exists
- `Partial`: optional product depth beyond MVP

## Summary

Mechanic-facing **MVP backend surface is complete**: auth, profile, feed, quotes, jobs, tracker, attachments (proof + PDF/docs), chat (HTTP + Socket.IO), notifications, earnings (summary, jobs list, monthly **statement**, payout info), billing, support, reviews, disputes.

## Job feed & saved filters

- `Done` `GET /api/v1/jobs?feed=true` … nearby, issue type, min payout
- `Done` **Feed presets** — `GET|POST /api/v1/feed-presets`, `PATCH|DELETE /api/v1/feed-presets/:presetId` (mechanic, fleet, company, mechanic employee)

## Quotes

- `Done` Submit, list (`/quotes/me`), amend, withdraw, fleet accept/decline

## Jobs & proof

- `Done` Lifecycle, timeline, location pings, cancellation preview (fleet)
- `Done` Legacy photos: `POST /api/v1/jobs/:jobId/photos`, `PATCH .../photos/remove`
- `Done` **Structured attachments**: `POST /api/v1/jobs/:jobId/attachments` with `{ items: [{ dataUrl?, url?, category, fileType?, filename?, originalName? }] }` — categories `BEFORE`, `AFTER`, `COMPLETION`, `DIAGNOSTIC`, `PARTS`, `INCIDENT`, `INVOICE`, `OTHER`; file types `IMAGE`, `PDF`, `DOCUMENT`, `OTHER` (images also mirrored into `photos` when applicable)
- `Done` `DELETE /api/v1/jobs/:jobId/attachments/:attachmentId`

## Realtime

- `Done` Socket.IO jobs + `chat:message`, `chat:read`, `chat:typing`

## Earnings

- `Done` `GET /api/v1/earnings/summary`
- `Done` `GET /api/v1/earnings/jobs`
- `Done` `GET /api/v1/earnings/payout-info`
- `Done` **`GET /api/v1/earnings/statement?year=&month=`** — monthly line items + totals

## Reviews & disputes

- `Done` `GET /api/v1/fleet/reviews/me`, `GET .../me/:reviewId`
- `Done` `GET /api/v1/fleet/disputes/me`, `GET .../me/:disputeId`, `PATCH .../me/:disputeId`

## Optional / future

- `Partial` Custom payout rules outside Stripe Connect defaults
- `Partial` Third-party map route polyline as a separate service
- `Partial` Full notification coverage for every edge-case product event

## Socket (reference)

Connect with JWT. Events: `job:subscribe`, `job:statusChanged`, `job:location`, `chat:message`, `chat:read`, `chat:typing`, `notification:new`.
