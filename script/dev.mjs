import { watch } from "node:fs"
import { spawn } from "node:child_process"
import { fileURLToPath } from "node:url"

const root = fileURLToPath(new URL("../", import.meta.url))
let timer
let building = false
let pending = false

function build() {
  if (building) { pending = true; return }
  building = true
  console.log("Building local Subagent Statusline. OpenCode reloads changed local modules.")
  // Fixed command; no filenames or user input are interpolated into the shell.
  const child = spawn("pnpm run build", { cwd: root, shell: true, stdio: "inherit" })
  child.on("error", (error) => { console.error(error); process.exit(1) })
  child.on("exit", (code) => {
    building = false
    if (code !== 0) console.error("Build failed; fix the source before reloading OpenCode.")
    if (pending) { pending = false; build() }
  })
}

function changed() {
  clearTimeout(timer)
  timer = setTimeout(build, 250)
}

watch(new URL("../src/", import.meta.url), { recursive: true }, changed)
console.log("Watching src/. Ctrl+C stops development builds.")
build()
