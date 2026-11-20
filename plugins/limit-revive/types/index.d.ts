export type PendingReason = 'limit-error' | 'aborted-by-mod' | 'held-prompt' | 'requested'

/** The usage window a revive waits for, as SessionRateLimit.kind names it. */
export type LimitWindow = 'five_hour' | 'seven_day'

/** Unfinished work waiting for a usage window (5-hour or weekly) to reset. */
export type Pending = {
  reason: PendingReason
  /** Which window's reset the revive waits for. */
  window: LimitWindow
  /** The window's reset, ISO 8601, as the rate limit reported it. */
  resetsAt: string
  /** When the in-session timer revives the session (reset + delay), ms. */
  resumeAt: number
  /** A prompt held back in finish-turn mode, submitted verbatim on revive. */
  heldText?: string
  /** The Windows scheduled task registered as the fallback, if any. */
  taskName?: string
  /** For a revive the model requested: the main turn it was armed in. */
  turnId?: string
}

/** A fallback task this mod registered, kept in $.store across sessions. */
export type OsTask = { sessionId: string; at: number; pending: Pending }

declare module 'claude-code' {
  interface PluginState {
    'limit-revive': {
      pending: Shaped<Pending | null>
      /** Until this time (ms) the user has overridden the mod: no stop/hold. */
      overrideUntil: Shaped<number>
      /** The weekly reset (ms) the session is stopped until, nothing scheduled; 0 = none. */
      weeklyStop: Shaped<number>
      /** Per window, the reset whose threshold crossing the model was told about. */
      noted: Shaped<Partial<Record<LimitWindow, string>>>
    }
  }
}
