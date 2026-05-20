import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

export const PIPELINE_STAGES = [
  "INIT",
  "INPUTS_LOADED",
  "DRAFT_REPLIES_GENERATED",
  "DETERMINISTIC_CHECKS_COMPLETE",
  "LLM_REVIEW_COMPLETE",
  "HUMAN_OVERRIDE_COMPLETE",
  "FINAL_ROUTING_DECIDED",
  "REPORT_GENERATED",
  "VALIDATION_COMPLETE",
  "RESULTS_FINALISED",
];

const GROQ_MODEL = "llama-3.3-70b-versatile";
const POLICY_RISKS = new Set(["low", "medium", "high"]);

export async function loadSampleInputs(rootDir = process.cwd()) {
  const ticketsPath = path.join(rootDir, "tickets.json");
  const policyPath = path.join(rootDir, "policy.json");
  const [ticketsText, policyText] = await Promise.all([
    fs.readFile(ticketsPath, "utf8"),
    fs.readFile(policyPath, "utf8"),
  ]);

  return {
    ticketsText,
    policyText,
    source: "disk",
    sourceFiles: [ticketsPath, policyPath],
  };
}

export function parseInputs({ ticketsText, policyText, source = "upload", sourceFiles = [] }) {
  const tickets = JSON.parse(ticketsText);
  const policy = JSON.parse(policyText);
  validateInputShapes(tickets, policy);

  const normalizedTickets = tickets.map((ticket) => normalizeTicket(ticket, policy.allowed_issue_types));

  return {
    tickets,
    policy,
    normalizedTickets,
    inputMeta: {
      source,
      sourceFiles,
      ticketsReadFromDisk: source === "disk",
      policyReadFromDisk: source === "disk",
    },
  };
}

function validateInputShapes(tickets, policy) {
  if (!Array.isArray(tickets) || tickets.length === 0) {
    throw new Error("tickets.json must contain a non-empty array.");
  }

  if (!policy || typeof policy !== "object") {
    throw new Error("policy.json must contain an object.");
  }

  const requiredPolicyKeys = [
    "allowed_issue_types",
    "required_reply_sections",
    "forbidden_claims",
    "routing_rules",
    "quality_rubric",
  ];

  for (const key of requiredPolicyKeys) {
    if (!(key in policy)) {
      throw new Error(`policy.json is missing required key "${key}".`);
    }
  }

  if (!Array.isArray(policy.allowed_issue_types) || policy.allowed_issue_types.length === 0) {
    throw new Error("policy.allowed_issue_types must be a non-empty array.");
  }

  if (!Array.isArray(policy.required_reply_sections) || policy.required_reply_sections.length === 0) {
    throw new Error("policy.required_reply_sections must be a non-empty array.");
  }

  if (!Array.isArray(policy.forbidden_claims)) {
    throw new Error("policy.forbidden_claims must be an array.");
  }

  if (!policy.routing_rules || typeof policy.routing_rules !== "object") {
    throw new Error("policy.routing_rules must be an object.");
  }

  if (!policy.quality_rubric || typeof policy.quality_rubric !== "object") {
    throw new Error("policy.quality_rubric must be an object.");
  }
}

function normalizeTicket(ticket, allowedIssueTypes) {
  const requiredTicketKeys = ["ticket_id", "customer_tone", "issue_type", "customer_message"];
  for (const key of requiredTicketKeys) {
    if (!ticket || typeof ticket[key] !== "string" || ticket[key].trim() === "") {
      throw new Error(`Every ticket must include a non-empty string "${key}".`);
    }
  }

  if (!allowedIssueTypes.includes(ticket.issue_type)) {
    throw new Error(`Ticket ${ticket.ticket_id} has unsupported issue_type "${ticket.issue_type}".`);
  }

  const context = ticket.account_context && typeof ticket.account_context === "object" ? ticket.account_context : {};

  return {
    ticket_id: ticket.ticket_id,
    customer_tone: ticket.customer_tone,
    issue_type: ticket.issue_type,
    customer_message: ticket.customer_message,
    account_context: {
      kyc_status: context.kyc_status ?? null,
      withdrawal_status: context.withdrawal_status ?? null,
      hours_since_request: context.hours_since_request ?? null,
    },
  };
}

export function createStageHistory() {
  return ["INIT"];
}

export function advanceStage(stageHistory, nextStage) {
  const current = stageHistory[stageHistory.length - 1];
  const currentIndex = PIPELINE_STAGES.indexOf(current);
  const nextIndex = PIPELINE_STAGES.indexOf(nextStage);

  if (nextIndex === -1) {
    throw new Error(`Unknown pipeline stage "${nextStage}".`);
  }

  if (nextIndex !== currentIndex + 1) {
    throw new Error(`Invalid stage transition from ${current} to ${nextStage}.`);
  }

  stageHistory.push(nextStage);
}

export function extractReplySections(replyText, requiredSections) {
  return requiredSections.filter((section) => {
    const escaped = section.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const patterns = [
      new RegExp(`^\\s*${escaped}\\s*:`, "im"),
      new RegExp(`^\\s*\\[${escaped}\\]\\s*$`, "im"),
    ];
    return patterns.some((pattern) => pattern.test(replyText));
  });
}

export function runDeterministicChecks(ticket, replyText, policy) {
  const failedChecks = [];
  const sectionsPresent = extractReplySections(replyText, policy.required_reply_sections);
  if (sectionsPresent.length !== policy.required_reply_sections.length) {
    failedChecks.push("missing_required_reply_sections");
  }

  if (/(full password|entire password|complete password)/i.test(replyText) || /send .*password/i.test(replyText)) {
    failedChecks.push("requests_full_password");
  }

  if (/(guarantee|guaranteed|i promise|will arrive today|approved today|within \d+ (hours|days)|by \d{1,2}(:\d{2})? ?(am|pm)?)/i.test(replyText)) {
    failedChecks.push("guaranteed_timeline_claim");
  }

  const withdrawalReleased = ticket.account_context?.withdrawal_status === "released";
  if (!withdrawalReleased && /(funds? (are|have been)? ?released|money (is|has been) on the way|withdrawal has been sent)/i.test(replyText)) {
    failedChecks.push("unsupported_funds_released_claim");
  }

  if (/(your fault|you should have|you failed to|calm down|that's not our problem|as already explained|obviously)/i.test(replyText)) {
    failedChecks.push("blaming_or_dismissive_language");
  }

  const uniqueFailures = [...new Set(failedChecks)];
  const deterministicScore = Math.max(0, 100 - uniqueFailures.length * 20 - (sectionsPresent.length !== policy.required_reply_sections.length ? 10 : 0));

  return {
    ticket_id: ticket.ticket_id,
    passed: uniqueFailures.length === 0,
    failed_checks: uniqueFailures,
    must_human_review: uniqueFailures.length > 0,
    deterministic_score: deterministicScore,
  };
}

function buildDraftPrompt(ticket, policy) {
  return [
    "You are drafting a customer-support reply for internal review only.",
    "Return plain text only.",
    "Use these exact section labels followed by a colon on their own lines:",
    policy.required_reply_sections.map((section) => `${section}:`).join("\n"),
    "Ticket data:",
    JSON.stringify(ticket, null, 2),
    "Policy constraints:",
    JSON.stringify(
      {
        required_reply_sections: policy.required_reply_sections,
        forbidden_claims: policy.forbidden_claims,
      },
      null,
      2,
    ),
    "Instructions:",
    "- Be empathetic, concise, and actionable.",
    "- Do not ask for full passwords or any unsafe secrets.",
    "- Do not make unsupported promises or guaranteed timelines.",
    "- Do not claim funds are released unless the account context explicitly says released.",
    "- Frame the message as a draft support reply, not a guaranteed operational outcome.",
  ].join("\n\n");
}

function buildRepairPrompt(ticket, policy, draftReply, failedChecks) {
  return [
    "You are repairing a customer-support draft reply that failed deterministic checks.",
    "Return plain text only.",
    "Keep the same customer issue and preserve empathy.",
    "Use these exact section labels followed by a colon on their own lines:",
    policy.required_reply_sections.map((section) => `${section}:`).join("\n"),
    "Ticket data:",
    JSON.stringify(ticket, null, 2),
    "Original reply:",
    draftReply,
    "Failed checks to fix:",
    JSON.stringify(failedChecks, null, 2),
    "Forbidden claims:",
    JSON.stringify(policy.forbidden_claims, null, 2),
    "Instructions:",
    "- Remove unsafe requests.",
    "- Remove guaranteed timelines.",
    "- Avoid unsupported account promises.",
    "- Keep the result suitable for internal support review.",
  ].join("\n\n");
}

function buildReviewPrompt(ticket, draftReply, policy, deterministicCheck) {
  return [
    "You are reviewing a drafted customer-support reply.",
    "Return a JSON object only with keys: quality_rating, policy_risk, review_summary, suggested_fix.",
    'policy_risk must be exactly one of: "low", "medium", "high".',
    "quality_rating must be an integer from 1 to 5.",
    "Original ticket:",
    JSON.stringify(ticket, null, 2),
    "Draft reply under review:",
    draftReply,
    "Policy constraints:",
    JSON.stringify(
      {
        forbidden_claims: policy.forbidden_claims,
        required_reply_sections: policy.required_reply_sections,
        routing_rules: policy.routing_rules,
        quality_rubric: policy.quality_rubric,
      },
      null,
      2,
    ),
    "Deterministic check results:",
    JSON.stringify(deterministicCheck, null, 2),
    "Review focus:",
    "- Helpfulness",
    "- Policy safety",
    "- Tone handling",
    "- Actionability",
  ].join("\n\n");
}

async function callGroq({ stage, ticketId, prompt, inputArtifacts, outputArtifact }) {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) {
    throw new Error("GROQ_API_KEY is required for generation and review calls.");
  }

  const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: GROQ_MODEL,
      temperature: 0.2,
      messages: [
        {
          role: "system",
          content: "You are a careful customer-support evaluation assistant.",
        },
        {
          role: "user",
          content: prompt,
        },
      ],
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Groq request failed for ${stage} (${ticketId}): ${response.status} ${body}`);
  }

  const data = await response.json();
  const content = data?.choices?.[0]?.message?.content;
  if (!content) {
    throw new Error(`Groq returned an empty response for ${stage} (${ticketId}).`);
  }

  return {
    text: content.trim(),
    log: {
      stage,
      ticket_id: ticketId,
      timestamp: new Date().toISOString(),
      provider: "groq",
      model: GROQ_MODEL,
      prompt_hash: crypto.createHash("sha256").update(prompt).digest("hex"),
      input_artifacts: inputArtifacts,
      output_artifact: outputArtifact,
    },
  };
}

function parseReviewJson(text, ticketId) {
  const jsonBlockMatch = text.match(/\{[\s\S]*\}/);
  const candidate = jsonBlockMatch ? jsonBlockMatch[0] : text;
  const parsed = JSON.parse(candidate);
  const quality = Number(parsed.quality_rating);
  const risk = String(parsed.policy_risk || "").toLowerCase();

  if (!Number.isInteger(quality) || quality < 1 || quality > 5) {
    throw new Error(`Invalid quality_rating for ticket ${ticketId}.`);
  }

  if (!POLICY_RISKS.has(risk)) {
    throw new Error(`Invalid policy_risk for ticket ${ticketId}.`);
  }

  return {
    ticket_id: ticketId,
    quality_rating: quality,
    policy_risk: risk,
    review_summary: String(parsed.review_summary || "").trim(),
    suggested_fix: String(parsed.suggested_fix || "").trim(),
  };
}

export function computeInitialRoute(ticket, check, review) {
  if (!check.passed) {
    return {
      route: "human_review",
      reason: `Deterministic checks failed: ${check.failed_checks.join(", ") || "unknown failure"}.`,
    };
  }

  if (ticket.customer_tone === "angry") {
    return {
      route: "human_review",
      reason: "Customer tone is angry.",
    };
  }

  if (ticket.issue_type === "bonus_dispute") {
    return {
      route: "human_review",
      reason: "Bonus disputes require human review.",
    };
  }

  if (review.policy_risk === "high") {
    return {
      route: "human_review",
      reason: "LLM review flagged high policy risk.",
    };
  }

  if (review.quality_rating < 3) {
    return {
      route: "human_review",
      reason: `LLM quality rating is below threshold (${review.quality_rating}/5).`,
    };
  }

  if (review.policy_risk === "medium" && check.deterministic_score < 90) {
    return {
      route: "human_review",
      reason: "Medium policy risk combined with a weaker deterministic score.",
    };
  }

  return {
    route: "auto_send",
    reason: "Draft is policy-compliant, strong enough, and not flagged by routing rules.",
  };
}

function buildReport(finalDecisions, metrics, checks, reviews) {
  const autoSend = finalDecisions.filter((item) => item.final_route === "auto_send");
  const humanReview = finalDecisions.filter((item) => item.final_route === "human_review");
  const failureCounts = new Map();

  for (const check of checks) {
    for (const failure of check.failed_checks) {
      failureCounts.set(failure, (failureCounts.get(failure) || 0) + 1);
    }
  }

  const reviewByTicket = new Map(reviews.map((review) => [review.ticket_id, review]));

  const renderTicketLine = (decision) => {
    const review = reviewByTicket.get(decision.ticket_id);
    return `- ${decision.ticket_id}: ${decision.decision_reason} Risk=${decision.policy_risk}, quality=${decision.quality_rating}/5. ${review?.review_summary || ""}`.trim();
  };

  const failureLines =
    failureCounts.size === 0
      ? ["- No deterministic failure patterns were observed in this run."]
      : [...failureCounts.entries()]
          .sort((a, b) => b[1] - a[1])
          .map(([failure, count]) => `- ${failure}: ${count} ticket(s).`);

  return [
    "# Evaluation Report",
    "",
    "## Summary",
    `- Total tickets: ${metrics.total_tickets}`,
    `- Auto-send count: ${metrics.auto_send_count}`,
    `- Human review count: ${metrics.human_review_count}`,
    `- Deterministic pass rate: ${metrics.deterministic_pass_rate}`,
    `- Average quality rating: ${metrics.average_quality_rating}`,
    "",
    "## Auto-send Candidates",
    ...(autoSend.length ? autoSend.map(renderTicketLine) : ["- None."]),
    "",
    "## Human Review Required",
    ...(humanReview.length ? humanReview.map(renderTicketLine) : ["- None."]),
    "",
    "## Common Failure Patterns",
    ...failureLines,
    "",
    "## Improvement Suggestions",
    "- Tighten the draft prompt around exact section labels so section detection remains stable.",
    "- Add stronger issue-type templates for password reset and account verification to reduce repair volume.",
    "- Route medium-risk replies to a second human pass when business sensitivity is high.",
  ].join("\n");
}

function buildMetrics(finalDecisions) {
  const totalTickets = finalDecisions.length;
  const autoSendCount = finalDecisions.filter((item) => item.final_route === "auto_send").length;
  const humanReviewCount = finalDecisions.filter((item) => item.final_route === "human_review").length;
  const deterministicPassed = finalDecisions.filter((item) => item.deterministic_passed).length;
  const averageQualityRating =
    totalTickets === 0
      ? 0
      : Number(
          (
            finalDecisions.reduce((sum, item) => sum + item.quality_rating, 0) / totalTickets
          ).toFixed(2),
        );

  return {
    total_tickets: totalTickets,
    auto_send_count: autoSendCount,
    human_review_count: humanReviewCount,
    deterministic_pass_rate: totalTickets === 0 ? 0 : Number((deterministicPassed / totalTickets).toFixed(2)),
    average_quality_rating: averageQualityRating,
  };
}

export async function runPipelineUntilReview(inputPayload) {
  const { tickets, policy, normalizedTickets, inputMeta } = parseInputs(inputPayload);
  const stageHistory = createStageHistory();
  advanceStage(stageHistory, "INPUTS_LOADED");

  const llmCallLogs = [];
  const drafts = [];

  for (const ticket of normalizedTickets) {
    const prompt = buildDraftPrompt(ticket, policy);
    const result = await callGroq({
      stage: "DRAFT_GENERATION",
      ticketId: ticket.ticket_id,
      prompt,
      inputArtifacts: ["tickets.json", "policy.json", "normalized_tickets.json"],
      outputArtifact: "draft_replies.json",
    });

    llmCallLogs.push(result.log);
    drafts.push({
      ticket_id: ticket.ticket_id,
      reply_text: result.text,
      reply_sections_present: extractReplySections(result.text, policy.required_reply_sections),
    });
  }

  advanceStage(stageHistory, "DRAFT_REPLIES_GENERATED");

  const checks = normalizedTickets.map((ticket) => {
    const draft = drafts.find((item) => item.ticket_id === ticket.ticket_id);
    return runDeterministicChecks(ticket, draft.reply_text, policy);
  });

  advanceStage(stageHistory, "DETERMINISTIC_CHECKS_COMPLETE");

  const repairedReplies = [];
  const effectiveDrafts = new Map(drafts.map((draft) => [draft.ticket_id, draft]));

  for (const check of checks.filter((item) => !item.passed)) {
    const ticket = normalizedTickets.find((item) => item.ticket_id === check.ticket_id);
    const originalDraft = drafts.find((item) => item.ticket_id === check.ticket_id);
    const prompt = buildRepairPrompt(ticket, policy, originalDraft.reply_text, check.failed_checks);
    const result = await callGroq({
      stage: "LLM_REPAIR",
      ticketId: ticket.ticket_id,
      prompt,
      inputArtifacts: ["draft_replies.json", "policy_checks.json", "policy.json"],
      outputArtifact: "repaired_replies.json",
    });

    llmCallLogs.push(result.log);
    const repaired = {
      ticket_id: ticket.ticket_id,
      reply_text: result.text,
      reply_sections_present: extractReplySections(result.text, policy.required_reply_sections),
      original_failed_checks: check.failed_checks,
    };
    repairedReplies.push(repaired);
    effectiveDrafts.set(ticket.ticket_id, repaired);
  }

  const reviews = [];
  for (const ticket of normalizedTickets) {
    const effectiveDraft = effectiveDrafts.get(ticket.ticket_id);
    const check = checks.find((item) => item.ticket_id === ticket.ticket_id);
    const prompt = buildReviewPrompt(ticket, effectiveDraft.reply_text, policy, check);
    const result = await callGroq({
      stage: "LLM_REVIEW",
      ticketId: ticket.ticket_id,
      prompt,
      inputArtifacts: ["draft_replies.json", "policy_checks.json", "policy.json"],
      outputArtifact: "llm_review.json",
    });

    llmCallLogs.push(result.log);
    reviews.push(parseReviewJson(result.text, ticket.ticket_id));
  }

  advanceStage(stageHistory, "LLM_REVIEW_COMPLETE");

  const currentRecommendations = normalizedTickets.map((ticket) => {
    const check = checks.find((item) => item.ticket_id === ticket.ticket_id);
    const review = reviews.find((item) => item.ticket_id === ticket.ticket_id);
    const initial = computeInitialRoute(ticket, check, review);
    return {
      ticket_id: ticket.ticket_id,
      deterministic_passed: check.passed,
      quality_rating: review.quality_rating,
      current_route_recommendation: initial.route,
      current_reason: initial.reason,
    };
  });

  return {
    stageHistory,
    artifacts: {
      normalized_tickets: normalizedTickets,
      draft_replies: drafts,
      policy_checks: checks,
      repaired_replies: repairedReplies,
      llm_review: reviews,
      llm_calls: llmCallLogs,
      current_recommendations: currentRecommendations,
      input_meta: inputMeta,
    },
  };
}

export function finalizePipeline({ ticketsText, policyText, artifacts, overrides = {}, stageHistory }) {
  const { normalizedTickets } = parseInputs({
    ticketsText,
    policyText,
    source: artifacts.input_meta?.source || "upload",
    sourceFiles: artifacts.input_meta?.sourceFiles || [],
  });

  const finalStageHistory = [...stageHistory];
  advanceStage(finalStageHistory, "HUMAN_OVERRIDE_COMPLETE");

  const effectiveDrafts = new Map(artifacts.draft_replies.map((draft) => [draft.ticket_id, draft]));
  for (const repaired of artifacts.repaired_replies || []) {
    effectiveDrafts.set(repaired.ticket_id, repaired);
  }

  const finalDecisions = normalizedTickets.map((ticket) => {
    const check = artifacts.policy_checks.find((item) => item.ticket_id === ticket.ticket_id);
    const review = artifacts.llm_review.find((item) => item.ticket_id === ticket.ticket_id);
    const draft = effectiveDrafts.get(ticket.ticket_id);
    const initial = computeInitialRoute(ticket, check, review);
    const finalRoute = overrides[ticket.ticket_id] || initial.route;
    const overrideApplied = overrides[ticket.ticket_id] && overrides[ticket.ticket_id] !== initial.route;

    return {
      ticket_id: ticket.ticket_id,
      draft_reply: draft.reply_text,
      deterministic_passed: check.passed,
      quality_rating: review.quality_rating,
      policy_risk: review.policy_risk,
      initial_route: initial.route,
      final_route: finalRoute,
      decision_reason: overrideApplied
        ? `Human override changed route from ${initial.route} to ${finalRoute}.`
        : initial.reason,
    };
  });

  advanceStage(finalStageHistory, "FINAL_ROUTING_DECIDED");

  const metrics = buildMetrics(finalDecisions);
  const report = buildReport(finalDecisions, metrics, artifacts.policy_checks, artifacts.llm_review);
  advanceStage(finalStageHistory, "REPORT_GENERATED");

  const artifactFiles = {
    "tickets.json": ticketsText,
    "policy.json": policyText,
    "normalized_tickets.json": JSON.stringify(artifacts.normalized_tickets, null, 2),
    "draft_replies.json": JSON.stringify(artifacts.draft_replies, null, 2),
    "policy_checks.json": JSON.stringify(artifacts.policy_checks, null, 2),
    "llm_review.json": JSON.stringify(artifacts.llm_review, null, 2),
    "human_overrides.json": JSON.stringify(overrides, null, 2),
    "final_decisions.json": JSON.stringify(finalDecisions, null, 2),
    "evaluation_report.md": report,
    "repaired_replies.json": JSON.stringify(artifacts.repaired_replies || [], null, 2),
    "metrics.json": JSON.stringify(metrics, null, 2),
    "llm_calls.jsonl": artifacts.llm_calls.map((entry) => JSON.stringify(entry)).join("\n"),
  };

  const validation = validateArtifacts({
    ticketsText,
    policyText,
    stageHistory: finalStageHistory,
    artifacts: {
      ...artifacts,
      final_decisions: finalDecisions,
      human_overrides: overrides,
      metrics,
      evaluation_report: report,
      artifact_files: artifactFiles,
    },
  });

  if (!validation.ok) {
    throw new Error(`Validation failed: ${validation.errors.join(" | ")}`);
  }

  advanceStage(finalStageHistory, "VALIDATION_COMPLETE");
  advanceStage(finalStageHistory, "RESULTS_FINALISED");

  return {
    stageHistory: finalStageHistory,
    finalDecisions,
    metrics,
    report,
    artifactFiles,
    validation,
  };
}

export function validateArtifacts({ ticketsText, policyText, stageHistory, artifacts }) {
  const errors = [];
  const { tickets, policy, normalizedTickets, inputMeta } = parseInputs({
    ticketsText,
    policyText,
    source: artifacts.input_meta?.source || "upload",
    sourceFiles: artifacts.input_meta?.sourceFiles || [],
  });

  const expectedFiles = [
    "tickets.json",
    "policy.json",
    "normalized_tickets.json",
    "draft_replies.json",
    "policy_checks.json",
    "llm_review.json",
    "human_overrides.json",
    "final_decisions.json",
    "evaluation_report.md",
    "repaired_replies.json",
    "metrics.json",
    "llm_calls.jsonl",
  ];

  for (const file of expectedFiles) {
    if (!artifacts.artifact_files?.[file]) {
      errors.push(`Missing artifact file content for ${file}.`);
    }
  }

  if (!Array.isArray(stageHistory) || stageHistory[0] !== "INIT") {
    errors.push("Stage history must begin with INIT.");
  }

  const requiredFinalStages = [
    "INPUTS_LOADED",
    "DRAFT_REPLIES_GENERATED",
    "DETERMINISTIC_CHECKS_COMPLETE",
    "LLM_REVIEW_COMPLETE",
    "HUMAN_OVERRIDE_COMPLETE",
    "FINAL_ROUTING_DECIDED",
    "REPORT_GENERATED",
  ];

  for (const stage of requiredFinalStages) {
    if (!stageHistory.includes(stage)) {
      errors.push(`Missing pipeline stage ${stage}.`);
    }
  }

  if (normalizedTickets.length !== tickets.length) {
    errors.push("Normalized ticket count does not match input ticket count.");
  }

  if (!inputMeta.ticketsReadFromDisk && artifacts.expect_disk_inputs) {
    errors.push("Validation expected tickets to be read from disk.");
  }

  if (!inputMeta.policyReadFromDisk && artifacts.expect_disk_inputs) {
    errors.push("Validation expected policy to be read from disk.");
  }

  if (artifacts.draft_replies.length !== tickets.length) {
    errors.push("There must be one generation result per ticket.");
  }

  if (artifacts.llm_review.length !== tickets.length) {
    errors.push("There must be one review result per ticket.");
  }

  for (const draft of artifacts.draft_replies) {
    if (!Array.isArray(draft.reply_sections_present)) {
      errors.push(`reply_sections_present must be a computed array for ${draft.ticket_id}.`);
    }
  }

  for (const review of artifacts.llm_review) {
    if (!POLICY_RISKS.has(review.policy_risk)) {
      errors.push(`Invalid policy risk ${review.policy_risk} for ${review.ticket_id}.`);
    }
  }

  const draftCalls = artifacts.llm_calls.filter((entry) => entry.stage === "DRAFT_GENERATION");
  const reviewCalls = artifacts.llm_calls.filter((entry) => entry.stage === "LLM_REVIEW");
  if (draftCalls.length !== tickets.length) {
    errors.push("llm_calls.jsonl must contain one draft-generation call per ticket.");
  }
  if (reviewCalls.length !== tickets.length) {
    errors.push("llm_calls.jsonl must contain one review call per ticket.");
  }

  for (const ticket of normalizedTickets) {
    const check = artifacts.policy_checks.find((item) => item.ticket_id === ticket.ticket_id);
    const review = artifacts.llm_review.find((item) => item.ticket_id === ticket.ticket_id);
    const decision = artifacts.final_decisions.find((item) => item.ticket_id === ticket.ticket_id);
    if (!check || !review || !decision) {
      errors.push(`Missing downstream artifacts for ${ticket.ticket_id}.`);
      continue;
    }

    const expectedInitial = computeInitialRoute(ticket, check, review).route;
    if (decision.initial_route !== expectedInitial) {
      errors.push(`Initial route mismatch for ${ticket.ticket_id}.`);
    }

    const expectedFinal = artifacts.human_overrides[ticket.ticket_id] || expectedInitial;
    if (decision.final_route !== expectedFinal) {
      errors.push(`Final route mismatch for ${ticket.ticket_id}.`);
    }
  }

  const reportText = artifacts.evaluation_report || "";
  for (const heading of [
    "## Summary",
    "## Auto-send Candidates",
    "## Human Review Required",
    "## Common Failure Patterns",
    "## Improvement Suggestions",
  ]) {
    if (!reportText.includes(heading)) {
      errors.push(`Missing report section ${heading}.`);
    }
  }

  if (!policy.required_reply_sections || !policy.forbidden_claims || !policy.routing_rules || !policy.quality_rubric) {
    errors.push("Policy structure is incomplete.");
  }

  return {
    ok: errors.length === 0,
    errors,
  };
}

export async function writeArtifactsToDisk(artifactFiles, rootDir = process.cwd()) {
  for (const [fileName, contents] of Object.entries(artifactFiles)) {
    await fs.writeFile(path.join(rootDir, fileName), contents, "utf8");
  }
}
