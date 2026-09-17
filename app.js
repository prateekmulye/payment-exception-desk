import {
  BANK_FIELDS,
  EXPECTED_FIELDS,
  parseCSV,
  parseBankCsv,
  parseExpectedCsv,
  eligibleCandidates,
  baselineMatches,
  exportReview,
  rejectDecision,
  sha256,
  escapeHTML as esc,
} from "./core.js";
const $ = (id) => document.getElementById(id);
const files = {};
const importVersions = { bank: 0, expected: 0 };
let bank = [],
  expected = [],
  rankings = [],
  decisions = Object.create(null),
  selected = "",
  page = 0,
  windowDays = 3,
  worker = null,
  request = 0,
  session = crypto.randomUUID(),
  timer,
  analysis = "Not run",
  modelEvidence = null;
const methods = {
  "exact-reference": "Exact reference",
  "token-overlap": "Text overlap",
  "model-similarity": "Model similarity",
  semantic: "Model similarity",
  "manual-review": "Manual comparison",
};
function status(text, error = false) {
  $("status").textContent = text;
  $("status").classList.toggle("error", error);
  if (error) {
    $("status").tabIndex = -1;
    $("status").focus();
  }
}
function download(name, text, type = "text/csv;charset=utf-8") {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
  status(`Download prepared: ${name}.`);
}
function changed() {
  return Object.keys(decisions).length > 0;
}
function mayDiscard() {
  return (
    !changed() ||
    confirm(
      "Discard your current review decisions? Choose Cancel to keep working and export first.",
    )
  );
}
function stop(
  message = "Analysis stopped. Existing decisions remain available.",
) {
  worker?.terminate();
  worker = null;
  clearTimeout(timer);
  request++;
  $("cancel").hidden = true;
  $("analyze").disabled = false;
  if (message) status(message);
}
function mapping(kind) {
  return Object.fromEntries(
    [...$(kind + "-mapping").querySelectorAll("select")].map((select) => [
      select.dataset.field,
      select.value,
    ]),
  );
}
function showMapping(kind) {
  const data = files[kind];
  const fields = [
    ...(kind === "bank" ? BANK_FIELDS : EXPECTED_FIELDS),
    "reference",
  ];
  $(kind + "-mapping").innerHTML =
    `<details open><summary>Confirm columns and preview</summary><div class="map-grid">${fields.map((field) => `<label>${esc(field)}${field === "reference" ? " (optional)" : ""}<select data-field="${esc(field)}" aria-label="${kind} ${esc(field)} column"><option value="">Choose column</option>${data.parsed.headers.map((header) => `<option value="${esc(header)}" ${header === field ? "selected" : ""}>${esc(header)}</option>`).join("")}</select></label>`).join("")}</div><div class="table-wrap"><table><caption class="eyebrow">First ${Math.min(5, data.parsed.rows.length)} source rows</caption><thead><tr>${data.parsed.headers.map((h) => `<th scope="col">${esc(h)}</th>`).join("")}</tr></thead><tbody>${data.parsed.rows
      .slice(0, 5)
      .map(
        (row) =>
          `<tr>${data.parsed.headers.map((h) => `<td>${esc(row[h])}</td>`).join("")}</tr>`,
      )
      .join("")}</tbody></table></div></details>`;
}
for (const kind of ["bank", "expected"])
  $(kind + "-file").addEventListener("change", async (event) => {
    const file = event.target.files[0];
    if (!file) return;
    const version = ++importVersions[kind];
    try {
      if (file.size > 5 * 1024 * 1024)
        throw Error("Each CSV must be 5 MiB or smaller.");
      const bytes = await file.arrayBuffer();
      const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      const parsed = parseCSV(text);
      const hash = await sha256(bytes);
      if (version !== importVersions[kind]) return;
      if (!mayDiscard()) {
        event.target.value = "";
        return;
      }
      stop("");
      bank = [];
      expected = [];
      decisions = Object.create(null);
      modelEvidence = null;
      session = crypto.randomUUID();
      files[kind] = {
        name: file.name,
        text,
        parsed,
        hash,
      };
      showMapping(kind);
      expandSources();
      $(kind + "-file-info").textContent =
        `${file.name} · ${parsed.rows.length.toLocaleString()} source rows`;
      $("workspace").hidden = true;
      $("export-area").hidden = true;
      $("analysis-controls").hidden = true;
      status("Check the column mappings, then validate both files.");
    } catch (error) {
      if (version !== importVersions[kind]) return;
      status(error.message, true);
      event.target.value = "";
    }
  });
$("bank-template").onclick = () =>
  download(
    "bank-credits-template.csv",
    BANK_FIELDS.concat("reference").join(",") + "\r\n",
  );
$("expected-template").onclick = () =>
  download(
    "expected-payments-template.csv",
    EXPECTED_FIELDS.concat("reference").join(",") + "\r\n",
  );
$("validate").onclick = () => {
  try {
    if (!files.bank || !files.expected)
      throw Error("Choose both bank credits and expected payments.");
    const days = Number($("date-window").value);
    if (
      !Number.isInteger(days) ||
      days < 0 ||
      days > 7 ||
      $("date-window").value === ""
    )
      throw Error("Choose a whole date window from 0 to 7 days.");
    const nextBank = parseBankCsv(files.bank.text, mapping("bank"));
    const nextExpected = parseExpectedCsv(
      files.expected.text,
      mapping("expected"),
    );
    if (!mayDiscard()) return;
    stop("");
    bank = nextBank;
    expected = nextExpected;
    windowDays = days;
    decisions = Object.create(null);
    rankings = baselineMatches(bank, expected, windowDays);
    selected = bank[0].id;
    page = 0;
    session = crypto.randomUUID();
    analysis = "Not run";
    modelEvidence = null;
    files.bank.mapping = mapping("bank");
    files.expected.mapping = mapping("expected");
    $("workspace").hidden = false;
    $("export-area").hidden = false;
    $("analysis-controls").hidden = false;
    compactSources();
    status(
      `${bank.length} credits and ${expected.length} expected payments ready. Eligible dates differ by at most ${days} calendar days. Review suggestions before proposing a match.`,
    );
    render();
  } catch (error) {
    status(error.message, true);
  }
};
function filtered() {
  const filter = $("filter").value;
  return bank.filter(
    (row) =>
      filter === "all" || (decisions[row.id]?.state ?? "unreviewed") === filter,
  );
}
function renderQueue() {
  const rows = filtered();
  const max = Math.max(0, Math.ceil(rows.length / 30) - 1);
  page = Math.min(page, max);
  $("queue-count").textContent = `${rows.length} / ${bank.length}`;
  $("queue-list").innerHTML = rows.length
    ? rows
        .slice(page * 30, page * 30 + 30)
        .map(
          (row) =>
            `<button class="queue-row" type="button" data-credit="${esc(row.id)}" aria-current="${selected === row.id}"><strong>${esc(row.id)}</strong><span class="amount">${esc(row.amount)} ${esc(row.currency)}</span><span class="sub">${esc(row.date)} · ${esc(decisions[row.id]?.state.replaceAll("_", " ") ?? "Unreviewed")}<br>${esc(row.description)}</span></button>`,
        )
        .join("")
    : '<div class="empty"><h3>No credits in this view.</h3><p>Choose another filter to continue.</p></div>';
  $("page-count").textContent = `Page ${page + 1} of ${max + 1}`;
  $("previous-page").disabled = page === 0;
  $("next-page").disabled = page === max;
}
function candidateMarkup(row, candidate, method = "manual-review", score) {
  const used = Object.entries(decisions).find(
    ([id, d]) =>
      id !== row.id &&
      d.state === "proposed_match" &&
      d.expectedId === candidate.id,
  );
  return `<article class="candidate"><div class="candidate-head"><h3>${esc(candidate.counterparty || candidate.id)}</h3><span class="tag">${esc(methods[method] ?? method)}</span></div><p class="mono">${esc(candidate.id)} · ${esc(candidate.amount)} ${esc(candidate.currency)}</p><p>${esc(candidate.date)} · ${candidate.day - row.day} calendar days from credit<br>Reference: ${esc(candidate.reference || "No reference")}</p><small>Same amount and currency. Source row ${candidate.sourceRow}.</small>${Number.isFinite(score) ? `<details><summary>Ranking detail</summary><small>Similarity score ${score.toFixed(3)}. A ranking value, not a probability.</small></details>` : ""}${used ? `<p class="warning">Already proposed for ${esc(used[0])}.</p>` : ""}<div class="actions"><button type="button" class="primary small" data-propose="${esc(candidate.id)}" data-method="${esc(method)}" ${used ? "disabled" : ""} aria-label="Propose match ${esc(candidate.id)}">Propose match</button><button type="button" class="small quiet" data-reject="${esc(candidate.id)}">Reject candidate</button></div></article>`;
}
function renderReview() {
  const row = bank.find((r) => r.id === selected);
  if (!row) return;
  const decision = decisions[row.id];
  const ranking = rankings.find((r) => r.bankId === row.id);
  const eligible = eligibleCandidates(row, expected, windowDays);
  const rejected = decision?.rejected ?? [];
  $("decision-state").textContent = (
    decision?.state ?? "Unreviewed"
  ).replaceAll("_", " ");
  const candidates = (ranking?.candidates ?? []).filter(
    (c) => !rejected.includes(c.expectedId),
  );
  $("review-body").innerHTML =
    `<dl class="source-summary"><div><dt>Credit ID</dt><dd>${esc(row.id)}</dd></div><div><dt>Received</dt><dd class="mono">${esc(row.amount)} ${esc(row.currency)}</dd></div><div><dt>Booking date</dt><dd>${esc(row.date)}</dd></div><div class="wide"><dt>Original description</dt><dd>${esc(row.description || "No description")}</dd></div><div class="wide"><dt>Original reference · source row ${row.sourceRow}</dt><dd>${esc(row.reference || "No reference")}</dd></div></dl><div class="panel-body"><h3>${eligible.length} eligible expected payment${eligible.length === 1 ? "" : "s"}</h3>${decision?.state === "proposed_match" ? `<p class="status">Proposed: ${esc(decision.expectedId)}. This has not changed an external record.</p>` : ""}${
      candidates.length
        ? candidates
            .map((c) => {
              const item = eligible.find((e) => e.id === c.expectedId);
              return item ? candidateMarkup(row, item, c.method, c.score) : "";
            })
            .join("")
        : '<p class="muted">No remaining suggestions. Inspect all eligible records or leave this credit unresolved.</p>'
    }${eligible.length ? `<details><summary>View all eligible candidates (${eligible.length})</summary><label for="manual-candidate">Expected payment<select id="manual-candidate">${eligible.map((c) => `<option value="${esc(c.id)}">${esc(c.id)} · ${esc(c.counterparty)} · ${esc(c.date)}</option>`).join("")}</select></label><div id="manual-detail"></div></details>` : '<p class="privacy">No candidate fits the chosen amount, currency and date rules.</p>'}</div><div class="review-foot"><label for="review-note">Review note<textarea id="review-note" maxlength="2000" placeholder="Record why this association is appropriate, or what needs follow-up.">${esc(decision?.reason ?? "")}</textarea></label><div class="actions"><button type="button" id="unresolved">Leave unresolved</button><button type="button" id="out-of-scope" class="quiet">Out of scope</button><button type="button" id="undo" class="quiet">Undo decision</button><button type="button" id="next-credit" class="quiet">Next unreviewed</button></div></div>`;
  if ($("manual-candidate")) {
    $("manual-candidate").onchange = () => {
      $("manual-detail").innerHTML = candidateMarkup(
        row,
        eligible.find((c) => c.id === $("manual-candidate").value),
      );
    };
    $("manual-candidate").onchange();
  }
  $("review-note").oninput = () => {
    decisions[row.id] = {
      ...(decisions[row.id] ?? { state: "unresolved" }),
      reason: $("review-note").value,
    };
    renderCounts();
  };
  $("unresolved").onclick = () => decide("unresolved");
  $("out-of-scope").onclick = () => decide("out_of_scope");
  $("undo").onclick = () => {
    delete decisions[row.id];
    render();
    status(`Decision for ${row.id} removed.`);
  };
  $("next-credit").onclick = () => {
    const next = bank.find((r) => !decisions[r.id] && r.id !== selected);
    if (next) {
      selected = next.id;
      render();
    } else status("No other unreviewed credits.");
  };
}
function decide(state, expectedId, method = "manual-review") {
  const reason = $("review-note")?.value ?? "";
  if (expectedId) {
    const conflict = Object.entries(decisions).find(
      ([id, d]) =>
        id !== selected &&
        d.state === "proposed_match" &&
        d.expectedId === expectedId,
    );
    if (conflict) {
      status(
        `${expectedId} is already proposed for ${conflict[0]}. Undo that proposal first.`,
        true,
      );
      return;
    }
    const row = bank.find((r) => r.id === selected);
    if (
      !eligibleCandidates(row, expected, windowDays).some(
        (r) => r.id === expectedId,
      )
    ) {
      status("This payment is not eligible.", true);
      return;
    }
  }
  decisions[selected] = {
    ...decisions[selected],
    state,
    expectedId,
    reason,
    method,
    rejected: (decisions[selected]?.rejected ?? []).filter(
      (id) => id !== expectedId,
    ),
  };
  render();
  status(`Decision recorded for ${selected}. You can undo it before export.`);
}
$("review-body").onclick = (event) => {
  const propose = event.target.closest("[data-propose]");
  const reject = event.target.closest("[data-reject]");
  if (propose)
    decide("proposed_match", propose.dataset.propose, propose.dataset.method);
  if (reject) {
    const current = decisions[selected] ?? {
      state: "rejected_candidate",
      reason: $("review-note").value,
    };
    decisions[selected] = rejectDecision(current, reject.dataset.reject);
    render();
  }
};
$("queue-list").onclick = (event) => {
  const button = event.target.closest("[data-credit]");
  if (button) {
    selected = button.dataset.credit;
    render();
  }
};
function renderCounts() {
  const proposed = Object.values(decisions).filter(
    (d) => d.state === "proposed_match",
  ).length;
  const reviewed = Object.keys(decisions).length;
  $("export-counts").textContent =
    `${proposed} proposed · ${bank.length - proposed} remaining unresolved or out of scope · ${bank.length - reviewed} unreviewed`;
  $("analysis-summary").textContent = `AI analysis: ${analysis}`;
}
function render() {
  renderQueue();
  renderReview();
  renderCounts();
}
$("filter").onchange = () => {
  page = 0;
  renderQueue();
};
$("previous-page").onclick = () => {
  page--;
  renderQueue();
};
$("next-page").onclick = () => {
  page++;
  renderQueue();
};
$("analyze").onclick = () => {
  if (!bank.length) return;
  stop("");
  const id = ++request;
  worker = new Worker("./analysis-worker.js", { type: "module" });
  $("analyze").disabled = true;
  $("cancel").hidden = false;
  analysis = "Running";
  renderCounts();
  status(
    "Preparing local description model. You can stop this and keep reviewing.",
  );
  timer = setTimeout(() => {
    analysis = "Incomplete";
    stop("Analysis timed out. Manual comparison remains available.");
    renderCounts();
  }, 180000);
  worker.onmessage = ({ data }) => {
    if (data.sessionId !== session || data.requestId !== id || request !== id)
      return;
    if (data.type === "progress") {
      status(
        data.payload?.message ??
          data.payload?.stage ??
          "Analyzing eligible descriptions on this device.",
      );
    } else if (data.type === "complete") {
      if (!Array.isArray(data.payload?.rows)) {
        stop(
          "Model returned an invalid response. Manual review remains available.",
        );
        return;
      }
      rankings = data.payload.rows;
      modelEvidence = {
        model: data.payload.model,
        limitations: data.payload.limitations,
        elapsedMs: data.payload.elapsedMs,
        semanticSkipped: data.payload.semanticSkipped,
        rankings,
      };
      analysis = "Complete";
      stop(
        "Description ranking complete. Review every proposal against its source.",
      );
      render();
    } else if (data.type === "error") {
      analysis = "Incomplete";
      stop(
        data.payload?.message ??
          "Description ranking did not finish. Manual comparison remains available.",
      );
      renderCounts();
    }
  };
  worker.onerror = () => {
    analysis = "Incomplete";
    stop(
      "Model could not start. Check your connection, then retry. Manual review remains available.",
    );
    renderCounts();
  };
  worker.postMessage({
    version: 1,
    sessionId: session,
    requestId: id,
    action: "analyze",
    payload: {
      bankText: files.bank.text,
      expectedText: files.expected.text,
      bankMapping: files.bank.mapping,
      expectedMapping: files.expected.mapping,
      windowDays,
    },
  });
};
$("cancel").onclick = () => {
  analysis = "Stopped";
  stop();
  renderCounts();
};
function prepare() {
  const normalized = Object.fromEntries(
    bank.map((row) => [
      row.id,
      decisions[row.id] ?? { state: "unresolved", reason: "Not reviewed" },
    ]),
  );
  return exportReview(bank, expected, normalized, windowDays, {
    sources: {
      bank: {
        name: files.bank.name,
        sha256: files.bank.hash,
        mapping: files.bank.mapping,
      },
      expected: {
        name: files.expected.name,
        sha256: files.expected.hash,
        mapping: files.expected.mapping,
      },
    },
    analysisStatus: analysis,
    modelEvidence,
  });
}
for (const [id, key, name, type] of [
  ["export-review", "csv", "payment-review.csv"],
  ["export-unresolved", "unresolved", "unresolved.csv"],
  [
    "export-evidence",
    "html",
    "payment-review-evidence.html",
    "text/html;charset=utf-8",
  ],
])
  $(id).onclick = () => {
    try {
      download(name, prepare()[key], type);
    } catch (error) {
      status(error.message, true);
    }
  };
$("reset").onclick = () => {
  if (mayDiscard()) {
    stop("");
    location.reload();
  }
};
addEventListener("beforeunload", (event) => {
  if (changed()) {
    event.preventDefault();
    event.returnValue = "";
  }
});
fetch("./asset-manifest.json")
  .then((r) => (r.ok ? r.json() : Promise.reject()))
  .then((m) => {
    $("model-note").textContent =
      `Optional on-device model. First use downloads ${(Number(m.downloadBytes ?? m.totalBytes ?? 0) / 1e6).toFixed(1)} MB of public runtime/model files. Your CSV contents are not part of these requests.`;
  })
  .catch(() => {
    $("model-note").textContent =
      "Optional on-device model. Its public files download only when you choose AI ranking. Download size is unavailable until model assets are prepared.";
  });

const sourceToggle = document.createElement("button");
sourceToggle.type = "button";
sourceToggle.className = "quiet small";
sourceToggle.textContent = "Edit sources";
sourceToggle.hidden = true;
sourceToggle.setAttribute("aria-expanded", "false");
document.querySelector(".sources .panel-head").append(sourceToggle);
sourceToggle.onclick = () => {
  const section = document.querySelector(".sources");
  const expanded = section.classList.toggle("is-expanded");
  sourceToggle.setAttribute("aria-expanded", String(expanded));
  sourceToggle.textContent = expanded ? "Close sources" : "Edit sources";
};
function compactSources() {
  document.querySelector(".sources").classList.add("is-ready");
  document.querySelector(".sources").classList.remove("is-expanded");
  document.body.classList.add("has-review");
  sourceToggle.hidden = false;
  sourceToggle.setAttribute("aria-expanded", "false");
  sourceToggle.textContent = "Edit sources";
}
function expandSources() {
  document
    .querySelector(".sources")
    .classList.remove("is-ready", "is-expanded");
  document.body.classList.remove("has-review");
  sourceToggle.hidden = true;
}
