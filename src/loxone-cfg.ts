var LoxoneAPI = require('loxone-nodejs');

var loxone = new LoxoneAPI({
    ip: "192.168.1.2", // Add your LOXONE Server IP ADDR
    debug: false,
    username: "username", // ADD A Loxone USER ID
    password: "changme" // ADD A Loxone Password
});
// populate the table below with
// device ID from the Lutron Server and Device Name from Loxone.
loxone._devMapper = {
  5:{"name":"Master", "type":"dimmer"},
  6:{"name":"Hallway Night Light", "type":"dimmer"}
}
module.exports = loxone;
