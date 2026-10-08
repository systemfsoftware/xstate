import { describe, it } from '@systemfsoftware/vitest'
import { checkStateIn, createActor, createMachine, matchesState, type StateValue } from '../src/index.js'

describe('transition "in" check', () => {
  it('should transition if string state path matches current state value', function*({ expect }) {
    const machine = createMachine({
      type: 'parallel',
      states: {
        a: {
          initial: 'a1',
          states: {
            a1: {
              on: {
                EVENT2: ({ value }) => {
                  if (matchesState({ b: 'b2' }, value)) {
                    return { target: 'a2' }
                  }
                  return undefined
                },
              },
            },
            a2: {
              id: 'a_a2',
            },
          },
        },
        b: {
          initial: 'b2',
          states: {
            b1: {},
            b2: {
              id: 'b_b2',
              type: 'parallel',
              states: {
                foo: {
                  initial: 'foo2',
                  states: {
                    foo1: {},
                    foo2: {},
                  },
                },
                bar: {
                  initial: 'bar1',
                  states: {
                    bar1: {
                      id: 'bar1',
                    },
                    bar2: {},
                  },
                },
              },
            },
          },
        },
      },
    })
    const actorRef = createActor(machine).start()
    actorRef.send({ type: 'EVENT2' })

    yield* expect(actorRef.getSnapshot().value).toEqual({
      a: 'a2',
      b: {
        b2: {
          foo: 'foo2',
          bar: 'bar1',
        },
      },
    })
  })

  it('should transition if state node ID matches current state value', function*({ expect }) {
    const machine = createMachine({
      type: 'parallel',
      states: {
        a: {
          initial: 'a1',
          states: {
            a1: {
              on: {
                EVENT3: ({ self }) => {
                  if (checkStateIn(self.getSnapshot(), '#b_b2')) {
                    return { target: 'a2' }
                  }
                  return undefined
                },
              },
            },
            a2: {
              id: 'a_a2',
            },
          },
        },
        b: {
          initial: 'b2',
          states: {
            b1: {},
            b2: {
              id: 'b_b2',
              type: 'parallel',
              states: {
                foo: {
                  initial: 'foo2',
                  states: {
                    foo1: {},
                    foo2: {},
                  },
                },
                bar: {
                  initial: 'bar1',
                  states: {
                    bar1: {
                      id: 'bar1',
                    },
                    bar2: {},
                  },
                },
              },
            },
          },
        },
      },
    })
    const actorRef = createActor(machine).start()
    actorRef.send({ type: 'EVENT3' })

    yield* expect(actorRef.getSnapshot().value).toEqual({
      a: 'a2',
      b: {
        b2: {
          foo: 'foo2',
          bar: 'bar1',
        },
      },
    })
  })

  it('should not transition if string state path does not match current state value', function*({ expect }) {
    const machine = createMachine({
      type: 'parallel',
      states: {
        a: {
          initial: 'a1',
          states: {
            a1: {
              on: {
                EVENT1: ({ value }) => {
                  if (matchesState('b.b2', value)) {
                    return { target: 'a2' }
                  }
                  return undefined
                },
              },
            },
            a2: {
              id: 'a_a2',
            },
          },
        },
        b: {
          initial: 'b1',
          states: {
            b1: {},
            b2: {
              id: 'b_b2',
              type: 'parallel',
              states: {
                foo: {
                  initial: 'foo1',
                  states: {
                    foo1: {},
                    foo2: {},
                  },
                },
                bar: {
                  initial: 'bar1',
                  states: {
                    bar1: {
                      id: 'bar1',
                    },
                    bar2: {},
                  },
                },
              },
            },
          },
        },
      },
    })
    const actorRef = createActor(machine).start()
    actorRef.send({ type: 'EVENT1' })

    yield* expect(actorRef.getSnapshot().value).toEqual({
      a: 'a1',
      b: 'b1',
    })
  })

  it('should not transition if state value matches current state value', function*({ expect }) {
    const machine = createMachine({
      type: 'parallel',
      states: {
        a: {
          initial: 'a1',
          states: {
            a1: {
              on: {
                EVENT2: ({ value }) => {
                  if (matchesState({ b: 'b2' }, value)) {
                    return { target: 'a2' }
                  }
                  return undefined
                },
              },
            },
            a2: {
              id: 'a_a2',
            },
          },
        },
        b: {
          initial: 'b2',
          states: {
            b1: {},
            b2: {
              id: 'b_b2',
              type: 'parallel',
              states: {
                foo: {
                  initial: 'foo2',
                  states: {
                    foo1: {},
                    foo2: {},
                  },
                },
                bar: {
                  initial: 'bar1',
                  states: {
                    bar1: {
                      id: 'bar1',
                    },
                    bar2: {},
                  },
                },
              },
            },
          },
        },
      },
    })
    const actorRef = createActor(machine).start()
    actorRef.send({ type: 'EVENT2' })

    yield* expect(actorRef.getSnapshot().value).toEqual({
      a: 'a2',
      b: {
        b2: {
          foo: 'foo2',
          bar: 'bar1',
        },
      },
    })
  })

  it('matching should be relative to grandparent (match)', function*({ expect }) {
    const machine = createMachine({
      type: 'parallel',
      states: {
        a: {
          initial: 'a1',
          states: {
            a1: {},
            a2: {
              id: 'a_a2',
            },
          },
        },
        b: {
          initial: 'b2',
          states: {
            b1: {},
            b2: {
              id: 'b_b2',
              type: 'parallel',
              states: {
                foo: {
                  initial: 'foo1',
                  states: {
                    foo1: {
                      on: {
                        EVENT_DEEP: ({ self }) => {
                          if (checkStateIn(self.getSnapshot(), '#bar1')) {
                            return { target: 'foo2' }
                          }
                          return undefined
                        },
                      },
                    },
                    foo2: {},
                  },
                },
                bar: {
                  initial: 'bar1',
                  states: {
                    bar1: {
                      id: 'bar1',
                    },
                    bar2: {},
                  },
                },
              },
            },
          },
        },
      },
    })
    const actorRef = createActor(machine).start()
    actorRef.send({ type: 'EVENT_DEEP' })

    yield* expect(actorRef.getSnapshot().value).toEqual({
      a: 'a1',
      b: {
        b2: {
          foo: 'foo2',
          bar: 'bar1',
        },
      },
    })
  })

  it('matching should be relative to grandparent (no match)', function*({ expect }) {
    const machine = createMachine({
      type: 'parallel',
      states: {
        a: {
          initial: 'a1',
          states: {
            a1: {},
            a2: {
              id: 'a_a2',
            },
          },
        },
        b: {
          initial: 'b2',
          states: {
            b1: {},
            b2: {
              id: 'b_b2',
              type: 'parallel',
              states: {
                foo: {
                  initial: 'foo1',
                  states: {
                    foo1: {
                      on: {
                        EVENT_DEEP: ({ self }) => {
                          if (checkStateIn(self.getSnapshot(), '#bar1')) {
                            return { target: 'foo2' }
                          }
                          return undefined
                        },
                      },
                    },
                    foo2: {},
                  },
                },
                bar: {
                  initial: 'bar2',
                  states: {
                    bar1: {
                      id: 'bar1',
                    },
                    bar2: {},
                  },
                },
              },
            },
          },
        },
      },
    })
    const actorRef = createActor(machine).start()
    actorRef.send({ type: 'EVENT_DEEP' })

    yield* expect(actorRef.getSnapshot().value).toEqual({
      a: 'a1',
      b: {
        b2: {
          foo: 'foo1',
          bar: 'bar2',
        },
      },
    })
  })

  it('should work to forbid events', function*({ expect }) {
    const machine = createMachine({
      initial: 'green',
      states: {
        green: { on: { TIMER: { target: 'yellow' } } },
        yellow: { on: { TIMER: { target: 'red' } } },
        red: {
          initial: 'walk',
          states: {
            walk: {
              on: { TIMER: { target: 'wait' } },
            },
            wait: {
              on: { TIMER: { target: 'stop' } },
            },
            stop: {},
          },
          on: {
            TIMER: ({ value }) => {
              if (matchesState({ red: 'stop' }, value)) {
                return { target: 'green' }
              }
              return undefined
            },
          },
        },
      },
    })

    const actorRef = createActor(machine).start()

    actorRef.send({ type: 'TIMER' })
    actorRef.send({ type: 'TIMER' })
    actorRef.send({ type: 'TIMER' })
    const afterThreeTimers = actorRef.getSnapshot().value

    actorRef.send({ type: 'TIMER' })
    const afterFourTimers = actorRef.getSnapshot().value

    actorRef.send({ type: 'TIMER' })
    const afterFiveTimers = actorRef.getSnapshot().value

    yield* expect({ afterThreeTimers, afterFourTimers, afterFiveTimers }).toEqual({
      afterThreeTimers: { red: 'wait' },
      afterFourTimers: { red: 'stop' },
      afterFiveTimers: 'green',
    })
  })

  it('should be possible to use a referenced `stateIn` guard', function*({ expect }) {
    const machine = createMachine({
      type: 'parallel',
      guards: {
        hasSelection: (value: StateValue) => {
          return matchesState('selected', value)
        },
      },
      states: {
        selected: {},
        location: {
          initial: 'home',
          states: {
            home: {
              on: {
                NEXT: ({ guards, value }) => {
                  if (guards.hasSelection(value)) {
                    return {
                      target: 'success',
                    }
                  }
                  return undefined
                },
              },
            },
            success: {},
          },
        },
      },
    })

    const actor = createActor(machine).start()
    actor.send({
      type: 'NEXT',
    })
    yield* expect(actor.getSnapshot().value).toEqual({
      selected: {},
      location: 'success',
    })
  })

  it.skip('should be possible to check an ID with a path', function*({ expect }) {
    const calls: Array<undefined> = []
    const spy = () => {
      calls.push(undefined)
    }
    const machine = createMachine({
      type: 'parallel',
      states: {
        A: {
          initial: 'A1',
          states: {
            A1: {
              on: {
                MY_EVENT: ({ value }, enq) => {
                  if (matchesState('#b.B1', value)) {
                    enq(spy)
                  }
                },
              },
            },
          },
        },
        B: {
          id: 'b',
          initial: 'B1',
          states: {
            B1: {},
          },
        },
      },
    })

    createActor(machine).start().send({
      type: 'MY_EVENT',
    })

    yield* expect(calls).toEqual([undefined])
  })
})
