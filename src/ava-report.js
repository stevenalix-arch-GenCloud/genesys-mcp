// Deterministic HTML renderer for Genesys Cloud AVA quality reports.
//
// This module deliberately contains no Cloudflare-specific APIs.
// It accepts normal JavaScript objects and returns HTML, which keeps
// the renderer portable when the MCP moves to Azure.

function esc(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function pct(value) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) {
    return 'N/A';
  }

  const n = Number(value);

  // Support scores represented either as 0-1 or 0-100.
  const normalized = n <= 1 ? n * 100 : n;
  return `${Math.round(normalized)}%`;
}

function scoreNumber(value) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) {
    return null;
  }

  const n = Number(value);
  return n <= 1 ? n * 100 : n;
}

function statusClass(value) {
  const text = String(value ?? '').toLowerCase();

  if (
    text.includes('pass') ||
    text.includes('success') ||
    text.includes('clean')
  ) {
    return 'status-pass';
  }

  if (
    text.includes('fail') ||
    text.includes('error') ||
    text.includes('blocking')
  ) {
    return 'status-fail';
  }

  return 'status-warn';
}

function pretty(value) {
  if (value === undefined) return '';
  if (typeof value === 'string') return value;

  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function array(value) {
  return Array.isArray(value) ? value : [];
}

function findingList(title, findings, cssClass) {
  const rows = array(findings);

  if (!rows.length) {
    return `
      <section class="panel">
        <h2>${esc(title)}</h2>
        <p class="muted">None recorded.</p>
      </section>
    `;
  }

  return `
    <section class="panel">
      <h2>${esc(title)} <span class="count">${rows.length}</span></h2>
      <div class="findings">
        ${rows.map((item, index) => `
          <article class="finding ${cssClass}">
            <div class="finding-title">
              ${esc(item.category || item.title || `Finding ${index + 1}`)}
            </div>

            <p>${esc(item.finding || item.message || item.summary || '')}</p>

            ${item.evidence ? `
              <div class="detail">
                <strong>Evidence</strong>
                <div>${esc(item.evidence)}</div>
              </div>
            ` : ''}

            ${item.fix || item.recommendation ? `
              <div class="detail">
                <strong>Recommended fix</strong>
                <div>${esc(item.fix || item.recommendation)}</div>
              </div>
            ` : ''}

            ${item.source ? `
              <div class="source">Source: ${esc(item.source)}</div>
            ` : ''}
          </article>
        `).join('')}
      </div>
    </section>
  `;
}

function attemptTranscript(attempt) {
  const transcript = array(attempt?.transcript);

  if (!transcript.length) return '';

  return `
    <details>
      <summary>Conversation transcript</summary>
      <div class="transcript">
        ${transcript.map((line) => {
          const speaker =
            line.role ||
            line.actor ||
            line.source ||
            line.type ||
            'Turn';

          const text =
            line.text ||
            line.content ||
            line.message ||
            pretty(line);

          return `
            <div class="turn">
              <div class="speaker">${esc(speaker)}</div>
              <div class="turn-text">${esc(text)}</div>
            </div>
          `;
        }).join('')}
      </div>
    </details>
  `;
}

function toolEvidence(attempt) {
  const calls = array(attempt?.tool_calls || attempt?.toolCalls);
  const results = array(attempt?.tool_results || attempt?.toolResults);

  if (!calls.length && !results.length) return '';

  return `
    <details>
      <summary>Tool evidence</summary>

      ${calls.length ? `
        <h4>Tool calls</h4>
        <pre>${esc(pretty(calls))}</pre>
      ` : ''}

      ${results.length ? `
        <h4>Tool results</h4>
        <pre>${esc(pretty(results))}</pre>
      ` : ''}
    </details>
  `;
}

function guardrailEvidence(attempt) {
  const events = array(
    attempt?.guardrail_events ||
    attempt?.guardrailEvents
  );

  if (!events.length) return '';

  return `
    <details>
      <summary>Guardrail events (${events.length})</summary>
      <pre>${esc(pretty(events))}</pre>
    </details>
  `;
}

function scenarioSection(scorecard) {
  const scenarios = array(
    scorecard?.perScenario ||
    scorecard?.per_scenario
  );

  if (!scenarios.length) {
    return `
      <section class="panel">
        <h2>Scenario Results</h2>
        <p class="muted">No scenario results were supplied.</p>
      </section>
    `;
  }

  return `
    <section class="panel">
      <h2>Scenario Results</h2>

      <div class="scenario-list">
        ${scenarios.map((scenario) => {
          const attempts = array(scenario.attempts);

          const passCount = attempts.filter((a) => {
            const result = String(
              a.result ||
              a.status ||
              a.verdict ||
              ''
            ).toLowerCase();

            return result.includes('pass') ||
              result.includes('success');
          }).length;

          const successRate =
            scenario.successRate ??
            scenario.success_rate ??
            (attempts.length ? passCount / attempts.length : null);

          const threshold =
            scenario.threshold ??
            scenario.successThreshold ??
            scenario.success_threshold;

          const score = scoreNumber(successRate);
          const thresholdScore = scoreNumber(threshold);

          const scenarioStatus =
            score !== null &&
            thresholdScore !== null
              ? score >= thresholdScore
                ? 'PASS'
                : 'FAIL'
              : scenario.status ||
                scenario.result ||
                'REVIEW';

          return `
            <article class="scenario">
              <div class="scenario-header">
                <div>
                  <span class="badge ${statusClass(scenarioStatus)}">
                    ${esc(scenarioStatus)}
                  </span>
                  <h3>${esc(
                    scenario.name ||
                    scenario.testCaseId ||
                    scenario.test_case_id ||
                    'Scenario'
                  )}</h3>
                </div>

                <div class="scenario-score">
                  ${pct(successRate)}
                </div>
              </div>

              <div class="scenario-meta">
                ${threshold !== undefined
                  ? `Threshold: ${pct(threshold)}`
                  : ''}
                ${attempts.length
                  ? ` · Attempts: ${attempts.length}`
                  : ''}
              </div>

              ${attempts.map((attempt, index) => `
                <div class="attempt">
                  <h4>Attempt ${esc(attempt.attempt ?? index + 1)}</h4>

                  ${attempt.ended ? `
                    <div class="meta-row">
                      End state: ${esc(attempt.ended)}
                    </div>
                  ` : ''}

                  ${attempt.layer1 ? `
                    <details>
                      <summary>Trajectory validation</summary>
                      <pre>${esc(pretty(attempt.layer1))}</pre>
                    </details>
                  ` : ''}

                  ${attempt.layer2 ? `
                    <details>
                      <summary>Quality judgments</summary>
                      <pre>${esc(pretty(attempt.layer2))}</pre>
                    </details>
                  ` : ''}

                  ${attemptTranscript(attempt)}
                  ${toolEvidence(attempt)}
                  ${guardrailEvidence(attempt)}
                </div>
              `).join('')}
            </article>
          `;
        }).join('')}
      </div>
    </section>
  `;
}

function dimensionCards(scorecard) {
  const summary = scorecard?.summary || {};

  const dimensions = [
    ['Goal Completion', summary.goal ?? summary.goalCompletion],
    ['Tool Use', summary.tool_use ?? summary.toolUse],
    ['Guardrails', summary.guardrail ?? summary.guardrails],
    ['Response Match', summary.responseMatch ?? summary.response_match],
    ['Tone / Format', summary.tone_format ?? summary.toneFormat],
  ].filter(([, value]) => value !== undefined);

  if (!dimensions.length) return '';

  return `
    <section class="score-grid">
      ${dimensions.map(([label, value]) => `
        <div class="score-card">
          <div class="score-label">${esc(label)}</div>
          <div class="score-value">${pct(value)}</div>
        </div>
      `).join('')}
    </section>
  `;
}

export function renderAvaQualityReport({
  title = 'Genesys Cloud AVA Quality Assessment',
  organization = '',
  avaName = '',
  avaId = '',
  version = '',
  runId = '',
  generatedAt = new Date().toISOString(),
  scorecard = {},
  critique = null,
}) {
  const overall =
    scorecard?.summary?.overall ??
    scorecard?.summary?.score ??
    scorecard?.overall ??
    null;

  const overallNumber = scoreNumber(overall);

  const overallStatus =
    scorecard?.summary?.status ||
    scorecard?.summary?.result ||
    (overallNumber === null
      ? 'REVIEW'
      : overallNumber >= 80
        ? 'PASS'
        : 'REVIEW');

  const critiqueData = critique || {};

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} - ${esc(avaName || 'AVA')}</title>

<style>
  :root {
    color-scheme: light dark;

    --bg: #f4f7fb;
    --panel: #ffffff;
    --text: #172033;
    --muted: #677287;
    --border: #dbe2ea;
    --brand: #3b50e0;
    --brand2: #635bff;

    --pass: #0f7b4b;
    --pass-bg: #e8f7ef;

    --fail: #b42318;
    --fail-bg: #fff0ee;

    --warn: #946200;
    --warn-bg: #fff7dc;

    --shadow: 0 8px 24px rgba(19, 33, 68, .08);
  }

  * {
    box-sizing: border-box;
  }

  body {
    margin: 0;
    background: var(--bg);
    color: var(--text);
    font-family:
      Inter, ui-sans-serif, system-ui, -apple-system,
      BlinkMacSystemFont, "Segoe UI", sans-serif;
    line-height: 1.5;
  }

  .page {
    width: min(1180px, calc(100% - 32px));
    margin: 32px auto 64px;
  }

  .hero {
    color: white;
    padding: 34px;
    border-radius: 20px;
    background:
      linear-gradient(135deg, #24298f 0%, var(--brand) 52%, var(--brand2) 100%);
    box-shadow: var(--shadow);
  }

  .eyebrow {
    text-transform: uppercase;
    letter-spacing: .11em;
    font-size: 12px;
    font-weight: 800;
    opacity: .8;
  }

  h1 {
    margin: 8px 0 6px;
    font-size: clamp(28px, 5vw, 46px);
    line-height: 1.05;
  }

  .ava-name {
    font-size: 20px;
    opacity: .92;
  }

  .hero-grid {
    display: grid;
    grid-template-columns: 1fr auto;
    gap: 24px;
    align-items: end;
    margin-top: 26px;
  }

  .metadata {
    display: flex;
    gap: 10px;
    flex-wrap: wrap;
  }

  .meta-pill {
    padding: 7px 11px;
    background: rgba(255,255,255,.14);
    border: 1px solid rgba(255,255,255,.2);
    border-radius: 999px;
    font-size: 13px;
  }

  .overall {
    text-align: right;
  }

  .overall-score {
    font-size: 48px;
    font-weight: 850;
    line-height: 1;
  }

  .overall-status {
    margin-top: 8px;
    font-weight: 800;
    letter-spacing: .08em;
  }

  .score-grid {
    display: grid;
    grid-template-columns: repeat(5, minmax(0, 1fr));
    gap: 14px;
    margin: 20px 0;
  }

  .score-card,
  .panel,
  .scenario {
    background: var(--panel);
    border: 1px solid var(--border);
    box-shadow: var(--shadow);
  }

  .score-card {
    padding: 18px;
    border-radius: 16px;
  }

  .score-label {
    color: var(--muted);
    font-size: 13px;
    font-weight: 700;
  }

  .score-value {
    margin-top: 4px;
    font-size: 30px;
    font-weight: 850;
  }

  .panel {
    margin-top: 20px;
    padding: 24px;
    border-radius: 18px;
  }

  .panel h2 {
    margin-top: 0;
  }

  .count {
    display: inline-block;
    margin-left: 6px;
    padding: 2px 8px;
    border-radius: 999px;
    background: var(--bg);
    font-size: 13px;
  }

  .scenario-list {
    display: grid;
    gap: 14px;
  }

  .scenario {
    padding: 20px;
    border-radius: 15px;
  }

  .scenario-header {
    display: flex;
    justify-content: space-between;
    gap: 20px;
  }

  .scenario-header h3 {
    display: inline;
    margin-left: 8px;
  }

  .scenario-score {
    font-size: 24px;
    font-weight: 850;
  }

  .scenario-meta,
  .meta-row,
  .source,
  .muted {
    color: var(--muted);
    font-size: 13px;
  }

  .attempt {
    margin-top: 16px;
    padding-top: 14px;
    border-top: 1px solid var(--border);
  }

  .badge {
    display: inline-block;
    padding: 4px 8px;
    border-radius: 8px;
    font-size: 12px;
    font-weight: 850;
  }

  .status-pass {
    color: var(--pass);
    background: var(--pass-bg);
  }

  .status-fail {
    color: var(--fail);
    background: var(--fail-bg);
  }

  .status-warn {
    color: var(--warn);
    background: var(--warn-bg);
  }

  details {
    margin-top: 12px;
    border: 1px solid var(--border);
    border-radius: 10px;
    padding: 10px 12px;
  }

  summary {
    cursor: pointer;
    font-weight: 750;
  }

  pre {
    overflow: auto;
    padding: 12px;
    border-radius: 10px;
    background: #111827;
    color: #f8fafc;
    font-size: 12px;
    white-space: pre-wrap;
    word-break: break-word;
  }

  .transcript {
    margin-top: 10px;
  }

  .turn {
    display: grid;
    grid-template-columns: 110px 1fr;
    gap: 12px;
    padding: 9px 0;
    border-bottom: 1px solid var(--border);
  }

  .speaker {
    font-weight: 800;
  }

  .findings {
    display: grid;
    gap: 12px;
  }

  .finding {
    border-left: 5px solid var(--border);
    padding: 14px;
    background: var(--bg);
    border-radius: 10px;
  }

  .finding.error {
    border-left-color: var(--fail);
  }

  .finding.warning {
    border-left-color: var(--warn);
  }

  .finding.positive {
    border-left-color: var(--pass);
  }

  .finding-title {
    font-weight: 850;
  }

  .detail {
    margin-top: 10px;
  }

  .footer {
    margin-top: 24px;
    color: var(--muted);
    text-align: center;
    font-size: 12px;
  }

  @media (max-width: 850px) {
    .score-grid {
      grid-template-columns: repeat(2, 1fr);
    }

    .hero-grid {
      grid-template-columns: 1fr;
    }

    .overall {
      text-align: left;
    }
  }

  @media (max-width: 520px) {
    .page {
      width: min(100% - 20px, 1180px);
      margin-top: 10px;
    }

    .hero,
    .panel {
      padding: 18px;
    }

    .score-grid {
      grid-template-columns: 1fr;
    }

    .turn {
      grid-template-columns: 1fr;
      gap: 2px;
    }
  }

  @media print {
    body {
      background: white;
    }

    .page {
      width: 100%;
      margin: 0;
    }

    .hero,
    .score-card,
    .panel,
    .scenario {
      box-shadow: none;
      break-inside: avoid;
    }

    details {
      break-inside: avoid;
    }

    details > * {
      display: block;
    }

    summary {
      list-style: none;
    }
  }
</style>
</head>

<body>
  <main class="page">

    <section class="hero">
      <div class="eyebrow">Genesys Cloud · Quality Engineering</div>

      <h1>${esc(title)}</h1>

      <div class="ava-name">${esc(avaName || 'Agentic Virtual Agent')}</div>

      <div class="hero-grid">
        <div class="metadata">
          ${organization
            ? `<span class="meta-pill">Org: ${esc(organization)}</span>`
            : ''}

          ${version
            ? `<span class="meta-pill">Version: ${esc(version)}</span>`
            : ''}

          ${runId
            ? `<span class="meta-pill">Run: ${esc(runId)}</span>`
            : ''}

          ${avaId
            ? `<span class="meta-pill">AVA ID: ${esc(avaId)}</span>`
            : ''}
        </div>

        <div class="overall">
          <div class="overall-score">${pct(overall)}</div>
          <div class="overall-status">${esc(overallStatus)}</div>
        </div>
      </div>
    </section>

    ${dimensionCards(scorecard)}

    ${scenarioSection(scorecard)}

    ${findingList(
      'Critical Findings',
      critiqueData.errors,
      'error'
    )}

    ${findingList(
      'Warnings',
      critiqueData.warnings,
      'warning'
    )}

    ${findingList(
      'Positive Patterns',
      critiqueData.positives,
      'positive'
    )}

    ${findingList(
      'Additional Observations',
      critiqueData.info,
      ''
    )}

    <section class="panel">
      <h2>Report Metadata</h2>

      <div class="meta-row">
        <strong>AVA:</strong> ${esc(avaName || 'Not supplied')}
      </div>

      <div class="meta-row">
        <strong>Genesys organization:</strong>
        ${esc(organization || 'Not supplied')}
      </div>

      <div class="meta-row">
        <strong>Version:</strong>
        ${esc(version || 'Not supplied')}
      </div>

      <div class="meta-row">
        <strong>Evaluation run:</strong>
        ${esc(runId || 'Not supplied')}
      </div>

      <div class="meta-row">
        <strong>Generated:</strong>
        ${esc(generatedAt)}
      </div>
    </section>

    <div class="footer">
      Generated from Genesys Cloud AVA evaluation and critique evidence.
    </div>

  </main>
</body>
</html>`;
}
