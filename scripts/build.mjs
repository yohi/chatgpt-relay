import { cp, mkdir, rm } from "node:fs/promises"
import { build } from "esbuild"

await rm("dist", { recursive: true, force: true })
await mkdir("dist", { recursive: true })

await build({
  entryPoints: {
    background: "src/background/service-worker.ts",
    content: "src/content/index.ts",
    popup: "src/popup/popup.ts",
  },
  bundle: true,
  entryNames: "[name]",
  format: "iife",
  outdir: "dist",
  platform: "browser",
  target: "chrome145",
})

await cp("public/manifest.json", "dist/manifest.json")
await cp("src/popup/popup.html", "dist/popup.html")
