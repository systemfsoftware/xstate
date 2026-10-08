import { describe, it } from '@systemfsoftware/vitest'
import { createActor, createMachine } from '../src/index.js'
import { trackEntries } from './utils.js'

describe('deep transitions', () => {
  describe('exiting super/substates', () => {
    it('should exit all substates when superstates exits', function*({ expect }) {
      const machine = createMachine({
        id: 'root',
        initial: 'A',
        states: {
          DONE: {},
          FAIL: {},
          A: {
            on: {
              A_EVENT: { target: '#root.DONE' },
            },
            initial: 'B',
            states: {
              B: {
                initial: 'C',
                states: {
                  C: {
                    initial: 'D',
                    states: {
                      D: {},
                    },
                  },
                },
              },
            },
          },
        },
      })

      const flushTracked = trackEntries(machine)

      const actor = createActor(machine).start()
      flushTracked()

      actor.send({
        type: 'A_EVENT',
      })

      yield* expect(flushTracked()).toEqual([
        'exit: A.B.C.D',
        'exit: A.B.C',
        'exit: A.B',
        'exit: A',
        'enter: DONE',
      ])
    })

    it('should exit substates and superstates when exiting (B_EVENT)', function*({ expect }) {
      const machine = createMachine({
        id: 'root',
        initial: 'A',
        states: {
          DONE: {},
          A: {
            initial: 'B',
            states: {
              B: {
                on: {
                  B_EVENT: { target: '#root.DONE' },
                },
                initial: 'C',
                states: {
                  C: {
                    initial: 'D',
                    states: {
                      D: {},
                    },
                  },
                },
              },
            },
          },
        },
      })

      const flushTracked = trackEntries(machine)

      const actor = createActor(machine).start()
      flushTracked()

      actor.send({
        type: 'B_EVENT',
      })

      yield* expect(flushTracked()).toEqual([
        'exit: A.B.C.D',
        'exit: A.B.C',
        'exit: A.B',
        'exit: A',
        'enter: DONE',
      ])
    })

    it('should exit substates and superstates when exiting (C_EVENT)', function*({ expect }) {
      const machine = createMachine({
        id: 'root',
        initial: 'A',
        states: {
          DONE: {},
          A: {
            initial: 'B',
            states: {
              B: {
                initial: 'C',
                states: {
                  C: {
                    on: {
                      C_EVENT: { target: '#root.DONE' },
                    },
                    initial: 'D',
                    states: {
                      D: {},
                    },
                  },
                },
              },
            },
          },
        },
      })

      const flushTracked = trackEntries(machine)

      const actor = createActor(machine).start()
      flushTracked()

      actor.send({
        type: 'C_EVENT',
      })

      yield* expect(flushTracked()).toEqual([
        'exit: A.B.C.D',
        'exit: A.B.C',
        'exit: A.B',
        'exit: A',
        'enter: DONE',
      ])
    })

    it('should exit superstates when exiting (D_EVENT)', function*({ expect }) {
      const machine = createMachine({
        id: 'root',
        initial: 'A',
        states: {
          DONE: {},
          A: {
            initial: 'B',
            states: {
              B: {
                initial: 'C',
                states: {
                  C: {
                    initial: 'D',
                    states: {
                      D: {
                        on: {
                          D_EVENT: { target: '#root.DONE' },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      })

      const flushTracked = trackEntries(machine)

      const actor = createActor(machine).start()
      flushTracked()

      actor.send({
        type: 'D_EVENT',
      })

      yield* expect(flushTracked()).toEqual([
        'exit: A.B.C.D',
        'exit: A.B.C',
        'exit: A.B',
        'exit: A',
        'enter: DONE',
      ])
    })

    it('should exit substate when machine handles event (MACHINE_EVENT)', function*({ expect }) {
      const machine = createMachine({
        id: 'deep',
        initial: 'A',
        on: {
          MACHINE_EVENT: { target: '#deep.DONE' },
        },
        states: {
          DONE: {},
          A: {
            initial: 'B',
            states: {
              B: {
                initial: 'C',
                states: {
                  C: {
                    initial: 'D',
                    states: {
                      D: {},
                    },
                  },
                },
              },
            },
          },
        },
      })

      const flushTracked = trackEntries(machine)

      const actor = createActor(machine).start()
      flushTracked()

      actor.send({
        type: 'MACHINE_EVENT',
      })

      yield* expect(flushTracked()).toEqual([
        'exit: A.B.C.D',
        'exit: A.B.C',
        'exit: A.B',
        'exit: A',
        'enter: DONE',
      ])
    })

    it('should exit deep and enter deep (A_S)', function*({ expect }) {
      const machine = createMachine({
        id: 'root',
        initial: 'A',
        states: {
          A: {
            on: {
              A_S: { target: '#root.P.Q.R.S' },
            },
            initial: 'B',
            states: {
              B: {
                initial: 'C',
                states: {
                  C: {
                    initial: 'D',
                    states: {
                      D: {},
                    },
                  },
                },
              },
            },
          },
          P: {
            initial: 'Q',
            states: {
              Q: {
                initial: 'R',
                states: {
                  R: {
                    initial: 'S',
                    states: {
                      S: {},
                    },
                  },
                },
              },
            },
          },
        },
      })
      const flushTracked = trackEntries(machine)

      const actor = createActor(machine).start()
      flushTracked()

      actor.send({
        type: 'A_S',
      })

      yield* expect(flushTracked()).toEqual([
        'exit: A.B.C.D',
        'exit: A.B.C',
        'exit: A.B',
        'exit: A',
        'enter: P',
        'enter: P.Q',
        'enter: P.Q.R',
        'enter: P.Q.R.S',
      ])
    })

    it('should exit deep and enter deep (D_P)', function*({ expect }) {
      const machine = createMachine({
        id: 'deep',
        initial: 'A',
        states: {
          A: {
            initial: 'B',
            states: {
              B: {
                initial: 'C',
                states: {
                  C: {
                    initial: 'D',
                    states: {
                      D: {
                        on: {
                          D_P: { target: '#deep.P' },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
          P: {
            initial: 'Q',
            states: {
              Q: {
                initial: 'R',
                states: {
                  R: {
                    initial: 'S',
                    states: {
                      S: {},
                    },
                  },
                },
              },
            },
          },
        },
      })

      const flushTracked = trackEntries(machine)

      const actor = createActor(machine).start()
      flushTracked()

      actor.send({
        type: 'D_P',
      })

      yield* expect(flushTracked()).toEqual([
        'exit: A.B.C.D',
        'exit: A.B.C',
        'exit: A.B',
        'exit: A',
        'enter: P',
        'enter: P.Q',
        'enter: P.Q.R',
        'enter: P.Q.R.S',
      ])
    })

    it(
      'should exit deep and enter deep when targeting an ancestor of the final resolved deep target',
      function*({ expect }) {
        const machine = createMachine({
          id: 'root',
          initial: 'A',
          states: {
            A: {
              on: {
                A_P: { target: '#root.P' },
              },
              initial: 'B',
              states: {
                B: {
                  initial: 'C',
                  states: {
                    C: {
                      initial: 'D',
                      states: {
                        D: {},
                      },
                    },
                  },
                },
              },
            },
            P: {
              initial: 'Q',
              states: {
                Q: {
                  initial: 'R',
                  states: {
                    R: {
                      initial: 'S',
                      states: {
                        S: {},
                      },
                    },
                  },
                },
              },
            },
          },
        })

        const flushTracked = trackEntries(machine)

        const actor = createActor(machine).start()
        flushTracked()

        actor.send({
          type: 'A_P',
        })

        yield* expect(flushTracked()).toEqual([
          'exit: A.B.C.D',
          'exit: A.B.C',
          'exit: A.B',
          'exit: A',
          'enter: P',
          'enter: P.Q',
          'enter: P.Q.R',
          'enter: P.Q.R.S',
        ])
      },
    )

    it('should exit deep and enter deep when targeting a deep state', function*({ expect }) {
      const machine = createMachine({
        id: 'root',
        initial: 'A',
        states: {
          A: {
            initial: 'B',
            states: {
              B: {
                initial: 'C',
                states: {
                  C: {
                    initial: 'D',
                    states: {
                      D: {
                        on: {
                          D_S: { target: '#root.P.Q.R.S' },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
          P: {
            initial: 'Q',
            states: {
              Q: {
                initial: 'R',
                states: {
                  R: {
                    initial: 'S',
                    states: {
                      S: {},
                    },
                  },
                },
              },
            },
          },
        },
      })

      const flushTracked = trackEntries(machine)

      const actor = createActor(machine).start()
      flushTracked()

      actor.send({
        type: 'D_S',
      })

      yield* expect(flushTracked()).toEqual([
        'exit: A.B.C.D',
        'exit: A.B.C',
        'exit: A.B',
        'exit: A',
        'enter: P',
        'enter: P.Q',
        'enter: P.Q.R',
        'enter: P.Q.R.S',
      ])
    })
  })
})
