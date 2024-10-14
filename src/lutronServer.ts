require('source-map-support').install();
const express = require('express')
const bodyParser = require('body-parser')
const LA = require('./lutronAPI')
const LAT = require('./lutronTelnetAPI')
const app = express()
const defaultMethodTelnet = true
const port = process.env.LUTRON_SERVER_PORT || 8082;
const lutronIP = process.env.LUTRON_SERVER_IP || "127.0.0.1";
let lutron = (defaultMethodTelnet)?new LAT.LutronTelnetAPI(lutronIP, 23):new LA.LutronAPI(lutronIP)

//type ExpCB = (dt:string)=>void;
type ExpCB = any;

app.use(bodyParser.urlencoded({extended: true}));
app.use(bodyParser.json());
if (!defaultMethodTelnet) {
  app.get('/v0/devices', function(req:ExpCB, res:ExpCB){
    console.log("Got a GET:/v0/devices");
    try {
      lutron.getDeviceList()
      .then((devList:any)=> {
        res.status(200).send(JSON.stringify(devList));
      });
    } catch(e: any) {
      console.log("Error: " + e);
      console.log(e.stack);
      res.status(400).send("Error while processing the request");
    }
  });
  app.get('/v0/name/:devicename', function (req:ExpCB, res:ExpCB, next:ExpCB){
    try {
      let deviceName = req.params.devicename;
      console.log("Got /v0/name/" + deviceName);
      lutron.getValueName(deviceName)
      .then((r:number)=>{
        let result = {'deviceName': deviceName, 'value':r};
        console.log("    Returning:" + JSON.stringify(result));
        res.status(200).send(JSON.stringify(result));
      });
    } catch(e: any) {
      console.log("Error: " + e);
      console.log(e.stack);
      res.status(400).send("Error while processing the request");
    }
  });
  app.put('/v0/name/:devicename/value/:value', function(req:ExpCB, res:ExpCB, next:ExpCB){
    try {
      let deviceName = req.params.devicename;
      let value = parseInt(req.params.value);
      console.log("Got /v0/name/ for " + deviceName + " = " + value);
      lutron.setValueName(deviceName, value)
      .then((r:any) => {
          res.status(200).send('ok');
      });
    } catch(e: any) {
      console.log("Error: " + e);
      console.log(e.stack);
      res.status(400).send("Error while processing the request");
    }
  });

  app.put('/v0/togglename/:devicename', function(req:ExpCB, res:ExpCB, next:ExpCB){
    try {
      let deviceName = req.params.devicename;
      console.log("Got /v0/toggle/ for " + deviceName);
      lutron.toggleName(deviceName)
      .then((r:any) => {
          res.status(200).send('ok');
      });
    } catch(e: any) {
      console.log("Error: " + e);
      console.log(e.stack);
      res.status(400).send("Error while processing the request");
    }
  });
}

app.get('/v0/device/:deviceid', function (req:ExpCB, res:ExpCB, next:ExpCB){
  try {
    let deviceId = req.params.deviceid;
    console.log("Got /v0/device/" + deviceId);
    lutron.getValue(deviceId)
    .then((r:number)=>{
      let result = {'deviceId': deviceId, 'value':r};
      console.log("    Returning:" + JSON.stringify(result));
      res.status(200).send(JSON.stringify(result));
    });
  } catch(e: any) {
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
  } catch(e: any) {
    console.log("Error: " + e);
    console.log(e.stack);
    res.status(400).send("Error while processing the request");
  }
});
app.get('/v0/status/all', function (req:ExpCB, res:ExpCB, next:ExpCB){
  try {
    let deviceName = req.params.devicename;
    console.log("Got /v0/status/all" + deviceName);
    lutron.getStatusAll()
    .then((result:string)=>{
      console.log("    Returning:" + JSON.stringify(result));
      res.status(200).send(JSON.stringify(result));
    });
  } catch(e: any) {
    console.log("Error: " + e);
    console.log(e.stack);
    res.status(400).send("Error while processing the request");
  }
});

app.put('/v0/toggle/:deviceid', function(req:ExpCB, res:ExpCB, next:ExpCB){
  try {
    let deviceId = req.params.deviceid;
    console.log("Got /v0/toggle/ for " + deviceId);
    lutron.toggleValue(deviceId)
    .then((r:any) => {
        res.status(200).send('ok');
    });
  } catch(e: any) {
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
