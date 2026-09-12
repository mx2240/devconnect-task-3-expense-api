# DevConnect Task 3 — Expense Tracker API

A small but production-quality Expense Tracker REST API built with **Node.js + Express + PostgreSQL**.

It implements user accounts with JWT authentication, per-user expense CRUD with strict ownership
enforcement, and an **idempotent** `POST /expenses` write path that is safe under concurrent requests.

## Project Overview

- Node.js (CommonJS), Express 5, PostgreSQL via the `pg` driver (no ORM).
- Passwords hashed with `bcryptjs`.
- Auth via `jsonwebtoken` (Bearer tokens, 1h expiry).
- Parameterized SQL everywhere — no string-built queries.
- Idempotent expense creation keyed on `(user_id, idempotency_key)`.
- Automated integration tests using the Node.js built-in test runner.

## Architecture

```
src/
  app.js          Express app: middleware, routes, health, 404 + error handlers
  server.js       HTTP entry point (loads env, starts listener)
  db.js           pg connection pool and helpers
  middleware/
    auth.js       requireAuth — verifies the JWT Bearer token
  routes/
    auth.js       POST /auth/register, POST /auth/login
    expenses.js   CRUD + idempotent POST for expenses
db/
  schema.sql      users and expenses tables (+ indexes)
test/
  api.test.js     end-to-end integration tests
```

Data flow:

1. `POST /auth/register` (or `/auth/login`) returns `{ user, token }`.
2. Client sends `Authorization: Bearer <token>` on every `/expenses` request.
3. `requireAuth` verifies the token and sets `req.user = { id, email }`.
4. **Every** expense query includes `user_id = $<n>` — an expense can only ever be
   read/updated/deleted by the user who created it. Cross-user access returns `404 Not Found`
   (the resource is invisible to the caller).
5. `POST /expenses` requires an `Idempotency-Key` header and is guarded by the unique
   constraint `UNIQUE (user_id, idempotency_key)`.

## Setup

Prerequisites: Node.js 20+ (tested on v24) and PostgreSQL 14+.

```bash
npm install
cp .env.example .env     # then fill in real values
```

## Environment Variables

| Variable      | Required | Description                                        |
|---------------|----------|----------------------------------------------------|
| `DATABASE_URL`| yes      | PostgreSQL connection string (e.g. `postgres://user:pass@localhost:5432/devconnect_expenses`) |
| `JWT_SECRET`  | yes      | Long random string used to sign JWTs               |
| `PORT`        | no       | HTTP port (default `3000`)                         |

`.env.example` documents the shape. **Never commit `.env`** (it is gitignored).

## Database Setup

Run the schema against the target database:

```bash
psql "$DATABASE_URL" -f db/schema.sql
```

Schema summary:

```sql
users (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,              -- never returned or logged
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
)

expenses (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  amount NUMERIC(12,2) NOT NULL,
  description TEXT NOT NULL,
  category TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  request_fingerprint TEXT NOT NULL,        -- sha256 of normalized request body
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (user_id, idempotency_key)         -- the final idempotency backstop
)
```

## API Endpoints

### `GET /health`
Public. Returns `{ "status": "ok" }`.

### `POST /auth/register`
Body: `{ "email": "...", "password": "..." }` (password min. 8 chars).

- `201` → `{ "user": { id, email, created_at }, "token" }`
- `409` → email already registered

### `POST /auth/login`
Body: `{ "email": "...", "password": "..." }`.

- `200` → `{ "user": { id, email, created_at }, "token" }`
- `401` → invalid email or password

### `GET /expenses` *(auth required)*
Returns `{ "expenses": [...] }` for the authenticated user only.

### `GET /expenses/:id` *(auth required)*
Single expense, scoped to the authenticated user.

### `POST /expenses` *(auth required, idempotent)*
Headers: `Idempotency-Key: <value>`

Body: `{ "amount": 12.34, "description": "Lunch", "category": "Food" }`

Behavior is described in detail under **Idempotency** below.

### `PUT /expenses/:id` *(auth required)*
Body: same shape as create. Updates the caller's own expense.

### `DELETE /expenses/:id` *(auth required)*
Deletes the caller's own expense. Returns `204`.

## Authentication

Use JWT Bearer authentication:

```
Authorization: Bearer <token>
```

- Tokens are issued by `POST /auth/register` and `POST /auth/login`.
- Protected routes return `401` when no/invalid credentials are supplied:

```json
{ "error": "Authentication required: provide Authorization: Bearer <token>" }
```

- `password_hash` is never returned by any endpoint and never logged. Passwords are
  never logged.

## Authorization / Ownership

Every expense query filters by `WHERE id = $1 AND user_id = $2`. The API never fetches an
expense by ID alone, so a user cannot observe or mutate another user's row:

```sql
SELECT ... FROM expenses WHERE id = $1 AND user_id = $2
UPDATE expenses SET ... WHERE id = $1 AND user_id = $2 RETURNING ...
DELETE FROM expenses WHERE id = $1 AND user_id = $2 RETURNING id
```

Cross-user access attempts return `404` ("expense not found for the authenticated user"),
so one user cannot even learn that another user's expense ID exists.

## Idempotency

`POST /expenses` is the idempotent write path. It **requires** an `Idempotency-Key` header;
a missing/empty key returns `400`:

```json
{ "error": "Idempotency-Key header is required for POST /expenses" }
```

### How repeated requests are recognized

Repeated requests are recognized by the pair **(authenticated `user_id`, `Idempotency-Key`)**:

1. The request body is normalized (`amount` to 2 decimals, trimmed `description`/`category`).
2. A deterministic fingerprint is computed: `sha256(normalized JSON body)`.
3. The server tries `INSERT ... ON CONFLICT (user_id, idempotency_key) DO NOTHING` inside a
   transaction.
4. If no row existed, the insert wins → `201 Created`.
5. If a row already exists with the same key, the stored `request_fingerprint` is compared
   to the current request:
   - **Same fingerprint** → the request is a replay of the original → return the original
     expense with `200 OK` (no new row).
   - **Different fingerprint** → the key was reused with different data → `409 Conflict`
     with an actionable message.

The **database unique constraint `UNIQUE (user_id, idempotency_key)` is the final
protection** — the code never relies on a SELECT-before-INSERT check.

### Concurrency safety

Because step 3 performs a single atomic `INSERT ... ON CONFLICT DO NOTHING`, two concurrent
(truly simultaneous) identical requests cannot create two rows:

- One insert commits and returns the row.
- The other insert blocks on the unique index, sees the conflict after the winner commits,
  does nothing, then re-reads the existing row and returns `200` with the original expense.

Verified by an automated test (`two concurrent identical POST /expenses requests create one
row`).

### Example Idempotency-Key responses

**First request — `201 Created`:**

```json
{
  "expense": {
    "id": "1",
    "user_id": "1",
    "amount": "12.34",
    "description": "Lunch",
    "category": "Food",
    "idempotency_key": "lap-order-001",
    "created_at": "2026-09-12T15:00:00.000Z"
  }
}
```

**Replay (same key + same body) — `200 OK`:** the same expense object as above.

**Replay with different body — `409 Conflict`:**

```json
{
  "error": "Idempotency-Key was already used with a different request body; use a new key for this request"
}
```

**Missing key — `400 Bad Request`:**

```json
{
  "error": "Idempotency-Key header is required for POST /expenses"
}
```

Different users may freely use the same idempotency key — keys are scoped per user.

## Error Response Format

All errors use a consistent shape:

```json
{ "error": "<actionable message>" }
```

Examples:

| Situation                        | Status | Body                                              |
|----------------------------------|--------|---------------------------------------------------|
| No/invalid token                 | 401    | `{"error":"Authentication required: provide Authorization: Bearer <token>"}` |
| Invalid amount                   | 400    | `{"error":"amount must be greater than 0"}`       |
| Missing description              | 400    | `{"error":"description is required"}`             |
| Missing category                 | 400    | `{"error":"category is required"}`                |
| Missing Idempotency-Key          | 400    | `{"error":"Idempotency-Key header is required for POST /expenses"}` |
| Key reused with different body   | 409    | `{"error":"Idempotency-Key was already used with a different request body; use a new key for this request"}` |
| Email already registered         | 409    | `{"error":"email is already registered; use a different email or log in"}` |
| Invalid login                    | 401    | `{"error":"invalid email or password"}`           |
| Unknown/unowned expense          | 404    | `{"error":"expense not found for the authenticated user"}` |
| Malformed JSON body              | 400    | `{"error":"request body must be valid JSON"}`     |
| Unknown route                    | 404    | `{"error":"route not found"}`                     |

Messages tell the caller exactly what to fix.

## Tests

Integration tests hit a real PostgreSQL database through the running Express app
(Node built-in test runner).

```bash
# point at a scratch/test database (never a production one)
export DATABASE_URL=postgres://postgres:YOURPASSWORD@localhost:5432/devconnect_expenses_test
export JWT_SECRET=some-test-secret
npm test
```

The suite covers:

1. `GET /health` returns 200.
2. Register works (and never returns `password_hash`).
3. Login works.
4. Protected `GET /expenses` without a token returns 401.
5. Authenticated user can create an expense.
6. Authenticated user can read their own expense.
7. User A cannot read User B's expense.
8. User A cannot update User B's expense.
9. User A cannot delete User B's expense.
10. Same idempotency key + same request returns the original expense, one row only.
11. Same idempotency key + different request returns 409.
12. Missing `Idempotency-Key` returns 400.
13. Invalid amount returns 400.
14. Invalid login returns 401.
15. Unknown expense returns 404.
16. Two concurrent identical `POST /expenses` requests create only one row.
17. Different users may reuse the same idempotency key.

## Deployment

Deployable anywhere Node + PostgreSQL are available. Steps for a typical PaaS (Render /
Railway / Heroku / Fly):

1. Provision a PostgreSQL instance and copy its connection string.
2. Push this repo to your Git provider.
3. Create the schema once: `psql "$DATABASE_URL" -f db/schema.sql`
   (or run the start command with a one-off `node -e` migration).
4. Set environment variables: `DATABASE_URL`, `JWT_SECRET` (use a
   `openssl rand -hex 32` value), optional `PORT`.
5. Start command: `npm start`.

### Public Deployment URL

Public URL placeholder (fill in after deploying):

```
https://<your-app>.onrender.com
```

## Acceptance Criteria Checklist

- [x] Deployable service with a public URL (placeholder documented above).
- [x] User accounts and authentication (register/login + JWT).
- [x] Protected routes return `401` when no credentials are supplied.
- [x] Users cannot read/update/delete another user's expenses (all queries scoped by `user_id`).
- [x] Automated tests prove cross-user access is prevented.
- [x] Idempotent write path on `POST /expenses`.
- [x] `Idempotency-Key` header required and validated.
- [x] Repeated requests recognized by `(user_id, idempotency_key)`.
- [x] Same key + same body returns the original expense (no duplicate row).
- [x] Same key + different body returns `409` with a clear explanation.
- [x] Error responses explain what the caller needs to fix.
- [x] Concurrent identical requests produce exactly one row (unique constraint as backstop).
- [x] No secrets committed; `.env` gitignored; `.env.example` provided.
- [x] Parameterized SQL throughout; no string interpolation of user input.

## Security Notes

- Passwords are hashed with bcrypt (cost 12). They are never stored in plaintext, never
  returned by the API, and never written to logs.
- All SQL is parameterized (`$1`, `$2`, …) — user input can never alter query structure.
- JWT secret must come from the environment (`JWT_SECRET`); the server refuses to start
  without it.
- Expense ownership is enforced in SQL with `WHERE ... AND user_id = $2`, making
  cross-user access impossible even if a handler bug were introduced elsewhere.
- Idempotency relies on a database `UNIQUE (user_id, idempotency_key)` constraint, not
  only on application logic, so it stays correct under concurrency.
- `.gitignore` excludes `.env` and `.env.*` (while keeping `.env.example`). Never commit
  real connection strings or secrets.