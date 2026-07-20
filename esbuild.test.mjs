import esbuild from "esbuild";
import fs from "fs";

fs.mkdirSync(".test", { recursive: true });
await esbuild.build({
  entryPoints: [
    "tests/watch-core.test.ts",
    "tests/notification-delivery.test.ts",
    "tests/ai-gateway-integration.test.ts",
  ],
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node18",
  outdir: ".test",
  outExtension: { ".js": ".cjs" },
});
