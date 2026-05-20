import { NextResponse } from "next/server";
import { loadSampleInputs } from "../../../lib/pipeline/core.js";

export const runtime = "nodejs";

export async function GET() {
  try {
    const sample = await loadSampleInputs();
    return NextResponse.json(sample);
  } catch (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
