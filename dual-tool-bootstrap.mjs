/**
 * Dual-constraint tool bootstrap with warmup + test rounds and cap schedule.
 *
 * Design (v2): THREE phases before the user's real input is processed, all in
 * the service of fixing the model's reasoning-chain STYLE before real work:
 *
 *   Phase A — Warmup round (synthetic, replayed by default, 0 model calls).
 *     The session's very first step is replaced with one synthetic warmup
 *     message ("This round is a test..."), presented with the Minimal tool
 *     pair (bash + str_replace_editor) and the tight bootstrap cap. When a
 *     replay file is configured, the warmup round's model output is
 *     short-circuited through `llm/stream` with a pre-recorded reasoning +
 *     reply (a "We need..."-style chain), so the anchor is DETERMINISTIC and
 *     costs zero adapter calls. The user's real input is deferred to a later
 *     round via `inbox.prepend('next-turn')`.
 *
 *   Phase B — Test round (real model, FULL tool catalog, mid cap).
 *     A second synthetic message exercises the model with the full Standard
 *     catalog under a mid cap (default 4096). This is the "test" that
 *     consolidates the style: the model genuinely uses many tools under a
 *     budget, building the "minimal thinking + multi-tool" habit in a real
 *     working scenario (the README's方案 B — 多轮 cap 阶梯 — moved to the
 *     pre-user rounds).
 *
 *   Phase C — User round (real input, cap RELEASED).
 *     Only now does the user's actual prompt enter the loop, with the full
 *     catalog and the output budget RELEASED (the adapter default flows).
 *     The user never hits the 1024 truncation wall: the cap ladder was
 *     consumed by the warmup/test rounds, and the real request starts
 *     with full budget.
 *
 * The cap schedule (`capSchedule`) therefore counts MODEL REQUEST rounds,
 * not user messages: warmup = turn 1, test = turn 2, user = turn 3+. Turns
 * not listed release the cap. Epoch-aware: a compaction restarts the
 * schedule at turn 1 AND re-arms the warmup/test phase (the post-compaction
 * "second first request" gets the same anchoring treatment).
 *
 * Promotion (default `promoteOn: either`): the first durable `tool/call` OR
 * first `assistant/message` promotes the session, which widens the tool
 * catalog (bootstrap pair → full). Subagents always see the full catalog and
 * are exempt from both the warmup phase and the cap schedule.
 *
 * Robustness (fail-soft, never brick a session):
 *  - A missing/unreadable replay file disables ONLY the stream
 *    short-circuit; the warmup round still runs through the real model.
 *  - A route that cannot resolve, a rejected step, or an abort skips the
 *    whole warmup/test phase and the real input proceeds unchanged.
 *  - The pre-step context filter degrades to "keep everything" on failure.
 *  - Missing bootstrap tool degrades to the full catalog with a one-time
 *    warning.
 *  - Invalid config fails at preset mount, where it is visible and fixable.
 */

import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { isAbsolute } from 'node:path'
import { pathToFileURL } from 'node:url'

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
 * Default first-request output cap (Phase A anchor). Issue #11 measured
 * 1024 producing "We need..." style first lines in 26/32 runs vs 0/5 at
 * 256000 (independent of tool description).
 */
const DEFAULT_BOOTSTRAP_MAX_TOKENS = 1024

/** Default suppressed context sources (the two Standard-only auto-injections). */
const DEFAULT_SUPPRESSED_SOURCES = ['skill-catalog', 'agent-instructions']

/** Default post-promotion tool release mode. */
const DEFAULT_POST_PROMOTION_MODE = 'full'

/** Discovery tools the upstream repo keeps resident (only used in `resident` mode). */
const RESIDENT_DISCOVERY_TOOLS = ['dev_tool_search', 'skill_search', 'skill_load']

/** Default synthetic warmup message (Phase A). */
const DEFAULT_WARMUP_MESSAGE = 'This round is a test. Tools are not open yet; all tools will open next round.'

/** Default synthetic test message (Phase B). */
const DEFAULT_TEST_MESSAGE = 'Test round: tools are now fully open. Keep your reasoning concise and work through this test task using the available tools.'

/** Default replay file location (relative to this module). */
const DEFAULT_REPLAY_FILE = './replay.json'

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

function optionalPositiveInt(value, field, fallback) {
  if (value === undefined) return fallback
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
 * Load the pre-recorded warmup output (Phase A replay). A replay document
 * carries the exact reasoning text and the exact visible reply from the
 * recorded warmup round. Read once at mount.
 */
function loadReplay(file, logger) {
  const target = typeof file === 'string' && file.length > 0 ? file : DEFAULT_REPLAY_FILE
  const url = isAbsolute(target) ? pathToFileURL(target) : new URL(target, import.meta.url)
  try {
    const document = JSON.parse(readFileSync(url, 'utf8'))
    if (document === null || typeof document !== 'object' || Array.isArray(document)) {
      throw new TypeError('replay document must be an object')
    }
    if (typeof document.reasoning !== 'string' || document.reasoning.length === 0) {
      throw new TypeError('replay.reasoning must be a non-empty string')
    }
    if (typeof document.reply !== 'string' || document.reply.length === 0) {
      throw new TypeError('replay.reply must be a non-empty string')
    }
    return { reasoning: document.reasoning, reply: document.reply }
  } catch (error) {
    logger.warn('%s: replay disabled (%s); the warmup round falls back to the real model', name, (error && error.message) || String(error))
    return undefined
  }
}

/** Build the synthetic LLM stream for one replayed warmup round. */
function replayChunks(replay) {
  return [
    { type: 'block-start', index: 0, blockType: 'reasoning' },
    { type: 'reasoning-delta', index: 0, text: replay.reasoning },
    { type: 'block-end', index: 0, block: { type: 'reasoning', text: replay.reasoning } },
    { type: 'block-start', index: 1, blockType: 'text' },
    { type: 'text-delta', index: 1, text: replay.reply },
    { type: 'block-end', index: 1, block: { type: 'text', text: replay.reply } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}

/** Yield the recorded chunks, honoring abort like a real adapter. */
async function* replayStream(chunks, signal) {
  for (const chunk of chunks) {
    if (signal?.aborted) throw new Error('aborted')
    yield chunk
  }
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
  const bootstrapMaxTokens = optionalPositiveInt(config.bootstrapMaxTokens, 'bootstrapMaxTokens', DEFAULT_BOOTSTRAP_MAX_TOKENS)
  const promoteEvents = parsePromoteOn(config.promoteOn)
  const suppressedSources = sourceList(config.suppressedContextSources, 'suppressedContextSources', DEFAULT_SUPPRESSED_SOURCES)
  const compactionTools = stringListOrEmpty(config.compactionTools, 'compactionTools')
  const postPromotionMode = parsePostPromotionMode(config.postPromotionMode)
  const { schedule: capSchedule } = parseCapSchedule(config.capSchedule, 'capSchedule')

  // Phase A/B synthetic messages.
  const warmupMessage = typeof config.warmupMessage === 'string' && config.warmupMessage.length > 0
    ? config.warmupMessage
    : DEFAULT_WARMUP_MESSAGE
  const testMessage = typeof config.testMessage === 'string' && config.testMessage.length > 0
    ? config.testMessage
    : DEFAULT_TEST_MESSAGE
  const replayFile = typeof config.replayFile === 'string' && config.replayFile.length > 0 ? config.replayFile : undefined

  const replay = replayFile === undefined ? undefined : loadReplay(replayFile, ctx.logger)
  const chunks = replay === undefined ? undefined : replayChunks(replay)

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
   * Agents whose next step must become the warmup (Phase A) or test
   * (Phase B) round, keyed by agent with the phase it is on.
   */
  const pending = new WeakMap()
  /** Sessions whose next loop-built model call must replay the warmup output. */
  const replaySessions = new Set()

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

  /** A session that has never logged a model request and is not a subagent. */
  const freshSession = (agent) => (
    agent !== undefined &&
    agent.session !== undefined &&
    !agent.session.events.some((event) => event.type === 'request/header') &&
    (agent.session.header?.delegationDepth ?? 0) === 0
  )

  // Arm the warmup when the first input of a fresh session is queued. This
  // fires synchronously during the inbox splice, before the driver wakes, so
  // the very first assembly already sees the pending flag.
  ctx.on('agent/inbox/inserted', ({ agent, message }) => {
    if (agent === undefined || message === undefined || pending.has(agent)) return
    if (freshSession(agent)) {
      pending.set(agent, { phase: 'warmup' })
      ctx.logger.info('%s: warmup phase armed for a fresh session', name)
    }
  })

  // Narrow the assembled tool catalog while the warmup is pending, so the
  // warmup step's request/header carries exactly the two tools below.
  // `prepend` keeps this filter outermost on the waterfall, so no later
  // listener can widen the catalog back before the request is built.
  ctx.on('system-prompt/assemble', async (_assembly, context, next) => {
    const assembled = await next()
    const agent = context.agent
    if (agent === undefined) return assembled
    const phase = pending.get(agent)?.phase
    // Phase B (test) keeps the FULL catalog: the test's job is to exercise
    // real multi-tool work under a budget. Phase A (warmup) narrows to the
    // bootstrap pair. Neither phase is "promoted" yet in the durable sense,
    // but the test phase must NOT be narrowed.
    if (phase === 'test') return assembled
    try {
      const status = promotion.status(agent)
      if (status.promoted) {
        // Post-promotion tool release mode.
        if (postPromotionMode === 'full') return assembled
        const keep = new Set([...bootstrapTools, ...RESIDENT_DISCOVERY_TOOLS, ...unlockedFor(agent?.session)])
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

  // The outermost pre-step listener: Phase A (warmup) and Phase B (test)
  // round replacement, plus first-step context stripping. `prepend` keeps
  // this listener OUTSIDE the host-plane instruction and skill injections,
  // so the replacement discards them for the warmup/test requests.
  //
  // Phase machine: 'warmup' → 'test' → (deleted). The real input is prepended
  // back to next-turn during BOTH synthetic rounds, so it is only processed
  // on the third round (Phase C, full budget, full catalog).
  ctx.on('agent/pre-step', async ({ agent, messages, turn, step, signal }, next) => {
    // Downstream errors propagate untouched; only this filter's own logic is guarded.
    const decision = await next()
    if (decision.kind === 'reject') return decision
    const phase = pending.get(agent)?.phase
    try {
      if (phase !== undefined) {
        // Synthetic round (warmup or test): replace the step's messages and
        // defer the real input. The replacement itself discards every
        // downstream injection, so no separate context strip is needed here.
        pending.delete(agent)
        if (messages.length === 0) return decision
        // The warmup phase additionally requires a genuinely fresh session
        // (never issued a model request). The test phase runs regardless —
        // it is the second synthetic round by construction.
        if (phase === 'warmup' && !freshSession(agent)) return decision
        // Resolve the model route up front: a synthetic round that cannot
        // run must not consume the real input.
        const seed = { provider: agent.options?.provider ?? '', model: agent.options?.model ?? '' }
        let proposed
        try {
          proposed = await agent.dispatch.waterfall('agent/request', { turn, step, signal }, () => Promise.resolve(seed))
        } catch (error) {
          ctx.logger.warn('%s: route resolution failed (%s); skipping the warmup/test round', name, (error && error.message) || String(error))
          return decision
        }
        if (signal?.aborted) return decision
        if (proposed === undefined || !proposed.provider || !proposed.model) {
          ctx.logger.warn('%s: no provider/model route; skipping the warmup/test round', name)
          return decision
        }
        for (let index = messages.length - 1; index >= 0; index--) agent.inbox.prepend('next-turn', messages[index])
        const text = phase === 'test' ? testMessage : warmupMessage
        const synthetic = { id: randomUUID(), role: 'user', content: [{ type: 'text', text }], source: { kind: 'plugin', plugin: name } }
        // Phase A only: mark the session for replay (0 adapter calls), then
        // advance the machine to the test phase. Phase B deletes the pending
        // entry, so the third round processes the real input normally.
        if (phase === 'warmup') {
          if (chunks !== undefined && agent.session?.id !== undefined) {
            const sid = agent.session.id
            replaySessions.add(sid)
            signal?.addEventListener?.('abort', () => replaySessions.delete(sid), { once: true })
          }
          pending.set(agent, { phase: 'test' })
        }
        ctx.logger.info('%s: %s round queued as turn %d step %d; real input deferred to the next turn', name, phase, turn, step)
        return { kind: 'enter', messages: [synthetic] }
      }

      // Non-synthetic step: strip first-step injected reminders (skill
      // catalog, AGENTS.md) while still unpromoted. Both return unchanged
      // from the test phase on (the test exercises the real context).
      if (suppressedSources.size === 0) return decision
      if (Array.isArray(decision.messages)) {
        const kept = decision.messages.filter((message) => {
          const kind = message?.source?.kind
          return typeof kind !== 'string' || !suppressedSources.has(kind)
        })
        if (kept.length !== decision.messages.length) {
          return { ...decision, messages: kept }
        }
      }
      return decision
    } catch (error) {
      // A filter bug must never eat context: degrade to keeping every message.
      warnOnce(`${name}: pre-step filter failed, keeping injected context: ${String((error && error.message) || error)}`)
      return decision
    }
  }, { prepend: true })

  // Short-circuit the warmup round's model call with the recorded stream.
  // Not calling `next()` is the documented `llm/stream` waterfall veto: the
  // adapter (and any provider I/O) never runs. The loop still logs
  // `assistant/chunk` and `assistant/message` from the yielded chunks.
  if (chunks !== undefined) {
    ctx.on('llm/stream', (options, next) => {
      if (options.sessionId === undefined || !replaySessions.has(options.sessionId)) return next()
      replaySessions.delete(options.sessionId)
      return replayStream(chunks, options.signal)
    })
  }
}
