import assert from "node:assert/strict";
import {
  parseCSV,
  money,
  dateDay,
  parseBankCsv,
  parseExpectedCsv,
  eligibleCandidates,
  baselineMatches,
  exportReview,
  rejectDecision,
} from "./core.js";
const bankText =
  'transaction_id,booking_date,amount,currency,direction,description,reference\nb1,2026-09-01,100.10,USD,credit,"North, Ltd",INV-1\nb2,2026-09-02,100.10,USD,credit,North,\n';
const expectedText =
  "expected_id,expected_date,amount,currency,counterparty,reference\ne1,2026-09-02,100.1,USD,North Ltd,INV-1\ne2,2026-09-09,100.10,USD,North Ltd,INV-2\ne3,2026-09-01,100.10,EUR,North Ltd,INV-3\ne4,2026-09-01,100.11,USD,North Ltd,INV-4\n";
const bank = parseBankCsv(bankText),
  expected = parseExpectedCsv(expectedText);
assert.equal(money("9999999999.99"), "999999999999");
assert.equal(money("0.01"), "1");
for (const amount of [
  "0",
  "-1",
  "1e2",
  "1,000",
  "1.001",
  "10000000000",
  " 1",
  "01",
  "NaN",
])
  assert.throws(() => money(amount));
assert.equal(dateDay("2024-03-01") - dateDay("2024-02-28"), 2);
assert.throws(() => dateDay("2026-02-29"));
assert.deepEqual(
  eligibleCandidates(bank[0], expected, 3).map((x) => x.id),
  ["e1"],
);
assert.throws(() => eligibleCandidates(bank[0], expected, 8));
assert.equal(
  baselineMatches(bank, expected)[0].candidates[0].method,
  "exact-reference",
);
assert.throws(() => parseBankCsv(bankText.replace("b2,", "b1,")), /unique/);
assert.throws(
  () => parseBankCsv(bankText.replace("credit", "debit")),
  /incoming/,
);
assert.throws(() => parseCSV('a,b\n1,"no close'));
assert.throws(() => parseCSV("a,a\n1,2"), /unique/);
assert.equal(parseCSV('a,b\r\n"x\ny","two ""quotes"""\r\n').rows[0].a, "x\ny");
const result = exportReview(
  bank,
  expected,
  {
    b1: {
      state: "proposed_match",
      expectedId: "e1",
      reason: ' =HYPERLINK("bad")',
    },
  },
  3,
  { sourceHashes: ["abc", "def"] },
);
assert.equal(result.records.length, 2);
assert.equal(parseCSV(result.unresolved).rows.length, 1);
assert.match(result.csv, /' =HYPERLINK/);
assert.equal(result.evidence.decisions[0].reason, ' =HYPERLINK("bad")');
assert.throws(
  () =>
    exportReview(
      bank,
      expected,
      {
        b1: { state: "proposed_match", expectedId: "e1" },
        b2: { state: "proposed_match", expectedId: "e1" },
      },
      3,
    ),
  /more than once/,
);
assert.throws(
  () =>
    exportReview(
      bank,
      expected,
      { b1: { state: "proposed_match", expectedId: "e4" } },
      3,
    ),
  /constraints/,
);
const rejected = rejectDecision(
  { state: "proposed_match", expectedId: "e1", reason: "Check remittance" },
  "e1",
);
assert.equal(rejected.state, "rejected_candidate");
assert.equal(rejected.expectedId, undefined);
assert.equal(
  exportReview(bank, expected, { b1: rejected }, 3).records[0].expected_id,
  "",
);
assert.throws(
  () =>
    exportReview(
      bank,
      expected,
      { b1: { state: "proposed_match", expectedId: "e1", rejected: ["e1"] } },
      3,
    ),
  /also rejected/,
);
const special = parseBankCsv(
  bankText.replace("b1,", "__proto__,").replace("b2,", "constructor,"),
);
assert.equal(exportReview(special, expected, {}, 3).records.length, 2);
// Dense amount/date buckets must not score the cross product on the main thread.
const denseSource = (count, reference = "") =>
  "expected_id,expected_date,amount,currency,counterparty,reference\n" +
  Array.from(
    { length: count },
    (_, i) =>
      `dense-${i},2026-09-01,100.10,USD,${i === count - 1 ? "North Ltd" : "Unrelated payer"},${i === count - 1 ? reference : ""}`,
  ).join("\n");
const threshold = baselineMatches(
  [bank[1]],
  parseExpectedCsv(denseSource(250)),
  3,
)[0];
assert.equal(threshold.status, "review-required");
assert.equal(threshold.candidates[0].expectedId, "dense-249");
assert.equal(threshold.candidates[0].method, "token-overlap");
const denseRows = parseExpectedCsv(denseSource(251, "INV-1"));
const dense = baselineMatches([bank[0]], denseRows, 3)[0];
assert.equal(dense.status, "manual-many-candidates");
assert.equal(dense.eligibleCount, 251);
assert.equal(dense.candidates.length, 3);
assert.equal(dense.candidates[0].expectedId, "dense-250");
assert.equal(dense.candidates[0].method, "exact-reference");
assert.ok(dense.candidates.every((candidate) => candidate.score === null));
assert.ok(
  dense.candidates
    .slice(1)
    .every((candidate) => candidate.method === "manual-review"),
);
const ambiguous = baselineMatches([bank[1]], denseRows, 3)[0];
assert.deepEqual(
  ambiguous.candidates.map((candidate) => candidate.expectedId),
  ["dense-0", "dense-1", "dense-2"],
);
assert.equal(eligibleCandidates(bank[1], denseRows, 3).length, 251);
const manualTail = exportReview(
  [bank[1]],
  denseRows,
  { b2: { state: "proposed_match", expectedId: "dense-250" } },
  3,
);
assert.equal(manualTail.records[0].expected_id, "dense-250");
console.log(
  "PASS payment integrity: exact money/date/currency, mapping, malformed CSV, manual decisions, conflicts and safe export.",
);
