import { describe, it } from '@systemfsoftware/vitest'
import { Ajv, type SchemaObject } from 'ajv'
import { Effect } from 'effect'
import { readFileSync } from 'node:fs'
import { BehaviorSubject } from 'rxjs'
import { createMachineFromConfig } from '../src/createMachineFromConfig.js'
import {
  createActor,
  createAsyncLogic,
  createMachine,
  createObservableLogic,
  serializeMachine,
  SimulatedClock,
} from '../src/index.js'
import { toSubscribable } from './utils.js'

const machineSchema: SchemaObject = JSON.parse(
  readFileSync(new URL('../src/machine.schema.json', import.meta.url), 'utf8'),
)

const ajv = new Ajv()
const validate = ajv.compile(machineSchema)

type EvaluatorArgs = {
  source: string
  scope: Record<string, unknown>
}

const jsEvaluator = ({ source, scope }: EvaluatorArgs) =>
  Function('scope', `with (scope) { return (${source}); }`)(scope)

const readInternal = (value: unknown, key: string): unknown => {
  if (typeof value !== 'object' || value === null || !(key in value)) {
    return undefined
  }
  return Reflect.get(value, key)
}

const isSchemaInvalid = (json: unknown): boolean => {
  validate(json)
  return validate.errors !== null
}

const neverResolves = <T>(): Promise<T> => Promise.withResolvers<T>().promise

const waitForSnapshot = (done: () => boolean) =>
  Effect.promise(() => {
    const { promise, resolve } = Promise.withResolvers<void>()
    let attempts = 0
    const poll = () => {
      if (done() || attempts >= 200) {
        resolve()
        return
      }
      attempts += 1
      setTimeout(poll, 1)
    }
    poll()
    return promise
  })

describe('json', () => {
  it('should serialize the machine', function*({ expect }) {
    const machine = createMachineFromConfig(
      {
        initial: 'foo',
        version: '1.0.0',
        context: {
          number: 0,
          string: 'hello',
        },
        invoke: [{ id: 'invokeId', src: 'invokeSrc' }],
        states: {
          testActions: {
            invoke: [{ id: 'invokeId', src: 'invokeSrc' }],
            entry: [
              { type: 'stringActionType' },
              {
                type: 'objectActionType',
              },
              {
                type: 'objectActionTypeWithExec',
                params: { other: 'any' },
              },
            ],
            on: {
              TO_FOO: {
                target: [
                  'testParallel.one.inactive',
                  'testParallel.two.inactive',
                ],
                guard: { type: 'isString', params: { string: 'hello' } },
              },
            },
            after: {
              1000: { target: 'bar' },
            },
          },
          foo: {},
          bar: {},
          testHistory: {
            type: 'history',
            history: 'deep',
            target: 'foo',
          },
          testFinal: {
            type: 'final',
            output: {
              something: 'else',
            },
          },
          testParallel: {
            type: 'parallel',
            states: {
              one: {
                initial: 'inactive',
                states: {
                  inactive: {},
                },
              },
              two: {
                initial: 'inactive',
                states: {
                  inactive: {},
                },
              },
            },
          },
        },
        output: { result: 42 },
      },
      {
        actors: {
          invokeSrc: createAsyncLogic({
            run: () => neverResolves(),
          }),
        },
        actions: {
          stringActionType: () => {},
          objectActionType: () => {},
          objectActionTypeWithExec: () => {},
        },
        guards: {
          isString: () => true,
        },
      },
    )

    const json = JSON.parse(JSON.stringify(serializeMachine(machine)))

    yield* expect({ invalid: isSchemaInvalid(json) }).toEqual({ invalid: false })
  })

  it('should validate serialized code expressions', function*({ expect }) {
    const entry = () => {}
    const transition = () => ({ target: 'done' })
    const machine = createMachine({
      guards: {
        isReady: () => true,
      },
      initial: 'idle',
      states: {
        idle: {
          entry,
          on: {
            GO: transition,
          },
        },
        routed: {
          id: 'routed',
          route: () => true,
        },
        done: {},
      },
    })

    const json = JSON.parse(JSON.stringify(serializeMachine(machine)))

    yield* expect({ invalid: isSchemaInvalid(json) }).toEqual({ invalid: false })
  })

  it('revives serialized code actions and transitions with evaluators', function*({ expect }) {
    const entry = ({ context }: { context: { count: number } }) => ({
      context: { count: context.count + 1 },
    })
    const transition = ({ context }: { context: { count: number } }) =>
      context.count === 1 ? { target: 'done' } : undefined
    const machine = createMachine({
      context: { count: 0 },
      initial: 'idle',
      states: {
        idle: {
          entry,
          on: {
            GO: transition,
          },
        },
        done: {},
      },
    })
    const json = JSON.parse(JSON.stringify(serializeMachine(machine)))
    const evaluator = ({ source, scope }: EvaluatorArgs) => {
      const fn = Function(`return (${source});`)()
      return fn(scope, scope['enq'])
    }

    const actor = createActor(
      createMachineFromConfig(json, {
        evaluators: { ts: evaluator },
      }),
    ).start()

    const contextBefore = actor.getSnapshot().context

    actor.send({ type: 'GO' })

    yield* expect({ contextBefore, valueAfter: actor.getSnapshot().value }).toEqual({
      contextBefore: { count: 1 },
      valueAfter: 'done',
    })
  })

  it('revives serialized code routes with evaluators', function*({ expect }) {
    const machine = createMachine({
      initial: 'idle',
      states: {
        blocked: {
          id: 'blocked',
          route: () => false,
        },
        idle: {
          id: 'idle',
          route: {},
        },
      },
    })
    const json = JSON.parse(JSON.stringify(serializeMachine(machine)))
    const evaluator = ({ source, scope }: EvaluatorArgs) => {
      const fn = Function(`return (${source});`)()
      return fn(scope)
    }

    const route = json.states.blocked.route

    const actor = createActor(
      createMachineFromConfig(json, {
        evaluators: { ts: evaluator },
      }),
    ).start()

    actor.send({ type: 'xstate.route', to: '#blocked' })

    yield* expect({ route, value: actor.getSnapshot().value }).toEqual({
      route: { '@code': '() => false', '@lang': 'ts' },
      value: 'idle',
    })
  })

  it('should detect an invalid machine', function*({ expect }) {
    const invalidMachineConfig = {
      id: 'something',
      key: 'something',
      type: 'invalid type',
      states: {},
    }

    yield* expect({ invalid: isSchemaInvalid(invalidMachineConfig) }).toEqual({ invalid: true })
  })

  it('should not double-serialize invoke transitions', function*({ expect }) {
    const machine = createMachineFromConfig(
      {
        initial: 'active',
        states: {
          active: {
            id: 'active',
            invoke: {
              src: 'someSrc',
              onDone: { target: 'foo' },
              onError: { target: 'bar' },
            },
            on: {
              EVENT: { target: 'foo' },
            },
          },
          foo: {},
          bar: {},
        },
      },
      {
        actors: {
          someSrc: createAsyncLogic({
            run: () => neverResolves(),
          }),
        },
      },
    )

    const machineJSON = JSON.stringify(serializeMachine(machine))

    const machineObject = JSON.parse(machineJSON)

    const revivedMachine = createMachineFromConfig(machineObject, {
      actors: {
        someSrc: createAsyncLogic({
          run: () => neverResolves(),
        }),
      },
    })

    const on = machineObject.states.active.on
    const invoke = machineObject.states.active.invoke

    const roundTrip = JSON.stringify(serializeMachine(revivedMachine))

    const activeState = revivedMachine.states['active']
    if (activeState === undefined) {
      throw new Error('expected an active state')
    }
    const transitions = [...activeState.transitions.values()].flat()

    yield* expect({
      on,
      invoke,
      roundTrip,
      eventTransitionCount: transitions.filter((t) => t.eventType === 'EVENT').length,
      hasDoneActor: transitions.some(
        (t) =>
          t.eventType === 'xstate.done.actor' &&
          t.matches?.['actorId'] === '0.active',
      ),
      hasErrorActor: transitions.some(
        (t) =>
          t.eventType === 'xstate.error.actor' &&
          t.matches?.['actorId'] === '0.active',
      ),
    }).toEqual({
      on: {
        EVENT: {
          target: 'foo',
        },
      },
      invoke: {
        onDone: {
          target: 'foo',
        },
        onError: {
          target: 'bar',
        },
        src: 'someSrc',
      },
      roundTrip: machineJSON,
      eventTransitionCount: 1,
      hasDoneActor: true,
      hasErrorActor: true,
    })
  })

  it('round-trips transition payload matches', function*({ expect }) {
    const machine = createMachineFromConfig({
      initial: 'pending',
      states: {
        pending: {
          on: {
            result: [
              { matches: { actorId: 'first' }, target: 'first' },
              { matches: { actorId: 'second' }, target: 'second' },
            ],
          },
        },
        first: {},
        second: {},
      },
    })
    const revived = createMachineFromConfig(
      JSON.parse(JSON.stringify(serializeMachine(machine))),
    )
    const actor = createActor(revived).start()

    actor.send({ type: 'result', actorId: 'second' })

    yield* expect(actor.getSnapshot().value).toBe('second')
  })

  it('revives delayed transitions from JSON', function*({ expect }) {
    const clock = new SimulatedClock()
    const actor = createActor(
      createMachineFromConfig({
        initial: 'waiting',
        states: {
          waiting: {
            after: {
              10: { target: 'done' },
            },
          },
          done: {},
        },
      }),
      { clock },
    ).start()

    clock.increment(9)
    const atNine = actor.getSnapshot().value
    clock.increment(1)
    const atTen = actor.getSnapshot().value

    yield* expect({ atNine, atTen }).toEqual({ atNine: 'waiting', atTen: 'done' })
  })

  it('revives state timeouts from JSON', function*({ expect }) {
    const clock = new SimulatedClock()
    const actor = createActor(
      createMachineFromConfig({
        initial: 'waiting',
        states: {
          waiting: {
            timeout: 10,
            onTimeout: { target: 'timedOut' },
          },
          timedOut: {},
        },
      }),
      { clock },
    ).start()

    clock.increment(10)

    yield* expect(actor.getSnapshot().value).toBe('timedOut')
  })

  it('revives state tags and final output from JSON', function*({ expect }) {
    const actor = createActor(
      createMachineFromConfig({
        initial: 'pending',
        output: { ok: true },
        states: {
          pending: {
            on: { ACTIVATE: { target: 'active' } },
          },
          active: {
            tags: ['complete'],
            on: { FINISH: { target: 'done' } },
          },
          done: {
            type: 'final',
          },
        },
      }),
    ).start()

    actor.send({ type: 'ACTIVATE' })
    const hasComplete = actor.getSnapshot().hasTag('complete')
    actor.send({ type: 'FINISH' })
    const output = actor.getSnapshot().output

    yield* expect({ hasComplete, output }).toEqual({ hasComplete: true, output: { ok: true } })
  })

  it.live('revives invoke input, completion transitions, and source maps', function*({ expect }) {
    let receivedInput: unknown
    const worker = createAsyncLogic<number, { count: number }>({
      run: ({ input }) => {
        receivedInput = input
        return Promise.resolve(input.count)
      },
    })

    const actor = createActor(
      createMachineFromConfig(
        {
          initial: 'loading',
          states: {
            loading: {
              invoke: {
                src: 'worker',
                input: { count: 42 },
                onDone: {
                  target: 'done',
                },
              },
            },
            done: {},
          },
        },
        {
          actors: { worker },
        },
      ),
    ).start()

    yield* waitForSnapshot(() => actor.getSnapshot().value === 'done')

    yield* expect({ value: actor.getSnapshot().value, receivedInput }).toEqual({
      value: 'done',
      receivedInput: { count: 42 },
    })
  })

  it.live('revives invoke source refs when actor sources are provided', function*({ expect }) {
    const worker = createAsyncLogic({
      run: () => Promise.resolve(42),
    })

    const actor = createActor(
      createMachineFromConfig(
        {
          initial: 'loading',
          states: {
            loading: {
              invoke: {
                src: 'worker',
                onDone: { target: 'done' },
              },
            },
            done: {},
          },
        },
        { actors: { worker } },
      ),
    ).start()

    yield* waitForSnapshot(() => actor.getSnapshot().value === 'done')

    yield* expect(actor.getSnapshot().value).toBe('done')
  })

  it('rejects missing action sources', function*({ expect }) {
    yield* expect(() =>
      createMachineFromConfig({
        entry: [{ type: 'track' }],
      })
    ).toThrow('Missing action source "track"')
  })

  it('rejects missing guard sources', function*({ expect }) {
    yield* expect(() =>
      createMachineFromConfig({
        initial: 'idle',
        states: {
          idle: {
            on: {
              GO: {
                target: 'done',
                guard: { type: 'ready' },
              },
            },
          },
          done: {},
        },
      })
    ).toThrow('Missing guard source "ready"')
  })

  it('revives serialized numeric delays from root delay maps', function*({ expect }) {
    const clock = new SimulatedClock()
    const actor = createActor(
      createMachineFromConfig({
        delays: {
          short: 10,
        },
        initial: 'waiting',
        states: {
          waiting: {
            after: {
              short: { target: 'done' },
            },
          },
          done: {},
        },
      }),
      { clock },
    ).start()

    clock.increment(9)
    const atNine = actor.getSnapshot().value
    clock.increment(1)
    const atTen = actor.getSnapshot().value

    yield* expect({ atNine, atTen }).toEqual({ atNine: 'waiting', atTen: 'done' })
  })

  it('revives invoke registryKey from JSON', function*({ expect }) {
    const worker = createAsyncLogic({
      run: () => neverResolves(),
    })

    const actor = createActor(
      createMachineFromConfig(
        {
          initial: 'loading',
          states: {
            loading: {
              invoke: {
                src: 'worker',
                registryKey: 'workerSystem',
              },
            },
          },
        },
        { actors: { worker } },
      ),
    ).start()

    yield* expect({ registered: actor.system.get('workerSystem') !== undefined }).toEqual({ registered: true })
  })

  it.live('revives invoke onSnapshot from JSON', function*({ expect }) {
    const subject = new BehaviorSubject(0)
    const worker = createObservableLogic<number, undefined>(() => toSubscribable(subject))
    const actor = createActor(
      createMachineFromConfig(
        {
          initial: 'watching',
          states: {
            watching: {
              invoke: {
                src: 'worker',
                onSnapshot: { target: 'seen' },
              },
            },
            seen: {},
          },
        },
        { actors: { worker } },
      ),
    ).start()

    yield* waitForSnapshot(() => actor.getSnapshot().value === 'seen')

    yield* expect(actor.getSnapshot().value).toBe('seen')
  })

  it('revives transition input from JSON', function*({ expect }) {
    const actor = createActor(
      createMachineFromConfig({
        initial: 'idle',
        states: {
          idle: {
            on: {
              GO: {
                target: 'active',
                input: 42,
              },
            },
          },
          active: {
            id: 'active',
          },
        },
      }),
    ).start()

    actor.send({ type: 'GO' })

    yield* expect(readInternal(readInternal(actor.getSnapshot(), '_stateInputs'), 'active')).toBe(42)
  })

  it('revives invoke timeouts from JSON', function*({ expect }) {
    const clock = new SimulatedClock()
    const worker = createAsyncLogic({
      run: () => neverResolves(),
    })

    const actor = createActor(
      createMachineFromConfig(
        {
          initial: 'loading',
          states: {
            loading: {
              invoke: {
                src: 'worker',
                timeout: 10,
                onTimeout: { target: 'timedOut' },
              },
            },
            timedOut: {},
          },
        },
        { actors: { worker } },
      ),
      { clock },
    ).start()

    clock.increment(10)

    yield* expect(actor.getSnapshot().value).toBe('timedOut')
  })

  it('rejects missing evaluators for expressions', function*({ expect }) {
    yield* expect(() =>
      createMachineFromConfig({
        '@exprLang': 'js',
        context: {
          count: { '@expr': 'input.count' },
        },
      })
    ).toThrow("Missing evaluator for @lang 'js' at $.context.count")
  })

  it('rejects expressions without a top-level or local language', function*({ expect }) {
    yield* expect(() =>
      createMachineFromConfig({
        context: {
          count: { '@expr': 'input.count' },
        },
      })
    ).toThrow('Missing @exprLang for expression at $.context.count')
  })

  it('uses local expression language overrides and passes evaluator metadata', function*({ expect }) {
    const calls: EvaluatorArgs[] = []
    const actor = createActor(
      createMachineFromConfig(
        {
          '@exprLang': 'js',
          context: {
            count: { '@expr': 'input.count', '@lang': 'other' },
          },
        },
        {
          evaluators: {
            js: () => {
              throw new Error('default evaluator should not be used')
            },
            other: (args) => {
              calls.push(args)
              return readInternal(args.scope['input'], 'count')
            },
          },
        },
      ),
      { input: { count: 7 } },
    ).start()

    yield* expect({
      context: actor.getSnapshot().context,
      callCount: calls.length,
      firstCall: calls[0],
      input: calls[0]?.scope['input'],
    }).toEqual({
      context: { count: 7 },
      callCount: 1,
      firstCall: expect.objectContaining({
        source: 'input.count',
        kind: 'expr',
        slot: 'context',
        path: '$.context.count',
      }),
      input: { count: 7 },
    })
  })

  it('resolves expressions in delays and state timeouts', function*({ expect }) {
    const clock = new SimulatedClock()
    const actor = createActor(
      createMachineFromConfig(
        {
          '@exprLang': 'js',
          context: {
            afterMs: 10,
            timeoutMs: 20,
          },
          delays: {
            short: { duration: { '@expr': 'context.afterMs' } },
          },
          initial: 'waiting',
          states: {
            waiting: {
              after: {
                short: { target: 'timed' },
              },
            },
            timed: {
              timeout: { '@expr': 'context.timeoutMs' },
              onTimeout: { target: 'done' },
            },
            done: {},
          },
        },
        { evaluators: { js: jsEvaluator } },
      ),
      { clock },
    ).start()

    clock.increment(9)
    const atNine = actor.getSnapshot().value
    clock.increment(1)
    const atTen = actor.getSnapshot().value
    clock.increment(19)
    const atTwentyNine = actor.getSnapshot().value
    clock.increment(1)
    const atThirty = actor.getSnapshot().value

    yield* expect({ atNine, atTen, atTwentyNine, atThirty }).toEqual({
      atNine: 'waiting',
      atTen: 'timed',
      atTwentyNine: 'timed',
      atThirty: 'done',
    })
  })

  it('resolves expressions in invoke timeout and invoke input', function*({ expect }) {
    const clock = new SimulatedClock()
    let receivedInput: unknown
    const worker = createAsyncLogic({
      run: ({ input }) => {
        receivedInput = input
        return neverResolves()
      },
    })

    const actor = createActor(
      createMachineFromConfig(
        {
          '@exprLang': 'js',
          context: {
            value: 42,
            timeoutMs: 10,
          },
          initial: 'loading',
          states: {
            loading: {
              invoke: {
                src: 'worker',
                input: {
                  value: { '@expr': 'context.value' },
                },
                timeout: { '@expr': 'context.timeoutMs' },
                onTimeout: { target: 'timedOut' },
              },
            },
            timedOut: {},
          },
        },
        {
          actors: { worker },
          evaluators: { js: jsEvaluator },
        },
      ),
      { clock },
    ).start()

    const input = receivedInput
    clock.increment(10)
    const value = actor.getSnapshot().value

    yield* expect({ input, value }).toEqual({ input: { value: 42 }, value: 'timedOut' })
  })

  it('resolves expressions in transition input and final output', function*({ expect }) {
    const actor = createActor(
      createMachineFromConfig(
        {
          '@exprLang': 'js',
          context: {
            count: 2,
          },
          output: { '@expr': 'context.count * 2' },
          initial: 'idle',
          states: {
            idle: {
              on: {
                GO: {
                  target: 'done',
                  input: { '@expr': 'context.count + event.by' },
                },
              },
            },
            done: {
              id: 'done',
              type: 'final',
            },
          },
        },
        { evaluators: { js: jsEvaluator } },
      ),
    ).start()

    actor.send({ type: 'GO', by: 3 })

    yield* expect({
      stateInput: readInternal(readInternal(actor.getSnapshot(), '_stateInputs'), 'done'),
      output: actor.getSnapshot().output,
    }).toEqual({ stateInput: 5, output: 4 })
  })

  it('revives serializable choice states and expression values', function*({ expect }) {
    const evaluator = ({ source, scope }: EvaluatorArgs) =>
      Function('scope', `with (scope) { return (${source}); }`)(scope)
    const actor = createActor(
      createMachineFromConfig(
        {
          '@exprLang': 'js',
          context: {
            tier: { '@expr': 'input.tier' },
            count: 0,
          },
          initial: 'routing',
          states: {
            routing: {
              type: 'choice',
              choice: [
                {
                  when: { '@expr': 'context.tier === "vip"' },
                  target: 'vip',
                  context: {
                    count: { '@expr': 'context.count + 1' },
                  },
                },
                { target: 'standard' },
              ],
            },
            vip: {},
            standard: {},
          },
        },
        {
          evaluators: {
            js: evaluator,
          },
        },
      ),
      { input: { tier: 'vip' } },
    ).start()

    yield* expect({
      value: actor.getSnapshot().value,
      context: actor.getSnapshot().context,
    }).toEqual({
      value: 'vip',
      context: {
        tier: 'vip',
        count: 1,
      },
    })
  })

  it('rejects choice fallback branches before the last branch', function*({ expect }) {
    yield* expect(() =>
      createMachineFromConfig({
        initial: 'routing',
        states: {
          routing: {
            type: 'choice',
            choice: [
              { target: 'standard' },
              { when: { '@expr': 'true', '@lang': 'js' }, target: 'vip' },
            ],
          },
          standard: {},
          vip: {},
        },
      })
    ).toThrow(
      'Choice fallback branch at $.states.routing.choice[0] must be last.',
    )
  })

  it('errors when a choice state has no matching branch', function*({ expect }) {
    const actor = createActor(
      createMachineFromConfig(
        {
          '@exprLang': 'js',
          initial: 'routing',
          states: {
            routing: {
              type: 'choice',
              choice: [{ when: { '@expr': 'false' }, target: 'done' }],
            },
            done: {},
          },
        },
        { evaluators: { js: jsEvaluator } },
      ),
    )
    actor.subscribe({ error: () => {} })

    actor.start()

    const snapshot = actor.getSnapshot()

    yield* expect({
      status: snapshot.status,
      message: readInternal(readInternal(snapshot, 'error'), 'message'),
    }).toEqual({
      status: 'error',
      message: 'Choice state at $.states.routing.choice did not match any branch.',
    })
  })

  it('runs declarative named actions with expression params', function*({ expect }) {
    const evaluator = ({ source, scope }: EvaluatorArgs) =>
      Function('scope', `with (scope) { return (${source}); }`)(scope)
    const actor = createActor(
      createMachineFromConfig(
        {
          '@exprLang': 'js',
          context: {
            count: 0,
          },
          actions: {
            setCount: {
              type: '@xstate.assign',
              context: {
                count: { '@expr': 'params.value' },
              },
            },
          },
          entry: [{ type: 'setCount', params: { value: 2 } }],
        },
        {
          evaluators: {
            js: evaluator,
          },
        },
      ),
    ).start()

    yield* expect(actor.getSnapshot().context).toEqual({
      count: 2,
    })
  })

  it('runs declarative named action arrays', function*({ expect }) {
    const actor = createActor(
      createMachineFromConfig({
        context: {
          count: 0,
        },
        actions: {
          incTwice: [
            {
              type: '@xstate.assign',
              context: { count: 1 },
            },
            {
              type: '@xstate.assign',
              context: { count: 2 },
            },
          ],
        },
        entry: [{ type: 'incTwice' }],
      }),
    ).start()

    yield* expect(actor.getSnapshot().context).toEqual({ count: 2 })
  })

  it('rejects circular declarative named actions', function*({ expect }) {
    yield* expect(() =>
      createMachineFromConfig({
        actions: {
          a: { type: 'b' },
          b: { type: 'a' },
        },
        entry: [{ type: 'a' }],
      })
    ).toThrow('Circular action reference: a -> b -> a')
  })

  it('runs declarative named guards', function*({ expect }) {
    const evaluator = ({ source, scope }: EvaluatorArgs) =>
      Function('scope', `with (scope) { return (${source}); }`)(scope)
    const actor = createActor(
      createMachineFromConfig(
        {
          '@exprLang': 'js',
          context: {
            ready: true,
          },
          guards: {
            isReady: {
              when: { '@expr': 'context.ready' },
            },
          },
          initial: 'idle',
          states: {
            idle: {
              on: {
                GO: { guard: { type: 'isReady' }, target: 'done' },
              },
            },
            done: {},
          },
        },
        {
          evaluators: {
            js: evaluator,
          },
        },
      ),
    ).start()

    actor.send({ type: 'GO' })

    yield* expect(actor.getSnapshot().value).toBe('done')
  })

  it('validates JSON Schema-shaped action, guard, and actor source schemas', function*({ expect }) {
    yield* expect({
      invalid: isSchemaInvalid({
        schemas: {
          actions: {
            track: {
              params: {
                type: 'object',
                properties: {
                  key: { type: 'string' },
                },
                required: ['key'],
              },
            },
          },
          guards: {
            allowed: {
              params: {
                type: 'object',
                properties: {
                  role: { type: 'string' },
                },
              },
            },
          },
          actors: {
            worker: {
              input: {
                type: 'object',
                properties: {
                  id: { type: 'string' },
                },
              },
              output: {
                type: 'object',
                properties: {
                  ok: { type: 'boolean' },
                },
              },
              emitted: {
                PROGRESS: {
                  type: 'object',
                  properties: {
                    percent: { type: 'number' },
                  },
                },
              },
            },
          },
        },
      }),
    }).toEqual({ invalid: false })
  })

  it('rejects invalid serializable machine schema shapes', function*({ expect }) {
    const configs = [
      {
        initial: 'on',
        states: {
          on: {
            initial: 'active',
            states: {
              active: {},
              history: { type: 'history' },
            },
          },
        },
      },
      {
        initial: 'on',
        states: {
          on: {
            initial: 'active',
            states: {
              active: {},
              history: { type: 'history', target: [] },
            },
          },
        },
      },
      {
        initial: 'routing',
        states: {
          routing: {
            type: 'choice',
            choice: [
              {
                target: 'done',
                actions: [],
              },
            ],
          },
          done: {},
        },
      },
      {
        actions: {
          track: {
            params: {},
          },
        },
      },
      {
        guards: {
          ready: {
            '@expr': 'true',
          },
        },
      },
      {
        schemas: {
          actions: {
            track: {},
          },
        },
      },
      {
        schemas: {
          actors: {
            worker: {
              schemas: {},
            },
          },
        },
      },
    ]

    yield* expect(configs.map(isSchemaInvalid)).toEqual([true, true, true, true, true, true, true])
  })

  it('rejects event and emitted payload schemas that redeclare event type', function*({ expect }) {
    const configs = [
      {
        schemas: {
          events: {
            SUBMIT: {
              type: 'object',
              properties: {
                value: { type: 'string' },
              },
            },
          },
          emitted: {
            TRACKED: {
              type: 'object',
              properties: {
                key: { type: 'string' },
              },
            },
          },
        },
      },
      {
        schemas: {
          events: {
            SUBMIT: {
              type: 'object',
              properties: {
                type: { const: 'SUBMIT' },
                value: { type: 'string' },
              },
            },
          },
        },
      },
      {
        schemas: {
          actors: {
            worker: {
              emitted: {
                PROGRESS: {
                  type: 'object',
                  properties: {
                    type: { const: 'PROGRESS' },
                    percent: { type: 'number' },
                  },
                },
              },
            },
          },
        },
      },
    ]

    yield* expect(configs.map(isSchemaInvalid)).toEqual([false, true, true])
  })
})

describe('reserved source names', () => {
  it("rejects source names using the reserved '@xstate.' prefix", function*({ expect }) {
    yield* expect(() =>
      createMachineFromConfig({
        initial: 'a',
        states: { a: {} },
      } as unknown as Record<string, unknown>).provide({
        actions: { '@xstate.raise': () => {} } as unknown as Record<string, unknown>,
      })
    ).toThrow(
      "Invalid actions name '@xstate.raise': the '@xstate.' prefix is reserved",
    )
  })
})
