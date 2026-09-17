import { parseBankCsv, parseExpectedCsv, eligibleCandidates } from "./core.js";

const MODEL = {
  id: "Xenova/all-MiniLM-L6-v2",
  revision: "751bff37182d3f1213fa05d7196b954e230abad9",
  runtime: "Transformers.js 3.8.1",
  dtype: "q8",
};
let extractor;
let busy = false;
const reference = (value) =>
  value.trim().normalize("NFKC").toLowerCase().replace(/\s+/gu, " ");
const narrative = (row) =>
  [row.description, row.counterparty, row.reference]
    .filter(Boolean)
    .join(" | ");
const dot = (a, b) =>
  a.reduce((sum, value, index) => sum + value * b[index], 0);

self.onmessage = async ({ data: request }) => {
  if (
    !request ||
    request.version !== 1 ||
    request.action !== "analyze" ||
    typeof request.sessionId !== "string" ||
    request.sessionId.length > 128 ||
    !Number.isSafeInteger(request.requestId)
  )
    return;
  const reply = (type, payload) =>
    self.postMessage({
      version: 1,
      sessionId: request.sessionId,
      requestId: request.requestId,
      type,
      payload,
    });
  if (busy)
    return reply("error", {
      code: "busy",
      message:
        "An analysis is already running. Cancel it before starting another.",
    });
  busy = true;
  const started = performance.now();
  let stage = "validate";
  try {
    const payload = request.payload;
    if (
      !payload ||
      typeof payload.bankText !== "string" ||
      typeof payload.expectedText !== "string"
    )
      throw new Error("Choose both CSV files before analysis.");
    const bank = parseBankCsv(payload.bankText, payload.bankMapping);
    const expected = parseExpectedCsv(
      payload.expectedText,
      payload.expectedMapping,
    );
    const windowDays = payload.windowDays ?? 3;
    if (!Number.isInteger(windowDays) || windowDays < 0 || windowDays > 7)
      throw new Error("Date window must be an integer from 0 to 7 days.");
    const buckets = new Map();
    for (const row of expected) {
      const key = `${row.currency}:${row.minor}`;
      if (!buckets.has(key)) buckets.set(key, []);
      buckets.get(key).push(row);
    }
    const vectors = new Map();
    let semanticSkipped = 0;
    stage = "download";
    reply("progress", {
      stage,
      message:
        "Loading the local text model. Files and results stay in this browser.",
    });
    if (!extractor) {
      const { pipeline, env } = await import("./vendor/transformers.min.js");
      env.allowRemoteModels = false;
      env.allowLocalModels = true;
      env.localModelPath = new URL("./models/", self.location.href).href;
      env.useBrowserCache = true;
      env.backends.onnx.wasm.wasmPaths = new URL(
        "./vendor/",
        self.location.href,
      ).href;
      env.backends.onnx.wasm.numThreads = 1;
      env.backends.onnx.wasm.proxy = false;
      extractor = await pipeline("feature-extraction", MODEL.id, {
        dtype: "q8",
        device: "wasm",
        progress_callback: (event) => {
          if (event.status === "progress")
            reply("progress", {
              stage,
              file: event.file,
              loaded: event.loaded,
              total: event.total,
            });
        },
      });
    }
    stage = "rank";
    const inferenceStart = performance.now();
    async function vector(text) {
      if (!text.trim()) return null;
      if (vectors.has(text)) return vectors.get(text);
      // The model supports 256 wordpieces. Never silently drop a reference suffix.
      const tokenized = await extractor.tokenizer(text, { truncation: false });
      if (tokenized.input_ids.dims.at(-1) > 256) {
        vectors.set(text, null);
        semanticSkipped += 1;
        return null;
      }
      const result = await extractor(text, {
        pooling: "mean",
        normalize: true,
      });
      const value = result.tolist()[0];
      if (
        value.length !== 384 ||
        value.some((number) => !Number.isFinite(number))
      )
        throw new Error("The model returned an invalid embedding.");
      vectors.set(text, value);
      return value;
    }
    const rows = [];
    for (let index = 0; index < bank.length; index += 1) {
      if (performance.now() - inferenceStart > 60_000)
        throw new Error(
          "Analysis exceeded the 60-second limit. Try a smaller export.",
        );
      const row = bank[index];
      const eligible = eligibleCandidates(
        row,
        buckets.get(`${row.currency}:${row.minor}`) ?? [],
        windowDays,
      );
      const exact = row.reference.trim()
        ? eligible.filter(
            (candidate) =>
              reference(candidate.reference) === reference(row.reference),
          )
        : [];
      let candidates = [];
      let status = "unresolved";
      if (exact.length === 1) {
        candidates = [
          { expectedId: exact[0].id, score: null, method: "exact-reference" },
        ];
        status = "suggestions";
      } else if (eligible.length) {
        const bankVector = await vector(narrative(row));
        if (bankVector) {
          for (const candidate of eligible) {
            if (performance.now() - inferenceStart > 60_000)
              throw new Error(
                "Analysis exceeded the 60-second limit. Try a smaller export.",
              );
            const candidateVector = await vector(narrative(candidate));
            if (candidateVector)
              candidates.push({
                expectedId: candidate.id,
                score: Math.max(
                  -1,
                  Math.min(1, dot(bankVector, candidateVector)),
                ),
                method: "semantic",
                scoreMeaning: "Cosine similarity, not probability",
              });
          }
          candidates.sort(
            (a, b) =>
              b.score - a.score || a.expectedId.localeCompare(b.expectedId),
          );
          candidates = candidates.slice(0, 3);
          status = candidates.length ? "suggestions" : "semantic-unavailable";
        } else status = "semantic-unavailable";
      }
      rows.push({
        bankId: row.id,
        eligibleCount: eligible.length,
        candidates,
        status,
      });
      if (index % 10 === 0 || index === bank.length - 1)
        reply("progress", { stage, completed: index + 1, total: bank.length });
    }
    reply("complete", {
      rows,
      model: MODEL,
      elapsedMs: Math.round(performance.now() - started),
      semanticSkipped,
      limitations: [
        "Suggestions require analyst review. No money moves and no ledger is changed.",
        "Semantic ranking quality has not been validated on a permissioned operational dataset.",
        "Descriptions longer than 256 model tokens are excluded from semantic ranking, without truncation.",
      ],
    });
  } catch (error) {
    reply("error", {
      code:
        stage === "validate"
          ? "invalid-input"
          : stage === "download"
            ? "model-unavailable"
            : "analysis-failed",
      stage,
      message:
        error instanceof Error
          ? error.message
          : "Analysis failed. Review the input and retry.",
    });
  } finally {
    busy = false;
  }
};
