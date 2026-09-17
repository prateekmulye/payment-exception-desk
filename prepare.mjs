/** Download pinned browser-only assets. Run from the repository root. No install scripts. */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
const revision = "751bff37182d3f1213fa05d7196b954e230abad9";
const model = "Xenova/all-MiniLM-L6-v2";
const version = "3.8.1";
const manifest = {
  runtime: `@huggingface/transformers@${version}`,
  model,
  revision,
  files: [],
};
const hash = (bytes, algorithm = "sha256") =>
  createHash(algorithm).update(bytes).digest("hex");
async function download(url, maxBytes = 60_000_000) {
  const response = await fetch(url, { signal: AbortSignal.timeout(120_000) });
  if (!response.ok) throw new Error(`${response.status}: ${url}`);
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > maxBytes) throw new Error(`Asset exceeds ${maxBytes}: ${url}`);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}
async function save(path, bytes, source) {
  const destination = join(root, path);
  await mkdir(dirname(destination), { recursive: true });
  await writeFile(destination, bytes);
  manifest.files.push({
    path,
    bytes: bytes.length,
    sha256: hash(bytes),
    source,
  });
}

const temporary = await mkdtemp(join(tmpdir(), "engineering-index-"));
try {
  const tarballURL = `https://registry.npmjs.org/@huggingface/transformers/-/transformers-${version}.tgz`;
  const tarball = await download(tarballURL);
  const integrity = createHash("sha512").update(tarball).digest("base64");
  if (
    integrity !==
    "tsTk4zVjImqdqjS8/AOZg2yNLd1z9S5v+7oUPpXaasDRwEDhB+xnglK1k5cad26lL5/ZIaeREgWWy0bs9y9pPA=="
  )
    throw new Error("Runtime package integrity mismatch");
  const archive = join(temporary, "runtime.tgz");
  await writeFile(archive, tarball);
  // transformers.web.min.js leaves bare ONNX imports; transformers.min.js is standalone.
  const runtimeFiles = [
    "dist/transformers.min.js",
    "dist/ort-wasm-simd-threaded.jsep.mjs",
    "dist/ort-wasm-simd-threaded.jsep.wasm",
    "LICENSE",
  ];
  execFileSync("tar", [
    "-xzf",
    archive,
    "-C",
    temporary,
    ...runtimeFiles.map((file) => `package/${file}`),
  ]);
  for (const file of runtimeFiles)
    await save(
      `vendor/${file.replace("dist/", "")}`,
      await readFile(join(temporary, "package", file)),
      tarballURL,
    );
  const onnxRevision = "89f8206ba4f1c22c39e0297fb55272e8ce8cd7d0";
  for (const file of ["LICENSE", "ThirdPartyNotices.txt"]) {
    const url = `https://raw.githubusercontent.com/microsoft/onnxruntime/${onnxRevision}/${file}`;
    await save(`vendor/onnx-${file}`, await download(url, 2_000_000), url);
  }
  for (const file of [
    "config.json",
    "tokenizer.json",
    "tokenizer_config.json",
    "special_tokens_map.json",
    "vocab.txt",
    "README.md",
    "onnx/model_quantized.onnx",
  ]) {
    const url = `https://huggingface.co/${model}/resolve/${revision}/${file}`;
    await save(`models/${model}/${file}`, await download(url), url);
  }
  manifest.downloadBytes = manifest.files
    .filter((file) => !/LICENSE|Notices|README/.test(file.path))
    .reduce((sum, file) => sum + file.bytes, 0);
  await writeFile(
    join(root, "asset-manifest.json"),
    JSON.stringify(manifest, null, 2) + "\n",
  );
  console.log(
    JSON.stringify({
      files: manifest.files.length,
      downloadBytes: manifest.downloadBytes,
      revision,
    }),
  );
} finally {
  await rm(temporary, { recursive: true, force: true });
}
