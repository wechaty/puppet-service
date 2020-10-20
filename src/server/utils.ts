import grpc             from 'grpc'
import { FileBox }      from 'wechaty-puppet'
import { FileBoxChunk } from '@chatie/grpc'

import {
  FILE_BOX_NAME_METADATA_KEY,
  log,
}         from '../config'

export function grpcError (
  method   : string,
  e        : Error,
  callback : Function,
): void {
  log.error('PuppetServiceImpl', `grpcError() ${method}() rejection: %s`, e && e.message)

  const error: grpc.ServiceError = {
    ...e,
    code: grpc.status.INTERNAL,
    details: e.message,
  }
  return callback(error, null)
}

export async function sendFileBoxInStream<T> (fileBox: FileBox, call: grpc.ServerWritableStream<T>) {
  const metaData = new grpc.Metadata()
  metaData.set(FILE_BOX_NAME_METADATA_KEY, fileBox.name)
  call.sendMetadata(metaData)

  const stream = await fileBox.toStream()

  const fileBoxChunk = new FileBoxChunk()
  stream.on('data', chunk => {
    fileBoxChunk.setChunk(chunk)
    call.write(fileBoxChunk)
  }).on('end', () => {
    call.end()
  })
}
