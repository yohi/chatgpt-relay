import { readFile } from "node:fs/promises"
import { resolve } from "node:path"
import { describe, expect, it } from "vitest"

type ExtensionManifest = {
  manifest_version: number
  minimum_chrome_version: string
  permissions: string[]
  host_permissions: string[]
  content_scripts: { matches: string[] }[]
}

async function readManifest(): Promise<ExtensionManifest> {
  const contents = await readFile(resolve(process.cwd(), "public/manifest.json"), "utf8")
  return JSON.parse(contents) as ExtensionManifest
}

describe("extension manifest contract", () => {
  it("pins Chrome 145 and the approved permission boundary", async () => {
    const manifest = await readManifest()

    expect(manifest.manifest_version).toBe(3)
    expect(manifest.minimum_chrome_version).toBe("145")
    expect(manifest.permissions).toEqual(["storage"])
  })

  it("does not request forbidden MVP permissions", async () => {
    const manifest = await readManifest()
    const forbiddenPermissions = ["tabs", "activeTab", "scripting", "<all_urls>", "webRequest", "debugger"]

    expect(manifest.permissions).not.toEqual(expect.arrayContaining(forbiddenPermissions))
    expect(manifest.host_permissions).not.toContain("<all_urls>")
  })

  it("injects the static content script only on chatgpt.com", async () => {
    const manifest = await readManifest()

    expect(manifest.host_permissions).toEqual(["https://chatgpt.com/*"])
    expect(manifest.content_scripts.map(({ matches }) => matches)).toEqual([
      ["https://chatgpt.com/*"],
    ])
  })
})
