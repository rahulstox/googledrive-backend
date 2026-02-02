import jwt from 'jsonwebtoken';
import User from '../models/User.js';

function getToken(req) {
  const authHeader = req.headers.authorization;
  if (authHeader?.startsWith('Bearer ')) return authHeader.slice(7);
  if (req.cookies?.token) return req.cookies.token;
  if (req.query?.token && typeof req.query.token === 'string') return req.query.token;
  return null;
}

export const protect = async (req, res, next) => {
  const token = getToken(req);

  if (!token) {
    return res.status(401).json({ message: 'Not authorized. Please log in.' });
  }

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    if (!decoded?.id) {
      return res.status(401).json({ message: 'Invalid token.' });
    }
    const user = await User.findById(decoded.id).select('-password');
    if (!user) {
      return res.status(401).json({ message: 'User not found.' });
    }
    if (!user.isActive) {
      return res.status(403).json({ message: 'Account not activated. Please check your email.' });
    }
    req.user = user;
    next();
  } catch (err) {
    return res.status(401).json({ message: 'Invalid or expired token. Please log in again.' });
  }
};
