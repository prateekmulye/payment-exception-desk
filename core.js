export const VERSION = "1.0.0";
export const CURRENCIES = ["USD", "EUR", "GBP", "CAD", "INR"];
export const BANK_FIELDS = [
  "transaction_id",
  "booking_date",
  "amount",
  "currency",
  "direction",
  "description",
];
export const EXPECTED_FIELDS = [
  "expected_id",
  "expected_date",
  "amount",
  "currency",
  "counterparty",
];

export function parseCSV(text, maxRows = 5000) {
  if (
    typeof text !== "string" ||
    text.length > 21_000_000 ||
    text.includes("\0")
  )
    throw new Error("Use a UTF-8 CSV within the file limit.");
  text = text.replace(/^\uFEFF/, "");
  const table = [];
  let row = [];
  let field = "";
  let quoted = false;
  let closed = false;
  for (let i = 0; i <= text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === undefined) throw new Error("CSV has an unclosed quoted field.");
      if (c === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (c === '"') {
        quoted = false;
        closed = true;
      } else field += c;
    } else if (c === "," || c === "\n" || c === "\r" || c === undefined) {
      row.push(field);
      field = "";
      closed = false;
      if (c !== ",") {
        if (row.some((value) => value !== "") || row.length > 1)
          table.push(row);
        row = [];
        if (c === "\r" && text[i + 1] === "\n") i++;
        if (table.length > maxRows + 1)
          throw new Error(`CSV exceeds ${maxRows} data rows.`);
      }
    } else if (closed)
      throw new Error("Unexpected text after a quoted CSV field.");
    else if (c === '"') {
      if (field) throw new Error("Quote inside an unquoted CSV field.");
      quoted = true;
    } else field += c;
  }
  if (table.length < 2)
    throw new Error("CSV needs a header and at least one data row.");
  const headers = table.shift().map((v) => v.trim());
  if (headers.some((v) => !v) || new Set(headers).size !== headers.length)
    throw new Error("Column names must be nonempty and unique.");
  const rows = table.map((values, i) => {
    if (values.length !== headers.length)
      throw new Error(
        `CSV row ${i + 2} has ${values.length} fields; expected ${headers.length}.`,
      );
    return Object.fromEntries(headers.map((name, j) => [name, values[j]]));
  });
  return { headers, rows };
}

export function money(value) {
  if (
    typeof value !== "string" ||
    !/^(?:0|[1-9]\d{0,9})(?:\.\d{1,2})?$/.test(value)
  )
    throw new Error(
      "Amounts must be positive decimals with at most two decimal places and no grouping.",
    );
  const [whole, fraction = ""] = value.split(".");
  const minor = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, "0"));
  if (minor <= 0n || minor > 999999999999n)
    throw new Error(
      "Amount must be greater than zero and at most 9,999,999,999.99.",
    );
  return minor.toString();
}

export function dateDay(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value))
    throw new Error("Use dates in YYYY-MM-DD format.");
  const epoch = Date.parse(value + "T00:00:00Z");
  if (
    !Number.isFinite(epoch) ||
    new Date(epoch).toISOString().slice(0, 10) !== value
  )
    throw new Error("Date is not a valid calendar day.");
  return epoch / 86400000;
}

function parsePayments(text, mapping, bank) {
  if (new TextEncoder().encode(text).length > 5 * 1024 * 1024)
    throw new Error("Each payment CSV must be 5 MiB or smaller.");
  const { headers, rows } = parseCSV(text);
  const fields = bank ? BANK_FIELDS : EXPECTED_FIELDS;
  const map =
    mapping ?? Object.fromEntries([...fields, "reference"].map((x) => [x, x]));
  if (
    fields.some((key) => !headers.includes(map[key])) ||
    new Set(fields.map((key) => map[key])).size !== fields.length
  )
    throw new Error("Map each required field to a different CSV column.");
  if (
    map.reference &&
    headers.includes(map.reference) &&
    fields.some((key) => map[key] === map.reference)
  )
    throw new Error("Reference must use its own column.");
  const seen = new Set();
  return rows.map((source, i) => {
    try {
      const get = (key) => source[map[key]] ?? "";
      const id = get(bank ? "transaction_id" : "expected_id").trim();
      if (!id || id.length > 128 || seen.has(id))
        throw new Error(
          "IDs must be unique, nonempty and at most 128 characters.",
        );
      seen.add(id);
      const date = get(bank ? "booking_date" : "expected_date");
      const amount = get("amount");
      const currency = get("currency");
      if (!CURRENCIES.includes(currency))
        throw new Error("Supported currencies: USD, EUR, GBP, CAD and INR.");
      if (bank && get("direction").trim().toLowerCase() !== "credit")
        throw new Error(
          "Only incoming credits are supported. Remove debits, fees and reversals before import.",
        );
      const description = bank ? get("description") : "";
      const counterparty = bank ? "" : get("counterparty");
      const reference = get("reference");
      if ([description, counterparty, reference].some((s) => s.length > 1000))
        throw new Error(
          "Descriptions, counterparties and references must each be at most 1,000 characters.",
        );
      return {
        id,
        date,
        day: dateDay(date),
        amount,
        minor: money(amount),
        currency,
        description,
        counterparty,
        reference,
        sourceRow: i + 2,
      };
    } catch (error) {
      throw new Error(`Row ${i + 2}: ${error.message}`);
    }
  });
}
export const parseBankCsv = (text, mapping) =>
  parsePayments(text, mapping, true);
export const parseExpectedCsv = (text, mapping) =>
  parsePayments(text, mapping, false);
export function eligibleCandidates(bank, expected, windowDays = 3) {
  if (!Number.isInteger(windowDays) || windowDays < 0 || windowDays > 7)
    throw new Error("Date window must be between 0 and 7 whole days.");
  return expected.filter(
    (row) =>
      row.currency === bank.currency &&
      row.minor === bank.minor &&
      Math.abs(row.day - bank.day) <= windowDays,
  );
}
const words = (value) =>
  new Set(
    value
      .toLowerCase()
      .normalize("NFKC")
      .match(/[\p{L}\p{N}]+/gu) ?? [],
  );
export function tokenScore(a, b) {
  return overlap(words(a), words(b));
}
function overlap(left, right) {
  let common = 0;
  for (const word of left) if (right.has(word)) common++;
  const total = left.size + right.size - common;
  return total ? common / total : 0;
}
export function baselineMatches(bank, expected, windowDays = 3) {
  const buckets = new Map();
  const tokens = new Map();
  for (const row of expected) {
    const key = `${row.currency}:${row.minor}`;
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(row);
    tokens.set(row.id, words(`${row.counterparty} ${row.reference}`));
  }
  return bank.map((row) => {
    const eligible = eligibleCandidates(
      row,
      buckets.get(`${row.currency}:${row.minor}`) ?? [],
      windowDays,
    );
    const reference = row.reference.trim().toLowerCase();
    const exact = reference
      ? eligible.filter((x) => x.reference.trim().toLowerCase() === reference)
      : [];
    // ponytail: dense buckets remain manual; never score millions of pairs on the UI thread.
    const dense = eligible.length > 250;
    const shortlist = dense
      ? exact.length === 1
        ? [exact[0], ...eligible.filter((x) => x !== exact[0]).slice(0, 2)]
        : eligible.slice(0, 3)
      : eligible;
    const sourceTokens = words(`${row.description} ${row.reference}`);
    const candidates = shortlist.map((x) => ({
      expectedId: x.id,
      score: dense ? null : overlap(sourceTokens, tokens.get(x.id)),
      method:
        exact.length === 1 && exact[0].id === x.id
          ? "exact-reference"
          : dense
            ? "manual-review"
            : "token-overlap",
    }));
    candidates.sort(
      (a, b) =>
        Number(b.method === "exact-reference") -
          Number(a.method === "exact-reference") || b.score - a.score,
    );
    return {
      bankId: row.id,
      eligibleCount: eligible.length,
      candidates: candidates.slice(0, 3),
      status: dense
        ? "manual-many-candidates"
        : eligible.length
          ? "review-required"
          : "unresolved",
    };
  });
}
export function csvCell(value) {
  let text = String(value ?? "");
  if (/^[\s\u0000-\u001f]*[=+\-@]/.test(text) || /^[\t\r\n]/.test(text))
    text = "'" + text;
  return '"' + text.replace(/"/g, '""') + '"';
}
export const toCSV = (headers, rows) =>
  [headers, ...rows].map((row) => row.map(csvCell).join(",")).join("\r\n") +
  "\r\n";
export const escapeHTML = (value) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
export async function sha256(bytes) {
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(hash)]
    .map((v) => v.toString(16).padStart(2, "0"))
    .join("");
}
export function rejectDecision(current, expectedId) {
  const decision = {
    ...current,
    rejected: [...new Set([...(current?.rejected ?? []), expectedId])],
  };
  if (decision.expectedId === expectedId) {
    decision.state = "rejected_candidate";
    delete decision.expectedId;
    delete decision.method;
  }
  return decision;
}
export function exportReview(
  bank,
  expected,
  decisions,
  windowDays,
  metadata = {},
) {
  const used = new Set();
  const records = bank.map((row) => {
    const decision = Object.hasOwn(decisions, row.id)
      ? decisions[row.id]
      : { state: "unresolved" };
    if (
      ![
        "proposed_match",
        "unresolved",
        "out_of_scope",
        "rejected_candidate",
      ].includes(decision.state)
    )
      throw new Error(`Invalid decision for ${row.id}.`);
    const match =
      decision.state === "proposed_match"
        ? expected.find((x) => x.id === decision.expectedId)
        : null;
    if (decision.state === "proposed_match") {
      if (decision.rejected?.includes(decision.expectedId))
        throw new Error(
          `Proposed match for ${row.id} was also rejected. Resolve the decision before export.`,
        );
      if (!match || !eligibleCandidates(row, [match], windowDays).length)
        throw new Error(
          `Proposed match for ${row.id} violates amount, currency or date constraints.`,
        );
      if (used.has(match.id))
        throw new Error(
          `Expected payment ${match.id} is used more than once. Resolve the conflict before export.`,
        );
      used.add(match.id);
    }
    return {
      transaction_id: row.id,
      expected_id: match?.id ?? "",
      review_state: decision.state,
      reason: String(decision.reason ?? "").slice(0, 2000),
      bank_amount: row.amount,
      expected_amount: match?.amount ?? "",
      currency: row.currency,
      date_difference_days: match ? match.day - row.day : "",
      method: decision.method ?? "manual-review",
      source_reference: row.reference,
      source_row: row.sourceRow,
    };
  });
  const headers = [
    "transaction_id",
    "expected_id",
    "review_state",
    "reason",
    "bank_amount",
    "expected_amount",
    "currency",
    "date_difference_days",
    "method",
    "source_reference",
  ];
  const make = (items) =>
    toCSV(
      headers,
      items.map((row) => headers.map((k) => row[k])),
    );
  const csv = make(records);
  const unresolved = make(
    records.filter((row) => row.review_state !== "proposed_match"),
  );
  if (parseCSV(csv, 5000).rows.length !== bank.length)
    throw new Error("Export row accounting failed.");
  const evidence = {
    schemaVersion: 1,
    appVersion: VERSION,
    dateWindowDays: windowDays,
    ...metadata,
    limitation:
      "Proposed associations only. Nothing has been posted or settled. CSV formula-like text is prefixed with an apostrophe; original source text is retained in this evidence record.",
    bank,
    expected,
    decisions: records,
  };
  const html = `<!doctype html><html lang="en"><meta charset="utf-8"><title>Payment review evidence</title><style>body{max-width:90rem;margin:2rem auto;font:15px system-ui;padding:1rem}table{border-collapse:collapse;width:100%}td,th{padding:.6rem;border:1px solid #ccc;text-align:left}pre{white-space:pre-wrap;overflow-wrap:anywhere}</style><h1>Payment review</h1><p>${escapeHTML(evidence.limitation)}</p><table><thead><tr>${headers.map((k) => `<th>${escapeHTML(k)}</th>`).join("")}</tr></thead><tbody>${records.map((row) => `<tr>${headers.map((k) => `<td>${escapeHTML(row[k])}</td>`).join("")}</tr>`).join("")}</tbody></table><h2>Source and method record</h2><pre>${escapeHTML(JSON.stringify(evidence, null, 2))}</pre></html>`;
  return { csv, unresolved, html, evidence, records };
}
