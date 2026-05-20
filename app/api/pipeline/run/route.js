import { NextResponse } from "next/server";
import { runPipelineUntilReview } from "../../../../lib/pipeline/core.js";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function POST(request) {
  try {
    const body = await request.json();
    const result = await runPipelineUntilReview({
      ticketsText: body.ticketsText,
      policyText: body.policyText,
      source: body.source || "upload",
      sourceFiles: body.sourceFiles || [],
    });

    return NextResponse.json(result);
  } catch (error) {
    return NextResponse.json({ error: error.message }, { status: 400 });
  }
}
