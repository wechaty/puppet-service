#!/usr/bin/env -S node --no-warnings --loader ts-node/esm
/* eslint-disable func-call-spacing */

import { test }  from 'tstest'

import {
  TestScheduler,
}                     from 'rxjs/testing'
import {
  throttleTime,
}                     from 'rxjs/operators'
import PuppetMock     from 'wechaty-puppet-mock'

import {
  Duck as PuppetDuck,
}                     from 'wechaty-redux'

import {
  epicRecoverReset$,
  epicRecoverDing$,
  monitorHeartbeat$,
}                     from './epic-recover.js'

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

test('monitorHeartbeat$()', async t => {
  const testScheduler = new TestScheduler(t.same)

  const puppet = new PuppetMock()

  const TIMEOUT = 15

  testScheduler.run(helpers => {
    const { hot, expectObservable, expectSubscriptions } = helpers

    const marble = {
      a: PuppetDuck.actions.activeState   (puppet.id, true),
      h: PuppetDuck.actions.heartbeatEvent(puppet.id, { data: 'heartbeat' }),
      t: PuppetDuck.actions.errorEvent    (puppet.id, { gerror: `monitorHeartbeat$() TIMEOUT(${TIMEOUT})` }),
    }

    const puppet$   = hot(`-^--a-----h------h ${TIMEOUT}ms -`, marble)
    const puppetSub = `     ^---------------- ${TIMEOUT}ms -`
    const expected  = `      ---------------- ${TIMEOUT}ms t`

    expectObservable(
      monitorHeartbeat$(TIMEOUT)(puppet$),
      // puppetSub,
    ).toBe(expected, marble)
    expectSubscriptions(puppet$.subscriptions).toBe(puppetSub)
  })
})

test('tbw', async t => {
  void epicRecoverReset$
  void epicRecoverDing$
  t.pass('tbw')
})
