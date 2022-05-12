#!/usr/bin/env -S node --no-warnings --loader ts-node/esm

import { test } from 'tstest'
import * as path from 'path'
import * as fs from 'fs'
import type {
  PuppetOptions,
} from 'wechaty-puppet'
import PuppetMock from 'wechaty-puppet-mock'
import getPort from 'get-port'

import PuppetService, {
  PuppetServer,
  PuppetServerOptions,
} from '../src/mod.js'
import { FileBox } from 'file-box'

const NIL_UUID_V4 = '00000000-0000-0000-0000-000000000000'
const __dirname = path.resolve()

test('message file test', async t => {
  const PORT = await getPort()
  const TOKEN = `insecure_${NIL_UUID_V4}`
  const ENDPOINT = `0.0.0.0:${PORT}`

  /**
   * Puppet Server
   */
  const puppet = new PuppetMock()
  puppet.messageFile = async () => {
    return FileBox.fromFile(path.join(__dirname, 'tests', 'file-box.spec.ts'))
  }

  const serverOptions = {
    endpoint: ENDPOINT,
    puppet: puppet,
    token: TOKEN,
  } as PuppetServerOptions

  const puppetServer = new PuppetServer(serverOptions)

  await puppetServer.start()

  /**
   * Puppet Service Client
   */
  const puppetOptions = {
    endpoint: ENDPOINT,
    token: TOKEN,
  } as PuppetOptions

  // check if ready event is emited on this ready-ed puppet
  const puppetService = new PuppetService(puppetOptions)
  await puppetService.start()

  try {
    const file = await puppetService.messageFile('sb')
    await file.toFile(path.join(__dirname, 'download.ts'))
    const fileSize = fs.statSync(path.join(__dirname, 'download.ts')).size
    if (fs.existsSync(path.join(__dirname, 'download.ts'))) {
      t.ok(fileSize > 0, 'file size should not be zero')
    }
    t.fail('should have file saved down')
  } catch (e) {
    t.fail(`error happens when saveing file: ${(e as Error).stack}`)
  }
  if (fs.existsSync(path.join(__dirname, 'download.ts'))) {
    fs.rmSync(path.join(__dirname, 'download.ts'))
  }
  await puppetService.stop()
  await puppetServer.stop()
})
