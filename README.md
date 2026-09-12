# DevConnect Task 3 — Expense Tracker API

A small but production-quality Expense Tracker REST API built with **Node.js + Express + PostgreSQL**.

It implements user accounts with JWT authentication, per-user expense CRUD with strict ownership enforcement, and an **idempotent** `POST /expenses` write path that is safe under concurrent requests.

## Project Overview

* Node.js (CommonJS), Express 5, PostgreSQL via the `pg` driver (no ORM).
* Passwords hashed with `bcryptjs`.
* Auth via `jsonwebtoken` (Bearer tokens, 1h expiry).
* Parameterized SQL everywhere — no string-built queries.
* Idempotent expense creation keyed on `(user_id, idempotency_key)`.
* Automated integration tests using the Node.js built-in test runner.
* Deployed publicly on Render with PostgreSQL.

## Public Deployment

**Live API:**

https://devconnect-task-3-expense-api.onrender.com

Health check:

https://devconnect-task-3-expense-api.onrender.com/health

Expected response:

```json
{
  "status": "ok"
}
```

## Architecture

```text
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
4. **Every** expense query includes `user_id = $<n>` — an expense can only ever be read, updated, or deleted by the user who created it. Cross-user access returns `404 Not Found`.
5. `POST /expenses` requires an `Idempotency-Key` header and is guarded by the unique constraint `UNIQUE (user_id, idempotency_key)`.

## Setup

Prerequisites:

* Node.js 20+ (tested on Node.js 24)
* PostgreSQL 14+

```bash
npm install
```

Create `.env` from `.env.example` and fill in the real values:

```bash
cp .env.example .env
```

On Windows, you can simply copy `.env.example` to `.env` manually.

## Environment Variables

| Variable       | Required | Description                          |
| -------------- | -------- | ------------------------------------ |
| `DATABASE_URL` | Yes      | PostgreSQL connection string         |
| `JWT_SECRET`   | Yes      | Long random string used to sign JWTs |
| `PORT`         | No       | HTTP port; defaults to `3000`        |

Example:

```env
DATABASE_URL=postgres://user:password@localhost:5432/devconnect_expenses
JWT_SECRET=replace_with_a_long_random_secret
PORT=3000
```

**Never commit `.env`.** It is gitignored. The repository only contains `.env.example`.

## Database Setup

Run the schema against the target database:

```bash
psql "$DATABASE_URL" -f db/schema.sql
```

The production Render PostgreSQL database used by this deployment has already been initialized with this schema.

### Schema Summary

```sql
users (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
)

expenses (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  amount NUMERIC(12,2) NOT NULL,
  description TEXT NOT NULL,
  category TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  request_fingerprint TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (user_id, idempotency_key)
)
```

## API Endpoints

### `GET /health`

Public.

Returns:

```json
{
  "status": "ok"
}
```

### `POST /auth/register`

Body:

```json
{
  "email": "user@example.com",
  "password": "password123"
}
```

Password must be at least 8 characters.

Responses:

* `201` — account created and JWT returned
* `400` — invalid input
* `409` — email already registered

### `POST /auth/login`

Body:

```json
{
  "email": "user@example.com",
  "password": "password123"
}
```

Responses:

* `200` — authenticated user and JWT returned
* `400` — missing input
* `401` — invalid email or password

### `GET /expenses`

**Authentication required.**

Returns expenses belonging only to the authenticated user.

### `GET /expenses/:id`

**Authentication required.**

Returns one expense only if it belongs to the authenticated user.

### `POST /expenses`

**Authentication required and idempotent.**

Headers:

```text
Authorization: Bearer <token>
Idempotency-Key: <unique-key>
```

Body:

```json
{
  "amount": 12.34,
  "description": "Lunch",
  "category": "Food"
}
```

Behavior is described in detail under **Idempotency** below.

### `PUT /expenses/:id`

**Authentication required.**

Body:

```json
{
  "amount": 20.00,
  "description": "Dinner",
  "category": "Food"
}
```

Updates only the authenticated user's expense.

### `DELETE /expenses/:id`

**Authentication required.**

Deletes only the authenticated user's expense.

Returns `204 No Content` on success.

## Authentication

The API uses JWT Bearer authentication.

Send the token using:

```text
Authorization: Bearer <token>
```

Tokens are issued by:

* `POST /auth/register`
* `POST /auth/login`

Protected routes return `401` when credentials are missing or invalid.

Example:

```json
{
  "error": "Authentication required: provide Authorization: Bearer <token>"
}
```

Passwords are never returned by the API or written to logs.

## Authorization / Ownership

Every expense query is scoped to the authenticated user's ID.

For example:

```sql
SELECT ...
FROM expenses
WHERE id = $1 AND user_id = $2;
```

Updates and deletes are also scoped:

```sql
UPDATE expenses
SET ...
WHERE id = $1 AND user_id = $2
RETURNING ...;
```

```sql
DELETE FROM expenses
WHERE id = $1 AND user_id = $2
RETURNING id;
```

The API never fetches an expense by ID alone.

Therefore, a user cannot read, update, or delete another user's expense.

Cross-user access attempts return:

```text
404 Not Found
```

with:

```json
{
  "error": "expense not found for the authenticated user"
}
```

This also prevents callers from learning whether another user's expense ID exists.

## Idempotency

`POST /expenses` is the idempotent write path.

It **requires** an `Idempotency-Key` header.

If the header is missing or empty, the API returns:

```text
400 Bad Request
```

with:

```json
{
  "error": "Idempotency-Key header is required for POST /expenses"
}
```

### How Repeated Requests Are Recognized

Repeated requests are recognized using the pair:

```text
(authenticated user_id, Idempotency-Key)
```

The process is:

1. The request body is normalized:

   * `amount` is converted to two decimal places.
   * `description` is trimmed.
   * `category` is trimmed.

2. A deterministic SHA-256 fingerprint is calculated from the normalized request body.

3. The server attempts:

```sql
INSERT ... 
ON CONFLICT (user_id, idempotency_key) DO NOTHING
```

inside a transaction.

4. If no row previously exists, the insert succeeds and returns:

```text
201 Created
```

5. If the same user has already used the key:

   * Same request body → return the original expense with `200 OK`.
   * Different request body → return `409 Conflict`.

### Same Request Replay

First request:

```text
201 Created
```

A repeated identical request with the same `Idempotency-Key` returns:

```text
200 OK
```

and the same expense ID.

No second database row is created.

### Different Request With Same Key

If the same user reuses an existing key with different data, the API returns:

```text
409 Conflict
```

Example:

```json
{
  "error": "Idempotency-Key was already used with a different request body; use a new key for this request"
}
```

This prevents accidental reuse of an idempotency key for a different operation.

### Concurrency Safety

The database constraint:

```sql
UNIQUE (user_id, idempotency_key)
```

is the final protection against duplicate rows.

The application does not rely on a vulnerable `SELECT`-before-`INSERT` pattern.

Instead, the database handles competing inserts atomically through the unique constraint and:

```sql
ON CONFLICT DO NOTHING
```

Therefore, concurrent identical requests cannot create duplicate expense rows.

Different users may reuse the same idempotency key because the key is scoped by `user_id`.

## Error Response Format

Errors use a consistent response shape:

```json
{
  "error": "actionable message"
}
```

Examples:

| Situation                      | Status | Error                                                                                            |
| ------------------------------ | -----: | ------------------------------------------------------------------------------------------------ |
| Missing/invalid authentication |    401 | `Authentication required: provide Authorization: Bearer <token>`                                 |
| Invalid JWT                    |    401 | `Invalid or expired authentication token`                                                        |
| Invalid amount                 |    400 | `amount must be greater than 0`                                                                  |
| Missing description            |    400 | `description is required`                                                                        |
| Missing category               |    400 | `category is required`                                                                           |
| Missing Idempotency-Key        |    400 | `Idempotency-Key header is required for POST /expenses`                                          |
| Same key with different body   |    409 | `Idempotency-Key was already used with a different request body; use a new key for this request` |
| Email already registered       |    409 | `email is already registered; use a different email or log in`                                   |
| Invalid login                  |    401 | `invalid email or password`                                                                      |
| Unknown/unowned expense        |    404 | `expense not found for the authenticated user`                                                   |
| Malformed JSON                 |    400 | `request body must be valid JSON`                                                                |
| Unknown route                  |    404 | `route not found`                                                                                |

The error messages are designed to tell the caller what needs to be changed without requiring access to the source code.

## Tests

Integration tests use a real PostgreSQL database and the Node.js built-in test runner.

Run:

```bash
npm test
```

The current test suite contains **16 passing tests** covering:

1. `GET /health` returns 200.
2. Register works and never returns `password_hash`.
3. Login works.
4. Protected `GET /expenses` without a token returns 401.
5. Authenticated user can create an expense.
6. Authenticated user can read their own expense.
7. User A cannot read User B's expense.
8. User A cannot update User B's expense.
9. User A cannot delete User B's expense.
10. Same idempotency key + same request returns the original expense without creating a duplicate row.
11. Same idempotency key + different request returns 409.
12. Missing `Idempotency-Key` returns 400.
13. Invalid amount returns 400.
14. Invalid login returns 401.
15. Unknown expense returns 404.
16. Two concurrent identical `POST /expenses` requests create only one row.

The suite also includes hardening checks for malformed JSON and invalid JWT handling within the existing test coverage.

## Deployment

The API is deployed as a Render Web Service connected to a Render PostgreSQL database.

### Render Configuration

Build command:

```text
npm install
```

Start command:

```text
npm start
```

Required environment variables:

```text
DATABASE_URL
JWT_SECRET
```

Render provides the production `PORT` automatically.

The production database schema was initialized separately before deployment.

### Production URL

```text
https://devconnect-task-3-expense-api.onrender.com
```

Health endpoint:

```text
https://devconnect-task-3-expense-api.onrender.com/health
```

## Acceptance Criteria Checklist

* [x] Deployed service with a public URL.
* [x] Public health endpoint is reachable.
* [x] User accounts and authentication implemented.
* [x] Protected routes return `401` when no credentials are supplied.
* [x] Invalid JWTs return `401`.
* [x] Users cannot read another user's expenses.
* [x] Users cannot update another user's expenses.
* [x] Users cannot delete another user's expenses.
* [x] Automated tests prove cross-user access is prevented.
* [x] Idempotent write path implemented on `POST /expenses`.
* [x] `Idempotency-Key` header is required.
* [x] Repeated requests are recognized by `(user_id, idempotency_key)`.
* [x] Same key + same body returns the original expense without creating a duplicate.
* [x] Same key + different body returns `409 Conflict`.
* [x] Error responses explain what the caller needs to fix.
* [x] Concurrent identical requests are protected by the database unique constraint.
* [x] No secrets committed to the repository.
* [x] `.env` is gitignored and `.env.example` is provided.
* [x] SQL queries are parameterized throughout.

## Security Notes

* Passwords are hashed with bcrypt using a cost factor of 12.
* Passwords are never stored in plaintext.
* Password hashes are never returned by the API.
* Passwords are never logged.
* All SQL uses parameterized queries (`$1`, `$2`, etc.).
* JWT signing uses the `JWT_SECRET` environment variable.
* The server refuses to start without required `DATABASE_URL` and `JWT_SECRET` environment variables.
* Expense ownership is enforced directly in SQL using `user_id`.
* Idempotency is enforced with a database-level unique constraint.
* `.gitignore` excludes `.env` and `.env.*` while keeping `.env.example`.
* Real database credentials, JWT secrets, and other sensitive values must never be committed to Git.
