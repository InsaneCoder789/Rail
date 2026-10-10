import jwt from "jsonwebtoken";

const JWT_ISSUER = "rail";
const JWT_AUDIENCE = "rail-clients";

export class InvalidTokenError extends Error {
  constructor() { super("invalid_token"); this.name = "InvalidTokenError"; }
}

function getJwtSecret(): string {
  const secret = process.env.JWT_SECRET ?? process.env.RAIL_SIGNING_SECRET;
  if (!secret) {
    throw new Error("JWT_SECRET_REQUIRED");
  }
  return secret;
}

export function generateToken(userId: string, authVersion = 0) {
  if (!Number.isSafeInteger(authVersion) || authVersion < 0 || authVersion > 2147483647) throw new Error("invalid_auth_version");
  return jwt.sign({ userId, authVersion }, getJwtSecret(), {
    expiresIn: "15m",
    issuer: JWT_ISSUER,
    audience: JWT_AUDIENCE,
    algorithm: "HS256",
  });
}

export function verifyToken(token: string): { userId: string; authVersion: number } {
  const secret = getJwtSecret();
  try {
    const decoded = jwt.verify(token, secret, {
      issuer: JWT_ISSUER,
      audience: JWT_AUDIENCE,
      algorithms: ["HS256"],
    });
    if (!decoded || typeof decoded !== "object" || typeof decoded.userId !== "string" ||
        decoded.userId.length < 3 || decoded.userId.length > 128 || /[\u0000-\u001F\u007F]/.test(decoded.userId) ||
        !Number.isSafeInteger(decoded.authVersion) || decoded.authVersion < 0 || decoded.authVersion > 2147483647 ||
        typeof decoded.exp !== "number" || typeof decoded.iat !== "number" ||
        !Number.isSafeInteger(decoded.exp) || !Number.isSafeInteger(decoded.iat) ||
        decoded.iat > Math.floor(Date.now() / 1000) + 30 || decoded.exp <= decoded.iat || decoded.exp - decoded.iat > 900) {
      throw new InvalidTokenError();
    }
    return { userId: decoded.userId, authVersion: decoded.authVersion };
  } catch {
    throw new InvalidTokenError();
  }
}
