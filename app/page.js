"use client";

import { useMemo, useState } from "react";

const PIPELINE_STAGES = [
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

const SAMPLE_TICKETS = `[
  {
    "ticket_id": "T-1001",
    "customer_tone": "frustrated",
    "issue_type": "delayed_withdrawal",
    "customer_message": "I requested a withdrawal yesterday and it still hasn't arrived. This is unacceptable. Where is my money?",
    "account_context": {
      "kyc_status": "verified",
      "withdrawal_status": "pending_review",
      "hours_since_request": 22
    }
  }
]`;

const SAMPLE_POLICY = `{
  "allowed_issue_types": ["delayed_withdrawal"],
  "required_reply_sections": ["acknowledgement", "next_steps", "safety_note"],
  "forbidden_claims": ["guarantee a timeline"],
  "routing_rules": {
    "must_human_review_if": ["reply fails any deterministic policy check"]
  },
  "quality_rubric": {
    "1": "unsafe",
    "5": "excellent"
  }
}`;

export default function HomePage() {
  const [ticketsText, setTicketsText] = useState(SAMPLE_TICKETS);
  const [policyText, setPolicyText] = useState(SAMPLE_POLICY);
  const [source, setSource] = useState("upload");
  const [sourceFiles, setSourceFiles] = useState([]);
  const [runResult, setRunResult] = useState(null);
  const [finalResult, setFinalResult] = useState(null);
  const [overrides, setOverrides] = useState({});
  const [isRunning, setIsRunning] = useState(false);
  const [isFinalizing, setIsFinalizing] = useState(false);
  const [message, setMessage] = useState("");

  function markAsUpload(nextText, setter) {
    setter(nextText);
    setSource("upload");
    setSourceFiles([]);
    setRunResult(null);
    setFinalResult(null);
    setOverrides({});
  }

  const currentStage = finalResult?.stageHistory?.at(-1) || runResult?.stageHistory?.at(-1) || "INIT";

  const stagePills = useMemo(() => {
    const stageHistory = finalResult?.stageHistory || runResult?.stageHistory || ["INIT"];
    return PIPELINE_STAGES.map((stage) => {
      const included = stageHistory.includes(stage);
      const isCurrent = currentStage === stage;
      return { stage, included, isCurrent };
    });
  }, [currentStage, finalResult?.stageHistory, runResult?.stageHistory]);

  async function loadSamples() {
    setMessage("");
    const response = await fetch("/api/sample-inputs");
    const data = await response.json();
    if (!response.ok) {
      setMessage(data.error || "Failed to load sample files.");
      return;
    }

    setTicketsText(data.ticketsText);
    setPolicyText(data.policyText);
    setSource("disk");
    setSourceFiles(data.sourceFiles || []);
    setRunResult(null);
    setFinalResult(null);
    setOverrides({});
    setMessage("Loaded tickets.json and policy.json from disk.");
  }

  async function handleFileChange(event, setter) {
    const file = event.target.files?.[0];
    if (!file) {
      return;
    }

    const text = await file.text();
    setter(text);
    setSource("upload");
    setSourceFiles(file.name ? [file.name] : []);
    setRunResult(null);
    setFinalResult(null);
    setOverrides({});
    setMessage(`Loaded ${file.name} from upload.`);
  }

  async function runPipeline() {
    setIsRunning(true);
    setMessage("");
    setFinalResult(null);

    try {
      const response = await fetch("/api/pipeline/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ticketsText, policyText, source, sourceFiles }),
      });

      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.error || "Pipeline run failed.");
      }

      setRunResult(data);
      const nextOverrides = {};
      for (const item of data.artifacts.current_recommendations) {
        nextOverrides[item.ticket_id] = item.current_route_recommendation;
      }
      setOverrides(nextOverrides);
      setMessage("Draft generation, deterministic checks, and LLM review completed.");
    } catch (error) {
      setMessage(error.message);
    } finally {
      setIsRunning(false);
    }
  }

  async function finalizePipelineRun() {
    if (!runResult) {
      return;
    }

    setIsFinalizing(true);
    setMessage("");

    try {
      const response = await fetch("/api/pipeline/finalize", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ticketsText,
          policyText,
          artifacts: runResult.artifacts,
          overrides,
          stageHistory: runResult.stageHistory,
        }),
      });

      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.error || "Finalization failed.");
      }

      setFinalResult(data);
      setMessage("Human override checkpoint applied and final artifacts are ready.");
    } catch (error) {
      setMessage(error.message);
    } finally {
      setIsFinalizing(false);
    }
  }

  function updateOverride(ticketId, value) {
    setOverrides((current) => ({
      ...current,
      [ticketId]: value,
    }));
  }

  function downloadArtifact(fileName, contents) {
    const blob = new Blob([contents], {
      type: fileName.endsWith(".md") ? "text/markdown;charset=utf-8" : "application/json;charset=utf-8",
    });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = fileName;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);
  }

  const ticketCards = runResult?.artifacts?.normalized_tickets || [];
  const draftByTicket = new Map((runResult?.artifacts?.draft_replies || []).map((item) => [item.ticket_id, item]));
  const repairedByTicket = new Map((runResult?.artifacts?.repaired_replies || []).map((item) => [item.ticket_id, item]));
  const checkByTicket = new Map((runResult?.artifacts?.policy_checks || []).map((item) => [item.ticket_id, item]));
  const reviewByTicket = new Map((runResult?.artifacts?.llm_review || []).map((item) => [item.ticket_id, item]));
  const recommendationByTicket = new Map(
    (runResult?.artifacts?.current_recommendations || []).map((item) => [item.ticket_id, item]),
  );

  return (
    <main className="page-shell">
      <section className="hero">
        <div className="eyebrow">Vercel + Groq</div>
        <h1>Customer Support Evaluation Pipeline</h1>
        <p>
          Upload or load <span className="inline-code">tickets.json</span> and{" "}
          <span className="inline-code">policy.json</span>, run the staged pipeline, review the
          deterministic and LLM signals, apply human overrides in the browser, and download every
          generated artifact.
        </p>
      </section>

      <section className="layout-grid">
        <div className="panel">
          <h2>Inputs</h2>
          <p className="subtle">
            Groq is used for generation, repair, and structured review. API keys stay server-side
            in environment variables only.
          </p>
          <div className="upload-grid">
            <div className="field-block">
              <strong>tickets.json</strong>
              <div className="button-row">
                <input type="file" accept=".json,application/json" onChange={(event) => handleFileChange(event, setTicketsText)} />
              </div>
              <textarea
                value={ticketsText}
                onChange={(event) => markAsUpload(event.target.value, setTicketsText)}
                spellCheck={false}
              />
            </div>
            <div className="field-block">
              <strong>policy.json</strong>
              <div className="button-row">
                <input type="file" accept=".json,application/json" onChange={(event) => handleFileChange(event, setPolicyText)} />
              </div>
              <textarea
                value={policyText}
                onChange={(event) => markAsUpload(event.target.value, setPolicyText)}
                spellCheck={false}
              />
            </div>
          </div>
          <div className="button-row">
            <button className="btn btn-secondary" onClick={loadSamples}>
              Load sample files from disk
            </button>
            <button className="btn btn-primary" onClick={runPipeline} disabled={isRunning}>
              {isRunning ? "Running pipeline..." : "Run pipeline"}
            </button>
            <button
              className="btn btn-ghost"
              onClick={finalizePipelineRun}
              disabled={!runResult || isFinalizing}
            >
              {isFinalizing ? "Finalizing..." : "Apply overrides and finalize"}
            </button>
          </div>
          <div className="flash">
            <strong>Current source:</strong> {source === "disk" ? "Loaded from repository files" : "Uploaded in browser"}
            {sourceFiles.length > 0 ? ` (${sourceFiles.join(", ")})` : ""}
            {message ? <div className="list-note" style={{ marginTop: 8 }}>{message}</div> : null}
          </div>
        </div>

        <div className="panel">
          <h2>Stages</h2>
          <div className="stage-list">
            {stagePills.map((item) => (
              <div
                key={item.stage}
                className={`stage-pill ${item.included ? "done" : ""} ${item.isCurrent ? "current" : ""}`}
              >
                {item.stage}
              </div>
            ))}
          </div>
        </div>
      </section>

      {finalResult ? (
        <section className="panel" style={{ marginTop: 20 }}>
          <h2>Final Metrics</h2>
          <div className="summary-grid">
            <div className="summary-card">
              Total tickets
              <strong>{finalResult.metrics.total_tickets}</strong>
            </div>
            <div className="summary-card">
              Auto-send
              <strong>{finalResult.metrics.auto_send_count}</strong>
            </div>
            <div className="summary-card">
              Human review
              <strong>{finalResult.metrics.human_review_count}</strong>
            </div>
            <div className="summary-card">
              Avg quality
              <strong>{finalResult.metrics.average_quality_rating}</strong>
            </div>
          </div>
        </section>
      ) : null}

      {runResult ? (
        <section className="panel" style={{ marginTop: 20 }}>
          <h2>Human Override Checkpoint</h2>
          <p className="subtle">
            One line per ticket shows the deterministic result, LLM quality rating, and current
            route recommendation. Update the dropdown before finalizing.
          </p>
          <div className="ticket-grid">
            {ticketCards.map((ticket) => {
              const draft = draftByTicket.get(ticket.ticket_id);
              const repaired = repairedByTicket.get(ticket.ticket_id);
              const check = checkByTicket.get(ticket.ticket_id);
              const review = reviewByTicket.get(ticket.ticket_id);
              const recommendation = recommendationByTicket.get(ticket.ticket_id);
              const activeReply = repaired?.reply_text || draft?.reply_text || "";

              return (
                <article className="ticket-card" key={ticket.ticket_id}>
                  <div className="ticket-meta">
                    <strong>{ticket.ticket_id}</strong>
                    <span className={`badge ${check?.passed ? "pass" : "fail"}`}>
                      {check?.passed ? "pass" : "fail"}
                    </span>
                    <span className="badge">{ticket.issue_type}</span>
                    <span className="badge">{ticket.customer_tone}</span>
                  </div>
                  <h3>{recommendation?.current_route_recommendation === "human_review" ? "Needs review" : "Candidate for auto-send"}</h3>
                  <div className="stat-line">
                    <span>Deterministic score: {check?.deterministic_score ?? "-"}</span>
                    <span>Quality rating: {review?.quality_rating ?? "-"}/5</span>
                    <span>Policy risk: {review?.policy_risk ?? "-"}</span>
                  </div>
                  <p>{ticket.customer_message}</p>
                  <div className="override-line">
                    <label htmlFor={`override-${ticket.ticket_id}`}>Override route</label>
                    <select
                      id={`override-${ticket.ticket_id}`}
                      className="route-select"
                      value={overrides[ticket.ticket_id] || recommendation?.current_route_recommendation || "auto_send"}
                      onChange={(event) => updateOverride(ticket.ticket_id, event.target.value)}
                    >
                      <option value="auto_send">auto_send</option>
                      <option value="human_review">human_review</option>
                    </select>
                  </div>
                  <div className="list-note" style={{ marginTop: 8 }}>
                    Current recommendation: {recommendation?.current_route_recommendation || "-"}.
                    {" "}
                    {recommendation?.current_reason || ""}
                  </div>
                  {check?.failed_checks?.length ? (
                    <div className="list-note" style={{ marginTop: 8 }}>
                      Failed checks: {check.failed_checks.join(", ")}
                    </div>
                  ) : null}
                  {repaired ? (
                    <div className="list-note" style={{ marginTop: 8 }}>
                      Repair attempted because the original draft failed deterministic checks.
                    </div>
                  ) : null}
                  <pre>{activeReply}</pre>
                </article>
              );
            })}
          </div>
        </section>
      ) : null}

      {finalResult ? (
        <>
          <section className="panel" style={{ marginTop: 20 }}>
            <h2>Downloads</h2>
            <div className="artifact-grid">
              {Object.entries(finalResult.artifactFiles).map(([fileName, contents]) => (
                <div className="artifact-card" key={fileName}>
                  <strong>{fileName}</strong>
                  <div className="button-row">
                    <button className="btn btn-primary" onClick={() => downloadArtifact(fileName, contents)}>
                      Download
                    </button>
                  </div>
                  <div className="artifact-preview">{contents.slice(0, 500)}{contents.length > 500 ? "..." : ""}</div>
                </div>
              ))}
            </div>
          </section>

          <section className="panel" style={{ marginTop: 20 }}>
            <h2>Evaluation Report</h2>
            <div className="report-box">{finalResult.report}</div>
          </section>
        </>
      ) : null}
    </main>
  );
}
