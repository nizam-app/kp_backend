# TruckFix Backend API Contract (v1)

## 1) Conventions

- Base URL: `/api/v1`
- Auth: `Authorization: Bearer <accessToken>`
- Response envelope:
  - success: `{ status: "success", message, data?, meta? }`
  - error: `{ status: "fail" | "error", message }`
- Time format: ISO-8601 UTC
- Pagination query:
  - `page` (default `1`)
  - `limit` (default `20`, max `100`)

## 2) Roles and Status Enums

- Roles: `FLEET`, `MECHANIC`, `ADMIN`
- User status:
  - `PENDING_REVIEW`
  - `ACTIVE`
  - `SUSPENDED`
  - `BLOCKED`
- Verification status (mechanic):
  - `NOT_SUBMITTED`
  - `SUBMITTED`
  - `UNDER_REVIEW`
  - `APPROVED`
  - `REJECTED`
- Job status:
  - `POSTED`
  - `QUOTING`
  - `ASSIGNED`
  - `EN_ROUTE`
  - `ON_SITE`
  - `IN_PROGRESS`
  - `AWAITING_APPROVAL`
  - `COMPLETED`
  - `CANCELLED`
- Quote status:
  - `WAITING`
  - `ACCEPTED`
  - `DECLINED`
  - `EXPIRED`
  - `WITHDRAWN`
- Availability:
  - mechanic online state: `ONLINE`, `OFFLINE`

## 3) State Transitions

### 3.1 User lifecycle

- register -> `PENDING_REVIEW` (mechanic) or `ACTIVE` (fleet)
- mechanic review approved -> `ACTIVE`
- mechanic review rejected -> remains `PENDING_REVIEW` (with reason)
- any role can be moved to `SUSPENDED`/`BLOCKED` by admin

### 3.2 Job lifecycle

- create job -> `POSTED`
- first quote received -> `QUOTING`
- quote accepted -> `ASSIGNED`
- mechanic starts travel -> `EN_ROUTE`
- mechanic arrives -> `ON_SITE`
- mechanic starts repair -> `IN_PROGRESS`
- mechanic marks done -> `AWAITING_APPROVAL`
- fleet approves + payment settled -> `COMPLETED`
- cancellation rules:
  - before `EN_ROUTE`: no fee (or configurable)
  - from `EN_ROUTE` onward: cancellation fee may apply

### 3.3 Quote lifecycle

- quote submitted -> `WAITING`
- fleet accepts one quote -> selected quote `ACCEPTED`, others `DECLINED`
- timeout reached -> `EXPIRED`
- mechanic may withdraw while `WAITING` -> `WITHDRAWN`

## 4) Auth and Session APIs

## 4.1 POST `/auth/register`

- Public
- body:
  - `email`, `password`, `role`
  - fleet fields: `companyName`, `contactName`, `phone`
  - mechanic fields: `displayName`, `businessName?`, `phone`, `skills?`
- result:
  - `user`
  - `accessToken`
  - `refreshToken`

## 4.2 POST `/auth/login`

- Public
- body: `email`, `password`
- result:
  - `user`
  - `accessToken`
  - `refreshToken`
  - `nextStep` (optional): `COMPLETE_PROFILE`, `UNDER_REVIEW`, `GO_DASHBOARD`

## 4.3 POST `/auth/refresh-token`

- Public
- body: `refreshToken`
- result: `accessToken`, `refreshToken` (rotated)

## 4.4 POST `/auth/logout`

- Protected
- body: `refreshToken`
- result: success message

## 4.5 POST `/auth/forgot-password`

- Public
- body: `email`
- result: generic success message

## 4.6 POST `/auth/reset-password`

- Public
- body: `token`, `newPassword`
- result: success message

## 5) Profile and Settings APIs

## 5.1 GET `/users/me`

- Protected
- result: full user profile by role

## 5.2 PATCH `/users/me`

- Protected
- fleet editable:
  - `companyName`, `regNumber`, `vatNumber`, `fleetSize`
  - `contactName`, `contactRole`, `phone`, `email`
  - `billingAddress`
- mechanic editable:
  - `displayName`, `businessName`, `phone`, `baseLocation`
  - `serviceRadiusMiles`, `skills`, `hourlyRate`, `emergencyRate`, `callOutFee`

## 5.3 PATCH `/users/me/availability`

- Mechanic only
- body: `availability` (`ONLINE`/`OFFLINE`), `lastKnownLocation?`

## 5.4 PATCH `/users/me/preferences`

- Protected
- body:
  - `pushEnabled`
  - `alertRadiusMiles`
  - notification flags:
    - `newBreakdownJobs`
    - `jobAcceptedDeclined`
    - `paymentReceived`
    - `systemAlerts`

## 5.5 POST `/users/me/photo`

- Protected
- multipart file upload (profile image)
- result: `photoUrl`

## 6) Fleet Domain APIs

## 6.1 GET `/fleet/dashboard`

- Fleet only
- cards: `activeCount`, `awaitingCount`, `monthCompletedCount`
- list sections:
  - `activeJobs[]`
  - `completedJobs[]` (paged)
- flags:
  - `hasPendingApprovals`
  - `profileCompletion` (percentage + missing sections)

## 6.2 POST `/fleet/vehicles`

- Fleet only
- create vehicle: `registration`, `type`, `make?`, `model?`, `year?`

## 6.3 GET `/fleet/vehicles`

- Fleet only

## 6.4 PATCH `/fleet/vehicles/:vehicleId`

- Fleet only

## 7) Job APIs

## 7.1 POST `/jobs`

- Fleet only
- body:
  - `vehicleId` or inline vehicle details (`registration`, `vehicleType`)
  - `issueType` (engine, tyres, electrical, etc.)
  - `title`
  - `description`
  - `urgency` (`LOW`, `MEDIUM`, `HIGH`, `CRITICAL`)
  - `location`: geo point + address text
  - `photos[]` (or pre-uploaded URLs)
- validations:
  - must pass profile completion gate
- result: created job in `POSTED`

## 7.2 GET `/jobs`

- Protected
- fleet filters:
  - `tab=active|completed|tracking`
- mechanic filters:
  - `feed=true`, `radiusMiles`, `skills`, `urgency`, `minPayout`

## 7.3 GET `/jobs/:jobId`

- Protected if related to job
- includes:
  - job details
  - customer/mechanic summary (as applicable)
  - current status
  - ETA and latest location (if assigned)

## 7.4 PATCH `/jobs/:jobId/cancel`

- Fleet only, allowed by policy
- body: `reason`
- result: cancellation outcome + fee details (if any)

## 8) Quote APIs

## 8.1 POST `/jobs/:jobId/quotes`

- Mechanic only
- body:
  - `amount`
  - `notes`
  - `availabilityType` (`NOW`, `IN_30_MIN`, `IN_1_HOUR`, `SCHEDULED`)
  - `scheduledAt?`
- rules:
  - only when job is `POSTED` or `QUOTING`
  - one active quote per mechanic per job

## 8.2 GET `/jobs/:jobId/quotes`

- Fleet only (job owner)
- optional sort: `amount`, `eta`, `rating`, `createdAt`

## 8.3 PATCH `/quotes/:quoteId/accept`

- Fleet only
- side-effects:
  - selected quote -> `ACCEPTED`
  - other waiting quotes -> `DECLINED`
  - job -> `ASSIGNED`

## 8.4 PATCH `/quotes/:quoteId/decline`

- Fleet only
- quote -> `DECLINED`

## 8.5 GET `/mechanic/quotes`

- Mechanic only
- tabs: `ALL`, `WAITING`, `ACCEPTED`, `EXPIRED`

## 9) Job Execution and Tracking APIs

## 9.1 GET `/mechanic/jobs`

- Mechanic only
- tabs:
  - `accepted`
  - `active`
  - `completed`

## 9.2 PATCH `/jobs/:jobId/journey/start`

- Mechanic assigned to job
- job -> `EN_ROUTE`

## 9.3 PATCH `/jobs/:jobId/arrive`

- Mechanic assigned to job
- job -> `ON_SITE`

## 9.4 PATCH `/jobs/:jobId/work/start`

- Mechanic assigned to job
- job -> `IN_PROGRESS`

## 9.5 PATCH `/jobs/:jobId/work/complete`

- Mechanic assigned to job
- body: `workSummary`, `finalAmount?`
- job -> `AWAITING_APPROVAL`

## 9.6 PATCH `/jobs/:jobId/complete/approve`

- Fleet only
- body: `paymentMethodId`
- job -> `COMPLETED` after payment success

## 9.7 POST `/jobs/:jobId/location-pings`

- Mechanic assigned to job
- body: `lat`, `lng`, `heading?`, `speed?`, `accuracy?`
- stored as latest + timeline sample

## 9.8 GET `/jobs/:jobId/timeline`

- Protected related users
- returns ordered `JobEvent[]`

## 10) Payments, Invoices, Earnings

## 10.1 POST `/billing/payment-methods`

- Protected
- body: provider token/id (no raw PAN/CVV)

## 10.2 GET `/billing/payment-methods`

- Protected
- masked cards/bank methods

## 10.3 DELETE `/billing/payment-methods/:methodId`

- Protected

## 10.4 GET `/mechanic/earnings/summary`

- Mechanic only
- result:
  - `todayGross`, `monthGross`, `monthNet`, `allTimeNet`
  - `monthlyNetSeries[]`

## 10.5 GET `/mechanic/earnings/jobs`

- Mechanic only
- completed paid jobs with fee breakdown

## 10.6 GET `/invoices/:invoiceId`

- Protected related users
- result:
  - invoice metadata
  - `pdfUrl`

## 11) Notifications and Support

## 11.1 POST `/notifications/device-tokens`

- Protected
- body: `token`, `platform` (`ios`/`android`), `appVersion?`

## 11.2 GET `/notifications`

- Protected
- paged list of notifications

## 11.3 PATCH `/notifications/:id/read`

- Protected

## 11.4 POST `/support/tickets`

- Protected
- body: `subject`, `message`, `category?`

## 12) Admin APIs (minimum for launch)

## 12.1 GET `/admin/mechanics/review-queue`

- Admin only

## 12.2 PATCH `/admin/mechanics/:userId/approve`

- Admin only
- body: `notes?`
- user status -> `ACTIVE`, verification -> `APPROVED`

## 12.3 PATCH `/admin/mechanics/:userId/reject`

- Admin only
- body: `reason`

## 12.4 PATCH `/admin/users/:userId/status`

- Admin only
- body: `status`

## 13) Realtime Events (WebSocket)

- `quote.created` (to fleet job owner)
- `quote.accepted` (to accepted mechanic)
- `quote.declined` (to declined mechanics)
- `job.status.changed` (to fleet + assigned mechanic)
- `job.location.updated` (to fleet tracking viewers)
- `payment.released` (to mechanic)

## 14) Immediate Implementation Backlog (Code Order)

1. Add enums/state constants + schema updates (`User`, new `Job`, `Quote`, `JobEvent`).
2. Harden auth: refresh rotation + logout + role/status guard behavior.
3. Implement fleet profile completion gate.
4. Implement job create/list/detail.
5. Implement quote submit/list/accept/decline.
6. Implement mechanic availability + location pings.
7. Implement job journey transitions and timeline.
8. Add notifications table + push token endpoints.
9. Add billing method abstraction and earnings read endpoints.
