import { createPrivateKey } from "node:crypto";
import { constants, openSync, closeSync, fstatSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { AgentClient, AgentClientError, type AgentIntentRequest } from "../rail/agentClient.js";

type Action = "propose" | "status" | "execute";
type Client = Pick<AgentClient, "proposeIntent" | "listIntents" | "executeIntent">;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;

export function simulatorConfiguration(env: NodeJS.ProcessEnv, action: string | undefined) {
  if (env.NODE_ENV === "production" || env.RAIL_DEMO_MODE !== "true") throw new Error("simulator_disabled");
  if (!["propose", "status", "execute"].includes(action ?? "")) throw new Error("invalid_simulator_action");
  const origin = new URL(env.RAIL_AGENT_ORIGIN ?? "");
  // This executable is an internal-wallet demonstration, never a hosted payment launcher.
  if (origin.origin !== env.RAIL_AGENT_ORIGIN || origin.protocol !== "http:" || origin.hostname !== "localhost")
    throw new Error("simulator_requires_localhost");
  const amount = env.RAIL_AGENT_AMOUNT_MINOR ?? "";
  if (!/^[1-9][0-9]{0,12}$/.test(amount) || Number(amount) > 1e12 ||
      !UUID.test(env.RAIL_AGENT_MANDATE_ID ?? "") || !/^[A-Za-z0-9_.:-]{8,128}$/.test(env.RAIL_AGENT_REQUEST_ID ?? "") ||
      !/^[A-Za-z0-9_.:-]{3,128}$/.test(env.RAIL_AGENT_RECEIVER_WALLET_ID ?? "") ||
      !/^[A-Z]{3}$/.test(env.RAIL_AGENT_CURRENCY ?? "") || !env.RAIL_AGENT_PRIVATE_KEY_PATH ||
      !/^rail_agent_[A-Za-z0-9_-]{43}$/.test(env.RAIL_AGENT_TOKEN ?? "")) throw new Error("invalid_simulator_configuration");
  return { action: action as Action, origin: origin.origin, token: env.RAIL_AGENT_TOKEN!, privateKeyPath: env.RAIL_AGENT_PRIVATE_KEY_PATH,
    request: Object.freeze({ mandateId: env.RAIL_AGENT_MANDATE_ID!, clientRequestId: env.RAIL_AGENT_REQUEST_ID!,
      receiverWalletId: env.RAIL_AGENT_RECEIVER_WALLET_ID!, amountMinor: Number(amount), currency: env.RAIL_AGENT_CURRENCY!, ttlSeconds: 300 }) };
}

export function simulatorPrivateKey(path: string) {
  const descriptor = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const info = fstatSync(descriptor);
    if (!info.isFile() || info.size > 4096 || (process.platform !== "win32" &&
        ((info.mode & 0o077) !== 0 || info.uid !== process.getuid?.()))) throw new Error("unsafe_simulator_key_file");
    return createPrivateKey(readFileSync(descriptor));
  } finally { closeSync(descriptor); }
}

function summary(intent: Awaited<ReturnType<AgentClient["proposeIntent"]>>) {
  return { intentId: intent.intentId, requestFingerprint: intent.requestFingerprint, status: intent.status,
    amountMinor: intent.amountMinor, currency: intent.currency, sharedBudgetId: intent.sharedBudgetId ?? null };
}

export async function runAgentSimulation(client: Client, action: Action, request: AgentIntentRequest) {
  if (action === "propose") return summary(await client.proposeIntent(request));
  const matches = (await client.listIntents()).filter(intent => intent.clientRequestId === request.clientRequestId);
  if (!matches.length) {
    if (action === "status") return { status: "not_found" };
    throw new Error("simulator_intent_not_found");
  }
  const intent = matches[0];
  if (matches.length !== 1 || intent.mandateId !== request.mandateId || intent.receiverWalletId !== request.receiverWalletId ||
      intent.amountMinor !== request.amountMinor || intent.currency !== request.currency) throw new Error("simulator_terms_mismatch");
  if (action === "status") return summary(intent);
  if (!["approved", "executed"].includes(intent.status)) throw new Error("simulator_owner_approval_required");
  return summary((await client.executeIntent(intent.intentId, intent.requestFingerprint)).intent);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  try {
    // Deliberately do not load the server .env or accept credentials in command arguments.
    const config = simulatorConfiguration(process.env, process.argv[2]);
    const client = new AgentClient({ origin: config.origin, token: config.token,
      privateKey: simulatorPrivateKey(config.privateKeyPath), allowLocalHttp: true });
    console.log(JSON.stringify(await runAgentSimulation(client, config.action, config.request)));
  } catch (error) {
    const rejected = error instanceof AgentClientError;
    console.error(JSON.stringify({ status: rejected ? "rejected" : "simulator_failed",
      code: rejected ? error.code : "check_simulator_configuration_or_original_intent",
      ...(rejected ? { httpStatus: error.status, retryAfterSeconds: error.retryAfterSeconds } : {}) }));
    process.exitCode = rejected ? 2 : 1;
  }
}
