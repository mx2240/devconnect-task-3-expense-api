require('dotenv').config();

const express = require('express');
const authRoutes = require('./routes/auth');
const expenseRoutes = require('./routes/expenses');

const app = express();

app.use(express.json());

app.get('/health', (_req, res) => {
  res.json({ status: 'ok' });
});

app.use('/auth', authRoutes);
app.use('/expenses', expenseRoutes);

app.use((_req, res) => {
  res.status(404).json({ error: 'route not found' });
});

app.use((err, _req, res, _next) => {
  if (err.type === 'entity.parse.failed') {
    return res.status(400).json({ error: 'request body must be valid JSON' });
  }

  return res.status(500).json({ error: 'internal server error' });
});

module.exports = app;
