import { Duration, Effect } from 'effect'

export const reportUnhandledError = (error: unknown): void => {
  Effect.runCallback(Effect.sleep(Duration.millis(1)), {
    onExit: () => {
      throw error
    },
  })
}
