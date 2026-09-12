const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const db = require('../db');

const router = express.Router();

const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function publicUser(row) {
  return {
    id: row.id,
    email: row.email,
    created_at: row.created_at,
  };
}

function signToken(user) {
  return jwt.sign({ email: user.email }, process.env.JWT_SECRET, {
    subject: String(user.id),
    expiresIn: '1h',
  });
}

router.post('/register', async (req, res, next) => {
  try {
    const { email, password } = req.body || {};

    if (!email || !emailPattern.test(email)) {
      return res.status(400).json({ error: 'valid email is required' });
    }

    if (!password || password.length < 8) {
      return res.status(400).json({ error: 'password must be at least 8 characters' });
    }

    const passwordHash = await bcrypt.hash(password, 12);
    const result = await db.query(
      'INSERT INTO users (email, password_hash) VALUES ($1, $2) RETURNING id, email, created_at',
      [email.toLowerCase(), passwordHash]
    );

    const user = result.rows[0];
    return res.status(201).json({ user: publicUser(user), token: signToken(user) });
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({ error: 'email is already registered; use a different email or log in' });
    }

    return next(err);
  }
});

router.post('/login', async (req, res, next) => {
  try {
    const { email, password } = req.body || {};

    if (!email) {
      return res.status(400).json({ error: 'email is required' });
    }

    if (!password) {
      return res.status(400).json({ error: 'password is required' });
    }

    const result = await db.query(
      'SELECT id, email, password_hash, created_at FROM users WHERE email = $1',
      [email.toLowerCase()]
    );

    const user = result.rows[0];
    const validPassword = user ? await bcrypt.compare(password, user.password_hash) : false;

    if (!validPassword) {
      return res.status(401).json({ error: 'invalid email or password' });
    }

    return res.json({ user: publicUser(user), token: signToken(user) });
  } catch (err) {
    return next(err);
  }
});

module.exports = router;
