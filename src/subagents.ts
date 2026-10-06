import type { OpenCodeEvent, SessionInfo, TokenUsageInfo } from "@opencode/client"
import type { Plugin } from "@opencode/plugin/tui"
import { batch, createMemo } from "solid-js"
import { createStore, produce } from "solid-js/store"

export type SubagentStatus = "running" | "done" | "error" | "interrupted" | "pending"

type ExecutionEvent = Extract<OpenCodeEvent, {
  type: "session.execution.started" | "session.execution.succeeded" | "session.execution.failed" | "session.execution.interrupted"
}>

interface Timing {
  elapsed: number
  startedAt: number | undefined
  sequence: number
  status: SubagentStatus
  ready: boolean
}

export interface Subagent {
  id: string
  title: string
  agent: string | undefined
  status: SubagentStatus
  tokens: number
  timing: Timing | undefined
}

function emptyTiming(): Timing {
  return { elapsed: 0, startedAt: undefined, sequence: -1, status: "pending", ready: false }
}

function isExecution(event: { type: string }): event is ExecutionEvent {
  return event.type === "session.execution.started"
    || event.type === "session.execution.succeeded"
    || event.type === "session.execution.failed"
    || event.type === "session.execution.interrupted"
}

function applyExecution(timing: Timing, event: ExecutionEvent): Timing {
  // Durable sequence numbers also deduplicate overlap between replay and live events.
  if (event.durable.seq <= timing.sequence) return timing
  const next = { ...timing, sequence: event.durable.seq }
  if (event.type === "session.execution.started") {
    next.startedAt ??= event.created
    next.status = "running"
    return next
  }
  if (next.startedAt !== undefined) next.elapsed += Math.max(0, event.created - next.startedAt)
  next.startedAt = undefined
  next.status = event.type === "session.execution.succeeded" ? "done"
    : event.type === "session.execution.failed" ? "error" : "interrupted"
  return next
}

function outcomeStatus(outcome: SessionInfo["outcome"]): SubagentStatus {
  return outcome === "succeeded" ? "done" : outcome === "failed" ? "error"
    : outcome === "interrupted" ? "interrupted" : "pending"
}

function totalTokens(tokens: TokenUsageInfo): number {
  // Same definition as OpenCode's TokenUsage.total, including both cache counters.
  return Math.max(0, tokens.input + tokens.output + tokens.reasoning + tokens.cache.read + tokens.cache.write)
}

export function displayText(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").replace(/\s+/g, " ").trim()
}

export function formatDuration(timing: Timing | undefined, now: number): string {
  if (!timing?.ready || timing.sequence < 0) return "--:--"
  const seconds = Math.floor((timing.elapsed + (timing.startedAt === undefined ? 0 : Math.max(0, now - timing.startedAt))) / 1000)
  const minutes = Math.floor(seconds / 60)
  const tail = String(seconds % 60).padStart(2, "0")
  if (minutes < 60) return `${String(minutes).padStart(2, "0")}:${tail}`
  return `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, "0")}:${tail}`
}

export function formatTokens(tokens: number): string {
  if (tokens < 1000) return String(Math.floor(tokens))
  const divisor = tokens < 1_000_000 ? 1000 : 1_000_000
  return `${(tokens / divisor).toFixed(1).replace(/\.0$/, "")}${divisor === 1000 ? "k" : "m"}`
}

export function createSubagentTracker(context: Plugin.Context, sessionID: string) {
  const controller = new AbortController()
  const [state, setState] = createStore<{
    sessions: Record<string, SessionInfo>
    timing: Record<string, Timing>
    loading: boolean
    error: boolean
  }>({ sessions: {}, timing: {}, loading: false, error: false })
  const deleted = new Set<string>()
  const queued = new Set<string>()
  const queue: string[] = []
  const replaying = new Map<string, ExecutionEvent[]>()
  // Only successful historical reads advance this cursor. Live events may arrive
  // while a session waits for a replay worker, after a gap in the connection.
  const checkpoints = new Map<string, Timing>()
  let workers = 0
  let discovering = false
  let disposed = false
  let createdDuringDiscovery = new Set<string>()

  const belongs = (id: string) => id === sessionID || state.sessions[id] !== undefined

  function remember(info: SessionInfo) {
    if (disposed || deleted.has(info.id) || info.id === sessionID) return
    const current = state.sessions[info.id]
    if (!current || current.time.updated <= info.time.updated) setState("sessions", info.id, info)
    enqueueTiming(info.id)
  }

  async function replay(id: string) {
    const buffer: ExecutionEvent[] = []
    replaying.set(id, buffer)
    const previous = checkpoints.get(id)
    let timing = previous?.ready ? { ...previous } : emptyTiming()
    try {
      for await (const event of context.client.session.log({
        sessionID: id,
        follow: false,
        ...(timing.sequence >= 0 ? { after: timing.sequence } : {}),
      }, { signal: controller.signal })) {
        if (isExecution(event)) timing = applyExecution(timing, event)
      }
      for (const event of buffer.sort((a, b) => a.durable.seq - b.durable.seq)) timing = applyExecution(timing, event)
      if (!disposed && !deleted.has(id)) {
        // Keep independent copies: Solid store updates must not mutate the cursor snapshot.
        checkpoints.set(id, { ...timing, ready: true })
        setState("timing", id, { ...timing, ready: true })
      }
    } catch {
      // Live status remains useful even if history is unavailable. Never invent a duration.
      if (!disposed && !deleted.has(id)) setState("timing", id, (current) => ({ ...(current ?? emptyTiming()), ready: false }))
    } finally {
      replaying.delete(id)
    }
  }

  function pump() {
    while (!disposed && workers < 4 && queue.length > 0) {
      const id = queue.shift()!
      if (deleted.has(id)) {
        queued.delete(id)
        continue
      }
      workers++
      void replay(id).finally(() => {
        workers--
        queued.delete(id)
        pump()
      })
    }
  }

  function enqueueTiming(id: string, force = false) {
    if (disposed || queued.has(id) || (!force && state.timing[id]?.ready)) return
    queued.add(id)
    queue.push(id)
    pump()
  }

  async function refresh() {
    if (disposed || discovering) return
    discovering = true
    createdDuringDiscovery = new Set()
    setState("loading", true)
    for (const id of Object.keys(state.sessions)) enqueueTiming(id, true)
    const found = new Set<string>()
    const parents = [sessionID]
    const visited = new Set<string>()
    try {
      // parentID is a public server-side filter. Read every page, then descend.
      while (parents.length > 0 && !disposed) {
        const parentID = parents.shift()!
        if (visited.has(parentID) || deleted.has(parentID)) continue
        visited.add(parentID)
        let cursor: string | undefined
        const cursors = new Set<string>()
        do {
          const page = await context.client.session.list({ parentID, limit: 100, order: "desc", ...(cursor ? { cursor } : {}) }, { signal: controller.signal })
          if (disposed) return
          if (deleted.has(parentID)) break
          batch(() => {
            for (const info of page.data) {
              if (info.parentID !== parentID || deleted.has(info.id) || info.id === sessionID) continue
              found.add(info.id)
              remember(info)
              parents.push(info.id)
            }
          })
          cursor = page.cursor.next ?? undefined
          if (cursor && cursors.has(cursor)) throw new Error("Repeated session cursor")
          if (cursor) cursors.add(cursor)
        } while (cursor)
      }
      if (!disposed) {
        setState("sessions", produce((sessions) => {
          for (const id of Object.keys(sessions)) {
            if (!found.has(id) && !createdDuringDiscovery.has(id)) delete sessions[id]
          }
        }))
        setState("error", false)
      }
    } catch {
      if (!disposed) setState("error", true)
    } finally {
      discovering = false
      if (!disposed) setState("loading", false)
    }
  }

  function remove(id: string) {
    if (deleted.has(id)) return
    deleted.add(id)
    checkpoints.delete(id)
    const children = Object.values(state.sessions).filter((info) => info.parentID === id)
    for (const child of children) remove(child.id)
    setState("sessions", produce((sessions) => { delete sessions[id] }))
    setState("timing", produce((timing) => { delete timing[id] }))
  }

  const unsubscribe = context.data.listen(({ details: event }) => {
    if (disposed) return
    if (event.type === "server.connected") {
      void refresh()
      return
    }
    if (event.type === "session.deleted") {
      // Remember unknown IDs too: an in-flight list may still contain this session.
      batch(() => remove(event.data.sessionID))
      return
    }
    if (event.type === "session.created") {
      const { data } = event
      if (!data.parentID || !belongs(data.parentID) || deleted.has(data.parentID) || deleted.has(data.sessionID)) return
      createdDuringDiscovery.add(data.sessionID)
      remember({
        id: data.sessionID,
        parentID: data.parentID,
        projectID: data.projectID,
        location: data.location,
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        time: { created: event.created, updated: event.created },
        ...(data.title !== undefined ? { title: data.title } : {}),
        ...(data.agent !== undefined ? { agent: data.agent } : {}),
      })
      return
    }
    if (!("sessionID" in event.data) || typeof event.data.sessionID !== "string") return
    const id = event.data.sessionID
    if (!belongs(id) || id === sessionID || deleted.has(id)) return
    if (isExecution(event)) {
      replaying.get(id)?.push(event)
      setState("timing", id, (timing) => applyExecution(timing ?? emptyTiming(), event))
      return
    }
    if (event.type === "session.renamed") setState("sessions", id, "title", event.data.title)
    else if (event.type === "session.agent.selected") setState("sessions", id, "agent", event.data.agent)
    else if (event.type === "session.usage.updated") {
      setState("sessions", id, { cost: event.data.cost, tokens: event.data.tokens })
    } else return
    setState("sessions", id, "time", "updated", event.created)
  })

  const rows = createMemo<Subagent[]>(() => {
    const rank: Record<SubagentStatus, number> = { running: 0, pending: 1, error: 2, interrupted: 3, done: 4 }
    return Object.values(state.sessions).map((snapshot) => {
      const cached = context.data.session.get(snapshot.id)
      const info = cached && cached.time.updated >= snapshot.time.updated ? cached : snapshot
      const timing = state.timing[info.id]
      const status = context.data.session.status(info.id) === "running" ? "running"
        : timing && timing.sequence >= 0 ? timing.status : outcomeStatus(info.outcome)
      return {
        id: info.id,
        title: displayText(info.title ?? "") || "Subagent",
        agent: info.agent === undefined ? undefined : displayText(info.agent),
        status,
        tokens: totalTokens(info.tokens),
        timing,
        created: info.time.created,
      }
    }).sort((a, b) => rank[a.status] - rank[b.status] || b.created - a.created || a.id.localeCompare(b.id))
  })

  void refresh()
  return {
    rows,
    loading: () => state.loading,
    error: () => state.error,
    refresh,
    dispose() {
      disposed = true
      unsubscribe()
      controller.abort()
      queue.length = 0
    },
  }
}
