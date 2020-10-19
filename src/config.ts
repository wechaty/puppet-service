/// <reference path="./typings.d.ts" />

export { log } from 'wechaty-puppet'

export { VERSION } from './version'

export const GRPC_LIMITATION = {
  'grpc.max_receive_message_length': 1024 * 1024 * 150,
  'grpc.max_send_message_length': 1024 * 1024 * 150,
}

export const FILE_BOX_NAME_METADATA_KEY = 'fileName'
export const CONVERSATION_ID_METADATA_KEY = 'conversationId'

export const WECHATY_PUPPET_HOSTIE_TOKEN    = process.env.WECHATY_PUPPET_HOSTIE_TOKEN
export const WECHATY_PUPPET_HOSTIE_ENDPOINT = process.env.WECHATY_PUPPET_HOSTIE_ENDPOINT
