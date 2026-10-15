#!/usr/bin/env node

import path from "node:path";
import { pathToFileURL } from "node:url";

import { Command, CommanderError } from "commander";

import { readLine, readSecret } from "../identity/prompt.js";
import {
  ApproveError,
  assertDecisionReady,
  prepareApproval,
  recordSignedDecision,
  type ApprovalContext,
} from "./prepare.js";

interface ApproveOptions {
  case: string;
  phase: string;
  root: string;
}

function presentEvidence(context: ApprovalContext): void {
  console.log(`\nPhase ${context.phaseId} — ${context.caseName}`);
  console.log(`\nArtefacts (${context.artifacts.length})`);
  for (const artifact of context.artifacts) {
    console.log(`  ${artifact.path}`);
    console.log(`    sha256 ${artifact.sha256}`);
  }
  console.log("\nFinal reviews");
  for (const verdict of context.verdicts) {
    console.log(
      `  ${verdict.reviewer}  round ${verdict.round}  ${verdict.verdict}`,
    );
  }
  console.log("\nReviewer records");
  for (const binding of context.reviewBindings) {
    console.log(`  ${binding.path}`);
  }
  console.log(
    `\nBoth reviewers cover the identical ${context.artifacts.length} artefact hashes.`,
  );
  if (context.verdicts.some(({ verdict }) => verdict === "DIVERGES")) {
    console.log("\nDIVERGES: approval is blocked. Only rejection or cancellation is available.");
  }
  console.log(`\nApprover  ${context.approverLabel}`);
  console.log(`Key       ${context.keyFingerprint}`);
}

export async function runApproveCli(argv: string[]): Promise<number> {
  const program = new Command();
  program
    .name("aff-approve")
    .description(
      "Record a signed human decision for one phase. Run this yourself, never through an agent.",
    )
    .requiredOption("--case <path>", "case beneath cases/<case-name>")
    .requiredOption("--phase <id>", "phase identifier")
    .option("--root <path>", "repository root", process.cwd())
    .exitOverride();

  try {
    program.parse(argv);
  } catch (error: unknown) {
    if (error instanceof CommanderError) {
      return error.exitCode === 0 ? 0 : 64;
    }
    throw error;
  }

  const options = program.opts<ApproveOptions>();

  try {
    const context = await prepareApproval({
      repositoryRoot: path.resolve(options.root),
      casePath: options.case,
      phaseId: options.phase,
    });
    presentEvidence(context);

    const answer = (
      await readLine("\nApprove, reject, or cancel? ")
    )
      .trim()
      .toLowerCase();
    if (answer !== "approve" && answer !== "reject") {
      console.log("Cancelled. No decision was recorded.");
      return 0;
    }

    const gapsAnswer = (
      await readLine(
        "Residual gaps you accept (semicolon separated, blank for none): ",
      )
    ).trim();
    const residualGapAcceptance =
      gapsAnswer === ""
        ? []
        : gapsAnswer
            .split(";")
            .map((entry) => entry.trim())
            .filter((entry) => entry !== "");

    const decidedAt = new Date().toISOString();
    const decision = answer === "approve" ? "APPROVED" : "REJECTED";
    await assertDecisionReady({ context, decision, decidedAt, residualGapAcceptance });
    const passphrase = await readSecret("Passphrase: ");
    const written = await recordSignedDecision({
      context,
      decision,
      decidedAt,
      passphrase,
      residualGapAcceptance,
    });

    console.log(
      `\nSigned ${answer === "approve" ? "approval" : "rejection"} written to ${written.file}`,
    );
    console.log(`Signed by ${context.approverLabel} (${written.keyFingerprint})`);
    console.log(
      "\nRun the validator to confirm the case still holds before continuing.",
    );
    return 0;
  } catch (error: unknown) {
    if (error instanceof ApproveError) {
      console.error(`ERROR [approve] ${error.message}`);
      return 1;
    }
    if (error instanceof Error) {
      console.error(`FATAL: ${error.message}`);
      return 2;
    }
    throw error;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runApproveCli(process.argv)
    .then((exitCode) => {
      process.exitCode = exitCode;
    })
    .catch((error: unknown) => {
      console.error(
        `FATAL: ${error instanceof Error ? error.message : String(error)}`,
      );
      process.exitCode = 2;
    });
}
