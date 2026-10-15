import path from "node:path";

import type { ValidationError } from "../types.js";
import type { LoadedRecord } from "./records.js";

export function validateRecordIdentity(
  caseRoot: string,
  records: LoadedRecord[],
): ValidationError[] {
  const expectedCaseName = path.basename(caseRoot);
  const identities = records.flatMap(({ file, value }) =>
    typeof value.caseName === "string" &&
    typeof value.artifactPrefix === "string"
      ? [{ file, recordType: value.recordType, caseName: value.caseName, artifactPrefix: value.artifactPrefix }]
      : [],
  ).sort((left, right) =>
    left.file.localeCompare(right.file) ||
    left.caseName.localeCompare(right.caseName) ||
    left.artifactPrefix.localeCompare(right.artifactPrefix),
  );
  const anchors = identities.filter(({ file, recordType }) =>
    (recordType === "input-inventory" || recordType === "model-plan") &&
    file.startsWith("0-coordination/") &&
    file.slice("0-coordination/".length).indexOf("/") === -1 &&
    file.endsWith(`-${recordType}.json`),
  );
  const prefixes = new Set(anchors.map(({ artifactPrefix }) => artifactPrefix));
  const trustworthy = anchors.length > 0 && prefixes.size === 1 &&
    anchors.every(({ file, recordType, caseName, artifactPrefix }) =>
      caseName === expectedCaseName &&
      file === `0-coordination/${artifactPrefix}-${recordType}.json`,
    );
  const expectedPrefix = trustworthy ? anchors[0]?.artifactPrefix : undefined;

  const errors = identities.flatMap(({ file, caseName, artifactPrefix }) => {
    const errors: ValidationError[] = [];
    if (caseName !== expectedCaseName) {
      errors.push({
        file,
        invariant: "case-record-identity",
        message: `Record caseName "${caseName}" differs from directory "${expectedCaseName}".`,
        remediation: "Use the immutable case directory name in every AFF record.",
      });
    }
    if (expectedPrefix && artifactPrefix !== expectedPrefix) {
      errors.push({
        file,
        invariant: "case-record-identity",
        message: `Record artifactPrefix "${artifactPrefix}" differs from "${expectedPrefix}".`,
        remediation: "Use the Phase 0 artifactPrefix consistently across the case.",
      });
    }
    return errors;
  });
  if (!trustworthy && identities.length > 0) {
    errors.push({
      file: "0-coordination",
      invariant: "case-record-identity",
      message: anchors.length === 0
        ? "Case artifactPrefix is ambiguous: no trustworthy canonical Phase 0 input-inventory or model-plan anchor is available."
        : `Case artifactPrefix is ambiguous: canonical Phase 0 identities do not agree (${anchors.map(({ file, caseName, artifactPrefix }) => `${file}: caseName="${caseName}", artifactPrefix="${artifactPrefix}"`).join("; ")}).`,
      remediation:
        "Establish the immutable case identity from correctly named Phase 0 input-inventory and model-plan records that agree; do not infer it from record order or a majority.",
    });
  }
  return errors;
}
