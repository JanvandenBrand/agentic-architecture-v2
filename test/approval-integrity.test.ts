import { createPrivateKey, generateKeyPairSync, sign } from "node:crypto";
import { cp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { prepareApproval, recordSignedDecision } from "../src/approve/prepare.js";
import { validateCase, validateLoadedCase } from "../src/case/index.js";
import { loadCaseRecords } from "../src/case/records.js";
import { createIdentity, fingerprintPublicKey } from "../src/identity/keys.js";
import * as signatures from "../src/identity/signature.js";
import { buildContosoSmokeWorkspace } from "../src/smoke/contoso.js";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const root = path.join(repositoryRoot, ".test-output", `approval-integrity-${process.pid}-${Date.now()}`);
const casePath = "cases/contoso-permit-services";
const passphrase = "synthetic test passphrase only";
const keyA = testKey();
const keyB = testKey();
let counter = 0;

function testKey() {
  const pair = generateKeyPairSync("ed25519", {
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem", cipher: "aes-256-cbc", passphrase },
  });
  return { ...pair, fingerprint: fingerprintPublicKey(pair.publicKey) };
}

function signed(record: Record<string, unknown>, key = keyA, omitOuter = false) {
  const value = signatures.signApproval(record, key.privateKey, passphrase, key.publicKey);
  if (omitOuter) {
    const extensions = value.extensions as Record<string, unknown>;
    delete extensions.keyFingerprint;
    (extensions.signature as Record<string, unknown>).value = sign(
      null, signatures.signablePayload(value),
      createPrivateKey({ key: key.privateKey, passphrase }),
    ).toString("base64");
  }
  return value;
}

beforeAll(async () => {
  await mkdir(root, { recursive: true });
  for (const schemaVersion of ["1.0.0", "1.1.0"] as const) {
    await buildContosoSmokeWorkspace(repositoryRoot, path.join(root, `base-${schemaVersion}`), {
      host: "github-copilot", schemaVersion,
    });
  }
});
afterAll(async () => { await rm(root, { recursive: true, force: true }); });

async function fixture(schemaVersion = "1.0.0") {
  const workspace = path.join(root, `case-${counter++}`);
  await cp(path.join(root, `base-${schemaVersion}`), workspace, { recursive: true });
  const caseRoot = path.join(workspace, ...casePath.split("/"));
  const approvalPath = path.join(caseRoot, "approvals", "phase-0", "contoso-phase-0-synthetic-approval.json");
  const template = JSON.parse(await readFile(approvalPath, "utf8")) as Record<string, unknown>;
  delete template.extensions;
  template.approver = "Synthetic architect";
  await rm(approvalPath);
  const journal = path.join(caseRoot, "contoso-run-journal.jsonl");
  const events = (await readFile(journal, "utf8")).trim().split(/\r?\n/u).slice(0, 4);
  await writeFile(journal, `${events.join("\n")}\n`);
  const home = path.join(workspace, "synthetic-home");
  await createIdentity({ label: "Synthetic architect", passphrase, home });
  const save = async (name: string, value: Record<string, unknown>) => {
    const file = path.join(caseRoot, "approvals", "phase-0", name);
    await writeFile(file, JSON.stringify(value));
    return file;
  };
  const validate = () => validateCase(workspace, casePath, { home });
  return { workspace, caseRoot, home, template, save, validate };
}

describe.each(["1.0.0", "1.1.0"])("full-case verified approval key continuity %s", (schemaVersion) => {
  it("accepts predecessor-authorised A to B rotation and subsequent B decisions", async () => {
    expect(signatures).toHaveProperty("signKeyRotation");
    const f = await fixture(schemaVersion);
    await f.save("a.json", signed(f.template));
    const next = { ...f.template, decidedAt: "2026-01-01T09:06:00Z" };
    const proof = signatures.signKeyRotation(next, keyA.privateKey, passphrase, keyA.publicKey, keyB.publicKey, "Planned replacement");
    await f.save("b.json", signed({ ...next, extensions: { keyRotation: proof } }, keyB));
    await f.save("b-later.json", signed({ ...f.template, decidedAt: "2026-01-01T09:07:00Z" }, keyB, true));
    expect((await f.validate()).errors).toEqual([]);
  });

  it.each(["wrong-signer", "other-case", "other-payload", "wrong-old", "blank-reason", "invalid-proof", "omitted-payload-field"])(
    "rejects %s rotation proof without advancing the trusted key", async (mutation) => {
      expect(signatures).toHaveProperty("signKeyRotation");
      const f = await fixture(schemaVersion);
      await f.save("a.json", signed(f.template));
      const next = { ...f.template, decidedAt: "2026-01-01T09:06:00Z" };
      const authorised = mutation === "other-case" ? { ...next, caseName: "another-case" }
        : mutation === "other-payload" ? { ...next, decision: "REJECTED" } : next;
      const proof = signatures.signKeyRotation(
        authorised, mutation === "wrong-signer" ? keyB.privateKey : keyA.privateKey,
        passphrase, mutation === "wrong-signer" ? keyB.publicKey : keyA.publicKey, keyB.publicKey, "Planned replacement",
      );
      if (mutation === "wrong-old") proof.previousKeyFingerprint = "0".repeat(64);
      if (mutation === "blank-reason") proof.reason = " ";
      if (mutation === "invalid-proof") proof.value = "bogus";
      await f.save("b.json", signed({ ...next, extensions: { keyRotation: proof } }, keyB, mutation === "omitted-payload-field"));
      await f.save("b-later.json", signed({ ...f.template, decidedAt: "2026-01-01T09:07:00Z" }, keyB));
      const loaded = await loadCaseRecords(f.workspace, f.caseRoot);
      expect(loaded.errors).toEqual([]);
      expect((await f.validate()).errors).toEqual([
        expect.objectContaining({ invariant: "approval-mode" }),
        expect.objectContaining({ invariant: "approval-mode" }),
      ]);
    },
  );

  it.each([false, true])("rejects foreign B when redundant fingerprint omitted (anchor omission %s)", async (omitAnchor) => {
    const f = await fixture(schemaVersion);
    await f.save("a.json", signed(f.template, keyA, omitAnchor));
    expect((await f.validate()).errors).toEqual([]);
    await f.save("b.json", signed({ ...f.template, decidedAt: "2026-01-01T09:06:00Z" }, keyB, true));
    const loaded = await loadCaseRecords(f.workspace, f.caseRoot);
    expect(loaded.errors).toEqual([]);
    const result = await validateLoadedCase(f.workspace, f.caseRoot, loaded, { home: f.home });
    expect(result.errors).toEqual([expect.objectContaining({ invariant: "approval-mode" })]);
  });

  it("rejects a self-asserted rotation instead of accepting metadata as authority", async () => {
    const f = await fixture(schemaVersion);
    await f.save("a.json", signed(f.template));
    await f.save("b.json", signed({
      ...f.template, decidedAt: "2026-01-01T09:06:00Z",
      extensions: { keyRotation: { previousKeyFingerprint: keyA.fingerprint, reason: "claimed rotation" } },
    }, keyB));
    const loaded = await loadCaseRecords(f.workspace, f.caseRoot);
    expect(loaded.errors).toEqual([]);
    expect((await f.validate()).errors).toEqual([expect.objectContaining({ invariant: "approval-mode" })]);
  });

  it("rejects signed inconsistent redundant metadata", async () => {
    const f = await fixture(schemaVersion);
    const value = signed(f.template);
    const extensions = value.extensions as Record<string, unknown>;
    extensions.keyFingerprint = keyB.fingerprint;
    (extensions.signature as Record<string, unknown>).value = sign(
      null, signatures.signablePayload(value), createPrivateKey({ key: keyA.privateKey, passphrase }),
    ).toString("base64");
    expect(signatures.verifyApprovalSignature(value).verified).toBe(true);
    await f.save("a.json", value);
    expect((await f.validate()).errors).toEqual([expect.objectContaining({ invariant: "approval-mode" })]);
  });
});

describe("append-only decision readiness and publication", () => {
  it("does not hide duplicate historical decision instants behind a prospective newer decision", async () => {
    const f = await fixture();
    await f.save("a.json", signed(f.template));
    await f.save("duplicate.json", signed(f.template));
    await writeFile(path.join(f.home, ".aff", "identity", "architect.pub"),
      JSON.stringify({ label: "Synthetic architect", publicKeyPem: keyA.publicKey }));
    await expect(prepareApproval({ repositoryRoot: f.workspace, casePath, phaseId: "0", home: f.home }))
      .rejects.toThrow(/duplicate|same decision time/iu);
  });
  it("records a rotation only with the predecessor proof for the exact prepared intent", async () => {
    const f = await fixture();
    await f.save("a.json", signed(f.template));
    await writeFile(path.join(f.home, ".aff", "identity", "architect.pub"),
      JSON.stringify({ label: "Synthetic architect", publicKeyPem: keyB.publicKey }));
    await writeFile(path.join(f.home, ".aff", "identity", "architect.key"), keyB.privateKey);
    const next = { ...f.template, decidedAt: "2026-01-01T09:06:00Z" };
    const intent = {
      decision: "APPROVED" as const,
      decidedAt: String(next.decidedAt),
      residualGapAcceptance: f.template.residualGapAcceptance as string[],
      keyRotation: signatures.signKeyRotation(next, keyA.privateKey, passphrase, keyA.publicKey, keyB.publicKey, "Planned replacement"),
    };
    const context = await prepareApproval({
      repositoryRoot: f.workspace, casePath, phaseId: "0", home: f.home, intent,
    });
    await recordSignedDecision({ context, ...intent, passphrase, home: f.home });
    expect((await f.validate()).errors).toEqual([]);
  });

  it("refuses an unsupported public-key algorithm before presenting approval", async () => {
    const f = await fixture();
    const rsa = generateKeyPairSync("rsa", {
      modulusLength: 2048,
      publicKeyEncoding: { type: "spki", format: "pem" },
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
    });
    await writeFile(path.join(f.home, ".aff", "identity", "architect.pub"),
      JSON.stringify({ label: "Synthetic architect", publicKeyPem: rsa.publicKey }));
    await expect(prepareApproval({ repositoryRoot: f.workspace, casePath, phaseId: "0", home: f.home }))
      .rejects.toThrow(/Ed25519|algorithm/iu);
  });

  it("refuses future-dated decisions before key unlock", async () => {
    const f = await fixture();
    const context = await prepareApproval({ repositoryRoot: f.workspace, casePath, phaseId: "0", home: f.home });
    await expect(recordSignedDecision({
      context, decision: "APPROVED", passphrase: "wrong", home: f.home, decidedAt: "2100-01-01T09:01:00Z",
    })).rejects.toThrow(/future|decision time/iu);
  });

  it("refuses a decision timestamp before the candidate and final reviews", async () => {
    const f = await fixture();
    const context = await prepareApproval({ repositoryRoot: f.workspace, casePath, phaseId: "0", home: f.home });
    await expect(recordSignedDecision({
      context, decision: "APPROVED", passphrase: "wrong", home: f.home, decidedAt: "2026-01-01T09:01:00Z",
    })).rejects.toThrow(/decision time|timestamp|review.*before|before.*review/iu);
  });

  it.each(["not-a-date", "2026-01-01"])("rejects invalid RFC3339 decision time %s before key unlock", async (decidedAt) => {
    const f = await fixture();
    const context = await prepareApproval({ repositoryRoot: f.workspace, casePath, phaseId: "0", home: f.home });
    await expect(recordSignedDecision({ context, decision: "APPROVED", passphrase: "wrong", home: f.home, decidedAt }))
      .rejects.toThrow(/schema-validation/iu);
  });

  it.each(["missing-file", "unreviewed-file", "duplicate-review", "wrong-model", "malformed-approval"])(
    "refuses preparation with unresolved %s", async (failure) => {
      const f = await fixture();
      const reviewPath = path.join(f.caseRoot, "reviews", "aff-a", "0", "round-1", "contoso-aff-a-review.json");
      if (failure === "missing-file") {
        await rm(path.join(f.caseRoot, "0-coordination", "contoso-coordination.md"));
      } else if (failure === "unreviewed-file") {
        await writeFile(path.join(f.caseRoot, "0-coordination", "not-reviewed.txt"), "unreviewed");
      } else if (failure === "duplicate-review") {
        await cp(reviewPath, path.join(path.dirname(reviewPath), "duplicate.json"));
      } else if (failure === "wrong-model") {
        const review = JSON.parse(await readFile(reviewPath, "utf8"));
        review.model = "gpt-incorrect-model";
        await writeFile(reviewPath, JSON.stringify(review));
      } else {
        await f.save("bad.json", { ...f.template, decidedAt: "not-a-date" });
      }
      await expect(prepareApproval({ repositoryRoot: f.workspace, casePath, phaseId: "0", home: f.home }))
        .rejects.toThrow(/validate|hash|review|schema/iu);
    },
  );

  it("persists rejection and subsequent approval as separate immutable files", async () => {
    const f = await fixture();
    const context = await prepareApproval({ repositoryRoot: f.workspace, casePath, phaseId: "0", home: f.home });
    const first = await recordSignedDecision({ context, decision: "REJECTED", passphrase, home: f.home, decidedAt: "2026-01-01T09:05:00Z" });
    const bytes = await readFile(path.join(f.caseRoot, first.file));
    const next = await prepareApproval({ repositoryRoot: f.workspace, casePath, phaseId: "0", home: f.home });
    const second = await recordSignedDecision({ context: next, decision: "APPROVED", passphrase, home: f.home, decidedAt: "2026-01-01T09:06:00Z" });
    expect(second.file).not.toBe(first.file);
    expect(await readFile(path.join(f.caseRoot, first.file))).toEqual(bytes);
    expect((await f.validate()).errors).toEqual([]);
  });

  it("racing publishers never replace a completed decision", async () => {
    const f = await fixture();
    const context = await prepareApproval({ repositoryRoot: f.workspace, casePath, phaseId: "0", home: f.home });
    const results = await Promise.allSettled(["APPROVED", "REJECTED"].map((decision) =>
      recordSignedDecision({ context, decision: decision as "APPROVED" | "REJECTED", passphrase, home: f.home, decidedAt: "2026-01-01T09:05:00Z" })));
    expect(results.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
    const files = await readdir(path.join(f.caseRoot, "approvals", "phase-0"));
    expect(files).toHaveLength(1);
    expect(signatures.verifyApprovalSignature(JSON.parse(await readFile(
      path.join(f.caseRoot, "approvals", "phase-0", files[0]!), "utf8",
    ))).verified).toBe(true);
  });

  it("does not replace an existing decision at the same instant", async () => {
    const f = await fixture();
    const context = await prepareApproval({ repositoryRoot: f.workspace, casePath, phaseId: "0", home: f.home });
    const first = await recordSignedDecision({ context, decision: "APPROVED", passphrase, home: f.home, decidedAt: "2026-01-01T09:05:00Z" });
    const bytes = await readFile(path.join(f.caseRoot, first.file));
    await expect(recordSignedDecision({ context, decision: "REJECTED", passphrase, home: f.home, decidedAt: "2026-01-01T10:05:00+01:00" })).rejects.toThrow();
    expect(await readFile(path.join(f.caseRoot, first.file))).toEqual(bytes);
  });

  it("rejects evidence changed after presentation before attempting key unlock", async () => {
    const f = await fixture();
    const context = await prepareApproval({ repositoryRoot: f.workspace, casePath, phaseId: "0", home: f.home });
    await writeFile(path.join(f.caseRoot, "0-coordination", "contoso-coordination.md"), "changed");
    await expect(recordSignedDecision({ context, decision: "APPROVED", passphrase: "wrong", home: f.home }))
      .rejects.toThrow(/changed|validate|hash/iu);
  });

  it("rejects a substituted local identity before attempting key unlock", async () => {
    const f = await fixture();
    const context = await prepareApproval({ repositoryRoot: f.workspace, casePath, phaseId: "0", home: f.home });
    await writeFile(path.join(f.home, ".aff", "identity", "architect.pub"),
      JSON.stringify({ label: "Other architect", publicKeyPem: keyB.publicKey }));
    await expect(recordSignedDecision({ context, decision: "APPROVED", passphrase: "wrong", home: f.home }))
      .rejects.toThrow(/identity.*changed/iu);
  });

  it.each(["7", "8", "bogus"])("refuses unsupported approval phase %s", async (phaseId) => {
    const f = await fixture();
    await expect(prepareApproval({ repositoryRoot: f.workspace, casePath, phaseId, home: f.home }))
      .rejects.toThrow(/phase|authorisation/iu);
  });

  it("blocks APPROVED on DIVERGES but permits rejection of the same converged candidate", async () => {
    const f = await fixture();
    const reviewPath = path.join(f.caseRoot, "reviews", "aff-a", "0", "round-1", "contoso-aff-a-review.json");
    const review = JSON.parse(await readFile(reviewPath, "utf8"));
    review.verdict = "DIVERGES";
    await writeFile(reviewPath, JSON.stringify(review));
    const context = await prepareApproval({ repositoryRoot: f.workspace, casePath, phaseId: "0", home: f.home });
    await expect(recordSignedDecision({ context, decision: "APPROVED", passphrase: "wrong", home: f.home }))
      .rejects.toThrow(/DIVERGES|approval-binding/iu);
    await recordSignedDecision({ context, decision: "REJECTED", passphrase, home: f.home, decidedAt: "2026-01-01T09:05:00Z" });
    expect((await f.validate()).errors).toEqual([]);
  });

  it("allows reapproval against newer reviews without deleting historic approval assurance", async () => {
    const f = await fixture();
    const context = await prepareApproval({ repositoryRoot: f.workspace, casePath, phaseId: "0", home: f.home });
    const first = await recordSignedDecision({ context, decision: "APPROVED", passphrase, home: f.home, decidedAt: "2026-01-01T09:05:00Z" });
    for (const reviewer of ["aff-a", "aff-b"]) {
      const original = path.join(f.caseRoot, "reviews", reviewer, "0", "round-1", `contoso-${reviewer}-review.json`);
      const review = JSON.parse(await readFile(original, "utf8"));
      review.round = 2;
      const directory = path.join(f.caseRoot, "reviews", reviewer, "0", "round-2");
      await mkdir(directory);
      await writeFile(path.join(directory, `contoso-${reviewer}-review.json`), JSON.stringify(review));
    }
    const next = await prepareApproval({ repositoryRoot: f.workspace, casePath, phaseId: "0", home: f.home });
    await recordSignedDecision({ context: next, decision: "APPROVED", passphrase, home: f.home, decidedAt: "2026-01-01T09:06:00Z" });
    expect((await f.validate()).errors).toEqual([]);
    const historical = JSON.parse(await readFile(path.join(f.caseRoot, first.file), "utf8"));
    historical.approver = "tampered";
    await writeFile(path.join(f.caseRoot, first.file), JSON.stringify(historical));
    await expect(prepareApproval({ repositoryRoot: f.workspace, casePath, phaseId: "0", home: f.home })).rejects.toThrow(/approval-mode/iu);
  });
});
