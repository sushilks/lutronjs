
interface JobT {
  id: number;
  value: number;
  cbfn: (a:number, b:number)=>void;
  timer: any;
};

let jobs:{ [k:number]: JobT } = {};

function schedTimer(id:number) {
  let jl = jobs[id]
  delete jobs[id]
  jl.cbfn(jl.id, jl.value);
}

export
function sched(id:number, value:number, delay: number, fn:(a:number, b:number)=>void) {
  if (id in jobs) {
    // clear all the previous timers
    let tm = jobs[id].timer;
    if (tm != null) {
      clearTimeout(tm);
    }
  }
  let tm = setTimeout((function(id:number) {schedTimer(id);}).bind(null,id), delay)
  jobs[id] = {id:id, value:value, cbfn:fn, timer:tm};
}
