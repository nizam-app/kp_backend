# Fleet Mobile App -> Backend API Parity Checklist (Updated)

This checklist compares the Fleet app prototype flows against the current `kp_backend` API.

Status legend:
- `Done`: backend route/service clearly exists
- `Partial`: optional product depth beyond MVP

## Core Auth & Fleet Profile

- `Done` Register/login/refresh/logout (`/api/v1/auth/...`)
- `Done` Fleet profile read/update via shared user endpoints (`GET/PATCH /api/v1/users/me`)
- `Done` Profile completion gating enforced for posting jobs (see `job.service.js` + `getProfileCompletionSummary`)

## Fleet Dashboard

- `Done` Dashboard summary (`GET /api/v1/fleet/dashboard`)
- `Done` Active / awaiting approval / completed counts + monthly spend + lists (see `fleet.service.js`)
- `Partial` One-to-one mapping for every possible dashboard widget

## Post Job

- `Done` Create job (`POST /api/v1/jobs`)
- `Done` List jobs + detail (`GET /api/v1/jobs`, `GET /api/v1/jobs/:jobId`)
- `Done` Upload job photos (`POST /api/v1/jobs/:jobId/photos`, remove via `PATCH .../photos/remove`)
- `Done` Upload job attachments (images + PDF/docs + proof categories): `POST /api/v1/jobs/:jobId/attachments`, remove via `DELETE .../attachments/:attachmentId`
- `Partial` “Hard validation” endpoints for every UI permutation (backend validates key fields; frontend still owns some UX rules)

## Quotes

- `Done` Fleet list quotes for a job (`GET /api/v1/jobs/:jobId/quotes`)
- `Done` Fleet accept/decline (`PATCH /api/v1/quotes/:quoteId/accept|decline`)
- `Partial` Quote negotiation / counter-offer flow
- `Partial` Quote expiration policy/management tailored for fleet UX

## Job Tracking (Fleet side)

- `Done` Mechanic status progression routes (journey/arrive/start/complete) + fleet approve completion
- `Done` Job timeline (`GET /api/v1/jobs/:jobId/timeline`)
- `Done` Location pings stored + emitted realtime (`POST /api/v1/jobs/:jobId/location-pings` + Socket.IO `job:location`)
- `Done` Realtime events via Socket.IO: `job:subscribe`, `job:statusChanged`, `job:location`, `job:event`, `job:posted`
- `Partial` Rich map route polyline/route-stream service (optional separate integration)

## Cancellation

- `Done` Cancel job (`PATCH /api/v1/jobs/:jobId/cancel`)
- `Done` Fee preview before cancel (`GET /api/v1/jobs/:jobId/cancellation-preview`)
- `Partial` More complex fee policies (if product expands beyond the current fixed-fee model)

## Vehicles

- `Done` Create/list/update/delete vehicles (`/api/v1/fleet/vehicles` + `DELETE /:vehicleId`)
- `Partial` Additional vehicle detail fields as UI expands

## Billing & Payment Methods

- `Done` Stripe config + setup intent + attach payment method (`/api/v1/billing/stripe/...`)
- `Done` CRUD payment methods (`/api/v1/billing/payment-methods`)
- `Partial` Fleet-facing “payment failure recovery” flows (retry invoice payment, recovery UX endpoints)

## Invoices

- `Done` List invoice, get detail, download (`GET /api/v1/invoices`, `GET /:invoiceId`, `GET /:invoiceId/download`)
- `Done` Disputes are available via `/api/v1/fleet/disputes` (create/list/update)

## Notifications

- `Done` List, mark read, device tokens (`/api/v1/notifications/...`)
- `Partial` Deep-link/action semantics standardization (payload contracts per notification type)

## Support

- `Done` Ticket create/list/detail/update + threaded replies (`/api/v1/support/tickets` + `POST /:ticketId/replies`)
- `Partial` Full support ops semantics (SLA, assignment rules, admin workflows)

## Reviews & Disputes

- `Done` Reviews (fleet creates + lists): `/api/v1/fleet/reviews`
- `Done` Disputes (fleet create/list/update): `/api/v1/fleet/disputes`

## Chat / Messaging

- `Done` Threads + messages + send + mark read (`/api/v1/chat/...`)
- `Done` Realtime chat events via Socket.IO (`chat:message`, `chat:read`, `chat:typing`)

## Fleet App Completion Verdict

- `Done` for Fleet MVP parity with the prototype’s functional flows:
  - auth + profile
  - dashboard
  - jobs + uploads
  - quotes accept/decline
  - tracking + realtime pings
  - cancellation + fee preview
  - vehicles
  - billing/payment methods
  - invoices
  - notifications
  - support tickets + replies
  - reviews + disputes
  - chat (HTTP + realtime)

- `Partial` / optional product depth:
  - quote negotiation + expiry policy
  - payment failure recovery
  - rich map/route services
  - notification deep-link contracts
