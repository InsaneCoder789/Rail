import jwt from "jsonwebtoken";

const JWT_SECRET: string = process.env.JWT_SECRET ?? "dev_secret";

export function generateToken(userId: string) {
  return jwt.sign({ userId }, JWT_SECRET, {
    expiresIn: "15m",
  });
}

export function verifyToken(token: string): { userId: string } {
  return jwt.verify(token, JWT_SECRET) as { userId: string };
}