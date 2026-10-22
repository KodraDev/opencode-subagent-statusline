import type { OpenCodeEvent, SessionInfo, TokenUsageInfo } from "@opencode/client"
import type { Plugin } from "@opencode/plugin/tui"
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
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
  /** Whether a start event was observed. Without one, the duration is unknown. */
  started: boolean
}

type FailureError = Extract<ExecutionEvent, { type: "session.execution.failed" }>["data"]["error"]

/** Transient per-session details that come from non-timing events. */
interface Detail {
  error: string | undefined
  retry: string | undefined
}

export interface Subagent {
  id: string
  title: string
  model: string | undefined
  status: SubagentStatus
  tokens: number
  cost: number
  timing: Timing | undefined
  error: string | undefined
  retry: string | undefined
}

function emptyTiming(): Timing {
  return { elapsed: 0, startedAt: undefined, sequence: -1, status: "pending", started: false }
}

function isExecution(event: { type: string }): event is ExecutionEvent {
  return event.type === "session.execution.started"
    || event.type === "session.execution.succeeded"
    || event.type === "session.execution.failed"
    || event.type === "session.execution.interrupted"
}

function applyExecution(timing: Timing, event: ExecutionEvent): Timing {
  // Callers supply events in durable order, so replay and live delivery converge.
  const next = { ...timing, sequence: event.durable.seq }
  if (event.type === "session.execution.started") {
    next.startedAt ??= event.created
    next.started = true
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
  if (timing === undefined || timing.sequence < 0) return "--:--"
  if (!timing.started && timing.elapsed <= 0) return "--:--"
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

export function formatCost(cost: number): string {
  if (!Number.isFinite(cost) || cost <= 0) return "$0.00"
  const decimals = cost < 0.0001 ? 6 : cost < 0.01 ? 4 : 2
  const [whole, fraction = ""] = cost.toFixed(decimals).split(".")
  const trimmed = fraction.replace(/0+$/, "")
  return `$${whole}.${trimmed.length >= 2 ? trimmed : trimmed.padEnd(2, "0")}`
}

function emptyDetail(): Detail {
  return { error: undefined, retry: undefined }
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`
}

function errorText(error: FailureError): string {
  const message = displayText(error.message) || displayText(error.type)
  const tagged = error.status === undefined ? message : `${message} (${error.status})`
  return truncate(tagged || "failed", 90)
}

function retryText(attempt: number, at: number, now: number): string {
  const seconds = Math.max(0, Math.ceil((at - now) / 1000))
  return seconds > 0 ? `retry ${attempt} · ${seconds}s` : `retry ${attempt}`
}

// Shared across tracker instances so remounting the sidebar does not erase times.
const histories = new Map<string, Map<number, ExecutionEvent>>()
const checkpoints = new Map<string, number>()

// Execution events are only delivered live: the durable log endpoint does not
// replay history, and reloading the plugin module drops in-memory state. Persist
// the reduced timing so totals survive TUI restarts and plugin reloads.
const timingFile = join(homedir(), ".local", "share", "opencode", "subagent-statusline", "timings.json")
const lastSeen = new Map<string, number>()

function loadTimings(): Map<string, Timing> {
  const result = new Map<string, Timing>()
  try {
    const parsed = JSON.parse(readFileSync(timingFile, "utf8")) as { sessions?: Record<string, Partial<Timing>> }
    for (const [id, value] of Object.entries(parsed.sessions ?? {})) {
      if (typeof value.elapsed !== "number" || typeof value.sequence !== "number") continue
      if (typeof value.started !== "boolean" || typeof value.status !== "string") continue
      result.set(id, {
        elapsed: Math.max(0, value.elapsed),
        startedAt: typeof value.startedAt === "number" ? value.startedAt : undefined,
        sequence: value.sequence,
        status: value.status as SubagentStatus,
        started: value.started,
      })
      lastSeen.set(id, Date.now())
    }
  } catch {
    // Missing or corrupt state only means times start empty.
  }
  return result
}

const timings = loadTimings()

function sameTiming(a: Timing | undefined, b: Timing): boolean {
  return a !== undefined && a.elapsed === b.elapsed && a.startedAt === b.startedAt
    && a.sequence === b.sequence && a.status === b.status && a.started === b.started
}

function saveTimings() {
  try {
    const entries = [...timings.entries()]
      .sort((a, b) => (lastSeen.get(b[0]) ?? 0) - (lastSeen.get(a[0]) ?? 0))
      .slice(0, 200)
    if (entries.length === 0) return
    const directory = join(homedir(), ".local", "share", "opencode", "subagent-statusline")
    mkdirSync(directory, { recursive: true })
    const temporary = `${timingFile}.tmp`
    writeFileSync(temporary, JSON.stringify({ version: 1, sessions: Object.fromEntries(entries) }))
    renameSync(temporary, timingFile)
  } catch {
    // Persistence is best effort; the panel still works from live events.
  }
}

export function createSubagentTracker(context: Plugin.Context, sessionID: string) {
  const controller = new AbortController()
  const [state, setState] = createStore<{
    sessions: Record<string, SessionInfo>
    timing: Record<string, Timing>
    details: Record<string, Detail>
    loading: boolean
    error: boolean
  }>({ sessions: {}, timing: {}, details: {}, loading: false, error: false })
  const deleted = new Set<string>()
  const queued = new Set<string>()
  const queue: string[] = []
  const retryTimers = new Map<string, ReturnType<typeof setTimeout>>()
  const retryAttempts = new Map<string, number>()
  const rescanned = new Set<string>()
  let workers = 0
  let discovering = false
  let disposed = false
  let createdDuringDiscovery = new Set<string>()

  const belongs = (id: string) => id === sessionID || state.sessions[id] !== undefined

  function remember(info: SessionInfo) {
    if (disposed || deleted.has(info.id) || info.id === sessionID) return
    const current = state.sessions[info.id]
    if (!current || current.time.updated <= info.time.updated) setState("sessions", info.id, info)
    if (info.outcome !== undefined) {
      const finalized = finalizeTiming(info.id, info)
      if (finalized !== undefined) setState("timing", info.id, finalized)
    } else if (timings.has(info.id) && state.timing[info.id] === undefined) {
      // Sessions seen before this panel mounted keep their accumulated time.
      setState("timing", info.id, timingOf(info.id))
    }
    enqueueTiming(info.id)
  }

  const syncing = new Set<string>()

  // The live event stream does not replay history, and some clients never receive
  // usage updates for child sessions. Pull the authoritative session info at step
  // boundaries so tokens and cost do not stay at zero.
  async function syncInfo(id: string) {
    if (disposed || deleted.has(id) || id === sessionID || syncing.has(id)) return
    syncing.add(id)
    try {
      const info = await context.client.session.get({ sessionID: id }, { signal: controller.signal })
      if (disposed || deleted.has(id) || info.id === sessionID) return
      remember(info)
      setState("sessions", id, { cost: info.cost, tokens: info.tokens })
      if (info.outcome !== undefined) {
        const finalized = finalizeTiming(id, info)
        if (finalized !== undefined) setState("timing", id, finalized)
      }
    } catch {
      // A transient read failure is harmless: the next step or idle event retries.
    } finally {
      syncing.delete(id)
    }
  }

  function record(id: string, event: ExecutionEvent): boolean {
    let history = histories.get(id)
    if (!history) {
      history = new Map()
      histories.set(id, history)
    }
    if (history.has(event.durable.seq)) return false
    history.set(event.durable.seq, event)
    return true
  }

  function timingOf(id: string): Timing {
    const history = histories.get(id)
    let timing = emptyTiming()
    if (history) {
      for (const event of [...history.values()].sort((a, b) => a.durable.seq - b.durable.seq)) {
        timing = applyExecution(timing, event)
      }
    }
    const previous = timings.get(id)
    if (previous !== undefined) {
      timing = timing.sequence < 0 ? previous : {
        ...timing,
        elapsed: Math.max(previous.elapsed, timing.elapsed),
        sequence: Math.max(previous.sequence, timing.sequence),
        started: previous.started || timing.started,
        startedAt: timing.startedAt ?? (timing.status === "running" ? previous.startedAt : undefined),
      }
    }
    lastSeen.set(id, Date.now())
    if (!sameTiming(previous, timing)) {
      timings.set(id, timing)
      saveTimings()
    }
    return timing
  }

  function finalizeTiming(id: string, info: SessionInfo): Timing | undefined {
    const timing = timings.get(id)
    if (timing === undefined || info.outcome === undefined) return undefined
    const end = info.time.idle ?? info.time.updated
    const next: Timing = {
      ...timing,
      elapsed: timing.startedAt === undefined ? timing.elapsed : timing.elapsed + Math.max(0, end - timing.startedAt),
      startedAt: undefined,
      status: outcomeStatus(info.outcome),
    }
    if (!sameTiming(timing, next)) {
      timings.set(id, next)
      lastSeen.set(id, Date.now())
      saveTimings()
    }
    return next
  }

  function patchDetail(id: string, patch: Partial<Detail>) {
    if (disposed || deleted.has(id)) return
    setState("details", id, (current) => ({ ...(current ?? emptyDetail()), ...patch }))
  }

  function clearRetry(id: string) {
    const timer = retryTimers.get(id)
    if (timer !== undefined) clearTimeout(timer)
    retryTimers.delete(id)
    retryAttempts.delete(id)
  }

  function scheduleRetry(id: string) {
    if (disposed || deleted.has(id) || retryTimers.has(id)) return
    const attempts = (retryAttempts.get(id) ?? 0) + 1
    retryAttempts.set(id, attempts)
    if (attempts > 6) return
    const delay = Math.min(1000 * 2 ** (attempts - 1), 30_000)
    retryTimers.set(id, setTimeout(() => {
      retryTimers.delete(id)
      if (!disposed && !deleted.has(id)) enqueueTiming(id, true)
    }, delay))
  }

  async function replay(id: string) {
    const checkpoint = checkpoints.get(id)
    let received = -1
    try {
      for await (const event of context.client.session.log({
        sessionID: id,
        follow: false,
        ...(checkpoint !== undefined ? { after: checkpoint } : {}),
      }, { signal: controller.signal })) {
        if (!isExecution(event)) continue
        received = Math.max(received, event.durable.seq)
        record(id, event)
      }
      if (disposed || deleted.has(id)) return
      if (received < 0) {
        // A session that already ran should have history. Keep retrying with backoff
        // while the durable log catches up instead of leaving the duration unknown.
        const finished = context.data.session.get(id)?.outcome !== undefined
          || state.sessions[id]?.outcome !== undefined
        if (!histories.get(id)?.size && finished) scheduleRetry(id)
        else clearRetry(id)
        return
      }
      clearRetry(id)
      rescanned.delete(id)
      checkpoints.set(id, received)
      setState("timing", id, timingOf(id))
    } catch {
      if (disposed || deleted.has(id)) return
      // A cursor can outlive the events it points at. Re-read that session once from
      // the beginning instead of retrying the same failing cursor forever.
      if (checkpoint !== undefined && !rescanned.has(id)) {
        rescanned.add(id)
        checkpoints.delete(id)
      }
      // Keep the timing assembled from live or partially read events; a failed read
      // must not erase it.
      if (received >= 0) setState("timing", id, timingOf(id))
      scheduleRetry(id)
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
    if (disposed || queued.has(id) || (!force && checkpoints.has(id))) return
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
        const stale: string[] = []
        setState("sessions", produce((sessions) => {
          for (const id of Object.keys(sessions)) {
            if (!found.has(id) && !createdDuringDiscovery.has(id)) {
              stale.push(id)
              delete sessions[id]
            }
          }
        }))
        for (const id of stale) {
          histories.delete(id)
          checkpoints.delete(id)
        }
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
    histories.delete(id)
    timings.delete(id)
    lastSeen.delete(id)
    saveTimings()
    rescanned.delete(id)
    clearRetry(id)
    const children = Object.values(state.sessions).filter((info) => info.parentID === id)
    for (const child of children) remove(child.id)
    setState("sessions", produce((sessions) => { delete sessions[id] }))
    setState("timing", produce((timing) => { delete timing[id] }))
    setState("details", produce((details) => { delete details[id] }))
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
      if (record(id, event)) setState("timing", id, timingOf(id))
      if (event.type === "session.execution.failed") {
        patchDetail(id, { retry: undefined, error: errorText(event.data.error) })
      } else if (event.type === "session.execution.started") {
        patchDetail(id, { error: undefined, retry: undefined })
      } else {
        patchDetail(id, { retry: undefined, error: undefined })
      }
      // Backfill history the first time this session runs. Live execution events can
      // arrive before the initial read, so a later start event must trigger a retry.
      if (!checkpoints.has(id)) enqueueTiming(id)
      if (event.type !== "session.execution.started") void syncInfo(id)
      return
    }
    if (event.type === "session.status") {
      const status = event.data.status
      patchDetail(id, status.type === "retry"
        ? { retry: retryText(status.attempt, status.next, event.created) }
        : { retry: undefined })
      return
    }
    if (event.type === "session.retry.scheduled") {
      patchDetail(id, { retry: retryText(event.data.attempt, event.data.at, event.created) })
      return
    }
    if (event.type === "session.idle") {
      patchDetail(id, { retry: undefined })
      void syncInfo(id)
      return
    }
    if (event.type === "session.step.ended") {
      void syncInfo(id)
      return
    }
    if (event.type === "session.renamed") setState("sessions", id, "title", event.data.title)
    else if (event.type === "session.agent.selected") setState("sessions", id, "agent", event.data.agent)
    else if (event.type === "session.model.selected") setState("sessions", id, "model", event.data.model)
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
      const detail = state.details[info.id]
      const status = context.data.session.status(info.id) === "running" ? "running"
        : info.outcome !== undefined ? outcomeStatus(info.outcome)
        : timing && timing.sequence >= 0 ? timing.status
        : "pending"
      return {
        id: info.id,
        title: displayText(info.title ?? "") || "Subagent",
        model: info.model === undefined ? undefined : displayText(info.model.id),
        status,
        // Usage is cumulative and only grows. Taking the largest value seen keeps a
        // stale snapshot from hiding tokens or cost reported by the live session.
        tokens: Math.max(totalTokens(info.tokens), totalTokens(snapshot.tokens), cached === undefined ? 0 : totalTokens(cached.tokens)),
        cost: Math.max(info.cost, snapshot.cost, cached?.cost ?? 0),
        timing,
        error: status === "error" ? detail?.error : undefined,
        retry: status === "running" ? detail?.retry : undefined,
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
      for (const timer of retryTimers.values()) clearTimeout(timer)
      retryTimers.clear()
      retryAttempts.clear()
    },
  }
}
