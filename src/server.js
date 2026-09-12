require('dotenv').config();

const app = require('./app');

const port = process.env.PORT || 3000;

if (!process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL environment variable is required');
}

if (!process.env.JWT_SECRET) {
  throw new Error('JWT_SECRET environment variable is required');
}

app.listen(port, () => {
  console.log(`Expense API listening on port ${port}`);
});
