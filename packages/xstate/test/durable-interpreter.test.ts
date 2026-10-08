import { describe, it } from '@systemfsoftware/vitest'
import {
  type AnyActor,
  type AnyMachineSnapshot,
  type AnyStateMachine,
  createMachine,
  type ExecutableActionObject,
  type Snapshot,
} from '../src/index.js'

type DurableCommand = {
  effectId: string
  type:
    | 'spawn'
    | 'start'
    | 'stop'
    | 'terminate'
    | 'schedule'
    | 'cancel'
    | 'send'
    | 'emit'
  sourceKey?: string
  actorKey?: string
  targetKey?: string
  event?: { type: string }
  timerId?: string
  dueAt?: number
  src?: string
  input?: unknown
  status?: 'done' | 'error'
  output?: unknown
  error?: unknown
}

type DurableRecord = {
  snapshot: unknown
  bindings: Record<string, string>
  outbox: DurableCommand[]
}

function commitTransition(
  machine: AnyStateMachine,
  snapshot: AnyMachineSnapshot,
  effects: ExecutableActionObject[],
  transitionId: string,
  now: number,
  bindings: Record<string, string> = {},
): DurableRecord {
  const nextBindings = { ...bindings }
  const actorKeys = new Map<AnyActor, string>()

  const seedActorKeys = (
    currentSnapshot: AnyMachineSnapshot,
    parentKey: string,
  ) => {
    for (
      const [id, actor] of Object.entries(currentSnapshot.children) as Array<
        [string, AnyActor | undefined]
      >
    ) {
      if (!actor) {
        continue
      }
      const slot = `${parentKey}/${id}`
      const actorKey = nextBindings[slot]
      if (!actorKey) {
        continue
      }
      actorKeys.set(actor, actorKey)
      const childSnapshot = actor.getSnapshot()
      if (childSnapshot && 'children' in childSnapshot) {
        seedActorKeys(childSnapshot as AnyMachineSnapshot, actorKey)
      }
    }
  }

  seedActorKeys(snapshot, 'root')

  const getActorKey = (actor: AnyActor | undefined) => actor ? (actorKeys.get(actor) ?? 'root') : undefined
  const outbox: DurableCommand[] = []

  for (const [index, effect] of effects.entries()) {
    const effectId = `${transitionId}:${index}`

    if (effect.kind === 'action') {
      if (effect.action) {
        throw new Error(
          `Durable execution requires a registered action, received "${effect.type}"`,
        )
      }
      continue
    }

    if (effect.kind === 'emit') {
      const sourceKey = getActorKey(effect.source)
      outbox.push({
        effectId,
        type: 'emit',
        ...(sourceKey === undefined ? {} : { sourceKey }),
        event: effect.event,
      })
      continue
    }

    switch (effect.type) {
      case '@xstate.spawn': {
        if (typeof effect.src !== 'string') {
          throw new Error(
            'Durable execution requires a registered actor source',
          )
        }
        const sourceKey = getActorKey(effect.source) ?? 'root'
        const actorKey = effectId
        nextBindings[`${sourceKey}/${effect.id}`] = actorKey
        actorKeys.set(effect.actor, actorKey)
        outbox.push({
          effectId,
          type: 'spawn',
          sourceKey,
          actorKey,
          src: effect.src,
          input: effect.input,
        })
        break
      }
      case '@xstate.start': {
        const actorKey = getActorKey(effect.actor)
        outbox.push({
          effectId,
          type: 'start',
          ...(actorKey === undefined ? {} : { actorKey }),
        })
        break
      }
      case '@xstate.stop': {
        const sourceKey = getActorKey(effect.source) ?? 'root'
        const slot = `${sourceKey}/${effect.id}`
        const actorKey = nextBindings[slot]
        outbox.push({
          effectId,
          type: 'stop',
          sourceKey,
          ...(actorKey === undefined ? {} : { actorKey }),
        })
        delete nextBindings[slot]
        break
      }
      case '@xstate.terminate': {
        const actorKey = getActorKey(effect.actor)
        outbox.push({
          effectId,
          type: 'terminate',
          ...(actorKey === undefined ? {} : { actorKey }),
          status: effect.status,
          output: effect.output,
          error: effect.error,
        })
        break
      }
      case '@xstate.raise': {
        const sourceKey = getActorKey(effect.source)
        outbox.push({
          effectId,
          type: 'schedule',
          ...(sourceKey === undefined ? {} : { sourceKey }),
          timerId: effect.id!,
          dueAt: now + (effect.delay ?? 0),
        })
        break
      }
      case '@xstate.sendTo': {
        const sourceKey = getActorKey(effect.source)
        const timerId = effect.id
        const targetKey = getActorKey(effect.target)
        outbox.push({
          effectId,
          type: effect.delay === undefined ? 'send' : 'schedule',
          ...(sourceKey === undefined ? {} : { sourceKey }),
          ...(timerId === undefined ? {} : { timerId }),
          ...(effect.delay === undefined
            ? {
              ...(targetKey === undefined ? {} : { targetKey }),
              event: effect.event,
            }
            : { dueAt: now + effect.delay }),
        })
        break
      }
      case '@xstate.cancel': {
        const sourceKey = getActorKey(effect.source)
        outbox.push({
          effectId,
          type: 'cancel',
          ...(sourceKey === undefined ? {} : { sourceKey }),
          timerId: effect.id,
        })
        break
      }
    }
  }

  return {
    snapshot: machine.getPersistedSnapshot(snapshot),
    bindings: nextBindings,
    outbox,
  }
}

function roundTrip<T>(value: T): T {
  return JSON.parse(JSON.stringify(value))
}

class IdempotentRuntime {
  private readonly applied: Set<string>
  readonly operations: DurableCommand[]

  constructor(
    persisted: { applied: string[]; operations: DurableCommand[] } = {
      applied: [],
      operations: [],
    },
  ) {
    this.applied = new Set(persisted.applied)
    this.operations = persisted.operations
  }

  execute(commands: DurableCommand[]): void {
    for (const command of commands) {
      if (this.applied.has(command.effectId)) {
        continue
      }
      this.applied.add(command.effectId)
      this.operations.push(command)
    }
  }

  persist() {
    return roundTrip({
      applied: [...this.applied],
      operations: this.operations,
    })
  }
}

describe('durable interpreter adapter', () => {
  it('commits terminal actor lifecycle to the durable outbox', function*({ expect }) {
    const machine = createMachine({
      initial: 'active',
      states: {
        active: { on: { FINISH: { target: 'done' } } },
        done: { type: 'final' },
      },
    })
    const [active] = machine.initialTransition(undefined)
    const [done, effects] = machine.transition(active, { type: 'FINISH' })

    const record = commitTransition(machine, done, effects, 'finish', 0)

    yield* expect({
      outboxTail: record.outbox.at(-1),
      serialized: JSON.stringify(record),
    }).toEqual({
      outboxTail: expect.objectContaining({
        type: 'terminate',
        actorKey: 'root',
        status: 'done',
      }),
      serialized: expect.any(String),
    })
  })

  it('can recover an outbox without duplicate effects or resetting timers', function*({ expect }) {
    const fiveMinutes = 5 * 60 * 1000
    const startedAt = 1_000_000
    const worker = createMachine({ on: { PING: {} } })
    const machine = createMachine({
      id: 'workflow',
      actors: { worker },
      initial: 'running',
      states: {
        running: {
          invoke: { id: 'worker', src: 'worker' },
          after: { [fiveMinutes]: { target: 'timedOut' } },
          on: {
            PING: ({ children }, enq) => enq.sendTo(children['worker'], { type: 'PING' }),
            REENTER: { target: 'running', reenter: true },
          },
        },
        timedOut: {},
      },
    })

    const [initialSnapshot, initialEffects] = machine.initialTransition(undefined)
    const initialRecord = commitTransition(
      machine,
      initialSnapshot,
      initialEffects,
      'transition-0',
      startedAt,
    )
    const spawn = initialRecord.outbox.find(
      (command) => command.type === 'spawn',
    )!
    const timer = initialRecord.outbox.find(
      (command) => command.type === 'schedule',
    )!

    const omittedTimerKeys = Object.keys(timer).filter(
      (key) => key === 'event' || key === 'targetKey',
    )

    const firstRuntime = new IdempotentRuntime()
    firstRuntime.execute(initialRecord.outbox.slice(0, 2))

    const persistedRecord = roundTrip(initialRecord)
    const resumedRuntime = new IdempotentRuntime(firstRuntime.persist())
    resumedRuntime.execute(persistedRecord.outbox)

    const resumedOperationTypes = resumedRuntime.operations.map(({ type }) => type)
    const resumedScheduleDueAt = resumedRuntime.operations.find(
      ({ type }) => type === 'schedule',
    )?.dueAt

    const restoredSnapshot = machine.restoreSnapshot(
      persistedRecord.snapshot as Snapshot<unknown>,
    )
    const [timedOutSnapshot, timerEffects] = machine.transition(
      restoredSnapshot,
      {
        type: 'xstate.timer',
        id: timer.timerId!,
      } as never,
    )
    const timerRecord = commitTransition(
      machine,
      timedOutSnapshot,
      timerEffects,
      'transition-timer',
      timer.dueAt!,
      persistedRecord.bindings,
    )

    const timedOutValue = timedOutSnapshot.value
    const timedOutTimers = timedOutSnapshot.timers
    const timerRecordOutboxTypes = timerRecord.outbox.map(({ type }) => type)

    const [nextSnapshot, nextEffects] = machine.transition(restoredSnapshot, {
      type: 'PING',
    })
    const nextRecord = commitTransition(
      machine,
      nextSnapshot,
      nextEffects,
      'transition-1',
      startedAt + 1000,
      persistedRecord.bindings,
    )
    const send = nextRecord.outbox.find((command) => command.type === 'send')!
    const sendTargetKey = send.targetKey

    resumedRuntime.execute(nextRecord.outbox)
    resumedRuntime.execute(roundTrip(nextRecord.outbox))
    const sendOperationTypes = resumedRuntime.operations
      .filter(({ type }) => type === 'send')
      .map(({ type }) => type)

    const [reenteredSnapshot, reentryEffects] = machine.transition(
      nextSnapshot,
      { type: 'REENTER' },
    )
    const reentryRecord = commitTransition(
      machine,
      reenteredSnapshot,
      reentryEffects,
      'transition-2',
      startedAt + 2000,
      nextRecord.bindings,
    )
    const nextSpawn = reentryRecord.outbox.find(
      (command) => command.type === 'spawn',
    )!

    yield* expect({
      timerDueAt: timer.dueAt,
      omittedTimerKeys,
      persistedSnapshot: initialRecord.snapshot,
      serializedInitial: JSON.stringify(initialRecord),
      resumedOperationTypes,
      resumedScheduleDueAt,
      timedOutValue,
      timedOutTimers,
      timerRecordOutboxTypes,
      spawnActorKey: spawn.actorKey,
      sendTargetKey,
      sendOperationTypes,
      reentryOutboxTypes: reentryRecord.outbox.map(({ type }) => type),
      reentryStopActorKey: reentryRecord.outbox.find(
        ({ type }) => type === 'stop',
      )?.actorKey,
      nextSpawnDiffersFromSpawn: nextSpawn.actorKey !== spawn.actorKey,
    }).toEqual({
      timerDueAt: startedAt + fiveMinutes,
      omittedTimerKeys: [],
      persistedSnapshot: expect.objectContaining({
        timers: expect.objectContaining({
          [timer.timerId!]: expect.objectContaining({
            delay: fiveMinutes,
            type: '@xstate.raise',
            target: 'self',
            event: expect.objectContaining({ type: 'xstate.after' }),
          }),
        }),
      }),
      serializedInitial: expect.any(String),
      resumedOperationTypes: ['spawn', 'schedule', 'start'],
      resumedScheduleDueAt: startedAt + fiveMinutes,
      timedOutValue: 'timedOut',
      timedOutTimers: {},
      timerRecordOutboxTypes: ['cancel', 'stop'],
      spawnActorKey: 'transition-0:0',
      sendTargetKey: 'transition-0:0',
      sendOperationTypes: ['send'],
      reentryOutboxTypes: ['cancel', 'stop', 'spawn', 'schedule', 'start'],
      reentryStopActorKey: 'transition-0:0',
      nextSpawnDiffersFromSpawn: true,
    })
  })
})
