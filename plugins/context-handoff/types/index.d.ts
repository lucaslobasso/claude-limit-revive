/**
 * Where the session stands in a handoff: nothing yet, waiting for the running
 * turn to finish, Claude writing the file, or the new session started.
 */
export type Phase = 'idle' | 'armed' | 'writing' | 'launched'

/** One session's handoff, kept in $.state. */
export type Handoff = {
  phase: Phase
  /** The handoff file Claude was asked to write, once one was asked for. */
  file?: string
  /** The context fill (%) that set the handoff off. */
  percent?: number
}

declare module 'claude-code' {
  interface PluginState {
    'context-handoff': {
      handoff: Shaped<Handoff>
      /**
       * The person cancelled (or was notified): no trigger until the context
       * falls below the threshold again, as after a compaction.
       */
      override: Shaped<boolean>
    }
  }
}
