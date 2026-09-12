const crypto = require('crypto');
const express = require('express');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

router.use(requireAuth);

function validateExpense(body) {
  const amount = Number(body && body.amount);

  if (!Number.isFinite(amount) || amount <= 0) {
    return { error: 'amount must be greater than 0' };
  }

  if (!body.description || typeof body.description !== 'string' || !body.description.trim()) {
    return { error: 'description is required' };
  }

  if (!body.category || typeof body.category !== 'string' || !body.category.trim()) {
    return { error: 'category is required' };
  }

  return {
    value: {
      amount: amount.toFixed(2),
      description: body.description.trim(),
      category: body.category.trim(),
    },
  };
}

function fingerprint(expense) {
  const body = JSON.stringify({
    amount: expense.amount,
    description: expense.description,
    category: expense.category,
  });

  return crypto.createHash('sha256').update(body).digest('hex');
}

function serializeExpense(row) {
  return {
    id: row.id,
    user_id: row.user_id,
    amount: row.amount,
    description: row.description,
    category: row.category,
    idempotency_key: row.idempotency_key,
    created_at: row.created_at,
  };
}

async function findExpenseForUser(userId, expenseId) {
  const result = await db.query(
    `SELECT id, user_id, amount, description, category, idempotency_key, created_at
     FROM expenses
     WHERE id = $1 AND user_id = $2`,
    [expenseId, userId]
  );

  return result.rows[0];
}

router.get('/', async (req, res, next) => {
  try {
    const result = await db.query(
      `SELECT id, user_id, amount, description, category, idempotency_key, created_at
       FROM expenses
       WHERE user_id = $1
       ORDER BY created_at DESC, id DESC`,
      [req.user.id]
    );

    return res.json({ expenses: result.rows.map(serializeExpense) });
  } catch (err) {
    return next(err);
  }
});

router.get('/:id', async (req, res, next) => {
  try {
    const expense = await findExpenseForUser(req.user.id, req.params.id);

    if (!expense) {
      return res.status(404).json({ error: 'expense not found for the authenticated user' });
    }

    return res.json({ expense: serializeExpense(expense) });
  } catch (err) {
    return next(err);
  }
});

router.post('/', async (req, res, next) => {
  const idempotencyKey = req.get('idempotency-key');

  if (!idempotencyKey || !idempotencyKey.trim()) {
    return res.status(400).json({ error: 'Idempotency-Key header is required for POST /expenses' });
  }

  const validation = validateExpense(req.body || {});

  if (validation.error) {
    return res.status(400).json({ error: validation.error });
  }

  const expense = validation.value;
  const requestFingerprint = fingerprint(expense);
  const client = await db.connect();

  try {
    await client.query('BEGIN');

    const inserted = await client.query(
      `INSERT INTO expenses (user_id, amount, description, category, idempotency_key, request_fingerprint)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (user_id, idempotency_key) DO NOTHING
       RETURNING id, user_id, amount, description, category, idempotency_key, request_fingerprint, created_at`,
      [req.user.id, expense.amount, expense.description, expense.category, idempotencyKey.trim(), requestFingerprint]
    );

    if (inserted.rows[0]) {
      await client.query('COMMIT');
      return res.status(201).json({ expense: serializeExpense(inserted.rows[0]) });
    }

    const existing = await client.query(
      `SELECT id, user_id, amount, description, category, idempotency_key, request_fingerprint, created_at
       FROM expenses
       WHERE user_id = $1 AND idempotency_key = $2`,
      [req.user.id, idempotencyKey.trim()]
    );

    const row = existing.rows[0];

    if (!row) {
      throw new Error('idempotency conflict row was not found');
    }

    if (row.request_fingerprint !== requestFingerprint) {
      await client.query('COMMIT');
      return res.status(409).json({
        error: 'Idempotency-Key was already used with a different request body; use a new key for this request',
      });
    }

    await client.query('COMMIT');
    return res.status(200).json({ expense: serializeExpense(row) });
  } catch (err) {
    await client.query('ROLLBACK');
    return next(err);
  } finally {
    client.release();
  }
});

router.put('/:id', async (req, res, next) => {
  try {
    const validation = validateExpense(req.body || {});

    if (validation.error) {
      return res.status(400).json({ error: validation.error });
    }

    const expense = validation.value;
    const result = await db.query(
      `UPDATE expenses
       SET amount = $1, description = $2, category = $3
       WHERE id = $4 AND user_id = $5
       RETURNING id, user_id, amount, description, category, idempotency_key, created_at`,
      [expense.amount, expense.description, expense.category, req.params.id, req.user.id]
    );

    if (!result.rows[0]) {
      return res.status(404).json({ error: 'expense not found for the authenticated user' });
    }

    return res.json({ expense: serializeExpense(result.rows[0]) });
  } catch (err) {
    return next(err);
  }
});

router.delete('/:id', async (req, res, next) => {
  try {
    const result = await db.query(
      'DELETE FROM expenses WHERE id = $1 AND user_id = $2 RETURNING id',
      [req.params.id, req.user.id]
    );

    if (!result.rows[0]) {
      return res.status(404).json({ error: 'expense not found for the authenticated user' });
    }

    return res.status(204).send();
  } catch (err) {
    return next(err);
  }
});

module.exports = router;
