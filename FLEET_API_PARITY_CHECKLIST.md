# Fleet Mobile App -> Backend API Parity Checklist

This checklist compares the original fleet mobile prototype against the current `kp_backend` API.

Status legend:
- `Done`: backend route/service clearly exists
- `Partial`: some backend support exists, but not enough for full mobile-flow parity
- `Missing`: no clear API support found yet

## Core Auth And User

- `Done` Register/login/refresh/logout
- `Done` Role-aware auth and access control
- `Partial` Fleet profile completion gating
Notes:
Profile completion is referenced in the fleet dashboard service, but there is no obvious dedicated fleet profile update/read API surfaced through `fleet.router.js`.

## Fleet Dashboard

- `Done` Fleet dashboard summary API
- `Done` Active jobs summary
- `Done` Awaiting approval summary
- `Done` Monthly spend / completed jobs summary
- `Partial` Dashboard shortcut data for all mobile dashboard widgets
Notes:
The dashboard API is real and useful, but it is not a one-to-one backend representation of every mobile dashboard panel/overlay.

## Post Job Flow

- `Done` Create job
- `Done` Job list API
- `Done` Get job detail API
- `Partial` Full mobile post-job payload parity
- `Missing` File/photo upload for incident/job attachments
- `Missing` Hard validation APIs for all mobile form variations
Notes:
Job creation exists, but the mobile prototype includes richer input branches and photo-style interactions that are not clearly backed by upload endpoints.

## Quotes

- `Done` Submit quote
- `Done` Fleet list quotes for a job
- `Done` Accept quote
- `Done` Decline quote
- `Done` Get quote detail
- `Partial` Fleet quote comparison workspace API
- `Missing` Quote negotiation / counter-offer flow
- `Missing` Quote expiration management endpoints tailored for fleet UX
Notes:
Core quote lifecycle is there. Comparison is possible by listing job quotes, but there is no dedicated fleet comparison/decision endpoint beyond that.

## Job Tracking

- `Done` Start journey
- `Done` Arrive on site
- `Done` Start work
- `Done` Complete work
- `Done` Fleet approve completion
- `Done` Job timeline
- `Done` Mechanic location pings
- `Partial` Fleet live-tracking UX parity
- `Missing` Real chat/messaging API
- `Missing` Rich map / route stream API
Notes:
Operational job status APIs are strong. Tracking is functionally supported, but the mobile chat and some richer tracking interactions are not backed by a messaging system.

## Cancellation

- `Done` Cancel job
- `Partial` Cancellation fee / policy handling
- `Missing` Dedicated cancellation quote/fee preview endpoint
Notes:
The job service contains cancellation concepts, but there is no obvious fleet-side endpoint specifically for previewing or explaining fees before cancellation.

## Vehicles

- `Done` Create vehicle
- `Done` List vehicles
- `Done` Update vehicle
- `Partial` Soft deactivate vehicle through update
- `Missing` Dedicated delete vehicle endpoint
- `Partial` Full vehicle-detail parity with mobile UI fields
Notes:
Vehicle CRUD is close, but delete is not exposed directly. Update supports `isActive`, so soft deactivation is possible if the frontend uses it intentionally.

## Billing And Payment Methods

- `Done` List payment methods
- `Done` Create payment method
- `Done` Set default payment method
- `Done` Remove payment method
- `Done` Stripe setup intent/config/attach flow
- `Partial` Full mobile billing UX parity
- `Missing` Payment failure recovery flows surfaced as dedicated fleet endpoints
Notes:
This area is relatively mature for a backend foundation.

## Invoices

- `Done` List invoices
- `Done` Get invoice detail
- `Done` Get invoice download URL
- `Partial` Invoice dispute / invoice action flows
- `Missing` Explicit invoice dispute endpoint
Notes:
Invoice reading is covered well, but active invoice dispute behavior is not surfaced even though dispute-related models exist elsewhere.

## Notifications

- `Done` List notifications
- `Done` Mark notification as read
- `Done` Register/list device tokens
- `Partial` Deep-link notification action semantics
Notes:
Basic notification support exists, but frontend-specific action routing still needs coordination.

## Support

- `Done` Create support ticket
- `Done` List support tickets
- `Partial` Ticket lifecycle management
- `Missing` Update ticket status / reply / threaded conversation APIs
Notes:
Fleet can open and read tickets, but not run a full support conversation workflow from the API shape we inspected.

## Reviews, Ratings, And Completion Feedback

- `Partial` Review data model exists in repo
- `Missing` Review/rating API routes for fleet completion feedback
Notes:
This appears modeled, but no active review router/controller/service was surfaced through `routes/index.js`.

## Disputes

- `Partial` Dispute model exists in repo
- `Missing` Dispute API routes/controllers exposed in v1 routes
Notes:
The backend appears prepared for disputes conceptually, but not wired as an accessible API surface.

## Chat / Messaging

- `Missing` Fleet-mechanic messaging API
- `Missing` Message list/send/read endpoints
- `Missing` Conversation/thread model exposed through routes
Notes:
This is one of the biggest remaining gaps versus the mobile prototype.

## Fleet App Completion Verdict

- `Done` for core operational lifecycle:
  - auth
  - dashboard summary
  - jobs
  - quotes
  - tracking state changes
  - vehicles
  - payment methods
  - invoices
  - notifications
  - basic support tickets

- `Not complete yet` for full fleet mobile parity:
  - chat
  - reviews/ratings
  - disputes
  - uploads/photos
  - richer support thread workflow
  - cancellation-fee preview/detail flow
  - dedicated fleet profile APIs if needed by frontend

## Recommended Next Backend Tasks

1. Add fleet/mechanic chat APIs.
2. Add review/rating APIs for job completion.
3. Add dispute APIs for invoices/payments/jobs.
4. Add upload endpoints for job/incident photos.
5. Add support ticket reply/update lifecycle APIs.
6. Add dedicated vehicle delete endpoint.
7. Add fleet profile read/update APIs if the frontend will rely on backend-managed profile state.
