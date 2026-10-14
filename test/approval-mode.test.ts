import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  approvalModeLabel,
  isApprovalMode,
  resolveApprovalMode,
  validateApprovalModes,
} from "../src/case/approval-mode.js";
import type { LoadedRecord } from "../src/case/records.js";
import { asApproval, type Approval } from "../src/case/review-records.js";

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

const binding = [
  { path: "0-coordination/sample-coordination.md", sha256: "a".repeat(64) },
];

function versionedApprovalRecord(schemaVersion: string, extensions?: Record<string, unknown>): LoadedRecord {
  return {
    file: "approvals/phase-0/sample-approval.json",
    absolutePath: path.join(repositoryRoot, "approvals", "sample.json"),
    snapshotSha256: "b".repeat(64),
    value: {
      schemaVersion,
      recordType: "human-approval",
      caseName: "sample",
      artifactPrefix: "sample",
      phaseId: "0",
      artifactHashes: binding,
      reviewRecords: binding,
      decision: "APPROVED",
      approver: "Accountable architect",
      decidedAt: "2026-01-01T10:00:00Z",
      ...(extensions ? { extensions } : {}),
    },
  };
}

function toApproval(record: LoadedRecord): Approval {
  const approval = asApproval(record);
  if (!approval) {
    throw new Error("fixture is not a valid approval record");
  }
  return approval;
}

describe.each(["1.0.0", "1.1.0"])("approval assurance mode with %s", (schemaVersion) => {
  const approvalRecord = (extensions?: Record<string, unknown>): LoadedRecord =>
    versionedApprovalRecord(schemaVersion, extensions);
  it("resolves an ordinary approval as self-asserted", () => {
    expect(resolveApprovalMode(toApproval(approvalRecord()))).toBe(
      "self-asserted",
    );
  });

  it("resolves harness-generated evidence as synthetic", () => {
    const approval = toApproval(
      approvalRecord({ syntheticTestEvidence: true, realApproval: false }),
    );

    expect(resolveApprovalMode(approval)).toBe("synthetic");
  });

  it("never resolves to human-verified while no signature is supported", () => {
    const approval = toApproval(
      approvalRecord({ approvalMode: "human-verified" }),
    );

    expect(resolveApprovalMode(approval)).not.toBe("human-verified");
  });

  it("accepts a declared mode that matches the recorded evidence", () => {
    expect(
      validateApprovalModes([
        approvalRecord({ approvalMode: "self-asserted" }),
        approvalRecord({
          approvalMode: "synthetic",
          syntheticTestEvidence: true,
          realApproval: false,
        }),
      ]),
    ).toEqual([]);
  });

  it("rejects an approval that claims verification it cannot show", () => {
    const errors = validateApprovalModes([
      approvalRecord({ approvalMode: "human-verified" }),
    ]);

    expect(errors).toHaveLength(1);
    expect(errors[0]).toEqual(
      expect.objectContaining({ invariant: "approval-mode" }),
    );
    expect(errors[0]?.message).toContain(
      'declares assurance mode "human-verified" but its recorded evidence supports only "self-asserted"',
    );
  });

  it("rejects synthetic evidence that presents itself as a human decision", () => {
    const errors = validateApprovalModes([
      approvalRecord({
        approvalMode: "self-asserted",
        syntheticTestEvidence: true,
        realApproval: false,
      }),
    ]);

    expect(errors).toHaveLength(1);
    expect(errors[0]?.message).toContain('supports only "synthetic"');
  });

  it("rejects an unknown assurance mode", () => {
    const errors = validateApprovalModes([
      approvalRecord({ approvalMode: "board-approved" }),
    ]);

    expect(errors).toEqual([
      expect.objectContaining({ invariant: "approval-mode" }),
    ]);
    expect(errors[0]?.message).toContain("unknown assurance mode");
  });

  it("treats an absent declaration as the weakest claim rather than an error", () => {
    expect(validateApprovalModes([approvalRecord()])).toEqual([]);
  });

  it("rejects an unsigned decision when this machine holds an approval key", () => {
    const errors = validateApprovalModes([approvalRecord()], {
      requireSignedApprovals: true,
    });

    expect(errors).toHaveLength(1);
    expect(errors[0]?.message).toContain("must be signed");
    expect(errors[0]?.remediation).toContain("your own terminal");
  });

  it("never treats harness evidence as an unsigned human decision", () => {
    const errors = validateApprovalModes(
      [
        approvalRecord({
          approvalMode: "synthetic",
          syntheticTestEvidence: true,
          realApproval: false,
        }),
      ],
      { requireSignedApprovals: true },
    );

    expect(errors).toEqual([]);
  });

  it("leaves self-asserted approvals valid on a machine with no approval key", () => {
    expect(
      validateApprovalModes([approvalRecord()], {
        requireSignedApprovals: false,
      }),
    ).toEqual([]);
  });

  it("rejects a later decision that drops the signature the case already established", async () => {
    const { mkdtemp, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const home = await mkdtemp(path.join(tmpdir(), "aff-continuity-"));
    try {
      const { createIdentity, readEncryptedPrivateKey } = await import(
        "../src/identity/keys.js"
      );
      const { signApproval } = await import("../src/identity/signature.js");
      const passphrase = "correct horse battery staple";
      const created = await createIdentity({
        label: "Accountable architect",
        passphrase,
        home,
      });
      const encrypted = await readEncryptedPrivateKey(home);

      const signedPhase0 = approvalRecord();
      signedPhase0.file = "approvals/phase-0/sample-approval.json";
      signedPhase0.value = signApproval(
        { ...signedPhase0.value, phaseId: "0", decidedAt: "2026-01-01T10:00:00Z" },
        encrypted,
        passphrase,
        created.publicKeyPem,
      );

      const unsignedPhase1 = approvalRecord();
      unsignedPhase1.file = "approvals/phase-1/sample-approval.json";
      unsignedPhase1.value = {
        ...unsignedPhase1.value,
        phaseId: "1",
        decidedAt: "2026-01-02T10:00:00Z",
      };

      const errors = validateApprovalModes([signedPhase0, unsignedPhase1]);

      expect(errors).toHaveLength(1);
      expect(errors[0]?.file).toBe("approvals/phase-1/sample-approval.json");
      expect(errors[0]?.message).toContain("carries no verified signature");
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it("rejects a decision signed by a key the case is not anchored to", async () => {
    const { mkdtemp, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const first = await mkdtemp(path.join(tmpdir(), "aff-key-a-"));
    const second = await mkdtemp(path.join(tmpdir(), "aff-key-b-"));
    try {
      const { createIdentity, readEncryptedPrivateKey } = await import(
        "../src/identity/keys.js"
      );
      const { signApproval } = await import("../src/identity/signature.js");
      const passphrase = "correct horse battery staple";
      const keyA = await createIdentity({
        label: "Accountable architect",
        passphrase,
        home: first,
      });
      const keyB = await createIdentity({
        label: "Someone else",
        passphrase,
        home: second,
      });

      const phase0 = approvalRecord();
      phase0.file = "approvals/phase-0/sample-approval.json";
      phase0.value = signApproval(
        { ...phase0.value, phaseId: "0", decidedAt: "2026-01-01T10:00:00Z" },
        await readEncryptedPrivateKey(first),
        passphrase,
        keyA.publicKeyPem,
      );

      const phase1 = approvalRecord();
      phase1.file = "approvals/phase-1/sample-approval.json";
      phase1.value = signApproval(
        { ...phase1.value, phaseId: "1", decidedAt: "2026-01-02T10:00:00Z" },
        await readEncryptedPrivateKey(second),
        passphrase,
        keyB.publicKeyPem,
      );

      const errors = validateApprovalModes([phase0, phase1]);

      expect(errors).toHaveLength(1);
      expect(errors[0]?.message).toContain("the case is anchored to");
    } finally {
      await rm(first, { recursive: true, force: true });
      await rm(second, { recursive: true, force: true });
    }
  });

  it("describes each mode without overstating it", () => {
    expect(approvalModeLabel("self-asserted")).toContain(
      "without verification of the approver",
    );
    expect(approvalModeLabel("synthetic")).toContain("no human decision");
    expect(isApprovalMode("human-verified")).toBe(true);
    expect(isApprovalMode("rubber-stamped")).toBe(false);
  });
});
