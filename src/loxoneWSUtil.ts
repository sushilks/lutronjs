
const LWA = require('node-lox-ws-api')

export
class LoxoneWS {
  private loxone:any;
  private devMapper:any;
  private debug:boolean;
  private state:any;
  constructor(loc:string, userid:string, password:string, devMap:any) {
     this.loxone = new LWA(loc,userid,password, true, 'Token-Enc')
     this.devMapper=devMap
     this.state = {
        connected: false,
        sfile: {}, // Full data structure file
        sfile_map : {}, // A partial uuid map to full controller map.
        flat_uuid_map: {} // full uuid flap map to -> Controller and state/modes
      }
    }
    public getWS() {
      return this.loxone
    }
    public setDebug(b:boolean) {
      this.debug=b
    }
    private connected() {
        console.log("CONNECTED to LOXONE WS.");
        this.state.connected = true;
    }

    private uuid_mapper(name:string, dt:any, map:{[k:string]:any}) {
        for (let itm in dt) {
          let value = dt[itm]
          if (typeof value === 'object') {
            this.uuid_mapper(name + '::' + itm, value, map)
          } else {
            map[value] = {'name' : name + '::' + itm}
          }
        }
    }

    public getStructuredFile(m:any) {
      this.state.sfile = m;
//      console.log('structured file::', m)
      // Process all the keys
      for (let uid in this.state.sfile['controls']) {
        let uid_split = uid.split('-')
        let hk = uid_split[0] + '-' + uid_split[1]
        this.state.sfile_map[hk] = uid
        this.uuid_mapper(uid, this.state.sfile['controls'][uid], this.state.flat_uuid_map)
      }
    }
    public processWSMsg(msg:string, dt:any, type:number) {
      //  console.log(msg, dt.length)
      //  console.log(dt)
      try {
        for (let itm in dt) {
          let uuid=dt[itm].uuid.string
          if (type==1) {
            let not_found = true
            if (this.state.sfile != {}) {
              let controls = this.state.sfile['controls']
              let uuid_split = uuid.split('-')
              let uuid_l = uuid_split[0] + '-' + uuid_split[1]
              let controller = ''
              let controller_type = ''
              if (uuid in controls) {
                let ctrl = controls[uuid]
                controller=ctrl['name']
                controller_type = ctrl['type']
              } else if (uuid_l in this.state.sfile_map) {
                let alias_uuid = this.state.sfile_map[uuid_l]
                let ctrl = controls[alias_uuid]
                controller=ctrl['name']
                controller_type = ctrl['type']
              }
              if (uuid in this.state.flat_uuid_map) {
                if (this.debug)
                  console.log('\t FLAT MAP =>', this.state.flat_uuid_map[uuid]['name'], '(',
                         controller,':', controller_type,') = ', dt[itm].value)
                this.state.flat_uuid_map[uuid]['value'] = dt[itm].value
                not_found = false
              }
            }
            if (not_found) {
              if (this.debug)
                console.log('\t',type, msg, uuid,dt[itm].value)
            }
          } else {
          }
        }
      } catch (e){
        console.log('ERROR:: EXCPETION >',msg, e)
      }
    }

    public async connect() {
//      this.loxone.on('connect', ((self)=>{self.connected()).bind(null,this)})
      console.log("CONN CALLED\n")
//      this.loxone.on('connect', ((self:LoxoneWS)=>{self.connected()}).bind(null,this))
      this.loxone.on('connect', ()=>{this.connected()})
      this.loxone.on('message_event_table_values', (m:any)=>{this.processWSMsg("message_event_table_values>",m, 1);})
      this.loxone.on('message_event_table_text', (m:any)=>{this.processWSMsg("message_event_table_text>",m, 2);})
      this.loxone.on('get_structure_file', (m:any)=> {this.getStructuredFile(m);})

      this.loxone.connect()
    }

    public state_update(uuid:string, value:number) {
      if (!(uuid in this.state.flat_uuid_map)){
        console.log("ERROR::UUID ", uuid,' not found in flat_uuid_map')
        return
      }
      if (this.state.flat_uuid_map[uuid]['value'] != value) {
          let n = this.state.flat_uuid_map[uuid]['name']
          let ns = n.split('::')
          if (ns[1] == 'subControls') {
            console.log(n,":Sending sub-command to loxone [",ns[2],"] == ", value)
            this.loxone.send_control_command(ns[2], value);
          } else {
            console.log(n,":Sending command to loxone [",uuid,"] == ", value)
            this.loxone.send_control_command(uuid, value);
          }
      }
    }
    public devUpdate(id:number, action:number, val:number) {
      //      console.log("Got Callback to sync Loxone ID:" + id + "action = " + action+" value="+val);
      if (id in this.devMapper) {
        let devAList = this.devMapper[id]
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
          this.state_update(uuid, val * mul)
          return
        } else if (dev['type'] == 'direct') {
          console.log("Got a direct command will pass through command " + dev.command + " to " + dev.name)
//          loxone.set(dev.name, dev.command, function(out:any){})
          this.loxone.send_control_command(uuid, dev.command)
          return
        } else {
          console.log("ERROR: Unable to use type=", dev['type']," for id = ")
        }
      }
    }

  }
