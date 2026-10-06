import { mkdir, readFile, writeFile } from "node:fs/promises"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const transform = new URL("./scripts/solid-transform.js", import.meta.resolve("@opentui/solid"))
const { transformSolidSource } = await import(transform)
const filename = resolve(root, "src/tui.tsx")
const code = await readFile(filename, "utf8")

await mkdir(resolve(root, "dist"), { recursive: true })
await writeFile(resolve(root, "dist/tui.js"), await transformSolidSource(code, { filename }))
