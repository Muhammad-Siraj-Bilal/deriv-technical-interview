import { NextResponse } from "next/server";
import { finalizePipeline } from "../../../../lib/pipeline/core.js";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function POST(request) {
  try {
    const body = await request.json();
    const result = finalizePipeline({
      ticketsText: body.ticketsText,
      policyText: body.policyText,
      artifacts: body.artifacts,
      overrides: body.overrides || {},
      stageHistory: body.stageHistory || [],
    });

    return NextResponse.json(result);
  } catch (error) {
    return NextResponse.json({ error: error.message }, { status: 400 });
  }
}
