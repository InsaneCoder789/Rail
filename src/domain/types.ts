export type MoneyMinor = number;

export type PaymentChannel = "nfc" | "ble" | "qr" | "online";

export interface PaymentTransaction {
  readonly txId: string;
  readonly idempotencyKey: string;
  readonly senderWalletId: string;
  readonly receiverWalletId: string;
  readonly amountMinor: MoneyMinor;
  readonly currency: string;
  readonly channel: PaymentChannel;
  readonly offlineTokenId?: string;
  /** Binds spend to the device that received the offline token (recommended for offline). */
  readonly deviceId?: string;
  /**
   * Optional HMAC-SHA256 (base64) over `canonicalTransactionPayload` when `RAIL_REQUIRE_TX_SIGNATURE=true`.
   * For production HSM, verify inside the HSM using the same canonical bytes.
   */
  readonly paymentSignature?: string;
  readonly createdAt: string;
}

export interface PipelineResult {
  readonly status: "accepted" | "rejected";
  readonly reason?: string;
  readonly ledgerEntryId?: string;
  readonly bnplLoanId?: string;
}

export interface RiskAssessment {
  score: number;
  decision: "allow" | "challenge" | "block";
  reasons: string[];
}
