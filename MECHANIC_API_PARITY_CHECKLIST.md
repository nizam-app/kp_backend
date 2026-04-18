# Mechanic Mobile/Web App -> Backend API Parity Checklist

This checklist compares the mechanic mobile app and mechanic website against the current `kp_backend` API.

Status legend:
- `Done`: backend route/service clearly exists
- `Partial`: backend support exists, but not enough for full app parity
- `Missing`: no clear API support found yet

## Core Auth And Mechanic Account

- `Done` Register/login/refresh/logout
- `Done` Role-aware mechanic auth
- `Done` Mechanic profile read/update
- `Done` Mechanic availability update
- `Done` Mechanic preferences update
- `Done` Profile completion summary
Notes:
Mechanic profile and availability are already handled through the shared user APIs in [user.router.js](/Users/Win%2010/Downloads/TruckFix%20Interactive%20Prototype/kp_backend/src/modules/user/user.router.js).

## Job Feed / Nearby Jobs

- `Done` Mechanic feed query using jobs list API
- `Done` Radius-aware nearby job discovery
- `Done` Issue-type filtering support
- `Done` Minimum payout filtering support
- `Partial` Full marketplace sorting/filter combinations from frontend
- `Missing` Dedicated saved filters / feed presets API
Notes:
The backend feed is driven through `GET /api/v1/jobs?feed=true` style filtering from the jobs service.

## Quote Flow

- `Done` Submit quote
- `Done` List mechanic quotes
- `Done` Get quote detail
- `Done` Fleet accept quote
- `Done` Fleet decline quote
- `Partial` Mechanic quote edit/withdraw/resubmit lifecycle
- `Missing` Explicit withdraw-quote endpoint
- `Missing` Explicit revise-quote endpoint
Notes:
The core quote path is there, but richer mechanic quote management is still limited.

## My Jobs

- `Done` Mechanic active jobs list
- `Done` Mechanic completed jobs list
- `Done` Job detail for assigned mechanic
- `Partial` Rich job archive/history workflow
Notes:
The backend supports the key list/detail flow, but not a specialized history/archive module beyond the jobs list.

## Job Tracker / Live Work

- `Done` Start journey
- `Done` Arrive on site
- `Done` Start work
- `Done` Complete work
- `Done` Job timeline
- `Done` Job location pings
- `Done` Access job detail with tracking context
- `Partial` Real-time/live-tracking delivery
- `Missing` Websocket/live stream support
Notes:
Status progression is covered well, but realtime transport is not implemented.

## Mechanic Chat

- `Done` List chat threads
- `Done` List job messages
- `Done` Send job message
- `Done` Mark chat messages as read
- `Partial` Real-time chat delivery
- `Missing` Typing indicators / presence / websocket messaging
Notes:
Job-scoped chat is now available and works for both mechanic and fleet, but it is request-based rather than realtime.

## Notifications

- `Done` List notifications
- `Done` Mark notification read
- `Done` Device token registration
- `Partial` Full notification event coverage for every mechanic-side action
Notes:
The basics are there and new backend flows now generate notifications, but coverage can still grow.

## Earnings / Payouts

- `Done` Earnings summary
- `Done` Earning jobs list
- `Done` Invoice association in earning items
- `Partial` Rich payout history / settlement workflow
- `Missing` Dedicated payout withdrawal / payout schedule API
Notes:
This is strong for reporting and visibility, but not yet a complete finance operations module.

## Payment Methods / Payout Methods

- `Done` List payment methods
- `Done` Create payment method
- `Done` Set default payment method
- `Done` Remove payment method
- `Partial` Mechanic-specific payout onboarding UX support
Notes:
The backend methods are generic enough to support mechanic payout methods too.

## Support

- `Done` Create support ticket
- `Done` List support tickets
- `Done` Get support ticket detail
- `Done` Update support ticket status
- `Done` Reply inside ticket thread
- `Partial` Full support operations workflow with assignment and SLA semantics
Notes:
Support is now much closer to a real threaded case flow.

## Job Photos / Proof / Attachments

- `Done` Add job photos
- `Done` Remove job photos
- `Partial` Proof-of-work completion flows
- `Missing` Separate proof categories such as before/after/completion evidence
- `Missing` Non-image attachment support
Notes:
Photo support now exists, but the mechanic-side “proof” workflow can still become richer.

## Reviews / Ratings

- `Done` Fleet can create mechanic reviews
- `Done` Mechanic rating aggregate updates from published reviews
- `Partial` Mechanic review visibility
- `Missing` Dedicated mechanic endpoint to view own reviews
Notes:
The review write path exists, but mechanic-facing review-read APIs are still missing.

## Disputes

- `Partial` Fleet dispute creation/update exists
- `Partial` Mechanic receives dispute notifications
- `Missing` Dedicated mechanic dispute listing/detail/update API
Notes:
The dispute system exists, but mechanic-side access is still indirect rather than first-class.

## Mechanic App Completion Verdict

- `Done` for core mechanic operational lifecycle:
  - auth
  - profile
  - availability
  - feed
  - quotes
  - my jobs
  - tracker progression
  - location pings
  - chat
  - notifications
  - earnings
  - support
  - job photos

- `Not complete yet` for full mechanic parity and production depth:
  - realtime transport for chat/tracking
  - quote revision/withdraw flows
  - richer proof-of-work workflows
  - mechanic-facing review listing
  - mechanic-facing dispute management
  - deeper payout operations

## Recommended Next Backend Tasks

1. Add mechanic-facing review list/detail endpoints.
2. Add mechanic-facing dispute list/detail endpoints.
3. Add quote withdraw / resubmit endpoints.
4. Add richer proof-of-work attachment semantics.
5. Add websocket or push strategy for realtime chat and tracking.
