#!/usr/bin/env node --no-warnings --loader ts-node/esm

import { test }  from 'tstest'

import { Puppet } from 'wechaty-puppet'

import {
  PuppetServer,
  PuppetServerOptions,
}                          from './puppet-server.js'

test('version()', async t => {
  const options: PuppetServerOptions = {
    endpoint : '127.0.0.1:8788',
    puppet   : {} as Puppet,
    token    : 'secret',
  }

  const puppet = new PuppetServer(options)
  t.ok(puppet.version())
})
