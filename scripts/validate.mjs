import { finalizePipeline, loadSampleInputs, runPipelineUntilReview, writeArtifactsToDisk } from "../lib/pipeline/core.js";

async function main() {
  if (!process.env.GROQ_API_KEY) {
    throw new Error("GROQ_API_KEY is required to run npm run validate.");
  }

  const sample = await loadSampleInputs(process.cwd());
  const runResult = await runPipelineUntilReview(sample);
  const finalResult = finalizePipeline({
    ticketsText: sample.ticketsText,
    policyText: sample.policyText,
    artifacts: {
      ...runResult.artifacts,
      expect_disk_inputs: true,
    },
    overrides: {},
    stageHistory: runResult.stageHistory,
  });

  await writeArtifactsToDisk(finalResult.artifactFiles, process.cwd());

  if (!finalResult.validation.ok) {
    throw new Error(finalResult.validation.errors.join("\n"));
  }

  console.log("Validation passed. Artifacts were regenerated from tickets.json and policy.json.");
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
