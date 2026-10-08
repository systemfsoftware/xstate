import { describe, it } from '@systemfsoftware/vitest'
import { createActor, createMachine } from '../src/index.js'

describe('tags', () => {
  it('supports tagging states', function*({ expect }) {
    const machine = createMachine({
      initial: 'green',
      states: {
        green: {
          tags: ['go'],
          on: {
            TIMER: { target: 'yellow' },
          },
        },
        yellow: {
          tags: ['go'],
          on: {
            TIMER: { target: 'red' },
          },
        },
        red: {
          tags: ['stop'],
        },
      },
    })

    const actorRef = createActor(machine).start()
    const initialHasGo = actorRef.getSnapshot().hasTag('go')
    actorRef.send({ type: 'TIMER' })
    const yellowHasGo = actorRef.getSnapshot().hasTag('go')
    actorRef.send({ type: 'TIMER' })
    const redHasGo = actorRef.getSnapshot().hasTag('go')

    yield* expect({ initialHasGo, yellowHasGo, redHasGo }).toEqual({
      initialHasGo: true,
      yellowHasGo: true,
      redHasGo: false,
    })
  })

  it('supports tags in compound states', function*({ expect }) {
    const machine = createMachine({
      initial: 'red',
      states: {
        green: {
          tags: ['go'],
        },
        yellow: {},
        red: {
          tags: ['stop'],
          initial: 'walk',
          states: {
            walk: {
              tags: ['crosswalkLight'],
            },
            wait: {
              tags: ['crosswalkLight'],
            },
          },
        },
      },
    })

    const actorRef = createActor(machine).start()
    const initialState = actorRef.getSnapshot()

    yield* expect({
      hasGo: initialState.hasTag('go'),
      hasStop: initialState.hasTag('stop'),
      hasCrosswalkLight: initialState.hasTag('crosswalkLight'),
    }).toEqual({ hasGo: false, hasStop: true, hasCrosswalkLight: true })
  })

  it('supports tags in parallel states', function*({ expect }) {
    const machine = createMachine({
      type: 'parallel',
      states: {
        foo: {
          initial: 'active',
          states: {
            active: {
              tags: ['yes'],
            },
            inactive: {
              tags: ['no'],
            },
          },
        },
        bar: {
          initial: 'active',
          states: {
            active: {
              tags: ['yes'],
              on: {
                DEACTIVATE: { target: 'inactive' },
              },
            },
            inactive: {
              tags: ['no'],
            },
          },
        },
      },
    })

    const actorRef = createActor(machine).start()
    const initialTags = actorRef.getSnapshot().tags
    actorRef.send({ type: 'DEACTIVATE' })
    const afterDeactivateTags = actorRef.getSnapshot().tags

    yield* expect({
      initialTagCount: initialTags.size,
      initialHasYes: initialTags.has('yes'),
      initialHasNo: initialTags.has('no'),
      afterDeactivateTagCount: afterDeactivateTags.size,
      afterDeactivateHasYes: afterDeactivateTags.has('yes'),
      afterDeactivateHasNo: afterDeactivateTags.has('no'),
    }).toEqual({
      initialTagCount: 1,
      initialHasYes: true,
      initialHasNo: false,
      afterDeactivateTagCount: 2,
      afterDeactivateHasYes: true,
      afterDeactivateHasNo: true,
    })
  })

  it('sets tags correctly after not selecting any transition', function*({ expect }) {
    const machine = createMachine({
      initial: 'a',
      states: {
        a: {
          tags: ['myTag'],
        },
      },
    })

    const actorRef = createActor(machine).start()
    actorRef.send({
      type: 'UNMATCHED',
    })

    yield* expect({ hasMyTag: actorRef.getSnapshot().hasTag('myTag') }).toEqual({
      hasMyTag: true,
    })
  })

  it('tags can be single (not array)', function*({ expect }) {
    const machine = createMachine({
      initial: 'green',
      states: {
        green: {
          tags: ['go'],
        },
      },
    })

    yield* expect({ hasGo: createActor(machine).getSnapshot().hasTag('go') }).toEqual({
      hasGo: true,
    })
  })

  it('stringifies to an array', function*({ expect }) {
    const machine = createMachine({
      initial: 'green',
      states: {
        green: {
          tags: ['go', 'light'],
        },
      },
    })

    const jsonState = createActor(machine).getSnapshot().toJSON()
    const tags = typeof jsonState === 'object' && jsonState !== null && 'tags' in jsonState
      ? jsonState.tags
      : undefined

    yield* expect(tags).toEqual(['go', 'light'])
  })
})
