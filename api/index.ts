import type http from "node:http";
import { createServerContext, handleRequest } from "../src/server/server.js";

let contextPromise: ReturnType<typeof createServerContext> | undefined;

function getContext(): ReturnType<typeof createServerContext> {
  contextPromise ??= createServerContext();
  return contextPromise;
}

export default async function handler(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> {
  const context = await getContext();
  await handleRequest(req, res, context);
}
