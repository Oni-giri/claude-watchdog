export type Severity = 'nit' | 'concern' | 'blocker'

export type LastNote = { severity: Severity; note: string; via: string; ts: number }

export type Summary = {
  reviews: number
  costUsd: number
  model: string | null
  pending: { nit: number; concern: number; blocker: number }
  last: LastNote | null
  error: string | null
}

declare module 'claude-code' {
  interface PluginState {
    'watchdog-ui': {
      /** What the band draws; null until the watchdog has done anything. */
      summary: Summary | null
      /** Feed lines already handled (survives hot reloads). */
      offset: number
      hidden: boolean
    }
  }
}
