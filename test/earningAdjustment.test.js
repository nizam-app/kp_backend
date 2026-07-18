import test from "node:test";
import assert from "node:assert/strict";
import mongoose from "mongoose";
import { EarningTransaction } from "../src/modules/earning/earningTransaction.model.js";

const base = {
  mechanic: new mongoose.Types.ObjectId(),
  job: new mongoose.Types.ObjectId(),
  grossAmount: -100,
  platformFee: -12,
  netAmount: -88,
};

test("refund adjustment accepts signed negative accounting amounts", async () => {
  const tx = new EarningTransaction({ ...base, type: "ADJUSTMENT" });
  await tx.validate();
});

test("job payment rejects negative accounting amounts", async () => {
  const tx = new EarningTransaction({ ...base, type: "JOB_PAYMENT" });
  await assert.rejects(tx.validate());
});
