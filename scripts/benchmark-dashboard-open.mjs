import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { performance } from "node:perf_hooks";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build as esbuildBuild } from "esbuild";

const localRoot = fileURLToPath(new URL("..", import.meta.url));
const baselineRoot = resolve(process.argv[2] ?? localRoot);
const candidateRoot = resolve(process.argv[3] ?? baselineRoot);
const expectOptimized = process.argv.includes("--expect-optimized");
const markdownFileCount = 10_000;
const sampleCount = 30;
const opensPerSample = 10;

async function importRuntime(sourceRoot) {
  const build = await esbuildBuild({
    absWorkingDir: sourceRoot,
    stdin: {
      contents: `
        export { default as TPSWatchlistPlugin } from "./src/main";
        export { WatchlistView } from "./src/view";
      `,
      resolveDir: sourceRoot,
      sourcefile: "dashboard-benchmark-entry.ts",
      loader: "ts",
    },
    bundle: true,
    format: "esm",
    platform: "node",
    write: false,
    plugins: [{
      name: "obsidian-benchmark-stub",
      setup(buildContext) {
        buildContext.onResolve({ filter: /^obsidian$/ }, () => ({
          path: join(sourceRoot, "tests/obsidian-runtime-stub.ts"),
        }));
      },
    }],
  });
  const moduleUrl = `data:text/javascript;base64,${Buffer.from(build.outputFiles[0].text).toString("base64")}#${encodeURIComponent(sourceRoot)}-${Date.now()}`;
  return import(moduleUrl);
}

function watchDefinition(path, index) {
  return {
    id: `watch-${index}`,
    path,
    title: `Watch ${index}`,
    provider: "page",
    url: "https://example.com",
    selector: "",
    jsonPath: "",
    pattern: "",
    query: "",
    condition: "changed",
    target: "",
    intervalMinutes: 15,
    notify: true,
    cooldownMinutes: 0,
    caseSensitive: false,
    status: index % 2 ? "holding" : "working",
    tags: [],
  };
}

function createHarness(Runtime, {
  existing = false,
  fileCount = 3,
  failSetViewState = false,
  failRender = false,
} = {}) {
  const files = Array.from({ length: fileCount }, (_, index) => ({
    path: `Notes/Fixture ${index}.md`,
  }));
  const definitions = new Map(
    files.slice(0, Math.min(3, files.length))
      .map((file, index) => [file.path, watchDefinition(file.path, index)]),
  );
  const plugin = Object.create(Runtime.TPSWatchlistPlugin.prototype);
  let parseCount = 0;
  let renderCount = 0;
  let revealCount = 0;
  let viewStateCount = 0;
  let lastRows = [];
  plugin.states = {};
  plugin.definitionFromFile = (file) => {
    parseCount += 1;
    return definitions.get(file.path) ?? null;
  };
  plugin.app = {
    vault: {
      getMarkdownFiles: () => files,
    },
    workspace: {},
  };

  const createView = () => {
    const view = Object.create(Runtime.WatchlistView.prototype);
    view.plugin = plugin;
    view.render = async () => {
      renderCount += 1;
      if (failRender) throw new Error("synthetic render failure");
      lastRows = plugin.getWatchRows().map((row) => ({
        path: row.definition.path,
        active: row.active,
      }));
    };
    return view;
  };
  const existingLeaf = existing ? { view: createView() } : null;
  plugin.app.workspace.getLeavesOfType = () => existingLeaf ? [existingLeaf] : [];
  plugin.app.workspace.getLeaf = () => {
    const leaf = {
      view: {},
      async setViewState(state) {
        viewStateCount += 1;
        if (failSetViewState) throw new Error("synthetic setViewState failure");
        leaf.view = createView();
        await leaf.view.onOpen();
        leaf.state = state;
      },
    };
    return leaf;
  };
  plugin.app.workspace.revealLeaf = () => {
    revealCount += 1;
  };

  return {
    run: () => plugin.openDashboard(),
    counts: () => ({
      parseCount,
      renderCount,
      revealCount,
      viewStateCount,
      lastRows,
    }),
  };
}

async function runScenario(Runtime, options) {
  const harness = createHarness(Runtime, options);
  let error = "";
  try {
    await harness.run();
  } catch (caught) {
    error = String(caught);
  }
  return { ...harness.counts(), error };
}

const [baselineRuntime, candidateRuntime] = await Promise.all([
  importRuntime(baselineRoot),
  importRuntime(candidateRoot),
]);

const scenarios = {};
for (const [name, options] of Object.entries({
  firstOpen: { fileCount: 1_000 },
  existingOpen: { existing: true, fileCount: 1_000 },
  setViewStateFailure: { failSetViewState: true, fileCount: 1_000 },
  firstOpenRenderFailure: { failRender: true, fileCount: 1_000 },
  existingRenderFailure: { existing: true, failRender: true, fileCount: 1_000 },
})) {
  const baseline = await runScenario(baselineRuntime, options);
  const candidate = await runScenario(candidateRuntime, options);
  assert.deepEqual(candidate.lastRows, baseline.lastRows, `${name} changed rendered rows`);
  assert.equal(candidate.revealCount, baseline.revealCount, `${name} changed reveal behavior`);
  assert.equal(candidate.viewStateCount, baseline.viewStateCount, `${name} changed view-state behavior`);
  assert.equal(candidate.error, baseline.error, `${name} changed error behavior`);
  scenarios[name] = { baseline, candidate };
}

const benchmarkFiles = Array.from({ length: markdownFileCount }, (_, index) => ({
  path: `Notes/Benchmark ${index}.md`,
}));

function createBenchmarkHarness(Runtime) {
  const plugin = Object.create(Runtime.TPSWatchlistPlugin.prototype);
  let parseCount = 0;
  let renderCount = 0;
  let revealCount = 0;
  plugin.states = {};
  plugin.definitionFromFile = () => {
    parseCount += 1;
    return null;
  };
  plugin.app = {
    vault: { getMarkdownFiles: () => benchmarkFiles },
    workspace: {
      getLeavesOfType: () => [],
      getLeaf: () => {
        const leaf = {
          view: {},
          async setViewState() {
            const view = Object.create(Runtime.WatchlistView.prototype);
            view.plugin = plugin;
            view.render = async () => {
              renderCount += 1;
              plugin.getWatchRows();
            };
            leaf.view = view;
            await view.onOpen();
          },
        };
        return leaf;
      },
      revealLeaf: () => {
        revealCount += 1;
      },
    },
  };
  return {
    run: () => plugin.openDashboard(),
    counts: () => ({ parseCount, renderCount, revealCount }),
  };
}

const measurements = {
  baseline: [],
  candidate: [],
};
const totals = {
  baseline: { parseCount: 0, renderCount: 0, revealCount: 0 },
  candidate: { parseCount: 0, renderCount: 0, revealCount: 0 },
};

async function measure(label, Runtime) {
  const harness = createBenchmarkHarness(Runtime);
  const startedAt = performance.now();
  for (let index = 0; index < opensPerSample; index += 1) await harness.run();
  measurements[label].push(performance.now() - startedAt);
  const counts = harness.counts();
  for (const key of Object.keys(counts)) totals[label][key] += counts[key];
}

for (let sample = 0; sample < sampleCount; sample += 1) {
  if (sample % 2 === 0) {
    await measure("baseline", baselineRuntime);
    await measure("candidate", candidateRuntime);
  } else {
    await measure("candidate", candidateRuntime);
    await measure("baseline", baselineRuntime);
  }
}

function summarize(label) {
  const samples = [...measurements[label]].sort((left, right) => left - right);
  const percentile = (fraction) => samples[Math.min(samples.length - 1, Math.floor(samples.length * fraction))];
  return {
    ...totals[label],
    medianMs: percentile(0.5),
    p95Ms: percentile(0.95),
  };
}

const baselineSummary = summarize("baseline");
const candidateSummary = summarize("candidate");
if (expectOptimized) {
  const openCount = sampleCount * opensPerSample;
  assert.equal(scenarios.firstOpen.baseline.renderCount, 2, "exact baseline must render a new dashboard twice");
  assert.equal(scenarios.firstOpen.candidate.renderCount, 1, "candidate must render a new dashboard once");
  assert.equal(scenarios.existingOpen.baseline.renderCount, 1, "baseline existing dashboard must render once");
  assert.equal(scenarios.existingOpen.candidate.renderCount, 1, "candidate existing dashboard must render once");
  assert.equal(baselineSummary.renderCount, openCount * 2, "baseline benchmark render count changed");
  assert.equal(candidateSummary.renderCount, openCount, "candidate benchmark must render once per first open");
  assert.equal(baselineSummary.parseCount, candidateSummary.parseCount * 2, "candidate must halve Markdown parses");
  assert.equal(candidateSummary.revealCount, baselineSummary.revealCount, "candidate changed reveal count");
  assert.ok(candidateSummary.medianMs < baselineSummary.medianMs, "candidate median did not improve");
  assert.ok(candidateSummary.p95Ms < baselineSummary.p95Ms, "candidate p95 did not improve");
}

process.stdout.write(`${JSON.stringify({
  baselineRoot,
  candidateRoot,
  expectOptimized,
  scenarios,
  benchmark: {
    markdownFileCount,
    sampleCount,
    opensPerSample,
    baseline: baselineSummary,
    candidate: candidateSummary,
  },
}, null, 2)}\n`);
