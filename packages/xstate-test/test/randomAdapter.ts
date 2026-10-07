/**
 * A dependency-free `TestAdapter` used to exercise the
 * `xstate/graph` property-testing surface from within `@xstate/test`.
 *
 * It is deliberately minimal: a seeded `mulberry32` PRNG, plain
 * `{ sample(rng) }` generators, uniformly random command sequences and no
 * shrinking. Real users should prefer `@xstate/test`.
 */
import type { EventObject, Snapshot } from '@systemfsoftware/xstate'
import * as Cause from 'effect/Cause'
import * as Effect from 'effect/Effect'
import { dual } from 'effect/Function'
import type {
  PropertyGeneratorKind,
  PropertyScenarioRunner,
  TestAdapter,
  TestAdapterRequest,
  TestAdapterResult,
} from '../src/engine/index.js'

type Rng = () => number

export interface Gen<TValue> {
  sample(rng: Rng): TValue
}

/** The generator kind used by {@link randomAdapter}. */
export interface RandomGeneratorKind extends PropertyGeneratorKind {
  readonly generator: Gen<this['target']>
}

function mulberry32(seed: number): Rng {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function gen<TValue>(sample: (rng: Rng) => TValue): Gen<TValue> {
  return { sample }
}

export function constant<const TValue>(value: TValue): Gen<TValue> {
  return gen(() => value)
}

export const integer: {
  (max: number): (min: number) => Gen<number>
  (min: number, max: number): Gen<number>
} = dual(2, function integer(min: number, max: number): Gen<number> {
  return gen((rng) => min + Math.floor(rng() * (max - min + 1)))
})

export function record<TValue extends Record<string, unknown>>(
  generators: {
    readonly [TKey in keyof TValue]: Gen<TValue[TKey]>
  },
): Gen<TValue> {
  return gen((rng) => {
    const value = {} as TValue
    for (const key of Object.keys(generators) as (keyof TValue)[]) {
      value[key] = generators[key].sample(rng)
    }
    return value
  })
}

export interface RandomAdapterOptions {
  readonly seed?: number
  readonly numRuns?: number
  readonly maxCommands?: number
}

interface Step<
  TSnapshot extends Snapshot<unknown>,
  TEvent extends EventObject,
> {
  check(runner: PropertyScenarioRunner<TSnapshot, TEvent>): boolean
  run(runner: PropertyScenarioRunner<TSnapshot, TEvent>): Promise<void>
}

type StepFactory<
  TSnapshot extends Snapshot<unknown>,
  TEvent extends EventObject,
> = (rng: Rng) => Step<TSnapshot, TEvent>

interface ScenarioBudget {
  readonly seed: number
  readonly maxCommands: number
  readonly configuredRuns: number
}

const runScenario = <TSnapshot extends Snapshot<unknown>, TEvent extends EventObject>(
  runner: PropertyScenarioRunner<TSnapshot, TEvent>,
  rng: Rng,
  factories: ReadonlyArray<StepFactory<TSnapshot, TEvent>>,
  maxCommands: number,
): Effect.Effect<unknown> =>
  Effect.promise(() => runner.start()).pipe(
    Effect.andThen(Effect.suspend(() =>
      Effect.forEach(
        Array.from({ length: 1 + Math.floor(rng() * maxCommands) }, (_, index) => index),
        () =>
          Effect.suspend(() => {
            const stepIndex = Math.floor(rng() * factories.length)
            const stepFactory = factories[stepIndex]
            if (stepFactory === undefined) {
              throw new Error('expected a step factory')
            }
            const step = stepFactory(rng)
            return step.check(runner) ? Effect.promise(() => step.run(runner)) : Effect.void
          }),
        { discard: true },
      )
    )),
    Effect.andThen(Effect.sync(() => runner.finish())),
    Effect.as(undefined),
    Effect.catchCause((cause) => cause.pipe(Cause.squash, Effect.succeed)),
    Effect.ensuring(Effect.promise(() => runner.dispose())),
  )

const runSeeds = <TSnapshot extends Snapshot<unknown>, TEvent extends EventObject>(
  request: TestAdapterRequest<TSnapshot, TEvent>,
  factories: ReadonlyArray<StepFactory<TSnapshot, TEvent>>,
  budget: ScenarioBudget,
): Effect.Effect<{ readonly runs: number; readonly error: unknown }> => {
  const from = (runIndex: number): Effect.Effect<{ readonly runs: number; readonly error: unknown }> =>
    Effect.suspend(() =>
      runScenario(request.createRunner(), mulberry32(budget.seed + runIndex), factories, budget.maxCommands).pipe(
        Effect.flatMap((error) =>
          error !== undefined || runIndex + 1 >= budget.configuredRuns
            ? Effect.succeed({ runs: runIndex + 1, error })
            : from(runIndex + 1)
        ),
      )
    )
  return budget.configuredRuns > 0 ? from(0) : Effect.succeed({ runs: 0, error: undefined })
}
class RandomAdapter implements TestAdapter<RandomGeneratorKind> {
  public readonly kind?: RandomGeneratorKind

  public constructor(private readonly options: RandomAdapterOptions) {}

  public run<
    TSnapshot extends Snapshot<unknown>,
    TEvent extends EventObject,
  >(
    request: TestAdapterRequest<TSnapshot, TEvent>,
  ): Promise<TestAdapterResult> {
    const options = this.options
    return Effect.runPromise(Effect.suspend(() => {
      const factories: StepFactory<TSnapshot, TEvent>[] = []
      for (const { type, caseId, generator } of request.events) {
        factories.push((rng) => {
          const generated = (generator as Gen<unknown>).sample(rng)
          return {
            check: (runner) => runner.canRunGenerated(type, generated, caseId),
            run: (runner) => runner.runGenerated(type, generated, caseId),
          }
        })
      }
      for (const command of request.commands) {
        if (command.type === 'advance') {
          factories.push((rng) => {
            const milliseconds = (command.generator as Gen<number>).sample(rng)
            return {
              check: (runner) => runner.canRunCommand(runner.getSnapshot().status === 'active'),
              run: (runner) => runner.advance(milliseconds),
            }
          })
        } else if (command.type === 'checkpoint') {
          factories.push((rng) => {
            const value = (
              command.generator as Gen<{ readonly label?: string }>
            ).sample(rng)
            return {
              check: (runner) => runner.canRunCommand(true),
              run: (runner) => runner.checkpoint(value.label),
            }
          })
        } else {
          factories.push((rng) => {
            ;(command.generator as Gen<unknown>).sample(rng)
            return {
              check: (runner) => runner.canRunCommand(runner.getSnapshot().status === 'active'),
              run: (runner) => runner.stop(),
            }
          })
        }
      }
      if (factories.length === 0) {
        throw new Error(
          'Property tests require at least one event or command generator',
        )
      }

      const seed = options.seed ?? 0
      const maxCommands = options.maxCommands ?? 10
      const configuredRuns = request.runBudget ?? options.numRuns ?? 10

      return runSeeds(request, factories, { seed, maxCommands, configuredRuns }).pipe(Effect.map(({ runs, error }) => {
        const truncationReasons: string[] = []
        if (error !== undefined && runs < configuredRuns) {
          truncationReasons.push(
            'counterexample found before configured runs completed',
          )
        }
        const exploration = {
          configuredRuns,
          maximumSequenceLength: maxCommands,
          engine: 'random',
          seed,
          truncated: truncationReasons.length > 0,
          truncationReasons,
        }
        if (error === undefined) {
          return { runs, exploration }
        }
        return {
          runs,
          exploration,
          error,
          replay: { engine: 'random', seed: seed + runs - 1 },
        }
      }))
    }))
  }
}

export function randomAdapter(
  options: RandomAdapterOptions = {},
): TestAdapter<RandomGeneratorKind> {
  return new RandomAdapter(options)
}
