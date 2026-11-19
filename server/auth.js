import { randomBytes } from "node:crypto";
import jwt from "jsonwebtoken";

let secret = process.env.JWT_SECRET;
if (!secret && process.env.NODE_ENV !== "production") {
  secret = randomBytes(48).toString("base64url");
  console.warn("JWT_SECRET is unset; using a temporary development secret. Set JWT_SECRET in .env to keep sessions across restarts.");
}
if (!secret || secret.length < 32) {
  throw new Error("JWT_SECRET must be set to a secret of at least 32 characters.");
}

export function createToken(user) {
  return jwt.sign({ sub: user.id }, secret, { expiresIn: "7d" });
}

export function requireAuth(req, res, next) {
  const header = req.get("authorization") || "";
  const match = header.match(/^Bearer\s+(.+)$/i);
  if (!match) return res.status(401).json({ error: "Authentication required." });
  try {
    const payload = jwt.verify(match[1], secret);
    req.userId = Number(payload.sub);
    return next();
  } catch {
    return res.status(401).json({ error: "Invalid or expired session. Please sign in again." });
  }
}
