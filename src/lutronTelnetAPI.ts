const Telnet = require('telnet-client')



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
          }
        }
      }
    }

}
/*
//let a = new LutronTelnetAPI('127.0.0.1',2323)
let a = new LutronTelnetAPI('192.168.55.195',23)
let run2 = async function(a:LutronTelnetAPI) {
  console.log("INIT...")
  await a.init()
  console.log("RUN")
//  await a.send('#OUTPUT,10,1,1.00')
  setTimeout(()=>{
    console.log("output...1 ");
    a.setValue(4, 1.00);
//     a.send('#OUTPUT,10,1,1.00');
     setTimeout(()=>{
       console.log("output...21 ");
  //      a.send('#OUTPUT,10,1,0')}, 1000);
       a.setValue(4, 0)}, 1000);
      a.update(16)
  }, 2000);

}
run2(a)*/
