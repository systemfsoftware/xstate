import { describe, it } from '@systemfsoftware/vitest'
import { createActor, createMachineFromConfig } from '../src/index.js'

describe('multiple', () => {
  const machine = createMachineFromConfig({
    initial: 'simple',
    states: {
      simple: {
        on: {
          DEEP_M: { target: 'para.K.M' },
          DEEP_CM: { target: ['para.A.C', 'para.K.M'] },
          DEEP_MR: { target: ['para.K.M', 'para.P.R'] },
          DEEP_CMR: { target: ['para.A.C', 'para.K.M', 'para.P.R'] },
          INITIAL: { target: 'para' },
        },
      },
      other: {
        initial: 'X',
        states: {
          X: {},
        },
      },
      para: {
        type: 'parallel',
        states: {
          A: {
            initial: 'B',
            states: {
              B: {},
              C: {},
            },
          },
          K: {
            initial: 'L',
            states: {
              L: {},
              M: {},
            },
          },
          P: {
            initial: 'Q',
            states: {
              Q: {},
              R: {},
            },
          },
        },
      },
      para2: {
        type: 'parallel',
        states: {
          A2: {
            initial: 'B2',
            states: {
              B2: {},
              C2: {},
            },
          },
          K2: {
            initial: 'L2',
            states: {
              L2: {
                type: 'parallel',
                states: {
                  L2A: {
                    initial: 'L2B',
                    states: {
                      L2B: {},
                      L2C: {},
                    },
                  },
                  L2K: {
                    initial: 'L2L',
                    states: {
                      L2L: {},
                      L2M: {},
                    },
                  },
                  L2P: {
                    initial: 'L2Q',
                    states: {
                      L2Q: {},
                      L2R: {},
                    },
                  },
                },
              },
              M2: {
                type: 'parallel',
                states: {
                  M2A: {
                    initial: 'M2B',
                    states: {
                      M2B: {},
                      M2C: {},
                    },
                  },
                  M2K: {
                    initial: 'M2L',
                    states: {
                      M2L: {},
                      M2M: {},
                    },
                  },
                  M2P: {
                    initial: 'M2Q',
                    states: {
                      M2Q: {},
                      M2R: {},
                    },
                  },
                },
              },
            },
          },
          P2: {
            initial: 'Q2',
            states: {
              Q2: {},
              R2: {},
            },
          },
        },
      },
    },
  })

  describe('transitions to parallel states', () => {
    it('should enter initial states of parallel states', function*({ expect }) {
      const actorRef = createActor(machine).start()
      actorRef.send({ type: 'INITIAL' })
      yield* expect(actorRef.getSnapshot().value).toEqual({
        para: { A: 'B', K: 'L', P: 'Q' },
      })
    })

    it('should enter specific states in one region', function*({ expect }) {
      const actorRef = createActor(machine).start()
      actorRef.send({ type: 'DEEP_M' })
      yield* expect(actorRef.getSnapshot().value).toEqual({
        para: { A: 'B', K: 'M', P: 'Q' },
      })
    })

    it('should enter specific states in all regions', function*({ expect }) {
      const actorRef = createActor(machine).start()
      actorRef.send({ type: 'DEEP_CMR' })
      yield* expect(actorRef.getSnapshot().value).toEqual({
        para: { A: 'C', K: 'M', P: 'R' },
      })
    })

    it('should enter specific states in some regions', function*({ expect }) {
      const actorRef = createActor(machine).start()
      actorRef.send({ type: 'DEEP_MR' })
      yield* expect(actorRef.getSnapshot().value).toEqual({
        para: { A: 'B', K: 'M', P: 'R' },
      })
    })
  })
})
