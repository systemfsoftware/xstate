import { describe, it } from '@systemfsoftware/vitest'
import { createMachine } from '../../index.js'
import { adjacencyMapToArray, getAdjacencyMap } from '../index.js'

describe('adjacency maps', () => {
  it('model generates an adjacency map (converted to an array)', function*({ expect }) {
    const machine = createMachine({
      initial: 'standing',
      states: {
        standing: {
          on: {
            left: { target: 'walking' },
            right: { target: 'walking' },
            down: { target: 'crouching' },
            up: { target: 'jumping' },
          },
        },
        walking: {
          on: {
            up: { target: 'jumping' },
            stop: { target: 'standing' },
          },
        },
        jumping: {
          on: {
            land: { target: 'standing' },
          },
        },
        crouching: {
          on: {
            release_down: { target: 'standing' },
          },
        },
      },
    })
    yield* expect(
      adjacencyMapToArray(getAdjacencyMap(machine, {})).map(
        ({ state, event, nextState }) => `Given Mario is ${state.value}, when ${event.type}, then ${nextState.value}`,
      ),
    ).toEqual([
      'Given Mario is standing, when left, then walking',
      'Given Mario is standing, when right, then walking',
      'Given Mario is standing, when down, then crouching',
      'Given Mario is standing, when up, then jumping',
      'Given Mario is walking, when up, then jumping',
      'Given Mario is walking, when stop, then standing',
      'Given Mario is crouching, when release_down, then standing',
      'Given Mario is jumping, when land, then standing',
    ])
  })

  it('function generates an adjacency map (converted to an array)', function*({ expect }) {
    const machine = createMachine({
      initial: 'green',
      states: {
        green: {
          on: {
            TIMER: { target: 'yellow' },
          },
        },
        yellow: {
          on: {
            TIMER: { target: 'red' },
          },
        },
        red: {
          on: {
            TIMER: { target: 'green' },
          },
        },
      },
    })

    const arr = adjacencyMapToArray(getAdjacencyMap(machine, {}))

    yield* expect(
      arr.map((x) => ({
        state: x.state.value,
        event: x.event.type,
        nextState: x.nextState.value,
      })),
    ).toEqual([
      {
        event: 'TIMER',
        nextState: 'yellow',
        state: 'green',
      },
      {
        event: 'TIMER',
        nextState: 'red',
        state: 'yellow',
      },
      {
        event: 'TIMER',
        nextState: 'green',
        state: 'red',
      },
    ])
  })
})
