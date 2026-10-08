import type { Page, test, TestInfo } from '@playwright/test'
import { expectTypeOf, it } from '@systemfsoftware/vitest'
import {
  createPlaywrightSut,
  type PlaywrightMock,
  type PlaywrightPage,
  type PlaywrightSutConfig,
  type PlaywrightTestInfo,
} from '../src/playwright.js'

it('accepts a real Playwright page', function*({ expect }) {
  expectTypeOf<
    Page extends PlaywrightPage ? true : false
  >().toEqualTypeOf<true>()

  yield* expect(typeof createPlaywrightSut).toEqual('function')
})

it('accepts route registrations returned from mocks', function*({ expect }) {
  expectTypeOf<(page: Page) => ReturnType<Page['route']>>().toExtend<
    PlaywrightMock<Page>
  >()

  yield* expect(typeof createPlaywrightSut).toEqual('function')
})

it('accepts testInfo and test.step', function*({ expect }) {
  expectTypeOf<
    TestInfo extends PlaywrightTestInfo ? true : false
  >().toEqualTypeOf<true>()
  const step: NonNullable<PlaywrightSutConfig<Page, any, any>['step']> = null! as typeof test.step
  void step

  yield* expect(typeof createPlaywrightSut).toEqual('function')
})
