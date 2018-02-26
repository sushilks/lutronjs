const LWSU = require('./loxoneWSUtil')
// populate the table below with
// device ID from the Lutron Server and Device Name from Loxone.
let deviceMapper = {
  1:[{"action":1, "name":"Master", "type":"default", "uuid":"12912922-2928-9392-ffff966013b4d4d8", "mult":1.0}],
  2:[{"action":1, "name":"Hallway Night Light", "type":"default", "uuid":"12912922-1234-9392-ffff966013b4d4d8", "mult":1.0}],
  3:[{"action":2, "name":"Master-Blind", "uuid":"12912922-3a53-9392-ffff966013b4d4d8", "type":"direct", "command":"PulseUp"},
     {"action":4, "name":"Master-Blind", "uuid":"12912922-9a31-9392-ffff966013b4d4d8", "type":"direct", "command":"PulseDown"}]
}
let lwsu = new LWSU.LoxoneWS('192.168.1.2','username', 'password',  deviceMapper)
module.exports = lwsu;
