#!/usr/bin/env ts-node

import {
  test,
  sinon,
}         from 'tstest'

import { metaGeneratorToken } from './call-cred'

test('metaGeneratorToken()', async t => {
  const TOKEN = '__token__'
  const EXPECTED_AUTHORIZATION = `Wechaty ${TOKEN}`

  const sandbox = sinon.createSandbox()
  const spy = sandbox.spy()

  const metaGenerator = metaGeneratorToken(TOKEN)

  metaGenerator({} as any, spy)
  t.equal(spy.args[0]![0], null, 'should no error')

  const metadata = spy.args[0]![1]
  const authorization = metadata.get('Authorization')[0]
  t.equal(authorization, EXPECTED_AUTHORIZATION, 'should generate authorization in metadata')
})
