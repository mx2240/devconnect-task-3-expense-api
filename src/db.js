const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

function query(text, params) {
  return pool.query(text, params);
}

function connect() {
  return pool.connect();
}

function end() {
  return pool.end();
}

module.exports = {
  query,
  connect,
  end,
  pool,
};
