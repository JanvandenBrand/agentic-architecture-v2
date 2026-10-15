import { createPrivateKey, createPublicKey, sign, verify } from "node:crypto";

import { canonicalize } from "json-canonicalize";

import { isRecord } from "../common/json.js";
import { fingerprintPublicKey, IdentityError } from "./keys.js";

export const signatureAlgorithm = "ed25519";

export interface ApprovalSignature {
  algorithm: string;
  publicKeyPem: string;
  keyFingerprint: string;
  value: string;
}

export interface KeyRotationProof {
  previousKeyFingerprint: string;
  newKeyFingerprint: string;
  reason: string;
  algorithm: "ed25519";
  value: string;
}

/**
 * The signed payload is the canonical JSON of the whole approval record with
 * only `extensions.signature` removed. Signing the artifact hashes alone would
 * leave the verdict, phase, approver, and decision time unprotected, so a valid
 * signature could be lifted onto a modified record.
 */
export function signablePayload(record: Record<string, unknown>): Buffer {
  const extensions = isRecord(record.extensions)
    ? Object.fromEntries(
        Object.entries(record.extensions).filter(([key]) => key !== "signature"),
      )
    : undefined;
  const payload: Record<string, unknown> = {
    ...record,
    ...(extensions ? { extensions } : {}),
  };
  return Buffer.from(canonicalize(payload), "utf8");
}

export function readSignature(
  record: Record<string, unknown>,
): ApprovalSignature | undefined {
  if (!isRecord(record.extensions) || !isRecord(record.extensions.signature)) {
    return undefined;
  }
  const candidate = record.extensions.signature;
  if (
    typeof candidate.algorithm !== "string" ||
    typeof candidate.publicKeyPem !== "string" ||
    typeof candidate.keyFingerprint !== "string" ||
    typeof candidate.value !== "string"
  ) {
    return undefined;
  }
  return {
    algorithm: candidate.algorithm,
    publicKeyPem: candidate.publicKeyPem,
    keyFingerprint: candidate.keyFingerprint,
    value: candidate.value,
  };
}

export interface VerificationResult {
  verified: boolean;
  reason?: string;
}

export function verifyApprovalSignature(
  record: Record<string, unknown>,
): VerificationResult {
  const signature = readSignature(record);
  if (!signature) {
    return { verified: false, reason: "no signature is recorded" };
  }
  if (signature.algorithm !== signatureAlgorithm) {
    return {
      verified: false,
      reason: `algorithm "${signature.algorithm}" is not supported`,
    };
  }

  let publicKey: ReturnType<typeof createPublicKey>;
  try {
    publicKey = createPublicKey(signature.publicKeyPem);
  } catch {
    return { verified: false, reason: "the embedded public key is unreadable" };
  }

  let actualFingerprint: string;
  try {
    actualFingerprint = fingerprintPublicKey(signature.publicKeyPem);
  } catch {
    return { verified: false, reason: "the embedded public key is unreadable" };
  }
  if (actualFingerprint !== signature.keyFingerprint) {
    return {
      verified: false,
      reason: "the recorded fingerprint does not match the embedded public key",
    };
  }

  let signatureBytes: Buffer;
  try {
    signatureBytes = Buffer.from(signature.value, "base64");
  } catch {
    return { verified: false, reason: "the signature is not valid base64" };
  }

  let valid = false;
  try {
    valid = publicKey.asymmetricKeyType === signatureAlgorithm &&
      verify(null, signablePayload(record), publicKey, signatureBytes);
  } catch {
    return { verified: false, reason: "the signature cannot be verified" };
  }
  return valid
    ? { verified: true }
    : { verified: false, reason: "the signature does not match the record" };
}

function rotationPayload(
  record: Record<string, unknown>,
  rotation: Omit<KeyRotationProof, "value">,
): Buffer {
  const extensions = isRecord(record.extensions) ? record.extensions : {};
  // The predecessor authorises the complete new decision, including both key
  // identities and case identity, but not either signature's circular bytes.
  const decision = JSON.parse(signablePayload({
    ...record,
    extensions: {
      ...extensions,
      keyRotation: rotation,
    },
  }).toString("utf8")) as Record<string, unknown>;
  return Buffer.from(canonicalize({
    domain: "AFF-APPROVAL-KEY-ROTATION-v1",
    decision,
  }), "utf8");
}

export function signKeyRotation(
  record: Record<string, unknown>,
  previousEncryptedPrivateKeyPem: string,
  passphrase: string,
  previousPublicKeyPem: string,
  newPublicKeyPem: string,
  reason: string,
): KeyRotationProof {
  const rotation: Omit<KeyRotationProof, "value"> = {
    previousKeyFingerprint: fingerprintPublicKey(previousPublicKeyPem),
    newKeyFingerprint: fingerprintPublicKey(newPublicKeyPem),
    reason,
    algorithm: signatureAlgorithm,
  };
  const privateKey = unlockPrivateKey(previousEncryptedPrivateKeyPem, passphrase);
  assertKeyPair(privateKey, previousPublicKeyPem);
  const extensions = isRecord(record.extensions) ? record.extensions : {};
  const finalPayload = {
    ...record,
    extensions: {
      ...extensions,
      approvalMode: "human-verified",
      keyFingerprint: rotation.newKeyFingerprint,
    },
  };
  return {
    ...rotation,
    value: sign(null, rotationPayload(finalPayload, rotation), privateKey).toString("base64"),
  };
}

export function verifyKeyRotation(
  record: Record<string, unknown>,
  previousPublicKeyPem: string,
  newPublicKeyPem: string,
): VerificationResult {
  const rotation = isRecord(record.extensions) ? record.extensions.keyRotation : undefined;
  if (
    !isRecord(rotation) ||
    typeof rotation.previousKeyFingerprint !== "string" ||
    !/^[0-9a-f]{64}$/u.test(rotation.previousKeyFingerprint) ||
    typeof rotation.newKeyFingerprint !== "string" ||
    !/^[0-9a-f]{64}$/u.test(rotation.newKeyFingerprint) ||
    typeof rotation.reason !== "string" || rotation.reason.trim() === "" ||
    rotation.algorithm !== signatureAlgorithm ||
    typeof rotation.value !== "string" ||
    !/^[A-Za-z0-9+/]{86}==$/u.test(rotation.value) ||
    Object.keys(rotation).some((key) =>
      !["previousKeyFingerprint", "newKeyFingerprint", "reason", "algorithm", "value"].includes(key))
  ) {
    return { verified: false, reason: "key rotation requires a well-formed predecessor countersignature and non-empty reason" };
  }
  try {
    if (
      rotation.previousKeyFingerprint !== fingerprintPublicKey(previousPublicKeyPem) ||
      rotation.newKeyFingerprint !== fingerprintPublicKey(newPublicKeyPem) ||
      rotation.previousKeyFingerprint === rotation.newKeyFingerprint
    ) {
      return { verified: false, reason: "key rotation does not bind the established previous key to the new key" };
    }
    const previousKey = createPublicKey(previousPublicKeyPem);
    const valid = previousKey.asymmetricKeyType === signatureAlgorithm && verify(
      null,
      rotationPayload(record, {
        previousKeyFingerprint: rotation.previousKeyFingerprint,
        newKeyFingerprint: rotation.newKeyFingerprint,
        reason: rotation.reason,
        algorithm: rotation.algorithm,
      }),
      previousKey,
      Buffer.from(rotation.value, "base64"),
    );
    return valid
      ? { verified: true }
      : { verified: false, reason: "the established previous key did not countersign this exact case decision and key transition" };
  } catch {
    return { verified: false, reason: "the key rotation countersignature cannot be verified" };
  }
}

/** A missing predecessor can establish only the original trust anchor, never a rotation. */
export function verifyKeyTransition(
  record: Record<string, unknown>,
  newPublicKeyPem: string,
  previousPublicKeyPem?: string,
): VerificationResult {
  try {
    if (createPublicKey(newPublicKeyPem).asymmetricKeyType !== signatureAlgorithm ||
        (previousPublicKeyPem && createPublicKey(previousPublicKeyPem).asymmetricKeyType !== signatureAlgorithm)) {
      return { verified: false, reason: "approval key transitions require Ed25519 public keys" };
    }
  } catch {
    return { verified: false, reason: "the approval public key is unreadable" };
  }
  const hasRotation = isRecord(record.extensions) && "keyRotation" in record.extensions;
  if (!previousPublicKeyPem || fingerprintPublicKey(previousPublicKeyPem) === fingerprintPublicKey(newPublicKeyPem)) {
    return hasRotation
      ? { verified: false, reason: "key rotation has no different established predecessor key" }
      : { verified: true };
  }
  return verifyKeyRotation(record, previousPublicKeyPem, newPublicKeyPem);
}

function unlockPrivateKey(encryptedPrivateKeyPem: string, passphrase: string): ReturnType<typeof createPrivateKey> {
  try {
    return createPrivateKey({ key: encryptedPrivateKeyPem, passphrase });
  } catch {
    throw new IdentityError(
      "The approval key could not be unlocked with that passphrase.",
      "Re-enter the passphrase. It is never stored, so it cannot be recovered or reset.",
    );
  }
}

function assertKeyPair(privateKey: ReturnType<typeof createPrivateKey>, publicKeyPem: string): void {
  const derived = createPublicKey(privateKey).export({ type: "spki", format: "pem" }).toString();
  if (privateKey.asymmetricKeyType !== signatureAlgorithm ||
      fingerprintPublicKey(derived) !== fingerprintPublicKey(publicKeyPem)) {
    throw new IdentityError(
      "The approval private key does not match the presented Ed25519 identity.",
      "Restore the matching identity; do not sign with a substituted key.",
    );
  }
}

export function signApproval(
  record: Record<string, unknown>,
  encryptedPrivateKeyPem: string,
  passphrase: string,
  publicKeyPem: string,
): Record<string, unknown> {
  const privateKey = unlockPrivateKey(encryptedPrivateKeyPem, passphrase);
  assertKeyPair(privateKey, publicKeyPem);

  const fingerprint = fingerprintPublicKey(publicKeyPem);
  const extensions = isRecord(record.extensions) ? record.extensions : {};
  const unsigned: Record<string, unknown> = {
    ...record,
    extensions: {
      ...extensions,
      approvalMode: "human-verified",
      keyFingerprint: fingerprint,
    },
  };

  const value = sign(null, signablePayload(unsigned), privateKey).toString(
    "base64",
  );

  return {
    ...unsigned,
    extensions: {
      ...(unsigned.extensions as Record<string, unknown>),
      signature: {
        algorithm: signatureAlgorithm,
        publicKeyPem,
        keyFingerprint: fingerprint,
        value,
      },
    },
  };
}
