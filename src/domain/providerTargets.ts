import { createHash } from "node:crypto";
import { RequestError } from "../server/http.js";

export interface ProviderTarget {
  readonly version: 1;
  readonly targetId: string;
  readonly revision: number;
  readonly ownerWalletId: string;
  readonly provider: string;
  readonly providerAccountRef: string;
  readonly instrumentRef: string;
  readonly merchantWalletId: string;
  readonly merchantRef: string;
  readonly currency: string;
}

const fields = ["version", "targetId", "revision", "ownerWalletId", "provider", "providerAccountRef", "instrumentRef",
  "merchantWalletId", "merchantRef", "currency"] as const;
const reference = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9_.:-]{3,128}$/.test(value);

export function parseProviderTarget(value: unknown): ProviderTarget {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("INVALID_PROVIDER_TARGET");
  const row = value as Record<string, unknown>;
  if (Object.keys(row).length !== fields.length || !fields.every(field => Object.hasOwn(row, field)) || row.version !== 1 ||
      !Number.isSafeInteger(row.revision) || Number(row.revision) < 1 || Number(row.revision) > 1000000 ||
      ![row.targetId, row.ownerWalletId, row.providerAccountRef, row.instrumentRef, row.merchantWalletId, row.merchantRef].every(reference) ||
      row.ownerWalletId === row.merchantWalletId || typeof row.provider !== "string" || !/^[a-z][a-z0-9_]{1,31}$/.test(row.provider) ||
      typeof row.currency !== "string" || !/^[A-Z]{3}$/.test(row.currency)) throw new Error("INVALID_PROVIDER_TARGET");
  return Object.freeze(Object.fromEntries(fields.map(field => [field, row[field]]))) as unknown as ProviderTarget;
}

export function providerTargetFingerprint(value: ProviderTarget): string {
  const target = parseProviderTarget(value);
  return createHash("sha256").update(JSON.stringify(["rail:provider-target:v1", ...fields.map(field => target[field])])).digest("hex");
}

/** Operator-declared trust, not proof of actual provider ownership or instrument funding. No credentials belong here. */
export class ProviderTargetRegistry {
  private readonly targets = new Map<string, { target: ProviderTarget; active: boolean }>();

  constructor(raw?: string) {
    if (raw === undefined || raw === "") return;
    try {
      if (Buffer.byteLength(raw) > 65536) throw new Error();
      const values: unknown = JSON.parse(raw);
      if (!Array.isArray(values) || values.length > 100) throw new Error();
      const instruments = new Map<string, string>(), merchants = new Map<string, string>();
      for (const value of values) {
        if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
        const { status, ...snapshot } = value as Record<string, unknown>;
        if (status !== "active" && status !== "revoked") throw new Error();
        const target = parseProviderTarget(snapshot);
        if (this.targets.has(target.targetId)) throw new Error();
        const instrument = JSON.stringify([target.provider, target.providerAccountRef, target.instrumentRef]);
        const merchant = JSON.stringify([target.provider, target.providerAccountRef, target.merchantRef]);
        if ((instruments.has(instrument) && instruments.get(instrument) !== target.ownerWalletId) ||
            (merchants.has(merchant) && merchants.get(merchant) !== target.merchantWalletId)) throw new Error();
        instruments.set(instrument, target.ownerWalletId); merchants.set(merchant, target.merchantWalletId);
        this.targets.set(target.targetId, { target, active: status === "active" });
      }
    } catch { throw new Error("INVALID_PROVIDER_TARGETS_CONFIGURATION"); }
  }

  resolve(targetId: string, ownerWalletId: string, currency: string): ProviderTarget {
    if (!this.targets.size) throw new RequestError(503, "provider_targets_unavailable", "provider targets are not configured");
    const found = this.targets.get(targetId);
    if (!found?.active || found.target.ownerWalletId !== ownerWalletId || found.target.currency !== currency)
      throw new RequestError(403, "provider_target_denied", "provider target is unavailable for this owner and currency");
    return found.target;
  }

  requireCurrent(snapshot: ProviderTarget): void {
    const target = parseProviderTarget(snapshot), current = this.resolve(target.targetId, target.ownerWalletId, target.currency);
    if (providerTargetFingerprint(current) !== providerTargetFingerprint(target))
      throw new RequestError(409, "provider_target_changed", "provider target changed; create a new proposal for review");
  }
}
