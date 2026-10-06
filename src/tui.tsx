import { Plugin } from "@opencode/plugin/tui"
import { createEffect, createMemo, createSignal, For, onCleanup, Show } from "solid-js"
import { createSubagentTracker, formatDuration, formatTokens, type SubagentStatus } from "./subagents.js"

interface Options {
  maxItems: number
  showTokens: boolean
}

function readOptions(options: Plugin.Context["options"]): Options {
  const maxItems = typeof options.maxItems === "number" && Number.isFinite(options.maxItems)
    ? Math.min(50, Math.max(1, Math.floor(options.maxItems))) : 8
  return { maxItems, showTokens: options.showTokens !== false }
}

const icons: Record<SubagentStatus, string> = {
  running: "●",
  done: "✓",
  error: "×",
  interrupted: "‖",
  pending: "○",
}

function SubagentPanel(props: { context: Plugin.Context; sessionID: string; options: Options }) {
  const tracker = createSubagentTracker(props.context, props.sessionID)
  const theme = () => props.context.theme
  const [now, setNow] = createSignal(Date.now())
  const [expanded, setExpanded] = createSignal(false)
  const counts = createMemo(() => tracker.rows().reduce((result, row) => {
    result[row.status]++
    return result
  }, { running: 0, done: 0, error: 0, interrupted: 0, pending: 0 }))
  const running = createMemo(() => counts().running > 0)
  const visibleLimit = () => Math.max(props.options.maxItems, counts().running)
  const visible = createMemo(() => expanded() ? tracker.rows() : tracker.rows().slice(0, visibleLimit()))
  const hidden = () => tracker.rows().length - visible().length

  const color = (status: SubagentStatus) => {
    if (status === "running") return theme().text.feedback.warning.base
    if (status === "done") return theme().text.feedback.success.base
    if (status === "error") return theme().text.feedback.error.base
    return theme().text.muted
  }
  const summaryColor = (status: SubagentStatus) => counts()[status] > 0 ? color(status) : theme().text.muted

  createEffect(() => {
    if (!running()) return
    setNow(Date.now())
    const timer = setInterval(() => setNow(Date.now()), 1000)
    onCleanup(() => clearInterval(timer))
  })
  onCleanup(tracker.dispose)

  return (
    <Show when={tracker.rows().length > 0 || tracker.error()}>
      <box flexShrink={0} minWidth={0} marginBottom={1}>
        <text fg={theme().text.base}><b>Subagents</b></text>
        <Show when={tracker.rows().length > 0}>
          <text fg={theme().text.muted} wrapMode="word">
            <span style={{ fg: summaryColor("running") }}>● {counts().running} running</span>
            {" · "}
            <span style={{ fg: summaryColor("done") }}>✓ {counts().done} done</span>
            {" · "}
            <span style={{ fg: summaryColor("error") }}>× {counts().error} error</span>
          </text>
          <Show when={counts().pending > 0 || counts().interrupted > 0}>
            <text fg={theme().text.muted} wrapMode="word">
              {[
                counts().pending > 0 ? `○ ${counts().pending} pending` : "",
                counts().interrupted > 0 ? `‖ ${counts().interrupted} interrupted` : "",
              ].filter(Boolean).join(" · ")}
            </text>
          </Show>
        </Show>
        <Show when={tracker.error()}>
          <text
            fg={theme().text.feedback.error.base}
            wrapMode="word"
            onMouseUp={() => { void tracker.refresh() }}
          >
            {tracker.loading() ? "Retrying…" : "Could not load subagents · retry"}
          </text>
        </Show>
        <Show when={visible().length > 0}>
          <box minWidth={0} marginTop={1}>
            <For each={visible()}>
              {(row) => (
                <box minWidth={0}>
                  <box flexDirection="row" gap={1} minWidth={0}>
                    <text fg={color(row.status)} flexShrink={0}>{icons[row.status]}</text>
                    <text
                      fg={row.status === "error" ? color("error") : theme().text.base}
                      truncate
                      wrapMode="none"
                      flexGrow={1}
                      minWidth={0}
                      onMouseUp={() => props.context.ui.router.navigate({ type: "session", sessionID: row.id })}
                    >
                      {row.title}
                    </text>
                  </box>
                  <text fg={theme().text.muted} paddingLeft={2} wrapMode="none" truncate minWidth={0}>
                    ◷ {formatDuration(row.timing, running() ? now() : Date.now())}
                    {props.options.showTokens ? ` · ${formatTokens(row.tokens)} tok` : ""}
                  </text>
                </box>
              )}
            </For>
          </box>
        </Show>
        <Show when={hidden() > 0}>
          <text fg={theme().text.action.primary.base} marginTop={1} onMouseUp={() => setExpanded(true)}>
            +{hidden()} more
          </text>
        </Show>
        <Show when={expanded() && tracker.rows().length > visibleLimit()}>
          <text fg={theme().text.action.primary.base} marginTop={1} onMouseUp={() => setExpanded(false)}>
            Show fewer
          </text>
        </Show>
      </box>
    </Show>
  )
}

export default Plugin.define({
  id: "kodradev-opencode-subagent-statusline",
  setup(context) {
    const options = readOptions(context.options)
    return context.ui.slot({
      prepend: "sidebar.content",
      render: (input) => (
        <Show when={input.sessionID} keyed>
          {(sessionID) => <SubagentPanel context={context} sessionID={sessionID} options={options} />}
        </Show>
      ),
    })
  },
})
