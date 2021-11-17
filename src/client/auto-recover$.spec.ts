#!/usr/bin/env -S node --no-warnings --loader ts-node/esm

import { test }  from 'tstest'

import {
  TestScheduler,
}                     from 'rxjs/testing'
import {
  throttleTime,
}                     from 'rxjs/operators'

import {
  isStable,
  noHeartbeatHard,
  noHeartbeatSoft,
}                     from './auto-recover$.js'
import PuppetMock from 'wechaty-puppet-mock'

test('isStable()', async t => {
  t.equal(isStable(true), true, 'should get expected result for boolean `true`')
  t.equal(isStable('pending'), false, 'should get expected result for `pending`')
})

/**
 * RxJS Marble Testing
 *
 *  - https://rxjs.dev/guide/testing/marble-testing
 *  - https://github.com/ReactiveX/rxjs/blob/master/docs_app/content/guide/testing/marble-testing.md
 *
 */
test('Example: marble testing', async t => {
  const testScheduler = new TestScheduler(t.same)

  testScheduler.run(helpers => {
    const { cold, time, expectObservable, expectSubscriptions } = helpers
    const e1       = cold('-a--b--c---|')
    const e1subs   = '     ^----------!'
    const t        = time('---|        ')  // t = 3
    const expected = '     -a-----c---|'

    expectObservable(e1.pipe(throttleTime(t))).toBe(expected)
    expectSubscriptions(e1.subscriptions).toBe(e1subs)
  })
})

test('noHeartbeatSoft()', async t => {
  const testScheduler = new TestScheduler(t.same)

  const puppet = new PuppetMock()

  const ding$ = noHeartbeatSoft(1)(puppet)

  testScheduler.run(helpers => {
    const { cold, time, expectObservable, expectSubscriptions } = helpers
    const e1       = cold('-a--b--b---|')
    const e1subs   = '     ^----------!'
    const t        = time('---|        ')  // t = 3
    const expected = '     -a-----c---|'

    expectObservable(e1.pipe(throttleTime(t))).toBe(expected)
    expectSubscriptions(e1.subscriptions).toBe(e1subs)
  })
})
