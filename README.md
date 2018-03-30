# NOTE
This project will only work if you have the Pro-Bridge form lutron.

Update: I have also added LOXONE sync to the code base, now all changes in lutron state will be directly updated into loxone. (i.e.  pressing a lutron switch on the wall will also toggle the state of a virtual switch in the LOXONE controller) Helps in keeping LOXONE dashboard in sync,(Othewise I was having the problem where loxone will say light is off but it may have been turned on by someone pressing the switch on the wall). 
This is achived by putting information on what you want to sync in the file loxone-cfg.ts, you will need to add an entry there for the switch that you want to sync and the lutron device id that you want the switch to sync to. 
The lutron device ID can be found by looking at the log when activating the lutron device. You will see a log message with the device id. 
The loxone device uuid can be found by running "npm run watch", this will print out uuid's as you interact with the loxone controller.

If you have problem with this or want some help open a issue on github.

# lutronjs

A NodeJS server which accepts REST commands and configures Lutron Caseta Gateway

I have it connected to some Dimmer and switches so far and it work well.
I am primarily using it for connecting all the Lutron devices to LOXONE home automation system.

# TO setup
npm install

# TO BUILD
npm run build

# To start SERVER
LUTRON_SERVER_IP="xx.xx.xx.xx" npm run server

# To run Watch
npm run watch 
this will show all the events generated in the LOXONE controller.

# To create a container to run the package use the docker directory
## Build the container
cd docker
./build_lutronjs
## to run the container (I Use shared namespace in my case)
docker run --net=host  -d --name lutronjs --restart unless-stopped --tmpfs /run --tmpfs /run/lock sushilks/lutronjs /bin/bash -c ". /root/.nvm/nvm.sh && LUTRON_SERVER_PORT=<PORT> LUTRON_SERVER_IP=<HUB IP> /root/run_lutronjs.sh"

## To attach to the running container
./attach_lutronjs

## To view the logs from the container
docker logs -f lutronjs

# Usages
## Get a list of devices
curl http://<IP>:8082/v0/devices
Returns a JSON Blob of devices
i.e. Here is an example output
```json
[
  {
    "href": "/device/1",
    "Name": "Smart Bridge",
    "FullyQualifiedName": [
      "Smart Bridge"
    ],
    "Parent": {
      "href": "/project"
    },
    "SerialNumber": 123456,
    "ModelNumber": "L-BDG2-WH",
    "DeviceType": "SmartBridge",
    "RepeaterProperties": {
      "IsRepeater": true
    }
  },
  {
    "href": "/device/2",
    "Name": "Master Light",
    "FullyQualifiedName": [
      "Master Light"
    ],
    "Parent": {
      "href": "/project"
    },
    "SerialNumber": 12345678,
    "ModelNumber": "PD-6WCL-XX",
    "DeviceType": "WallDimmer",
    "LocalZones": [
      {
        "href": "/zone/1"
      }
    ]
  },
  {
    "href": "/device/3",
    "Name": "Master Light Remote 1",
    "FullyQualifiedName": [
      "Master Light Remote 1"
    ],
    "Parent": {
      "href": "/project"
    },
    "SerialNumber": 12345678,
    "ModelNumber": "PJ2-3BRL-GXX-X01",
    "DeviceType": "Pico3ButtonRaiseLower",
    "ButtonGroups": [
      {
        "href": "/buttongroup/2"
      }
    ]
  },
  {
    "href": "/device/15",
    "Name": "Outside Front Light",
    "FullyQualifiedName": [
      "Outside Front Light"
    ],
    "Parent": {
      "href": "/project"
    },
    "SerialNumber": 12345678,
    "ModelNumber": "PD-8ANS-XX",
    "DeviceType": "WallSwitch",
    "LocalZones": [
      {
        "href": "/zone/11"
      }
    ]
  }
]
```
## Get the setting of a device
curl http://<IP>:8082/v0/device/<deviceid>

i.e. curl http://<IP>:8082/v0/device/2
```json
{"deviceId":"2","value":100}
```

## Set a device to a value
To set the zone 2 device to a value of 20 use the following command
curl -X PUT http://<IP>:8082/v0/device/2/value/20

## Get the value by name of the device
curl http://<IP>:8082/v0/name/<deviceName>

i.e. curl http://<IP>:8082/v0/Master%20Light
```json
{"deviceId":"2","value":100}
```
## set the value of a device by name
To set the "Master Light" device to a value of 20 use the following command
curl -X PUT http://<IP>:8082/v0/name/Master%20Light/value/20

## To toggle a device. (If it's on it will turn off and vice-versa)
To toggle the "Master Light" device (If the device value is non zero it will be flipped to zero. Otherwise it will be set to 100)
curl -X PUT http://<IP>:8082/v0/toggle/Master%20Light

## Get the status of all the devices
curl http://<IP>:8082/v0/status/all

i.e. example output
```json
{"Master Light": 20, "Outside Front Light": 0}
```


