/**
 * os-shim.js — Browser-compatible shim for Node's 'os' module
 */

module.exports = {
  platform: () => 'browser',
  homedir: () => '/home/user',
  tmpdir: () => '/tmp',
  hostname: () => 'browser',
  type: () => 'Browser',
  arch: () => 'web',
  release: () => '1.0.0',
  cpus: () => [{ model: 'Browser', speed: 0, times: {} }],
  totalmem: () => 0,
  freemem: () => 0,
  networkInterfaces: () => ({}),
  userInfo: () => ({ username: 'web-user', homedir: '/home/user', shell: '/bin/sh', uid: 1000, gid: 1000 }),
  endianness: () => 'LE',
  EOL: '\n',
}
