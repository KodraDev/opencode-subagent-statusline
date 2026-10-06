import { Plugin } from "@opencode/plugin"

// The server entrypoint enables project-scoped loading of the companion TUI.
// All functionality lives in ./tui; no server tools or hooks are registered.
export default Plugin.define({
  id: "kodradev-opencode-subagent-statusline",
  setup() {},
})
