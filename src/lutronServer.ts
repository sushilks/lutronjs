require('source-map-support').install();
const express = require('express')
const bodyParser = require('body-parser')
const LA = require('./lutronAPI')
const app = express()
const port = process.env.LUTRON_SERVER_PORT || 8082;
const lutronIP = process.env.LUTRON_SERVER_IP || "127.0.0.1";
let lutron = new LA.LutronAPI(lutronIP)

//type ExpCB = (dt:string)=>void;
type ExpCB = any;

app.use(bodyParser.urlencoded({extended: true}));
app.use(bodyParser.json());
app.get('/v0/devices', function(req:ExpCB, res:ExpCB){
  console.log("Got a GET:/v0/devices");
  try {
    lutron.getDeviceList()
    .then((devList:any)=> {
      res.status(200).send(JSON.stringify(devList));
    });
  } catch(e) {
    console.log("Error: " + e);
    console.log(e.stack);
    res.status(400).send("Error while processing the request");
  }
});

app.get('/v0/device/:deviceid', function (req:ExpCB, res:ExpCB, next:ExpCB){
  try {
    let deviceId = req.params.deviceid;
    lutron.getValue(deviceId)
    .then((r:number)=>{
      let result = {'deviceId': deviceId, 'value':r};
      res.status(200).send(JSON.stringify(result));
    });
  } catch(e) {
    console.log("Error: " + e);
    console.log(e.stack);
    res.status(400).send("Error while processing the request");
  }
});
app.put('/v0/device/:deviceid/value/:value', function(req:ExpCB, res:ExpCB, next:ExpCB){
  try {
    let deviceId = req.params.deviceid;
    let value = parseInt(req.params.value);
    lutron.setValue(deviceId, value)
    .then((r:any) => {
        res.status(200).send('ok');
    });
  } catch(e) {
    console.log("Error: " + e);
    console.log(e.stack);
    res.status(400).send("Error while processing the request");
  }
});

lutron.init()
.then(()=>
  app.listen(port, function() {
    console.log("App is running on port:", port);
  })
);
