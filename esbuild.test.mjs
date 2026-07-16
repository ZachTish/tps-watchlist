import esbuild from "esbuild";
import fs from "fs";

fs.mkdirSync(".test", { recursive: true });
await esbuild.build({
  entryPoints: ["tests/watch-core.test.ts"],
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node18",
  outfile: ".test/watch-core.test.cjs",
});
