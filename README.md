# DevConnect Task 3 — Expense Tracker API

A small, production-quality Expense Tracker REST API built with **Node.js, Express, and PostgreSQL**.

The API provides user accounts, JWT authentication, user-owned expense CRUD operations, and an idempotent `POST /expenses` write path that is safe to retry, including under concurrent requests.

## Project Overview

* Node.js using CommonJS modules.
* Express 5 REST API.
* PostgreSQL database using the `pg` driver.
* No ORM.
* Passwords hashed with `bcryptjs`.
* JWT authentication using `jsonwebtoken`.
* Parameterized SQL queries throughout.
* Per-user expense ownership enforcement.
* Idempotent expense creation using `Idempotency-Key`.
* Database-level uniqueness protection for idempotency.
* Automated integration tests using the Node.js built-in test runner.
* Deployed publicly on Render.

## Public Deployment

**Live API:**

`https://devconnect-task-3-expense-api.onrender.com`

**Health check:**

`https://devconnect-task-3-expense-api.onrender.com/health`

Expected response:

```json
{
  "status": "ok"
}
```

The deployment has been tested successfully.

---

# Architecture

```text
devconnect-task-3-expense-api/
├── src/
│   ├── app.js
│   ├── server.js
│   ├── db.js
│   ├── middleware/
│   │   └── auth.js
│   └── routes/
│       ├── auth.js
│       └── expenses.js
├── db/
│   └── schema.sql
├── test/
│   └── api.test.js
├── .env
├── .env.example
├── .gitignore
├── package.json
└── README.md
```

### Main files

| File                     | Purpose                                                         |
| ------------------------ | --------------------------------------------------------------- |
| `src/app.js`             | Express application, middleware, routes, 404 and error handling |
| `src/server.js`          | Loads environment variables and starts the HTTP server          |
| `src/db.js`              | PostgreSQL connection pool                                      |
| `src/middleware/auth.js` | JWT authentication middleware                                   |
| `src/routes/auth.js`     | Registration and login                                          |
| `src/routes/expenses.js` | Expense CRUD and idempotent creation                            |
| `db/schema.sql`          | PostgreSQL database schema                                      |
| `test/api.test.js`       | Integration tests                                               |

## Request Flow

1. A user registers or logs in.
2. The API returns a JWT.
3. The client sends the JWT using `Authorization: Bearer <token>`.
4. The authentication middleware verifies the token.
5. The authenticated user's ID is attached to the request.
6. Expense queries are always scoped to that user ID.
7. `POST /expenses` additionally requires an `Idempotency-Key`.

---

# Prerequisites

The following are required for local development:

* **Node.js 20 LTS or newer**

  * The deployed application has been tested with Node.js `24.14.1`.
* **PostgreSQL 14 or newer**

  * The production database currently uses PostgreSQL 18.
* Git
* `psql` if using the PostgreSQL command-line setup shown below.

Check your versions:

```bash
node --version
npm --version
psql --version
```

---

# Local Setup

A new developer should be able to clone the repository, configure PostgreSQL, start the service, and call `/health` using the instructions below.

## 1. Clone the repository

```bash
git clone <repository-url>
cd devconnect-task-3-expense-api
```

## 2. Install dependencies

```bash
npm install
```

## 3. Create the environment file

Copy `.env.example` to `.env`.

On Windows PowerShell:

```powershell
Copy-Item .env.example .env
```

On macOS/Linux:

```bash
cp .env.example .env
```

Edit `.env` and provide the correct values.

## 4. Create the PostgreSQL database

Create a PostgreSQL database named, for example:

```text
devconnect_expenses
```

Then update `DATABASE_URL` in `.env` to point to that database.

## 5. Apply the database schema

Run:

```bash
psql "$DATABASE_URL" -f db/schema.sql
```

If using Windows PowerShell, you can also provide the connection string directly to `psql` or run the SQL file through pgAdmin.

The schema creates the `users` and `expenses` tables and the required indexes and constraints.

## 6. Start the API

```bash
npm start
```

The local server uses port `3000` unless `PORT` is provided.

Expected output:

```text
Expense API listening on port 3000
```

## 7. Call the health endpoint

Open:

```text
http://localhost:3000/health
```

Expected response:

```json
{
  "status": "ok"
}
```

No authentication is required for the health endpoint.

---

# Environment Variables

| Variable       | Required? | Source                                                                    | Default | Starts without it? |
| -------------- | --------- | ------------------------------------------------------------------------- | ------- | ------------------ |
| `DATABASE_URL` | Yes       | PostgreSQL connection string from the local or hosted PostgreSQL database | None    | **No**             |
| `JWT_SECRET`   | Yes       | A long random secret generated by the developer/operator                  | None    | **No**             |
| `PORT`         | No        | Local developer choice; Render provides the production port               | `3000`  | **Yes**            |

## `DATABASE_URL`

Example:

```text
postgres://username:password@localhost:5432/devconnect_expenses
```

For production, the value comes from the deployed PostgreSQL provider.

The application refuses to start if `DATABASE_URL` is missing.

## `JWT_SECRET`

This is a private secret used to sign and verify JWT authentication tokens.

It should be generated by the developer/operator and must never be committed to Git.

The application refuses to start if `JWT_SECRET` is missing.

## `PORT`

This is the HTTP port used by Express.

Locally, the application defaults to:

```text
3000
```

Render supplies the production `PORT` automatically.

The application can start without explicitly defining `PORT`.

---

# Database Model

The application uses two main tables.

## `users`

| Column          | Type        | Rules               |
| --------------- | ----------- | ------------------- |
| `id`            | BIGINT      | Primary key         |
| `email`         | TEXT        | Unique and required |
| `password_hash` | TEXT        | Required            |
| `created_at`    | TIMESTAMPTZ | Automatically set   |

## `expenses`

| Column                | Type          | Rules                                     |
| --------------------- | ------------- | ----------------------------------------- |
| `id`                  | BIGINT        | Primary key                               |
| `user_id`             | BIGINT        | References `users.id`                     |
| `amount`              | NUMERIC(12,2) | Must be greater than 0 at API validation  |
| `description`         | TEXT          | Required                                  |
| `category`            | TEXT          | Required                                  |
| `idempotency_key`     | TEXT          | Required                                  |
| `request_fingerprint` | TEXT          | SHA-256 fingerprint of normalized request |
| `created_at`          | TIMESTAMPTZ   | Automatically set                         |

The database has:

```sql
UNIQUE (user_id, idempotency_key)
```

This ensures that one authenticated user cannot create multiple expenses using the same idempotency key.

Different users may use the same idempotency key.

---

# API Reference

All API responses use JSON unless otherwise stated.

## `GET /health`

### Authentication
none.

### Authentication quick example

#### Register

```http
POST /auth/register
Content-Type: application/json

{
  "email": "alice@example.com",
  "password": "password123"
}

### Input

No body or authentication header required.

### Success

`200 OK`

```json
{
  "status": "ok"
}
```

### Possible status codes

| Status | Meaning            |
| -----: | ------------------ |
|  `200` | Service is running |

---

# Authentication Endpoints

## `POST /auth/register`

Creates a new user account.

### Authentication

None.

### Request body

```json
{
  "email": "user@example.com",
  "password": "password123"
}
```

### Input rules

* Email must have a valid email format.
* Password must contain at least 8 characters.

### Success

`201 Created`

Example:

```json
{
  "user": {
    "id": 1,
    "email": "user@example.com",
    "created_at": "2026-09-12T12:00:00.000Z"
  },
  "token": "<jwt-token>"
}
```

### Possible status codes

| Status | Meaning                          |
| -----: | -------------------------------- |
|  `201` | Account successfully created     |
|  `400` | Invalid email or password        |
|  `409` | Email is already registered      |
|  `500` | Unexpected server/database error |

---

## `POST /auth/login`

Authenticates an existing user.

### Authentication

None.

### Request body

```json
{
  "email": "user@example.com",
  "password": "password123"
}
```

### Success

`200 OK`

Example:

```json
{
  "user": {
    "id": 1,
    "email": "user@example.com",
    "created_at": "2026-09-12T12:00:00.000Z"
  },
  "token": "<jwt-token>"
}
```

### Possible status codes

| Status | Meaning                          |
| -----: | -------------------------------- |
|  `200` | Login successful                 |
|  `400` | Email or password is missing     |
|  `401` | Invalid email or password        |
|  `500` | Unexpected server/database error |

---

# Expense Endpoints

All expense endpoints require:

```text
Authorization: Bearer <token>
```

## `GET /expenses`

Returns expenses belonging to the authenticated user.

### Request body

None.

### Success

`200 OK`

```json
{
  "expenses": [
    {
      "id": 1,
      "user_id": 1,
      "amount": "25.50",
      "description": "Lunch",
      "category": "Food",
      "idempotency_key": "expense-001",
      "created_at": "2026-09-12T12:00:00.000Z"
    }
  ]
}
```

### Possible status codes

| Status | Meaning                           |
| -----: | --------------------------------- |
|  `200` | Expenses returned                 |
|  `401` | Authentication missing or invalid |
|  `500` | Unexpected server/database error  |

---

## `GET /expenses/:id`

Returns one expense belonging to the authenticated user.

### Example

```text
GET /expenses/1
```

### Request body

None.

### Success

`200 OK`

```json
{
  "expense": {
    "id": 1,
    "user_id": 1,
    "amount": "25.50",
    "description": "Lunch",
    "category": "Food",
    "idempotency_key": "expense-001",
    "created_at": "2026-09-12T12:00:00.000Z"
  }
}
```

### Possible status codes

| Status | Meaning                                                             |
| -----: | ------------------------------------------------------------------- |
|  `200` | Expense returned                                                    |
|  `401` | Authentication missing or invalid                                   |
|  `404` | Expense does not belong to the authenticated user or does not exist |
|  `500` | Unexpected server/database error                                    |

---

## `POST /expenses`

Creates an expense.

This is the API's **idempotent write path**.

### Authentication

Required.

### Required header

```text
Authorization: Bearer <token>
Idempotency-Key: <unique-key>
```

### Request body

```json
{
  "amount": 12.34,
  "description": "Lunch",
  "category": "Food"
}
```

### Input rules

* `amount` must be greater than `0`.
* `description` is required.
* `category` is required.
* `Idempotency-Key` is required.

### First successful request

`201 Created`

```json
{
  "expense": {
    "id": 1,
    "user_id": 1,
    "amount": "12.34",
    "description": "Lunch",
    "category": "Food",
    "idempotency_key": "expense-001",
    "created_at": "2026-09-12T12:00:00.000Z"
  }
}
```

### Repeated identical request

`200 OK`

The API returns the original expense instead of creating a second row.

### Same key with different request

`409 Conflict`

```json
{
  "error": "Idempotency-Key was already used with a different request body; use a new key for this request"
}
```

### Possible status codes

| Status | Meaning                                           |
| -----: | ------------------------------------------------- |
|  `201` | New expense created                               |
|  `200` | Existing result returned for an identical retry   |
|  `400` | Missing idempotency key or invalid expense data   |
|  `401` | Authentication missing or invalid                 |
|  `409` | Same idempotency key was used with different data |
|  `500` | Unexpected server/database error                  |

---

## `PUT /expenses/:id`

Updates an expense belonging to the authenticated user.

### Example

```text
PUT /expenses/1
```

### Request body

```json
{
  "amount": 20.00,
  "description": "Dinner",
  "category": "Food"
}
```

### Success

`200 OK`

```json
{
  "expense": {
    "id": 1,
    "user_id": 1,
    "amount": "20.00",
    "description": "Dinner",
    "category": "Food",
    "idempotency_key": "expense-001",
    "created_at": "2026-09-12T12:00:00.000Z"
  }
}
```

### Possible status codes

| Status | Meaning                                                             |
| -----: | ------------------------------------------------------------------- |
|  `200` | Expense updated                                                     |
|  `400` | Invalid expense data                                                |
|  `401` | Authentication missing or invalid                                   |
|  `404` | Expense does not belong to the authenticated user or does not exist |
|  `500` | Unexpected server/database error                                    |

---

## `DELETE /expenses/:id`

Deletes an expense belonging to the authenticated user.

### Example

```text
DELETE /expenses/1
```

### Request body

None.

### Success

`204 No Content`

No response body is returned.

### Possible status codes

| Status | Meaning                                                             |
| -----: | ------------------------------------------------------------------- |
|  `204` | Expense deleted                                                     |
|  `401` | Authentication missing or invalid                                   |
|  `404` | Expense does not belong to the authenticated user or does not exist |
|  `500` | Unexpected server/database error                                    |

---

# Authentication and Authorization

The API uses JWT Bearer authentication.

A successful registration or login returns a JWT.

Clients send it using:

```text
Authorization: Bearer <token>
```

Protected routes return `401` if the token is missing, malformed, invalid, or expired.

Example:

```json
{
  "error": "Authentication required: provide Authorization: Bearer <token>"
}
```

Invalid tokens return:

```json
{
  "error": "Invalid or expired authentication token"
}
```

## Expense Ownership

Every expense database operation is scoped to the authenticated user's ID.

For example:

```sql
SELECT id, user_id, amount, description, category
FROM expenses
WHERE id = $1 AND user_id = $2;
```

Updates also include the user ID:

```sql
UPDATE expenses
SET amount = $1,
    description = $2,
    category = $3
WHERE id = $4
  AND user_id = $5
RETURNING ...;
```

Deletes use the same ownership rule:

```sql
DELETE FROM expenses
WHERE id = $1
  AND user_id = $2
RETURNING id;
```

The API therefore never allows a user to operate on another user's expense.

Cross-user access returns:

```text
404 Not Found
```

with:

```json
{
  "error": "expense not found for the authenticated user"
}
```

---

# Idempotency

`POST /expenses` requires an `Idempotency-Key`.

Repeated requests are recognized using:

```text
authenticated user_id + Idempotency-Key
```

The request body is normalized and hashed with SHA-256.

The normalized fields are:

* `amount`
* `description`
* `category`

The database then enforces:

```sql
UNIQUE (user_id, idempotency_key)
```

The insert uses:

```sql
ON CONFLICT (user_id, idempotency_key) DO NOTHING
```

## Same request repeated

If the same user sends the same key and same request data again, the API returns the original expense.

No duplicate row is created.

## Same key with different data

If the same user sends the same key with different data, the API returns:

```text
409 Conflict
```

The caller must use a new idempotency key.

## Concurrent requests

The unique database constraint provides the final protection against duplicate rows when identical requests arrive at the same time.

Different users can use the same idempotency key because uniqueness is scoped by `user_id`.

---

# Error Responses

Errors use the following general format:

```json
{
  "error": "actionable message"
}
```

Common errors include:

| Situation                          | Status | Example                                  |
| ---------------------------------- | -----: | ---------------------------------------- |
| Missing authentication             |  `401` | Authentication required                  |
| Invalid JWT                        |  `401` | Invalid or expired authentication token  |
| Invalid amount                     |  `400` | `amount must be greater than 0`          |
| Missing description                |  `400` | `description is required`                |
| Missing category                   |  `400` | `category is required`                   |
| Missing idempotency key            |  `400` | Idempotency-Key header is required       |
| Different body with existing key   |  `409` | Use a new idempotency key                |
| Duplicate email                    |  `409` | Email is already registered              |
| Invalid login                      |  `401` | Invalid email or password                |
| Unknown/unowned expense            |  `404` | Expense not found for authenticated user |
| Malformed JSON                     |  `400` | Request body must be valid JSON          |
| Unknown route                      |  `404` | Route not found                          |
| Unexpected server/database failure |  `500` | Internal server error                    |

The messages are intended to tell the caller what needs to be changed without requiring access to the source code.

---

# Tests

The project uses the Node.js built-in test runner and a real PostgreSQL database for integration testing.

Run:

```bash
npm test
```

The current suite contains **16 passing integration tests** covering the main acceptance criteria, including:

1. Health endpoint.
2. User registration.
3. User login.
4. Protected routes requiring authentication.
5. Expense creation.
6. Reading the authenticated user's expense.
7. Preventing User A from reading User B's expense.
8. Preventing User A from updating User B's expense.
9. Preventing User A from deleting User B's expense.
10. Idempotent replay of the same request.
11. Rejection of the same key with different data.
12. Missing idempotency key validation.
13. Invalid amount validation.
14. Invalid login.
15. Unknown expense handling.
16. Concurrent identical expense creation.

Additional hardening checks cover malformed JSON and invalid JWT handling.

Current local verification:

```text
16 tests passed
0 tests failed
```

---

# Running the Tests

The test suite requires a PostgreSQL database.

Set the test environment variables to a test database before running:

```text
DATABASE_URL=<test PostgreSQL connection string>
JWT_SECRET=<test secret>
```

Then run:

```bash
npm test
```

The tests create the required schema and clean up test data between test cases.

Do not point automated tests at a database containing important production data.

---

# Deployment

The application is deployed as a Render Web Service connected to a Render PostgreSQL database.

## Render Build Command

```text
npm install
```

## Render Start Command

```text
npm start
```

## Production environment variables

```text
DATABASE_URL
JWT_SECRET
PORT
```

`DATABASE_URL` and `JWT_SECRET` are required by the application.

Render supplies `PORT` automatically.

The production PostgreSQL database was initialized using `db/schema.sql`.

## Production API

```text
https://devconnect-task-3-expense-api.onrender.com
```

## Production health check

```text
https://devconnect-task-3-expense-api.onrender.com/health
```

---

# Decisions to Revisit at 10× Traffic

The current implementation is intentionally simple and appropriate for the project's scope.

If traffic increased by approximately 10×, the following areas would be revisited.

## 1. Database connection pooling

The current application uses PostgreSQL connection pooling through `pg`.

At higher traffic, I would:

* Measure connection utilization.
* Tune pool size.
* Monitor connection exhaustion.
* Consider a managed connection pooler if required.

## 2. Database indexes

The current schema indexes expenses by user and creation time.

At higher traffic, I would inspect query plans and add or adjust indexes based on real query patterns rather than adding indexes blindly.

## 3. Pagination

`GET /expenses` currently returns all expenses belonging to the authenticated user.

At 10× traffic and larger datasets, this should be changed to cursor-based or limit/offset pagination.

## 4. Rate limiting

The current project does not implement production rate limiting.

At higher traffic, I would add rate limits to authentication and write endpoints to reduce abuse and accidental request floods.

## 5. Observability

At higher traffic, I would add:

* Structured logging.
* Request metrics.
* Database performance metrics.
* Error monitoring.
* Health/readiness checks.

## 6. Caching

Caching would only be introduced after measuring actual bottlenecks.

Frequently requested read data could potentially be cached, but user-specific expense data requires careful cache isolation.

## 7. Database scaling

If PostgreSQL became the bottleneck, I would evaluate:

* Query optimization.
* Larger database resources.
* Read replicas for suitable read-heavy workloads.
* Archiving old data where appropriate.

## 8. Idempotency storage

The current design stores idempotency information directly on the expense row.

If the API developed many different idempotent write operations, I would consider a dedicated idempotency table so that idempotency behavior could be shared across multiple endpoints.

---

# Limitations and Known Issues

This project intentionally focuses on the requirements of the DevConnect Task 3 final project.

It does **not** currently provide:

* A web frontend.
* A mobile application.
* Password reset.
* Email verification.
* Refresh tokens.
* Social login.
* Expense sharing between users.
* Pagination for `GET /expenses`.
* Production rate limiting.
* Advanced monitoring or distributed tracing.
* Automated database migrations.
* File or receipt uploads.
* Currency conversion.
* Recurring expenses.
* Budget management.

There are no known intentionally broken core features at the time of submission.

The application has been tested locally and deployed successfully on Render.

The limitations above are known scope limitations rather than hidden defects.

---

# Security Notes

* Passwords are hashed using bcrypt.
* Passwords are never stored in plaintext.
* Password hashes are never returned by the API.
* Passwords are not written to application logs.
* SQL queries use parameters rather than string concatenation.
* JWT signing uses the private `JWT_SECRET` environment variable.
* The application refuses to start when required secrets are missing.
* Expense ownership is enforced directly in SQL.
* Idempotency is protected by a database-level unique constraint.
* `.env` is excluded from Git.
* `.env.example` contains only placeholder values.
* Real database passwords and JWT secrets must never be committed.

---

# Acceptance Criteria

The implementation satisfies the final project requirements:

* [x] Publicly deployed API.
* [x] Repository available for review.
* [x] User accounts.
* [x] Authentication.
* [x] Protected routes return `401` without credentials.
* [x] Invalid authentication returns `401`.
* [x] Users cannot read another user's rows.
* [x] Users cannot update another user's rows.
* [x] Users cannot delete another user's rows.
* [x] Automated tests verify ownership isolation.
* [x] Idempotent write path implemented.
* [x] Duplicate identical requests return the original result.
* [x] Duplicate requests do not create duplicate database rows.
* [x] Same idempotency key with different data returns `409`.
* [x] Error responses explain what the caller needs to fix.
* [x] Concurrent identical writes are protected by the database constraint.
* [x] No secrets are committed.
* [x] README documents setup and API behavior.
* [x] Limitations and future scaling decisions are documented.

---

# Repository

The repository contains the source code, database schema, automated tests, environment example, and this README.

Before deployment or submission, verify that:

```bash
git status
```

does not show `.env` or other secret files as tracked changes.

The project should be submitted together with the public repository and deployed API URL.
