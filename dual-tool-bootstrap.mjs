/**
 * Dual-constraint tool bootstrap with multi-turn warmup cap schedule.
 *
 * Combines TWO anchors on the first model request, then extends the anchor
 * across multiple turns via a configurable cap schedule to build trajectory
 * inertia (not just a one-shot first-round lock):
 *
 *   Anchor 1 — Tool schema. The first request exposes exactly the Minimal
 *   preset's pair (persistent `bash` + `str_replace_editor`), byte-identical
 *   to the official Minimal composition. Issue #11 measured this schema
 *   anchoring 5/5 at adapter-default maxTokens while every standard-family
 *   schema fell into standard-like behavior 11/11.
 *
 *   Anchor 2 — Output budget. The first request is capped at
 *   `bootstrapMaxTokens` tokens (default 1024) to force a concise
 *   "We need to..." style first reasoning chain — issue #11 measured
 *   1024 producing that style in 26/32 runs vs 0/5 at 256000.
 *
 *   Multi-turn cap schedule (`capSchedule`, the inertia extension):
 *   instead of releasing the cap the moment the session promotes, the cap
 *   follows a per-turn schedule so the model keeps experiencing
 *   "tight budget + full tools" for several turns. This builds style
 *   inertia: the trajectory accumulates "We need..."-style turns, and the
 *   model conditions on that history. The cap steps up gradually (e.g.
 *   1024 → 4096 → release) rather than jumping from 1024 straight to the
 *   adapter default, so the transition is smooth. Turns are counted
 *   epoch-aware (per compaction boundary), so a mid-session compaction
 *   restarts the schedule — the post-compaction "second first request"
 *   gets the same anchoring treatment.
 *
 *   Plus context strip — the auto-injected AGENTS.md workspace digest
 *   (`agent-instructions`) and the ~9KB skill catalog reminder
 *   (`skill-catalog`) are stripped from the first request. The full
 *   Standard context returns from request #2 on.
 *
 * Promotion (default `promoteOn: either`): the first durable `tool/call`
 * OR the first `assistant/message`, whichever comes first. Request #1
 * always sees the bootstrap catalog; request #2 always sees the released
 * catalog. The cap schedule is independent of promotion: it governs the
 * output budget per turn regardless of which tool catalog is visible.
 *
 * Post-promotion (configurable via `postPromotionMode`):
 *   - `full` (default): release the FULL assembled Standard catalog —
 *     25 tools, no resident-set narrowing. Combined with the multi-turn
 *     cap schedule, this tests the hypothesis that style inertia from
 *     several tight-budget turns is enough to keep the trajectory
 *     anchored even when the full catalog is visible.
 *   - `resident`: the upstream repo's safety mode — narrow to the
 *     bootstrap pair + the three discovery tools + whatever the model
 *     explicitly unlocked via `dev_tool_search` (if mounted).
 *
 * Compaction (epoch-aware): after `compaction/end` the session falls back
 * to the controlled phase — bootstrap pair + `compactionTools` — until a
 * NEW durable promotion signal exists past the boundary. The cap schedule
 * also restarts at turn 1 of the new epoch. Subagents always see the full
 * catalog.
 *
 * Robustness:
 *  - Promotion decisions memoized per session for the process lifetime;
 *    the durable event scan runs once per session per process, then O(1).
 *  - Subagents (delegationDepth > 0) always see the full catalog and are
 *    exempt from the cap schedule (their first request must be able to
 *    call tools freely).
 *  - Missing bootstrap tool degrades to the full catalog with a one-time
 *    warning; never bricks a session.
 *  - The pre-step context filter degrades to "keep everything" on failure.
 *  - Invalid config (bad tool lists, unknown `promoteOn`, malformed
 *    `suppressedContextSources`, non-positive `bootstrapMaxTokens`,
 *    unknown `postPromotionMode`, malformed `capSchedule`) fails at
 *    preset mount, where it is visible and fixable.
 */

import { createEpochPromotion } from './compaction-epoch.mjs'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'dual-tool-bootstrap'

/** Deliberately no inject list: listeners only touch services at event time. */
export const inject = []

/** Durable session event types that count as a promotion signal per mode. */
const PROMOTE_EVENTS = {
  'tool-call': ['tool/call'],
  'assistant-message': ['assistant/message'],
  either: ['tool/call', 'assistant/message'],
}

/** Default bootstrap tool pair (the official Minimal preset's exact pair). */
const DEFAULT_BOOTSTRAP_TOOLS = ['bash', 'str_replace_editor']

/**
 * Default first-request output cap. This is the user's dual-constraint addition:
 * issue #11 measured 1024 producing "We need..." style first lines in 26/32
 * runs vs 0/5 at 256000 (independent of tool description). Combined with the
 * Minimal tool pair, the two anchors lock the first-token trajectory.
 */
const DEFAULT_BOOTSTRAP_MAX_TOKENS = 1024

/** Default suppressed context sources (the two Standard-only auto-injections). */
const DEFAULT_SUPPRESSED_SOURCES = ['skill-catalog', 'agent-instructions']

/** Default post-promotion tool release mode. */
const DEFAULT_POST_PROMOTION_MODE = 'full'

/** Discovery tools the upstream repo keeps resident (only used in `resident` mode). */
const RESIDENT_DISCOVERY_TOOLS = ['dev_tool_search', 'skill_search', 'skill_load']

function stringList(value, field) {
  if (!Array.isArray(value) || value.length === 0 || value.some((item) => typeof item !== 'string' || item.length === 0)) {
    throw new TypeError(`${name}: ${field} must be a non-empty array of non-empty strings`)
  }
  return [...new Set(value)]
}

function stringListOrEmpty(value, field) {
  if (value === undefined) return []
  return stringList(value, field)
}

function parsePromoteOn(value) {
  if (value === undefined || value === 'either') return PROMOTE_EVENTS.either
  if (value === 'tool-call' || value === 'assistant-message') return PROMOTE_EVENTS[value]
  throw new TypeError(`${name}: promoteOn must be one of "tool-call", "assistant-message", "either"; got ${JSON.stringify(value)}`)
}

function sourceList(value, field, fallback) {
  if (value === undefined) return new Set(fallback)
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || item.length === 0)) {
    throw new TypeError(`${name}: ${field} must be an array of non-empty strings`)
  }
  return new Set(value)
}

function optionalPositiveInt(value, field) {
  if (value === undefined) return DEFAULT_BOOTSTRAP_MAX_TOKENS
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${name}: ${field} must be a positive safe integer`)
  }
  return value
}

function parsePostPromotionMode(value) {
  if (value === undefined) return DEFAULT_POST_PROMOTION_MODE
  if (value === 'full' || value === 'resident') return value
  throw new TypeError(`${name}: postPromotionMode must be one of "full", "resident"; got ${JSON.stringify(value)}`)
}

/**
 * Parse the per-turn cap schedule.
 *
 * Format: an object mapping turn number (1-based) to maxTokens. Turns not
 * listed release the cap (the adapter default flows). Example:
 *   { 1: 1024, 2: 1024, 3: 4096 }
 * means turn 1 and 2 are capped at 1024, turn 3 at 4096, turn 4+ released.
 *
 * When `undefined`, the schedule degrades to the single-cap legacy mode:
 * the bootstrap cap applies while unpromoted, released on promotion.
 *
 * @returns {{ schedule: Map<number, number> | null }}
 *   `schedule` is null for legacy mode, or a Map of turn → maxTokens.
 */
function parseCapSchedule(value, field) {
  if (value === undefined) return { schedule: null }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${name}: ${field} must be an object mapping turn number to maxTokens`)
  }
  const schedule = new Map()
  for (const [key, val] of Object.entries(value)) {
    const turn = Number(key)
    if (!Number.isSafeInteger(turn) || turn < 1) {
      throw new TypeError(`${name}: ${field} keys must be positive integers (turn numbers); got ${JSON.stringify(key)}`)
    }
    if (!Number.isSafeInteger(val) || val <= 0) {
      throw new TypeError(`${name}: ${field} values must be positive integers (maxTokens); got ${JSON.stringify(val)}`)
    }
    schedule.set(turn, val)
  }
  if (schedule.size === 0) {
    throw new TypeError(`${name}: ${field} must not be empty`)
  }
  return { schedule }
}

/**
 * Count completed model turns within the current epoch (after the last
 * compaction boundary). A "turn" = one assistant/message event. The
 * in-flight request is therefore turn `count + 1`.
 */
function turnsInEpoch(session, boundary) {
  if (session === undefined || !Array.isArray(session.events)) return 0
  let count = 0
  for (const event of session.events) {
    if (event.type !== 'assistant/message') continue
    const seq = event.seq ?? 0
    if (seq > boundary) count += 1
  }
  return count
}

/** Register the per-session bootstrap filters. */
export function apply(ctx, config) {
  const bootstrapTools = stringList(config.bootstrapTools, 'bootstrapTools')
  const bootstrapMaxTokens = optionalPositiveInt(config.bootstrapMaxTokens, 'bootstrapMaxTokens')
  const promoteEvents = parsePromoteOn(config.promoteOn)
  const suppressedSources = sourceList(config.suppressedContextSources, 'suppressedContextSources', DEFAULT_SUPPRESSED_SOURCES)
  const compactionTools = stringListOrEmpty(config.compactionTools, 'compactionTools')
  const postPromotionMode = parsePostPromotionMode(config.postPromotionMode)
  const { schedule: capSchedule } = parseCapSchedule(config.capSchedule, 'capSchedule')

  const promotion = createEpochPromotion(promoteEvents)
  ctx.on('session/event', (session, event) => promotion.observe(session, event))

  let warned = false
  const warnOnce = (message) => {
    if (warned) return
    warned = true
    try {
      ctx.logger.warn(message)
    } catch {
      // Logger unavailable — guard only against spam.
    }
  }

  /**
   * Per-session record of the most recently applied cap, so the release
   * step can strip a maxTokens value that the seed proposal carried
   * forward from the previous turn. Keyed by session id.
   */
  const lastCapBySession = new Map()

  /**
   * Tool names the model explicitly unlocked via `dev_tool_search` for one
   * session (only consulted when postPromotionMode === 'resident').
   * Derived from durable `tool/call` events so resume/reload keeps them.
   */
  const unlockedFor = (session) => {
    const unlocked = new Set()
    if (session === undefined || !Array.isArray(session.events)) return unlocked
    for (const event of session.events) {
      if (event.type !== 'tool/call') continue
      if (event.data?.name !== 'dev_tool_search') continue
      let args
      try {
        args = JSON.parse(event.data.arguments)
      } catch {
        continue
      }
      if (args === null || typeof args !== 'object' || Array.isArray(args)) continue
      const names = args.toolNames
      if (Array.isArray(names)) for (const n of names) if (typeof n === 'string' && n.length > 0) unlocked.add(n)
    }
    return unlocked
  }

  /** Narrow the assembled catalog to a keep-set; validate required names. */
  const keepTools = (assembled, keep, missingAllowsFullCatalog) => {
    const available = new Set(assembled.tools.map((tool) => tool.name))
    const missing = [...keep].filter((toolName) => !available.has(toolName))
    if (missing.length > 0) {
      warnOnce(
        `${name}: expected every phase tool; missing=${JSON.stringify(missing)} — `
        + (missingAllowsFullCatalog ? 'bootstrap disabled, full catalog exposed' : 'continuing with what is available'),
      )
      if (missingAllowsFullCatalog) return assembled
    }
    return {
      ...assembled,
      tools: assembled.tools.filter((tool) => keep.has(tool.name)),
    }
  }

  ctx.on('system-prompt/assemble', async (_assembly, context, next) => {
    // Downstream errors propagate untouched; only this filter's own logic is guarded.
    const assembled = await next()
    try {
      const status = promotion.status(context.agent)
      if (status.promoted) {
        // Post-promotion tool release mode.
        if (postPromotionMode === 'full') {
          // Release the FULL Standard catalog — combined with the multi-turn
          // cap schedule, style inertia from several tight-budget turns
          // keeps the trajectory anchored even with the full catalog visible.
          return assembled
        }
        // 'resident' mode: bootstrap pair + discovery tools + explicitly
        // unlocked names. The upstream repo's safety mode.
        const keep = new Set([...bootstrapTools, ...RESIDENT_DISCOVERY_TOOLS, ...unlockedFor(context.agent?.session)])
        return keepTools(assembled, keep, false)
      }
      // Controlled phase: bootstrap pair; after a compaction, plus the
      // compaction work set so mid-task work can continue.
      const { boundary } = status
      const keep = new Set(bootstrapTools)
      if (boundary >= 0) for (const toolName of compactionTools) keep.add(toolName)
      return keepTools(assembled, keep, true)
    } catch (error) {
      // A filter bug must never brick a session: degrade to the full catalog.
      warnOnce(`${name}: bootstrap filter failed, exposing the full catalog: ${String((error && error.message) || error)}`)
      return assembled
    }
  })

  // Apply the per-turn output cap. The cap follows `capSchedule` when set
  // (multi-turn inertia mode), otherwise degrades to the legacy single-cap
  // behavior (bootstrap cap while unpromoted, released on promotion).
  ctx.on('agent/request', async (payload, next) => {
    const resolved = await next()
    const agent = payload.agent
    const session = agent?.session
    const sessionId = session?.id
    const status = promotion.status(agent)

    // Subagents are exempt: their first request must be able to call tools
    // freely, and they inherit the parent's already-anchored trajectory.
    if (sessionId !== undefined && (session.header?.delegationDepth ?? 0) > 0) {
      return resolved
    }

    // Resolve the cap for THIS turn, or `undefined` to release.
    let desiredCap
    if (capSchedule === null) {
      // Legacy mode: bootstrap cap while unpromoted, released on promotion.
      desiredCap = status.promoted ? undefined : bootstrapMaxTokens
    } else {
      // Multi-turn schedule mode. The current turn number is the count of
      // completed assistant/message events in this epoch, plus one.
      const currentTurn = turnsInEpoch(session, status.boundary) + 1
      desiredCap = capSchedule.get(currentTurn)
      // Turns not listed in the schedule release the cap. While unpromoted
      // (no assistant/message yet, so currentTurn === 1) the schedule's
      // turn-1 entry is authoritative; if turn 1 is absent from the schedule
      // the bootstrap cap is used as a fallback so the anchor is never lost.
      if (desiredCap === undefined && currentTurn === 1 && !status.promoted) {
        desiredCap = bootstrapMaxTokens
      }
    }

    if (desiredCap === undefined) {
      // Release: strip a cap value that the seed proposal carried forward
      // from the previous turn, so the release is explicit (otherwise the
      // cap would persist for the whole session).
      const lastCap = sessionId === undefined ? undefined : lastCapBySession.get(sessionId)
      if (lastCap !== undefined && resolved.maxTokens === lastCap) {
        if (sessionId !== undefined) lastCapBySession.delete(sessionId)
        const { maxTokens: _carried, ...rest } = resolved
        return rest
      }
      return resolved
    }

    // Apply the cap.
    if (sessionId !== undefined) lastCapBySession.set(sessionId, desiredCap)
    return { ...resolved, maxTokens: desiredCap }
  }, { prepend: true })

  // Strip first-step injected reminders (skill catalog, AGENTS.md) during
  // bootstrap. Both return unchanged from request #2 on.
  ctx.on('agent/pre-step', async ({ agent }, next) => {
    // Downstream errors propagate untouched; only this filter's own logic is guarded.
    const decision = await next()
    if (decision.kind === 'reject') return decision
    try {
      if (promotion.status(agent).promoted || suppressedSources.size === 0) return decision
      if (!Array.isArray(decision.messages)) return decision
      const kept = decision.messages.filter((message) => {
        const kind = message?.source?.kind
        return typeof kind !== 'string' || !suppressedSources.has(kind)
      })
      return kept.length === decision.messages.length ? decision : { ...decision, messages: kept }
    } catch (error) {
      // A filter bug must never eat context: degrade to keeping every message.
      warnOnce(`${name}: pre-step context filter failed, keeping injected context: ${String((error && error.message) || error)}`)
      return decision
    }
  }, { prepend: true })
}
