#!/usr/bin/env node
// Generate the sha256 hex for any WD_* secret the deployment consumes
// (WD_OPERATOR_PASSCODE_HASH, WD_MACHINE_TOKEN_HASH). Usage:
//   npm run hash -- 'your-long-passcode'
// Prints the hash and the exact env line(s) to paste.
import { createHash } from 'node:crypto'

const value = process.argv[2]
if (!value) {
  console.error('usage: npm run hash -- "<your-secret>"')
  console.error('  generates the sha256 hex for WD_OPERATOR_PASSCODE_HASH / WD_MACHINE_TOKEN_HASH')
  process.exit(1)
}
if (value.length < 12) {
  console.error('note: pick something longer than 12 characters — this gates the public demo')
}
const hash = createHash('sha256').update(value).digest('hex')
console.log(hash)
console.log('# paste into .env.local (console) or /etc/who-decides.env (host):')
console.log(`WD_OPERATOR_PASSCODE_HASH=${hash}`)
console.log('# only if you run the agent service yourself (agentcore/.env.local.example):')
console.log(`# WD_MACHINE_TOKEN_HASH=${hash}`)
