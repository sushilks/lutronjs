const loxone_config = process.env.LOXONE_CONFIG || "./loxone-cfg";
console.log("LOADING CONFIG FROM :", loxone_config, process.env.LOXONE_CONFIG )
var loxone = require(loxone_config);
loxone.setDebug(true)
loxone.connect()
