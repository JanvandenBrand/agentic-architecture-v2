import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  createIdentity,
  fingerprintPublicKey,
  IdentityError,
  identityDirectory,
  readEncryptedPrivateKey,
  readIdentity,
} from "../src/identity/keys.js";
import {
  signApproval,
  signablePayload,
  verifyApprovalSignature,
} from "../src/identity/signature.js";

const temporaryDirectories: string[] = [];
const passphrase = "correct horse battery staple";

async function temporaryHome(): Promise<string> {
  const home = await mkdtemp(path.join(tmpdir(), "aff-identity-"));
  temporaryDirectories.push(home);
  return home;
}

function approvalRecord(schemaVersion: string): Record<string, unknown> {
  return {
    schemaVersion,
    recordType: "human-approval",
    caseName: "sample",
    artifactPrefix: "sample",
    phaseId: "1",
    artifactHashes: [
      { path: "1-requirements/sample-requirements.md", sha256: "a".repeat(64) },
    ],
    reviewRecords: [
      { path: "reviews/aff-a/1/round-1/r.json", sha256: "b".repeat(64) },
      { path: "reviews/aff-b/1/round-1/r.json", sha256: "c".repeat(64) },
    ],
    decision: "APPROVED",
    approver: "Accountable architect",
    decidedAt: "2026-01-02T10:00:00Z",
    residualGapAcceptance: [],
  };
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("architect approval identity", () => {
  it("writes the private key as ciphertext, never the passphrase", async () => {
    const home = await temporaryHome();

    const created = await createIdentity({
      label: "Accountable architect",
      passphrase,
      home,
    });

    const onDisk = await readFile(created.privateKeyPath, "utf8");
    expect(onDisk).toContain("BEGIN ENCRYPTED PRIVATE KEY");
    expect(onDisk).not.toContain(passphrase);
    const publicFile = await readFile(created.publicKeyPath, "utf8");
    expect(publicFile).not.toContain(passphrase);
    expect(created.fingerprint).toMatch(/^[0-9a-f]{64}$/u);
  });

  it("refuses to silently replace an existing identity", async () => {
    const home = await temporaryHome();
    await createIdentity({ label: "Accountable architect", passphrase, home });

    await expect(
      createIdentity({ label: "Someone else", passphrase, home }),
    ).rejects.toBeInstanceOf(IdentityError);
  });

  it("refuses a passphrase too short to be worth having", async () => {
    const home = await temporaryHome();

    await expect(
      createIdentity({ label: "Accountable architect", passphrase: "short", home }),
    ).rejects.toBeInstanceOf(IdentityError);
  });

  it("reads back the label and a fingerprint derived from the public key", async () => {
    const home = await temporaryHome();
    const created = await createIdentity({
      label: "Accountable architect",
      passphrase,
      home,
    });

    const identity = await readIdentity(home);

    expect(identity?.label).toBe("Accountable architect");
    expect(identity?.fingerprint).toBe(created.fingerprint);
    expect(fingerprintPublicKey(identity?.publicKeyPem ?? "")).toBe(
      created.fingerprint,
    );
  });

  it("reports no identity rather than failing when none exists", async () => {
    expect(await readIdentity(await temporaryHome())).toBeUndefined();
  });

  it("requires signed approvals by default once a key exists", async () => {
    const home = await temporaryHome();
    await createIdentity({ label: "Accountable architect", passphrase, home });

    expect((await readIdentity(home))?.requireSignedApprovals).toBe(true);
  });

  it("reads a truncated identity as the stricter policy", async () => {
    const home = await temporaryHome();
    const created = await createIdentity({
      label: "Accountable architect",
      passphrase,
      home,
    });
    await writeFile(
      created.publicKeyPath,
      JSON.stringify({
        label: created.label,
        publicKeyPem: created.publicKeyPem,
      }),
      "utf8",
    );

    expect((await readIdentity(home))?.requireSignedApprovals).toBe(true);
  });

  it("honours a deliberate relaxation of the policy", async () => {
    const home = await temporaryHome();
    const created = await createIdentity({
      label: "Accountable architect",
      passphrase,
      home,
    });
    await writeFile(
      created.publicKeyPath,
      JSON.stringify({
        label: created.label,
        publicKeyPem: created.publicKeyPem,
        requireSignedApprovals: false,
      }),
      "utf8",
    );

    expect((await readIdentity(home))?.requireSignedApprovals).toBe(false);
  });
});

describe.each(["1.0.0", "1.1.0"])("approval signatures with %s", (schemaVersion) => {
  async function signedFixture(): Promise<{
    home: string;
    signed: Record<string, unknown>;
    fingerprint: string;
  }> {
    const home = await temporaryHome();
    const created = await createIdentity({
      label: "Accountable architect",
      passphrase,
      home,
    });
    const signed = signApproval(
      approvalRecord(schemaVersion),
      await readEncryptedPrivateKey(home),
      passphrase,
      created.publicKeyPem,
    );
    return { home, signed, fingerprint: created.fingerprint };
  }

  it("verifies a decision signed with the correct passphrase", async () => {
    const { signed, fingerprint } = await signedFixture();

    expect(verifyApprovalSignature(signed)).toEqual({ verified: true });
    const extensions = signed.extensions as Record<string, unknown>;
    expect(extensions.approvalMode).toBe("human-verified");
    expect(extensions.keyFingerprint).toBe(fingerprint);
  });

  it("cannot sign without the passphrase", async () => {
    const home = await temporaryHome();
    const created = await createIdentity({
      label: "Accountable architect",
      passphrase,
      home,
    });
    const encrypted = await readEncryptedPrivateKey(home);

    expect(() =>
      signApproval(approvalRecord(schemaVersion), encrypted, "wrong passphrase", created.publicKeyPem),
    ).toThrow(IdentityError);
  });

  it("rejects a decision flipped after signing", async () => {
    const { signed } = await signedFixture();

    const tampered = { ...signed, decision: "REJECTED" };

    expect(verifyApprovalSignature(tampered).verified).toBe(false);
  });

  it("rejects a signature copied onto another contract version", async () => {
    const { signed } = await signedFixture();
    expect(verifyApprovalSignature({
      ...signed,
      schemaVersion: schemaVersion === "1.0.0" ? "1.1.0" : "1.0.0",
    }).verified).toBe(false);
  });

  it("rejects an artifact hash swapped after signing", async () => {
    const { signed } = await signedFixture();

    const tampered = {
      ...signed,
      artifactHashes: [
        { path: "1-requirements/sample-requirements.md", sha256: "d".repeat(64) },
      ],
    };

    expect(verifyApprovalSignature(tampered).verified).toBe(false);
  });

  it("rejects a signature lifted onto another phase", async () => {
    const { signed } = await signedFixture();

    const tampered = { ...signed, phaseId: "2" };

    expect(verifyApprovalSignature(tampered).verified).toBe(false);
  });

  it("rejects a signature lifted onto a different approver", async () => {
    const { signed } = await signedFixture();

    const tampered = { ...signed, approver: "Someone else" };

    expect(verifyApprovalSignature(tampered).verified).toBe(false);
  });

  it("rejects a fingerprint that does not match the embedded key", async () => {
    const { signed } = await signedFixture();
    const extensions = signed.extensions as Record<string, unknown>;

    const tampered = {
      ...signed,
      extensions: {
        ...extensions,
        signature: {
          ...(extensions.signature as Record<string, unknown>),
          keyFingerprint: "e".repeat(64),
        },
      },
    };

    const result = verifyApprovalSignature(tampered);
    expect(result.verified).toBe(false);
    expect(result.reason).toContain("fingerprint");
  });

  it("rejects a record whose signature was removed", async () => {
    const { signed } = await signedFixture();
    const extensions = signed.extensions as Record<string, unknown>;
    const { signature: _removed, ...withoutSignature } = extensions;

    const result = verifyApprovalSignature({
      ...signed,
      extensions: withoutSignature,
    });

    expect(result).toEqual({
      verified: false,
      reason: "no signature is recorded",
    });
  });

  it("excludes only the signature from the signed payload", async () => {
    const { signed } = await signedFixture();
    const extensions = signed.extensions as Record<string, unknown>;

    const payload = signablePayload(signed).toString("utf8");

    expect(payload).not.toContain('"signature"');
    expect(payload).toContain('"approvalMode":"human-verified"');
    expect(payload).toContain(`"keyFingerprint":"${String(extensions.keyFingerprint)}"`);
    expect(payload).toContain('"decision":"APPROVED"');
  });

  it("survives formatting changes that do not change meaning", async () => {
    const home = await temporaryHome();
    const created = await createIdentity({
      label: "Accountable architect",
      passphrase,
      home,
    });
    const signed = signApproval(
      approvalRecord(schemaVersion),
      await readEncryptedPrivateKey(home),
      passphrase,
      created.publicKeyPem,
    );
    const file = path.join(home, "approval.json");
    await writeFile(file, JSON.stringify(signed, null, 4), "utf8");

    const reloaded: unknown = JSON.parse(await readFile(file, "utf8"));

    expect(
      verifyApprovalSignature(reloaded as Record<string, unknown>).verified,
    ).toBe(true);
  });

  it("keeps the private key out of the identity directory listing", async () => {
    const home = await temporaryHome();
    await createIdentity({ label: "Accountable architect", passphrase, home });

    expect(identityDirectory(home)).toContain(".aff");
  });
});
