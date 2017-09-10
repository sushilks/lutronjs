# lutronjs

A NodeJS server which accepts REST commands and configures Lutron Caseta Gateway

Work in Progress.

# TO setup
npm install

# TO BUILD
npm run build

# To start SERVER
LUTRON_SERVER_IP="xx.xx.xx.xx" npm run server

# Usages
## Get a list of devices
curl http://<IP>:8082/v0/devices
Returns a JSON Blob of devices
i.e.
> curl http://<IP>:8082/v0/devices
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


The private key is copied form the project
https://github.com/njschwartz/Lutron-Smart-Pi
