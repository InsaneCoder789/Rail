import { createHash } from "node:crypto";
import type { PoolClient } from "pg";
import { RequestError } from "../server/http.js";
import { isCurrency, isRecord, isSafeText, isValidAmountMinor } from "../server/validation.js";

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
export function isBudgetId(value: unknown): value is string { return typeof value === "string" && UUID.test(value); }
function invalid(): never { throw new RequestError(422, "invalid_shared_budget_request", "invalid shared budget request"); }

export interface SharedBudgetInput {
  readonly name: string;
  readonly currency: string;
  readonly totalBudgetMinor: number;
  readonly ttlSeconds: number;
  readonly agentIds: readonly string[];
}

export function parseSharedBudgetInput(value: unknown): SharedBudgetInput {
  if (!isRecord(value) || Object.keys(value).some(key => !["name", "currency", "totalBudgetMinor", "ttlSeconds", "agentIds", "grantToken"].includes(key)) ||
      !isSafeText(value.name, 1, 80) || !value.name.trim() || !isCurrency(value.currency) || !isValidAmountMinor(value.totalBudgetMinor) ||
      !Array.isArray(value.agentIds) || value.agentIds.length < 1 || value.agentIds.length > 50 ||
      !value.agentIds.every(isBudgetId) || new Set(value.agentIds).size !== value.agentIds.length) invalid();
  const seconds = value.ttlSeconds ?? 86400;
  if (typeof seconds !== "number" || !Number.isSafeInteger(seconds) || seconds < 60 || seconds > 30 * 86400) invalid();
  return Object.freeze({ name: value.name.trim(), currency: value.currency, totalBudgetMinor: value.totalBudgetMinor,
    ttlSeconds: seconds, agentIds: Object.freeze([...value.agentIds].sort()) });
}

export type SharedBudgetAction = "create" | "limit" | "member_add" | "member_remove" | "revoke";

/** Fixed tuples bind passkey consent independently of JSON/JSONB object ordering. */
export function sharedBudgetOperationPayload(action: SharedBudgetAction, budgetId: string | null, value: unknown): string {
  if (action === "create") {
    if (budgetId !== null) invalid();
    const input = parseSharedBudgetInput(value);
    return JSON.stringify(["rail:owner-operation:v1", "shared_budget", action, null,
      [input.name, input.currency, input.totalBudgetMinor, input.ttlSeconds, input.agentIds]]);
  }
  if (!isBudgetId(budgetId) || !isRecord(value)) invalid();
  if (action === "limit") {
    if (Object.keys(value).some(key => !["totalBudgetMinor", "revision", "grantToken"].includes(key)) ||
        !isValidAmountMinor(value.totalBudgetMinor) || !Number.isSafeInteger(value.revision) || Number(value.revision) < 1) invalid();
    return JSON.stringify(["rail:owner-operation:v1", "shared_budget", action, budgetId, [value.revision, value.totalBudgetMinor]]);
  }
  if (action !== "member_add" && action !== "member_remove" && action !== "revoke") invalid();
  if (Object.keys(value).some(key => !["agentId", "grantToken"].includes(key)) ||
      (action !== "revoke" && !isBudgetId(value.agentId)) || (action === "revoke" && value.agentId !== undefined)) invalid();
  return JSON.stringify(["rail:owner-operation:v1", "shared_budget", action, budgetId, action === "revoke" ? [] : [value.agentId]]);
}

export function sharedBudgetOperationFingerprint(action: SharedBudgetAction, budgetId: string | null, value: unknown): string {
  return createHash("sha256").update(sharedBudgetOperationPayload(action, budgetId, value)).digest("hex");
}

export function mapSharedBudget(row: Record<string, unknown>) {
  const held = Number(row.reserved_budget_minor), spent = Number(row.spent_budget_minor), limit = Number(row.total_budget_minor);
  const iso = (value: unknown) => (value instanceof Date ? value : new Date(String(value))).toISOString();
  return { budgetId: String(row.budget_id), name: String(row.name), currency: String(row.currency),
    totalBudgetMinor: limit, reservedBudgetMinor: held, spentBudgetMinor: spent, availableBudgetMinor: limit - held - spent,
    revision: Number(row.revision), status: row.revoked_at ? "revoked" : row.expired === true ? "expired" : "active",
    createdAt: iso(row.created_at), expiresAt: iso(row.expires_at),
    revokedAt: row.revoked_at ? iso(row.revoked_at) : null };
}

/** Caller holds owner/agent locks before acquiring mandate and shared-budget locks. */
export async function requireSharedBudget(client: PoolClient, input: {
  budgetId: string; owner: string; agentId: string; currency: string; stepUpRequired: boolean;
}) {
  const found = await client.query(`SELECT budget.*, budget.expires_at>clock_timestamp() AS valid,
      member.revoked_at AS member_revoked_at, creation.step_up_challenge_id AS creation_grant,
      addition.step_up_challenge_id AS membership_grant, current_control.step_up_challenge_id AS current_grant
    FROM rail_shared_budgets budget JOIN rail_shared_budget_members member
      ON member.budget_id=budget.budget_id AND member.owner_wallet_id=budget.owner_wallet_id AND member.agent_id=$3
    JOIN rail_shared_budget_controls creation ON creation.control_id=budget.created_control_id
    JOIN rail_shared_budget_controls addition ON addition.control_id=member.created_control_id
    JOIN rail_shared_budget_controls current_control ON current_control.control_id=budget.current_control_id
    WHERE budget.budget_id=$1 AND budget.owner_wallet_id=$2 FOR UPDATE OF budget,member`,
  [input.budgetId, input.owner, input.agentId]);
  const row = found.rows[0];
  if (!row) throw new RequestError(404, "shared_budget_not_found", "shared budget membership not found");
  if (row.revoked_at || row.member_revoked_at || !row.valid)
    throw new RequestError(409, "shared_budget_inactive", "shared budget or membership is inactive");
  if (row.currency !== input.currency) throw new RequestError(403, "shared_budget_currency_denied", "shared budget currency does not match");
  if (input.stepUpRequired && (!row.creation_grant || !row.membership_grant || !row.current_grant))
    throw new RequestError(409, "fresh_shared_budget_consent_required", "replace legacy budget authority with owner passkey consent");
  return row;
}
