import jwt from "jsonwebtoken";
import User from "../models/User.js";
import { cache } from "../services/cacheService.js";

function getToken(req) {
  const authHeader = req.headers.authorization;
  if (authHeader?.startsWith("Bearer ")) return authHeader.slice(7);
  if (req.cookies?.token) return req.cookies.token;
  if (req.query?.token && typeof req.query.token === "string")
    return req.query.token;
  return null;
}

export const authenticate = async (req, res, next) => {
  const token = getToken(req);

  if (!token) {
    return res.status(401).json({ message: "Not authorized. Please log in." });
  }

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    if (!decoded?.id) {
      return res.status(401).json({ message: "Invalid token." });
    }

    let user;
    const cacheKey = `user:${decoded.id}`;
    const cachedUser = await cache.get(cacheKey);

    if (cachedUser) {
      // console.log(`[Auth] Cache HIT for ${cacheKey}`);
      const userObj = JSON.parse(cachedUser);
      // Verify token version matches cached version
      if (userObj.tokenVersion && decoded.v !== userObj.tokenVersion) {
        // console.log(`[Auth] Token version mismatch for ${cacheKey}`);
        // Token version mismatch (cached user is newer/older than token?).
        // If token is old (v=1) and cache is new (v=2), reject.
        // If cache is old (v=1) and token is new (v=2), we should fetch DB.
        // But usually cache is invalidated on update.
        // Safest is to treat mismatch as "fetch from DB".
        user = null;
      } else if (userObj.isActive === false) {
        // If user is inactive in cache, verify with DB to prevent stale cache issues
        // (e.g. user just activated but cache wasn't updated)
        // console.log(`[Auth] Cached user is inactive. Verifying with DB...`);
        user = null;
      } else {
        user = User.hydrate(userObj);
        // console.log(
        //   `[Auth] User hydrated from cache. isActive: ${user.isActive}`,
        // );
      }
    } else {
      // console.log(`[Auth] Cache MISS for ${cacheKey}`);
    }

    if (!user) {
      user = await User.findById(decoded.id).select("+tokenVersion");
      if (user) {
        // console.log(`[Auth] User fetched from DB. isActive: ${user.isActive}`);
        // Cache the user object (lean)
        // We need to ensure virtuals or necessary fields are present.
        // toObject() gives plain JSON.
        await cache.set(cacheKey, JSON.stringify(user.toObject()));
        // console.log(`[Auth] User cached for ${cacheKey}`);
      }
    }

    if (!user) {
      return res.status(401).json({ message: "User not found." });
    }

    // Check if token version matches (for session invalidation)
    if (user.tokenVersion && decoded.v !== user.tokenVersion) {
      return res
        .status(401)
        .json({ message: "Session expired. Please log in again." });
    }

    req.user = user;
    next();
  } catch (err) {
    return res
      .status(401)
      .json({ message: "Invalid or expired token. Please log in again." });
  }
};

export const requireActive = (req, res, next) => {
  if (!req.user.isActive) {
    return res
      .status(403)
      .json({ message: "Account not activated. Please check your email." });
  }
  next();
};

export const authorize = (...roles) => {
  return (req, res, next) => {
    if (!req.user.role || !roles.includes(req.user.role)) {
      return res.status(403).json({
        message: "You do not have permission to perform this action",
      });
    }
    next();
  };
};

// Combine for backward compatibility and standard protection
export const protect = [authenticate, requireActive];
