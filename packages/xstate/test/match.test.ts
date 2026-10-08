import { describe, it } from '@systemfsoftware/vitest'
import { createActor, createMachine, matchesState } from '../src/index.js'

describe('matchesState()', (it) => {
  it('should return true if two states are equivalent', function*({ expect }) {
    yield* expect({
      equivalent: matchesState('a', 'a'),
      equivalentDeep: matchesState('b.b1', 'b.b1'),
      different: matchesState('B.bar', { A: 'foo' }),
    }).toEqual({
      equivalent: true,
      equivalentDeep: true,
      different: false,
    })
  })

  it('should return true if two state values are equivalent', function*({
    expect,
  }) {
    yield* expect({
      simple: matchesState({ a: 'b' }, { a: 'b' }),
      nested: matchesState({ a: { b: 'c' } }, { a: { b: 'c' } }),
    }).toEqual({ simple: true, nested: true })
  })

  it('should return true if two parallel states are equivalent', function*({
    expect,
  }) {
    yield* expect({
      parallel: matchesState(
        { a: { b1: 'foo', b2: 'bar' } },
        { a: { b1: 'foo', b2: 'bar' } },
      ),
      parallelDeep: matchesState(
        { a: { b1: 'foo', b2: 'bar' }, b: { b3: 'baz', b4: 'quo' } },
        { a: { b1: 'foo', b2: 'bar' }, b: { b3: 'baz', b4: 'quo' } },
      ),
      flat: matchesState({ a: 'foo', b: 'bar' }, { a: 'foo', b: 'bar' }),
    }).toEqual({ parallel: true, parallelDeep: true, flat: true })
  })

  it('should return true if a state is a substate of a superstate', function*({
    expect,
  }) {
    yield* expect({
      simple: matchesState('b', 'b.b1'),
      deep: matchesState('foo.bar', 'foo.bar.baz.quo'),
    }).toEqual({ simple: true, deep: true })
  })

  it('should return true if a state value is a substate of a superstate value', function*({
    expect,
  }) {
    yield* expect({
      objectSuper: matchesState('b', { b: 'b1' }),
      deepObject: matchesState(
        { foo: 'bar' },
        { foo: { bar: { baz: 'quo' } } },
      ),
    }).toEqual({ objectSuper: true, deepObject: true })
  })

  it('should return true if a parallel state value is a substate of a superstate value', function*({
    expect,
  }) {
    yield* expect({
      parallelSuper: matchesState('b', { b: 'b1', c: 'c1' }),
      parallelBoth: matchesState(
        { foo: 'bar', fooAgain: 'barAgain' },
        { foo: { bar: { baz: 'quo' } }, fooAgain: { barAgain: 'baz' } },
      ),
    }).toEqual({ parallelSuper: true, parallelBoth: true })
  })

  it('should return false if two states are not equivalent', function*({
    expect,
  }) {
    yield* expect({
      differentStates: matchesState('a', 'b'),
      differentDeep: matchesState('a.a1', 'b.b1'),
    }).toEqual({ differentStates: false, differentDeep: false })
  })

  it('should return false if parent state is more specific than child state', function*({
    expect,
  }) {
    yield* expect({
      stringForm: matchesState('a.b.c', 'a.b'),
      objectForm: matchesState({ a: { b: { c: 'd' } } }, { a: 'b' }),
    }).toEqual({ stringForm: false, objectForm: false })
  })

  it('should return false if two state values are not equivalent', function*({
    expect,
  }) {
    yield* expect({
      objectForm: matchesState({ a: 'a1' }, { b: 'b1' }),
    }).toEqual({ objectForm: false })
  })

  it('should return false if a state is not a substate of a superstate', function*({
    expect,
  }) {
    yield* expect({
      unrelated: matchesState('a', 'b.b1'),
      differentPath: matchesState('foo.false.baz', 'foo.bar.baz.quo'),
    }).toEqual({ unrelated: false, differentPath: false })
  })

  it('should return false if a state value is not a substate of a superstate value', function*({
    expect,
  }) {
    yield* expect({
      stringChild: matchesState('a', { b: 'b1' }),
      objectChild: matchesState(
        { foo: { false: 'baz' } },
        { foo: { bar: { baz: 'quo' } } },
      ),
    }).toEqual({ stringChild: false, objectChild: false })
  })

  it('should mix/match string state values and object state values', function*({
    expect,
  }) {
    yield* expect({
      mixed: matchesState('a.b.c', { a: { b: 'c' } }),
    }).toEqual({ mixed: true })
  })
})

describe('matches() method', (it) => {
  it('should execute matchesState on a State given the parent state value', function*({
    expect,
  }) {
    const machine = createMachine({
      initial: 'foo',
      states: {
        foo: {
          initial: 'bar',
          states: {
            bar: {
              initial: 'baz',
              states: {
                baz: {},
              },
            },
          },
        },
      },
    })

    const initialState = createActor(machine).getSnapshot()

    yield* expect({
      top: initialState.matches('foo'),
      nested: initialState.matches({ foo: 'bar' }),
      fake: initialState.matches('fake'),
    }).toEqual({ top: true, nested: true, fake: false })
  })
})
