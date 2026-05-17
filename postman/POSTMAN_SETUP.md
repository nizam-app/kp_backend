# TruckFix Postman pack — setup and variables

## 401 "Invalid credentials" (port is not the problem)

If the server returns **401** and `Invalid credentials`, the request **reached** the API (port/host are fine). Common causes:

1. **Seeded users had plaintext passwords in Mongo** (older `seedFakeData.js` used `findOneAndUpdate`, which skipped bcrypt). **Fix:** use the current seed script, then run `npm run seed:fake` again (set `SEED_FORCE=true` once if you need to rewrite users). Logins use **`Password123!`** for seeded accounts.

2. **Postman variables empty**: ensure **TruckFix — kp_backend (dev)** is selected (not **No environment**) so `{{fleetEmail}}` / `{{password}}` resolve — or paste manually: `fleet@truckfix.dev` and `Password123!`.

## Why the request URL looked empty in Postman

That happened when each request used **only** `url: { "raw": "{{baseUrl}}/api/v1/..." }` and **No environment** was selected. Many Postman builds **do not show** unresolved `{{baseUrl}}` in the address bar (it can appear blank even though the request exists).

**Fix in this repo:** each request now exports a **full Postman URL** (`protocol`, `host`, `port`, `path`, `query`) and a **literal** `raw` like:

`http://192.168.10.251:5000/api/v1/auth/login`

So the route is always visible. Dynamic pieces (for example `{{jobIdPosted}}`) still appear only where needed.

## Files

| File | Purpose |
|------|---------|
| `TruckFix.kp_backend.v1.postman_collection.json` | Collection (import into Postman). |
| `TruckFix.local.postman_environment.json` | Environment with defaults (import + select in top-right). |
| `build-truckfix-collection.mjs` | Regenerates the collection. Edit `DEFAULT_BASE_URL` at the top, then run `node postman/build-truckfix-collection.mjs`. |

## Recommended: select an environment

1. **Import** `TruckFix.local.postman_environment.json`.
2. In the top-right environment dropdown, choose **TruckFix — kp_backend (dev)** (not **No environment**).

Then `{{fleetEmail}}`, `{{password}}`, `{{baseUrl}}` in bodies resolve from that environment.

## If you keep “No environment”

The collection also defines **collection variables** (open the collection → **Variables**). After you run the login requests in folder `00 — Auth + seed context`, scripts fill tokens and job IDs into **both** environment (if selected) and collection variables.

You must still have **`baseUrl`** (and emails/password) defined — either import the environment or copy defaults into **collection variables**.

## Default API origin

Built into each request’s URL (`raw` + host/port): **`http://192.168.10.251:6000`** (match `HOST`/`PORT` in `kp_backend/.env`).

Match this to your running server (`HOST` / `PORT` in `kp_backend/.env`). To change for everyone:

1. Edit `DEFAULT_BASE_URL` in `build-truckfix-collection.mjs`.
2. Run: `node postman/build-truckfix-collection.mjs`.
3. Update `TruckFix.local.postman_environment.json` key `baseUrl` if you use the env file.

## Variable reference (detailed)

| Variable | Typical value | Set by |
|----------|----------------|--------|
| `baseUrl` | `http://192.168.10.251:5000` | Environment file / collection variables |
| `fleetEmail` | `fleet@truckfix.dev` | Environment / collection |
| `mechanicEmail` | `mechanic@truckfix.dev` | Environment / collection |
| `password` | `Password123!` | Environment / collection (seed users) |
| `fleetAccessToken` | JWT string | Test script on Fleet login |
| `fleetRefreshToken` | JWT string | Test script on Fleet login |
| `mechanicAccessToken` | JWT string | Test script on Mechanic login |
| `mechanicRefreshToken` | JWT string | Test script on Mechanic login |
| `jobCodePosted` | `TF-8819` | Default (seed) |
| `jobCodeEnRoute` | `TF-8821` | Default (seed) |
| `jobCodeAwaitingApproval` | `TF-8823` | Default (seed) |
| `jobIdPosted` | Mongo ObjectId string | Test script on `GET /jobs` (Fleet) |
| `jobIdEnRoute` | Mongo ObjectId string | Same |
| `jobIdAwaitingApproval` | Mongo ObjectId string | Same |
| `quoteIdWaiting145` | Mongo ObjectId string | Test script on `GET .../jobs/{{jobIdPosted}}/quotes` |

## Folder `00 — Auth + seed context` — run in order

1. **POST /auth/login (Fleet seed)** — fills Fleet tokens.  
2. **POST /auth/login (Mechanic seed — James)** — fills Mechanic tokens.  
3. **GET /jobs (Fleet) — resolve job ObjectIds** — fills `jobId*` from `jobCode*`.  
4. **GET /jobs/:jobId/quotes (Fleet)** — fills `quoteIdWaiting145` (James £145 WAITING on `TF-8819`).  

Later requests use Bearer `{{fleetAccessToken}}` or `{{mechanicAccessToken}}`.

## Seed data (Mongo)

From `kp_backend/`: `npm run seed:fake` (not in production).

Seeded accounts (example):

- Fleet: `fleet@truckfix.dev` / `Password123!`
- Mechanic (James): `mechanic@truckfix.dev` / `Password123!`

Seeded job codes: `TF-8819`, `TF-8819C`, `TF-8821`, `TF-8822`, `TF-8814`, `TF-8823`.

## API response shape

Most endpoints return JSON:

```json
{
  "status": "success",
  "message": "...",
  "data": { }
}
```

Login puts tokens under **`data.accessToken`** and **`data.refreshToken`**.

## Realtime

Job/chat realtime uses **Socket.IO**, not REST — not represented in this collection.
