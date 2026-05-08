import jwt from "jsonwebtoken";

const JWT_ISSUER = "rail";
const JWT_AUDIENCE = "rail-clients";

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
  });
}

export function verifyToken(token: string): { userId: string } {
  return jwt.verify(token, getJwtSecret(), {
    issuer: JWT_ISSUER,
    audience: JWT_AUDIENCE,
  }) as { userId: string };
}
