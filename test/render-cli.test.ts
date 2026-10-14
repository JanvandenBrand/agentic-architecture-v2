import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { runRenderCli } from "../src/render/cli.js";
import { hashArtifact } from "../src/case/hash.js";

const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("aff-render CLI", () => {
  it.each(["1.0.0", "1.1.0"])("renders partial %s metadata using repository-relative case arguments", async (schemaVersion) => {
    const root = await mkdtemp(path.join(tmpdir(), "aff-render-cli-"));
    temporaryDirectories.push(root);
    const phaseRoot = path.join(root, "cases", "sample", "0-coordination");
    await mkdir(phaseRoot, { recursive: true });
    await cp(path.join(projectRoot, "schemas"), path.join(root, "schemas"), {
      recursive: true,
    });
    const sourcePath = path.join(phaseRoot, "sample-coordination.md");
    await writeFile(
      sourcePath,
      "# Phase 0\n\nSafe content.\n",
    );
    await writeFile(
      path.join(phaseRoot, "sample-input-inventory.json"),
      `${JSON.stringify({
        schemaVersion,
        recordType: "input-inventory",
        caseName: "sample",
        artifactPrefix: "sample",
        sources: [
          {
            sourcePath: "0-coordination/sample-coordination.md",
            governedArtifact: {
              path: "0-coordination/sample-coordination.md",
              sha256: await hashArtifact(sourcePath),
            },
            readable: true,
          },
        ],
      })}\n`,
    );

    const exitCode = await runRenderCli([
      "node",
      "aff-render",
      "phase",
      "--root",
      root,
      "--case",
      "cases/sample",
      "--phase",
      "0",
      "--source",
      "0-coordination/sample-coordination.md",
      "--output",
      "0-coordination/sample-coordination.html",
      "--metadata",
      "0-coordination/sample-input-inventory.json",
    ]);

    expect(exitCode).toBe(0);
    expect(
      await readFile(
        path.join(phaseRoot, "sample-coordination.html"),
        "utf8",
      ),
    ).toContain("AFF generated view");
  });
});
