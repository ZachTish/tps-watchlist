import esbuild from "esbuild";
import fs from "fs";
import path from "path";

fs.mkdirSync(".test", { recursive: true });
await esbuild.build({
  entryPoints: ["tests/watch-core.test.ts"],
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node18",
  outfile: ".test/watch-core.test.cjs",
  plugins: [{
    name: "obsidian-test-stub",
    setup(build) {
      build.onResolve({ filter: /^obsidian$/ }, () => ({
        path: path.resolve("tests/obsidian-runtime-stub.ts"),
      }));
    },
  }],
});
