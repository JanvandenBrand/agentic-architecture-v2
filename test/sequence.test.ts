import path from "node:path";
import { appendFile, cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { readLifecycle } from "../src/framework/lifecycle.js";
import type { LoadedRecord } from "../src/case/records.js";
import { validatePhaseSequence } from "../src/case/sequence.js";
import { validateCase } from "../src/case/index.js";

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

const binding = [
  {
    path: "0-coordination/sample-coordination.md",
    sha256: "a".repeat(64),
  },
];

function record(file: string, value: Record<string, unknown>): LoadedRecord {
  return {
    file,
    absolutePath: path.join(repositoryRoot, file),
    snapshotSha256: "b".repeat(64),
    value,
  };
}

function approval(phaseId: string, decidedAt: string, decision = "APPROVED") {
  return record(`approvals/phase-${phaseId}/sample-approval.json`, {
    schemaVersion: "1.0.0",
    recordType: "human-approval",
    caseName: "sample",
    artifactPrefix: "sample",
    phaseId,
    artifactHashes: binding,
    reviewRecords: binding,
    decision,
    approver: "Human Architect",
    decidedAt,
  });
}

function journalEvent(
  phaseId: string,
  eventType: string,
  sequence: number,
  extra: Record<string, unknown> = {},
) {
  return record(`sample-run-journal.jsonl:${sequence}`, {
    schemaVersion: "1.0.0",
    recordType: "run-journal-event",
    caseName: "sample",
    artifactPrefix: "sample",
    eventId: `EVT-${sequence}`,
    sequence,
    timestamp: "2026-01-01T09:00:00Z",
    phaseId,
    eventType,
    actor: "AFF-0-coordinator",
    summary: "Synthetic event.",
    ...extra,
  });
}

function messages(errors: { message: string }[]): string {
  return errors.map(({ message }) => message).join("\n");
}

describe("phase sequence", () => {
  it("accepts the first phase with no predecessor", async () => {
    const manifest = await readLifecycle(repositoryRoot);

    const errors = validatePhaseSequence(
      [
        approval("0", "2026-01-01T10:00:00Z"),
        journalEvent("0", "ARTIFACTS-RECORDED", 1, {
          artifactHashes: binding,
        }),
      ],
      manifest,
    );

    expect(errors).toEqual([]);
  });

  it("accepts phases approved in lifecycle order", async () => {
    const manifest = await readLifecycle(repositoryRoot);

    const errors = validatePhaseSequence(
      [
        approval("0", "2026-01-01T10:00:00Z"),
        approval("1", "2026-01-02T10:00:00Z"),
        approval("2", "2026-01-03T10:00:00Z"),
      ],
      manifest,
    );

    expect(errors).toEqual([]);
  });

  it("rejects a phase approved while its predecessor has no approval", async () => {
    const manifest = await readLifecycle(repositoryRoot);

    const errors = validatePhaseSequence(
      [approval("1", "2026-01-02T10:00:00Z")],
      manifest,
    );

    expect(errors).toHaveLength(1);
    expect(errors[0]).toEqual(
      expect.objectContaining({ invariant: "phase-sequence" }),
    );
    expect(messages(errors)).toContain(
      "Phase 1 was approved while phase 0 has no approved human decision",
    );
  });

  it("rejects a phase approved while its predecessor was rejected", async () => {
    const manifest = await readLifecycle(repositoryRoot);

    const errors = validatePhaseSequence(
      [
        approval("0", "2026-01-01T10:00:00Z", "REJECTED"),
        approval("1", "2026-01-02T10:00:00Z"),
      ],
      manifest,
    );

    expect(messages(errors)).toContain(
      "Phase 1 was approved while phase 0 has no approved human decision",
    );
  });

  it("rejects phase entry before the predecessor is approved", async () => {
    const manifest = await readLifecycle(repositoryRoot);

    const errors = validatePhaseSequence(
      [journalEvent("1", "PHASE-ENTERED", 2)],
      manifest,
    );

    expect(messages(errors)).toContain("Phase 1 was entered while phase 0");
  });

  it("rejects candidate artifacts recorded before the predecessor is approved", async () => {
    const manifest = await readLifecycle(repositoryRoot);

    const errors = validatePhaseSequence(
      [
        approval("0", "2026-01-01T10:00:00Z"),
        journalEvent("2", "ARTIFACTS-RECORDED", 5, {
          artifactHashes: binding,
        }),
      ],
      manifest,
    );

    expect(messages(errors)).toContain(
      "Phase 2 recorded candidate artifacts while phase 1 has no approved human decision",
    );
  });

  it("rejects an approval recorded before its predecessor decision time", async () => {
    const manifest = await readLifecycle(repositoryRoot);

    const errors = validatePhaseSequence(
      [
        approval("0", "2026-01-05T10:00:00Z"),
        approval("1", "2026-01-02T10:00:00Z"),
      ],
      manifest,
    );

    expect(messages(errors)).toContain(
      "Phase 1 was approved at 2026-01-02T10:00:00Z, before phase 0 was approved at 2026-01-05T10:00:00Z",
    );
  });

  it("fails closed when an optional phase prerequisite has no catalogued record", async () => {
    const manifest = await readLifecycle(repositoryRoot);

    const errors = validatePhaseSequence(
      [
        approval("6", "2026-01-06T10:00:00Z"),
        journalEvent("7", "PHASE-ENTERED", 9),
      ],
      manifest,
    );

    expect(messages(errors)).toContain(
      'declared prerequisite "scoped-attempt-authorisation" has no catalogued case record',
    );
  });

  it("still requires an approved Phase 6 before Phase 7 is entered", async () => {
    const manifest = await readLifecycle(repositoryRoot);

    const errors = validatePhaseSequence(
      [journalEvent("7", "PHASE-ENTERED", 9)],
      manifest,
    );

    expect(messages(errors)).toContain(
      "Phase 7 was entered while phase 6 has no approved human decision",
    );
  });

  it("ignores phases with no case evidence", async () => {
    const manifest = await readLifecycle(repositoryRoot);

    expect(validatePhaseSequence([], manifest)).toEqual([]);
  });

  it.each(["PHASE-ENTERED", "ARTIFACTS-RECORDED"])(
    "rejects early %s even when a later prerequisite approval exists",
    async (eventType) => {
      const manifest = await readLifecycle(repositoryRoot);
      const errors = validatePhaseSequence([
        approval("0", "2026-01-01T10:00:00Z"),
        journalEvent("1", eventType, 2, { artifactHashes: binding }),
        approval("1", "2026-01-01T11:00:00Z"),
      ], manifest);
      expect(messages(errors)).toContain("before");
      expect(errors.some(({ file }) => file.includes("sample-run-journal.jsonl:2"))).toBe(true);
    },
  );

  it("does not hide an invalid earlier candidate behind a newer candidate", async () => {
    const manifest = await readLifecycle(repositoryRoot);
    const errors = validatePhaseSequence([
      approval("0", "2026-01-01T10:00:00Z"),
      journalEvent("1", "ARTIFACTS-RECORDED", 2, { artifactHashes: binding }),
      journalEvent("1", "ARTIFACTS-RECORDED", 3, {
        timestamp: "2026-01-01T11:00:00Z", artifactHashes: binding,
      }),
    ], manifest);
    expect(errors).toContainEqual(expect.objectContaining({
      file: "sample-run-journal.jsonl:2",
      invariant: "phase-sequence",
    }));
  });

  it("accepts activity at the prerequisite approval instant", async () => {
    const manifest = await readLifecycle(repositoryRoot);
    expect(validatePhaseSequence([
      approval("0", "2026-01-01T10:00:00Z"),
      journalEvent("1", "PHASE-ENTERED", 2, { timestamp: "2026-01-01T10:00:00Z" }),
    ], manifest)).toEqual([]);
  });

  it("uses the latest decision at the event time, not any historical approval", async () => {
    const manifest = await readLifecycle(repositoryRoot);
    const rejected = approval("0", "2026-01-01T11:00:00Z", "REJECTED");
    rejected.file = "approvals/phase-0/rejected.json";
    const restored = approval("0", "2026-01-01T13:00:00Z");
    restored.file = "approvals/phase-0/restored.json";
    const errors = validatePhaseSequence([
      approval("0", "2026-01-01T10:00:00Z"),
      rejected,
      journalEvent("1", "PHASE-ENTERED", 2, { timestamp: "2026-01-01T12:00:00Z" }),
      restored,
    ], manifest);
    expect(messages(errors)).toContain("no approved prerequisite decision at that time");
  });

  it.each(["PHASE-REOPENED", "BLOCKER", "ARTIFACTS-RECORDED"])(
    "rejects downstream work after upstream %s until fresh approval",
    async (eventType) => {
      const manifest = await readLifecycle(repositoryRoot);
      const restored = approval("0", "2026-01-01T13:00:00Z");
      restored.file = "approvals/phase-0/restored.json";
      const errors = validatePhaseSequence([
        approval("0", "2026-01-01T10:00:00Z"),
        journalEvent("0", eventType, 2, {
          timestamp: "2026-01-01T11:00:00Z", artifactHashes: binding,
        }),
        journalEvent("1", "PHASE-ENTERED", 3, { timestamp: "2026-01-01T12:00:00Z" }),
        restored,
      ], manifest);
      expect(messages(errors)).toContain("requires fresh approval");
    },
  );

  it("preserves valid earlier activity across a later reopen and reapproval", async () => {
    const manifest = await readLifecycle(repositoryRoot);
    const restored = approval("0", "2026-01-01T13:00:00Z");
    restored.file = "approvals/phase-0/restored.json";
    expect(validatePhaseSequence([
      approval("0", "2026-01-01T10:00:00Z"),
      journalEvent("1", "PHASE-ENTERED", 2, { timestamp: "2026-01-01T10:30:00Z" }),
      journalEvent("0", "PHASE-REOPENED", 3, { timestamp: "2026-01-01T11:00:00Z" }),
      restored,
      journalEvent("1", "ARTIFACTS-RECORDED", 4, {
        timestamp: "2026-01-01T14:00:00Z", artifactHashes: binding,
      }),
    ], manifest)).toEqual([]);
  });

  it("rejects backfilled prerequisite approval through full case validation", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "aff-chronology-"));
    try {
      const caseRoot = path.join(root, "cases", "valid-case");
      await cp(path.join(repositoryRoot, "schemas"), path.join(root, "schemas"), { recursive: true });
      await cp(path.join(repositoryRoot, ".github"), path.join(root, ".github"), { recursive: true });
      await cp(path.join(repositoryRoot, "test", "fixtures", "cases", "valid-case"), caseRoot, { recursive: true });
      const event = journalEvent("1", "PHASE-ENTERED", 2, {
        caseName: "valid-case",
        timestamp: "2020-01-01T09:00:00Z",
        actor: "AFF-1-requirements",
      });
      await appendFile(
        path.join(caseRoot, "sample-run-journal.jsonl"),
        `${JSON.stringify(event.value)}\n`,
      );
      const result = await validateCase(root, "cases/valid-case", { home: path.join(root, "home") });
      expect(result.errors).toContainEqual(expect.objectContaining({
        invariant: "phase-sequence",
        file: "sample-run-journal.jsonl:2",
        message: expect.stringContaining("before approval"),
      }));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
