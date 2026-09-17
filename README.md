# Payment Exception Desk

Review incoming bank credits against expected payments. Exact amount, currency and date constraints determine eligibility. Optional local AI ranks eligible descriptions. You decide which proposals to retain and export for follow-up.

Built by [Prateek Mulye](https://prateekmulye.dev/).

## Run locally

Use Node.js 22 or later, Python 3 and `tar`. Run these commands from this directory. No `npm install` is needed.

```sh
node prepare.mjs
node checks.mjs
python3 -m http.server 8000 --bind 127.0.0.1
```

Open [http://127.0.0.1:8000](http://127.0.0.1:8000). The preparation command downloads pinned public assets and writes `asset-manifest.json`; it runs no package installation scripts. Skip it if the assets are already present. Checks print `PASS payment integrity` followed by the covered cases.

The app uses browser modules and a worker. Serve it over HTTP locally or HTTPS when hosted; opening `index.html` as a file is insufficient. Cloudflare Pages reads `_headers`; Python's development server does not apply those headers.

## Inputs and review

Import two UTF-8 CSVs. The interface supports column mapping and provides empty templates.

Bank credits:

```csv
transaction_id,booking_date,amount,currency,direction,description,reference
credit-1,2026-09-01,1200.00,USD,credit,Harbor Solar invoice 104,INV-104
```

Expected payments:

```csv
expected_id,expected_date,amount,currency,counterparty,reference
expected-1,2026-09-02,1200.00,USD,Harbor Solar,INV-104
```

`reference` is optional in either file. Required fields must map to separate columns. Each file supports up to 5 MiB and 5,000 rows. IDs must be unique within their file and at most 128 characters. Descriptions, counterparties and references each allow 1,000 characters.

Amounts must be positive plain decimals, at most two decimal places, up to `9999999999.99`. Supported currencies are USD, EUR, GBP, CAD and INR. Dates use `YYYY-MM-DD`. Remove debits, fees and reversals before importing. Split payments, partial payments and currency conversion are outside this version's scope.

1. Validate the mappings and choose a date window from zero to seven days.
2. Inspect eligible candidates. Optionally choose **Rank descriptions with AI**.
3. Propose a match, reject a candidate, leave a credit unresolved, or mark it out of scope. Add a reason where useful.
4. Export the review CSV, unresolved CSV and HTML evidence before leaving.

No payment is booked or transferred. Export rechecks the constraints and prevents reuse of an expected payment. Unreviewed credits remain unresolved. Every bank row remains represented in the review export. Evidence includes source filenames, SHA-256 hashes, mappings, decisions and model details. Formula-like text is prefixed in CSV exports for safer spreadsheet opening; original text remains in the evidence.

## AI, privacy and limits

The optional model is `Xenova/all-MiniLM-L6-v2`, revision `751bff37182d3f1213fa05d7196b954e230abad9`, through Transformers.js 3.8.1. The manifest's `downloadBytes` field counts 46,445,356 bytes of runtime and model payload, about 46.4 MB before HTTP compression, excluding license notices and model documentation. Preparation downloads these assets from npm, GitHub and Hugging Face; browser inference loads the prepared assets from the app's own origin.

Descriptions longer than 256 model tokens skip semantic ranking rather than being truncated. Ranking cannot override amount, currency or date constraints. Similarity scores are not match probabilities. If model loading fails, manual review remains available. Cancel terminates the worker.

CSV contents and decisions stay in browser memory. The app has no account, server-side inference, autosave or session restore. Export before closing or reloading. Ordinary browser caching may retain public model files, not review data.

Checks cover parser and money rules, date and currency exclusions, decision conflicts, source-row accounting and safe exports. Synthetic examples exercise the workflow; no labelled operational accuracy or time-saving benchmark is claimed. Third-party notices and model information remain alongside the prepared assets.
