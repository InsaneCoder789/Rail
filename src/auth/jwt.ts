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

export function generateToken(userId: string) {
  return jwt.sign({ userId }, getJwtSecret(), {
    expiresIn: "15m",
    issuer: JWT_ISSUER,
    audience: JWT_AUDIENCE,
    algorithm: "HS256",
  });
}

export function verifyToken(token: string): { userId: string } {
  const secret = getJwtSecret();
  try {
    const decoded = jwt.verify(token, secret, {
      issuer: JWT_ISSUER,
      audience: JWT_AUDIENCE,
      algorithms: ["HS256"],
    });
    if (!decoded || typeof decoded !== "object" || typeof decoded.userId !== "string" ||
        decoded.userId.length < 3 || decoded.userId.length > 128 || /[\u0000-\u001F\u007F]/.test(decoded.userId)) {
      throw new InvalidTokenError();
    }
    return { userId: decoded.userId };
  } catch {
    throw new InvalidTokenError();
  }
}
