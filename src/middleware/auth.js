const jwt = require('jsonwebtoken');

function requireAuth(req, res, next) {
  const header = req.get('authorization');

  if (!header || !header.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Authentication required: provide Authorization: Bearer <token>' });
  }

  const token = header.slice('Bearer '.length).trim();

  if (!token) {
    return res.status(401).json({ error: 'Authentication required: provide Authorization: Bearer <token>' });
  }

  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    req.user = { id: payload.sub, email: payload.email };
    return next();
  } catch (_err) {
    return res.status(401).json({ error: 'Invalid or expired authentication token' });
  }
}

module.exports = { requireAuth };
