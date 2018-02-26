const Telnet = require('telnet-client')
let squeue = require('./taskQueue')
const loxone_config = process.env.LOXONE_CONFIG || "./loxone-cfg";
console.log("LOADING CONFIG FROM :", loxone_config, process.env.LOXONE_CONFIG )
var loxone = require(loxone_config);

export
class LutronTelnetAPI {
    private loc:string;
    private telnet:any;
    private port:number;
    private devices:{[n:number]:number}
    constructor(loc: string, port: number=23) {
      this.loc = loc;
      this.telnet = new Telnet();
      this.port = port;
      this.devices = {}
    }
    public async init() {
      let params = {
        host: this.loc,
        port: this.port,
        shellPrompt: 'GNET>',
        debug:true,
        username: 'lutron',
        password: 'integration',
        timeout: 5000
      };
      console.log("Called with param:", params);
      this.telnet.on('data', ((self:LutronTelnetAPI, pkt:any) => {
        self.recv(pkt)
      }).bind(null,this));

      this.telnet.on('ready', function(p:string){
        console.log("READY :"+p);
      });
//      this.telnet.on('connect', function() {
//        console.log("CONNECT ");
//      });
      this.telnet.on('timeout', function() {
        console.log("TIMEOUT");
      });
      this.telnet.on('failedlogin', function() {
        console.log("FAILED LOGIN");
      });
      this.telnet.on('error', function() {
        console.log("ERR ");
      });

      this.telnet.on('close', function() {
        console.log("CLOSE");
      })


      loxone.connect()

      await this.telnet.connect(params);
      console.log("DONE WITH INIT")
    }
    private async send(str:string) {
      let sock = this.telnet.getSocket();
      await this.telnet.getSocket().write(str + '\n');
    }
    public async update(deviceId:number) {
      await this.send('?OUTPUT,'+ deviceId + ',1');
    }
    public async setValue(deviceId:number, val:number) {
      await this.send('#OUTPUT,'+ deviceId + ',1,' + val);
    }
    public async getValue(dev:number) {
      await this.update(dev);
      return this.devices[dev];
    }
    public async getStatusAll() {
        return this.devices;
    }
    public async toggleValue(dev:number) {
      if (!(dev in this.devices)) {
        await this.update(dev);
      }
      let curVal = this.devices[dev];
      if (curVal >  0) {
        await this.setValue(dev, 0)
      } else {
        await this.setValue(dev, 100)
      }
    }
    /*
    # = SET, ? = Get, ~ = Event

    for OUTPUT action
    1 = level
    */
    private recv(data:string) {
      let st = data.toString().trim();
      console.log('data Received:', st)
      let cmd = st[0]
      let cs = st.substring(1).split(',')
      let type = cs[0]
      if (cs.length >3) {
        let deviceId = parseInt(cs[1])
        let action = parseInt(cs[2])
        let param = parseFloat(cs[3])
        if (0)
        console.log('[',cmd,',', type, ',',deviceId,
        ',', action,',', param,']')
        if (cmd == '~') {
          // event notification
          if (type == 'OUTPUT' && action == 1) {
            this.devices[deviceId] = param
            this.scheduleLoxoneUpdate(deviceId, action, param)
          } else if (type == 'DEVICE') {
            this.scheduleLoxoneUpdate(deviceId, action, param)
          }
        }
      }
    }
    /*
    private loxoneCBUpdate(id:number, action:number, val:number) {
//      console.log("Got Callback to sync Loxone ID:" + id + "action = " + action+" value="+val);
      if (id in loxone._devMapper) {
        let devAList = loxone._devMapper[id]
        let dev = devAList[0]
        let found = 0
        for (let idx in devAList) {
          if (devAList[idx].action == action) {
            dev = devAList[idx]
            found = 1
            break;
          }
        }
        if (found == 0) {
          console.log("\t Did not find the action " + action + " for device " + id);
          return;
        }

        console.log("Got Callback to sync Loxone ID:" + id + " action = " + action+" value="+val);
        let rname = dev.name
        let uuid = dev['uuid']
        if (dev['type'] == 'default') {
          let mul = dev['mult']
          loxone.state_update(uuid, val * mul)
          return
        } else if (dev['type'] == 'direct') {
          console.log("Got a direct command will pass through command " + dev.command + " to " + dev.name)
//          loxone.set(dev.name, dev.command, function(out:any){})
          loxone.send_control_command(uuid, dev.command)
          return
        } else {
          console.log("ERROR: Unable to use type=", dev['type']," for id = ")
        }
/*
        loxone.get(rname, (function(name: string, type:string, set_val:any, out:any) {
          if (out.LL.Code == 200) {
            if (type == 'switch') {
              if (set_val > 0) set_val = 1;
            }
            let val = parseFloat(out.LL.value)
            if (val != set_val) {
                if (type == 'switch') {
                   if (set_val == 1) set_val = 'on';
                   else set_val = 'off';
                }
                console.log("Updating loxone " + name + " OldVal:" + val + " NewVal:" + set_val)
                loxone.set(name, set_val, function(out:any){})
            }
          }
        }).bind(null, dev.name, dev.type, val))
        * /
      }
    }*/
    private scheduleLoxoneUpdate(deviceId:number, action:number, value:number){
      squeue.sched(deviceId, {v:value, a:action}, 1000, (function(th:LutronTelnetAPI, id:number, val:any) {
        loxone.devUpdate(id, val.a, val.v)
      }).bind(null, this))
    }

}
