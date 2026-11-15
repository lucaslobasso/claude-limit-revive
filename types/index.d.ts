export type PendingReason = 'limit-error' | 'aborted-by-mod' | 'held-prompt'

/** Unfinished work waiting for the 5-hour window to reset. */
export type Pending = {
  reason: PendingReason
  /** The window's reset, ISO 8601, as the rate limit reported it. */
  resetsAt: string
  /** When the in-session timer revives the session (reset + delay), ms. */
  resumeAt: number
  /** A prompt held back in finish-turn mode, submitted verbatim on revive. */
  heldText?: string
  /** The Windows scheduled task registered as the fallback, if any. */
  taskName?: string
}

/** A fallback task this mod registered, kept in $.store across sessions. */
export type OsTask = { sessionId: string; at: number; pending: Pending }

declare module 'claude-code' {
  interface PluginState {
    'limit-revive': {
      pending: Shaped<Pending | null>
      /** Until this time (ms) the user has overridden the mod: no stop/hold. */
      overrideUntil: Shaped<number>
    }
  }
}
