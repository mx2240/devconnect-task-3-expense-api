const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const http = require('node:http');
const path = require('node:path');
const test = require('node:test');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-that-is-not-used-in-production';

const app = require('../src/app');
const db = require('../src/db');

let server;
let baseUrl;

async function request(method, pathname, { token, idempotencyKey, body } = {}) {
  const headers = {};

  if (token) {
    headers.authorization = `Bearer ${token}`;
  }

  if (idempotencyKey) {
    headers['idempotency-key'] = idempotencyKey;
  }

  const options = { method, headers };

  if (body !== undefined) {
    headers['content-type'] = 'application/json';
    options.body = JSON.stringify(body);
  }

  const response = await fetch(`${baseUrl}${pathname}`, options);
  const text = await response.text();

  return {
    status: response.status,
    body: text ? JSON.parse(text) : null,
  };
}

async function register(email) {
  const response = await request('POST', '/auth/register', {
    body: { email, password: 'password123' },
  });

  assert.equal(response.status, 201);
  return response.body;
}

async function createExpense(token, idempotencyKey, body = {}) {
  return request('POST', '/expenses', {
    token,
    idempotencyKey,
    body: {
      amount: 12.34,
      description: 'Lunch',
      category: 'Food',
      ...body,
    },
  });
}

test.before(async () => {
  if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL is required to run integration tests');
  }

  const schema = await fs.readFile(path.join(__dirname, '..', 'db', 'schema.sql'), 'utf8');
  await db.query(schema);
  await db.query('TRUNCATE expenses, users RESTART IDENTITY CASCADE');

  server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
  await new Promise((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
  await db.end();
});

test('GET /health returns 200', async () => {
  const response = await request('GET', '/health');

  assert.equal(response.status, 200);
  assert.deepEqual(response.body, { status: 'ok' });
});

test('register works and does not return password_hash', async () => {
  const email = `register-${Date.now()}@example.com`;
  const response = await request('POST', '/auth/register', {
    body: { email, password: 'password123' },
  });

  assert.equal(response.status, 201);
  assert.equal(response.body.user.email, email);
  assert.equal(typeof response.body.token, 'string');
  assert.equal(response.body.user.password_hash, undefined);
});

test('login works', async () => {
  const email = `login-${Date.now()}@example.com`;
  await register(email);

  const response = await request('POST', '/auth/login', {
    body: { email, password: 'password123' },
  });

  assert.equal(response.status, 200);
  assert.equal(response.body.user.email, email);
  assert.equal(typeof response.body.token, 'string');
});

test('protected GET /expenses without token returns 401', async () => {
  const response = await request('GET', '/expenses');

  assert.equal(response.status, 401);
  assert.match(response.body.error, /Authentication required/);
});

test('authenticated user can create and read their own expense', async () => {
  const { token } = await register(`owner-${Date.now()}@example.com`);
  const created = await createExpense(token, 'owner-create-read');

  assert.equal(created.status, 201);
  assert.equal(created.body.expense.description, 'Lunch');

  const read = await request('GET', `/expenses/${created.body.expense.id}`, { token });

  assert.equal(read.status, 200);
  assert.equal(read.body.expense.id, created.body.expense.id);
});

test('user A cannot read, update, or delete user B expense', async () => {
  const userA = await register(`user-a-${Date.now()}@example.com`);
  const userB = await register(`user-b-${Date.now()}@example.com`);
  const createdByB = await createExpense(userB.token, 'owned-by-b');
  const expenseId = createdByB.body.expense.id;

  const read = await request('GET', `/expenses/${expenseId}`, { token: userA.token });
  assert.equal(read.status, 404);
  const list = await request('GET', '/expenses', { token: userA.token });
  assert.equal(list.status, 200);
  assert.equal(
    list.body.expenses.some((expense) => expense.id === expenseId),
    false
  );

  const update = await request('PUT', `/expenses/${expenseId}`, {
    token: userA.token,
    body: { amount: 99, description: 'Changed', category: 'Other' },
  });
  assert.equal(update.status, 404);

  const remove = await request('DELETE', `/expenses/${expenseId}`, { token: userA.token });
  assert.equal(remove.status, 404);

  const stillExistsForB = await request('GET', `/expenses/${expenseId}`, { token: userB.token });
  assert.equal(stillExistsForB.status, 200);
  assert.equal(stillExistsForB.body.expense.id, expenseId);
});

test('same idempotency key and same request returns original expense only once', async () => {
  const { token, user } = await register(`idempotent-${Date.now()}@example.com`);
  const key = 'same-key-same-body';
  const first = await createExpense(token, key);
  const second = await createExpense(token, key);

  assert.equal(first.status, 201);
  assert.equal(second.status, 200);
  assert.equal(second.body.expense.id, first.body.expense.id);

  const count = await db.query(
    'SELECT COUNT(*)::int AS count FROM expenses WHERE user_id = $1 AND idempotency_key = $2',
    [user.id, key]
  );
  assert.equal(count.rows[0].count, 1);
});

test('same idempotency key and different request returns 409', async () => {
  const { token } = await register(`conflict-${Date.now()}@example.com`);
  const key = 'same-key-different-body';

  const first = await createExpense(token, key);
  const second = await createExpense(token, key, { amount: 55.5 });

  assert.equal(first.status, 201);
  assert.equal(second.status, 409);
  assert.match(second.body.error, /different request body/);
});

test('missing Idempotency-Key returns 400', async () => {
  const { token } = await register(`missing-key-${Date.now()}@example.com`);
  const response = await request('POST', '/expenses', {
    token,
    body: { amount: 12, description: 'Lunch', category: 'Food' },
  });

  assert.equal(response.status, 400);
  assert.match(response.body.error, /Idempotency-Key/);
});

test('POST /expenses rejects requests without an idempotency key', async () => {
  const { token } = await register(`missing-key-${Date.now()}@example.com`);

  const response = await request('POST', '/expenses', {
    token,
    body: {
      amount: 25.50,
      description: 'Missing key test',
      category: 'Testing',
    },
  });

  assert.equal(response.status, 400);
  assert.match(response.body.error, /Idempotency-Key header is required/);
});

test('invalid amount returns 400', async () => {
  const { token } = await register(`bad-amount-${Date.now()}@example.com`);
  const response = await createExpense(token, 'bad-amount', { amount: 0 });

  assert.equal(response.status, 400);
  assert.match(response.body.error, /amount/);
});

test('invalid login returns appropriate error', async () => {
  const email = `invalid-login-${Date.now()}@example.com`;
  await register(email);

  const response = await request('POST', '/auth/login', {
    body: { email, password: 'wrong-password' },
  });

  assert.equal(response.status, 401);
  assert.match(response.body.error, /invalid email or password/);
});

test('unknown expense returns appropriate error', async () => {
  const { token } = await register(`unknown-${Date.now()}@example.com`);
  const response = await request('GET', '/expenses/999999', { token });

  assert.equal(response.status, 404);
  assert.match(response.body.error, /expense not found/);
});

test('different users may use the same idempotency key', async () => {
  const userA = await register(`same-key-a-${Date.now()}@example.com`);
  const userB = await register(`same-key-b-${Date.now()}@example.com`);
  const key = 'shared-key';

  const createdByA = await createExpense(userA.token, key);
  const createdByB = await createExpense(userB.token, key);

  assert.equal(createdByA.status, 201);
  assert.equal(createdByB.status, 201);
  assert.notEqual(createdByA.body.expense.id, createdByB.body.expense.id);
});

test('two concurrent identical POST /expenses requests create one row', async () => {
  const { token, user } = await register(`concurrent-${Date.now()}@example.com`);
  const key = 'concurrent-key';
  const payload = { amount: 18.75, description: 'Train', category: 'Travel' };

  const [first, second] = await Promise.all([
    createExpense(token, key, payload),
    createExpense(token, key, payload),
  ]);

  assert.deepEqual([first.status, second.status].sort(), [200, 201]);
  assert.equal(first.body.expense.id, second.body.expense.id);

  const count = await db.query(
    'SELECT COUNT(*)::int AS count FROM expenses WHERE user_id = $1 AND idempotency_key = $2',
    [user.id, key]
  );
  assert.equal(count.rows[0].count, 1);
});

test('malformed JSON returns 400', async () => {
  const response = await fetch(`${baseUrl}/auth/login`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
    },
    body: '{"email":',
  });

  const text = await response.text();

  assert.equal(response.status, 400);
  assert.deepEqual(JSON.parse(text), {
    error: 'request body must be valid JSON',
  });
});

test('invalid JWT returns 401', async () => {
  const response = await request('GET', '/expenses', {
    token: 'this-is-not-a-valid-jwt',
  });

  assert.equal(response.status, 401);
  assert.match(response.body.error, /Invalid or expired authentication token/);
});