import test from "node:test";
import assert from "node:assert/strict";
import { MemoryIdempotencyStore } from "../dist/pipeline/idempotency.js";

test("replays the same idempotent result without rerunning work", async () => {
  const store = new MemoryIdempotencyStore();
  let runs = 0;
  const run = async () => {
    runs += 1;
    return { status: "accepted", ledgerEntryId: "leg_test" };
  };

  assert.deepEqual(await store.dedupe("idem_test_001", "fingerprint_a", run), {
    status: "accepted",
    ledgerEntryId: "leg_test",
  });
  assert.deepEqual(await store.dedupe("idem_test_001", "fingerprint_a", run), {
    status: "accepted",
    ledgerEntryId: "leg_test",
  });
  assert.equal(runs, 1);
});

test("rejects reusing an idempotency key for different transaction data", async () => {
  const store = new MemoryIdempotencyStore();
  await store.dedupe("idem_test_002", "fingerprint_a", async () => ({ status: "accepted" }));

  await assert.rejects(
    store.dedupe("idem_test_002", "fingerprint_b", async () => ({ status: "accepted" })),
    { message: "IDEMPOTENCY_KEY_REUSED" },
  );
});

test("allows a failed idempotent attempt to retry", async () => {
  const store = new MemoryIdempotencyStore();
  await assert.rejects(
    store.dedupe("idem_test_003", "fingerprint_a", async () => {
      throw new Error("temporary_failure");
    }),
    { message: "temporary_failure" },
  );

  const result = await store.dedupe("idem_test_003", "fingerprint_a", async () => ({ status: "accepted" }));
  assert.deepEqual(result, { status: "accepted" });
});
