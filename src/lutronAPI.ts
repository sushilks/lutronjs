
const NodeSSH = require('node-ssh')
const fs = require('fs')
const SSHUserName = 'leap'
const SSHPort = 22
const SSHKey = fs.readFileSync('./lutron.pem')

const LutronCommMap:{[n:string]:string} = {'ReadRequest':'ReadResponse', 'CreateRequest':'CreateResponse'} //, 'ExceptionResponse']


interface LutronBodyCmd {
  CommandType: string;
  Parameter: Array<{[n:string]:number | string}>
}
interface LutronZoneStatus {
  Zone: {
    href: string;
  }
  Level: number;
}
interface LutronDevices {
  href: string;
  Name: string;
  SerialNumber: string;
  ModelNumber: string;
  DeviceType: string;
  RepeaterProperties ?: {
    isRepeater: boolean;
  }
  Parent: {
    href: string;
  }
  FullyQualifiedName: Array<string>;
  LocalZones ?: Array<{href: string}>; // href : /zone/1
  ButtonGroups ?: Array<{href:string}>; // href : /buttongroup/2
}
interface LutronBody {
  Command?: LutronBodyCmd;
  ZoneStatus?: LutronZoneStatus;
  Devices ?: Array<LutronDevices>;
  Message ?: string;
}
interface LutronHeader {
  Url: string;
  StatusCode?: string;
  MessageBodyType?: string;
}
interface LutronMSG {
  CommuniqueType: string;
  Header: LutronHeader;
  Body?: LutronBody;
}
export
class LutronAPI {
    private loc:string;
    private ssh:any;
    private shell:any;
    private shellPromise: { [k:string]: (d:LutronMSG | string)=>LutronMSG | string} = {};
    private shellPromiseResp:string = '';
    private deviceList: {[id:number]: LutronDevices} = {};
    private deviceListName: {[name:string]: LutronDevices} = {};
    private zoneSatus: {[id:number]: number}  = {};
    private DEBUG = 1+2;
    private chunkBuffer :string = '';
    private statusAllCnt = 0;
    constructor(loc: string) {
      this.loc = loc;
      this.ssh = new NodeSSH();
    }

    public async init() {
      let r = await this.ssh.connect({
        host: this.loc,
        username: SSHUserName,
        port: SSHPort,
        privateKey: String(SSHKey)
      });
      console.log("Done with Connect");
      this.shell = await this.ssh.requestShell();
      this.shell.on('data', ((self:LutronAPI, data:string)=>{self.shellData(data)}).bind(null, this));
      this.shell.stderr.on('data', ((self:LutronAPI, data:string)=>{self.shellErrData(data)}).bind(null, this));
      await this.getDeviceList();
    }
    private getId(url:string):number {
      return parseInt(url.substring(url.lastIndexOf('/')+1));
    }
    private shellData(chunk:string) {
        let dt = this.chunkBuffer + String(chunk);
        this.chunkBuffer = '';
//        console.log("=>" + dt + "<=");
        while (true) {
          let n = dt.indexOf('\n');
          if (n != -1) {
            this.shellData_(dt.substr(0, n));
            dt = dt.substr(n + 1);
          } else {
            if (dt != '') {
              this.chunkBuffer = dt;
//              console.log("Saving in buffer: " + this.chunkBuffer);
            }
            break;
          }
        }
    }
    private shellData_(chunk:string) {
      if (this.DEBUG) console.log("LutronAPI::shellData got chunk " + chunk);
      let resp:LutronMSG = JSON.parse(chunk);
      if (resp.CommuniqueType == 'ReadResponse' && resp.Header.MessageBodyType == "MultipleDeviceDefinition"
          && resp.Body !== undefined
          && resp.Body.Devices !== undefined) {
        // add all the devices in
        for (let idx in resp.Body.Devices) {
          let device_id = this.getId(resp.Body.Devices[idx].href)
          let dev_t = resp.Body.Devices[idx];
          this.deviceList[device_id] = dev_t;
          this.deviceListName[dev_t.Name] = dev_t;
        }
      } else if (resp.CommuniqueType == 'ReadResponse' && resp.Header.MessageBodyType == "OneZoneStatus"
            && resp.Body !== undefined && resp.Body.ZoneStatus !== undefined) {
        let level = resp.Body.ZoneStatus.Level
        let zone_id = this.getId(resp.Body.ZoneStatus.Zone.href)
        this.zoneSatus[zone_id] = level
        if (this.DEBUG) console.log("LutronAPI: Updating Status for [" + zone_id + "] to " + level);
      }

      if (this.shellPromiseResp != '') {
        if (resp.CommuniqueType == this.shellPromiseResp) {
          this.shellPromise.resolve(resp);
          this.shellPromiseResp = '';
        } else if (resp.CommuniqueType == 'ExceptionResponse') {
          this.shellPromise.reject(resp);
          this.shellPromiseResp = '';
        }
      }
    }
    private shellErrData(chunk:string) {
      if (this.DEBUG) console.log("LutronAPI::shellErrData got chunk " + chunk);
      if (this.shellPromiseResp != '') {
        this.shellPromise.reject(chunk);
        this.shellPromiseResp = ''
      }
    }

    private execShellCommand(cmd:LutronMSG): Promise<LutronMSG> {
      return new Promise((function (self:LutronAPI, resolve:(d:string)=>string, reject:(d:string)=>string) {
        if (self.shellPromiseResp != '') {
          console.log('ERROR: Found Previous promise callbacks!! Will Overwrite');
          let msg:LutronMSG = {
              CommuniqueType:'ExceptionResponse',
              Header:{ MessageBodyType: 'ExceptionDetail',
                       Url: 'Unknown',
                       StatusCode: '400 BadRequest'},
              Body:{Message: 'Looks like there was a timeout on this request. Waiting for :' + self.shellPromiseResp} }
              if (self.DEBUG) console.log("LutronAPI::execShellCommand Rejecting with cmd:" + JSON.stringify(msg));

          self.shellPromise.reject(msg);
        }
        self.shellPromise = {'resolve': resolve, 'reject':reject};
        self.shellPromiseResp = LutronCommMap[cmd.CommuniqueType];
        self.shell.write(JSON.stringify(cmd) + '\n');
        if (self.DEBUG) console.log("LutronAPI::execShellCommand Sending cmd:" + JSON.stringify(cmd));
      }).bind(null, this));
    }

    public async getDeviceList():Promise<{[id:number]: LutronDevices}> {
      let cmd:LutronMSG = { CommuniqueType:'ReadRequest',
                  Header:{
                     Url:"/device"
                   }
                };
      let resp = await this.execShellCommand(cmd);
      if (resp != undefined && resp.Body != undefined && resp.Body.Devices != undefined)
        return resp.Body.Devices;
      throw("ERROR Unable to parse Device Infromation");
    }
    public getZone(devid:number) {
      let dev = this.deviceList[devid];
      if (dev != undefined && dev.LocalZones != undefined) {
        return this.getId(dev.LocalZones[0].href)
      } else {
        throw "Unable to get zone for device id" + devid;
      }
    }
    public getZoneName(devname:string) {
      let dev = this.deviceListName[devname];
      if (dev != undefined && dev.LocalZones != undefined) {
        return this.getId(dev.LocalZones[0].href)
      } else {
        throw "Unable to get zone for device id" + devname;
      }
    }
    public async getValue(deviceId:number) {
      try {
        let zoneid = this.getZone(deviceId);
        let cmd:LutronMSG = {
          CommuniqueType: 'ReadRequest',
          Header: {
            Url: '/zone/' + zoneid + '/status'
          }
        }
        let ret_str = await this.execShellCommand(cmd);
        if (ret_str.Body !== undefined && ret_str.Body.ZoneStatus !== undefined)
          return ret_str.Body.ZoneStatus.Level;
        else
          return -1;
      } catch(e) {
        console.log("ERROR : getValue:" + e.stack)
        return -1;
      }
    }
    public async getStatusAll() {
      try {
        // every 100 queries do a full device list
        this.statusAllCnt ++;
        if (this.statusAllCnt == 100) {
          await this.getDeviceList()
          this.statusAllCnt = 0;
        }
        let res:{[id:string]: number} = {};
        for (const key in this.deviceListName) {
            let dev = this.deviceListName[key];
            if (dev.DeviceType == 'WallDimmer' ||
                dev.DeviceType == 'WallSwitch') {
              let r = await this.getValueName(key);
              if (r != -1) {
                res[key] = r;
              }
            }
        }
        return res;
      } catch(e) {
        console.log("ERROR : getStatusAll:" + e.stack)
        return -1;
      }
    }

    public async getValueName(deviceName:string) {
      try {

        let zoneid = this.getZoneName(deviceName);
        let curValue =  this.zoneSatus[zoneid];
        if (curValue != undefined && curValue != null)
          return curValue;
        let cmd:LutronMSG = {
          CommuniqueType: 'ReadRequest',
          Header: {
            Url: '/zone/' + zoneid + '/status'
          }
        }
        let ret_str = await this.execShellCommand(cmd);
        if (ret_str.Body !== undefined && ret_str.Body.ZoneStatus !== undefined)
          return ret_str.Body.ZoneStatus.Level;
        else
          return -1;
      } catch(e) {
        console.log("ERROR : getValue:" + e.stack)
        return -1;
      }
    }
    public async setValueName(deviceName:string, value:number):Promise<boolean> {
      try {
        let zoneid = this.getZoneName(deviceName);
        console.log("    Setting Value:" + deviceName + " = " + value);
        let cmd:LutronMSG = {
          CommuniqueType: 'CreateRequest',
          Header: {
            Url: '/zone/' + zoneid + '/commandprocessor'
          },
          Body: {
            Command: {
              CommandType: 'GoToLevel',
              Parameter: [ {
                Type: 'Level',
                Value: value
              }]
            }
          }
        };
        let ret_str = await this.execShellCommand(cmd);
        return true;
      } catch(e) {
        console.log("ERROR : setValue:" + e.stack)
        return false;
      }
    }

    public async toggleName(deviceName:string):Promise<boolean> {
      try {
        let zoneid = this.getZoneName(deviceName);
        let curValue =  this.zoneSatus[zoneid];
        let nextValue = 0;
        if (curValue == 0)
          nextValue = 100;
        console.log("     Toggle:" + deviceName + " Zone:" + zoneid + " Value:" + curValue + " -> " + nextValue);
        let cmd:LutronMSG = {
          CommuniqueType: 'CreateRequest',
          Header: {
            Url: '/zone/' + zoneid + '/commandprocessor'
          },
          Body: {
            Command: {
              CommandType: 'GoToLevel',
              Parameter: [ {
                Type: 'Level',
                Value: nextValue
              }]
            }
          }
        };
        let ret_str = await this.execShellCommand(cmd);
        return true;
      } catch(e) {
        console.log("ERROR : setValue:" + e.stack)
        return false;
      }
    }

    public getDevices():{[id:number]:LutronDevices} {
      return this.deviceList;
    }
    public getDeviceByID(id:number):LutronDevices {
      return this.deviceList[id];
    }


}
