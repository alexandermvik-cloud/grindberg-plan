/* Kobler planleggeren til serveren på grindberg-plan.grindberg.workers.dev.
   Etterligner det lille database-grensesnittet planleggeren bruker (doc/collection/onSnapshot/set/update/delete/add),
   og henter endringer fra serveren hvert 5. sekund, så alt er levende. */
(function(){
  var API="https://grindberg-plan.grindberg.workers.dev/api/";
  var KEY="gb-lederkode";
  function getCode(){try{return localStorage.getItem(KEY)||""}catch(e){return ""}}
  function setCode(c){try{c?localStorage.setItem(KEY,c):localStorage.removeItem(KEY)}catch(e){}}
  var code=getCode(),me=null,store={},ver=null,docL=[],colL=[],timer=null;

  function req(method,path,body){
    return fetch(API+path,{method:method,headers:Object.assign({"x-kode":code},body?{"content-type":"application/json"}:{}),body:body?JSON.stringify(body):undefined})
      .then(function(r){return r.json().then(function(j){if(!r.ok){var e=new Error(j.error||"feil");e.code=r.status===401?"revoked":(r.status===403?"invalid_argument":"unavailable");e.status=r.status;throw e}return j})});
  }
  function snapDoc(coll,id){var d=store[coll]&&store[coll][id];return {id:id,exists:!!d,data:function(){return d?JSON.parse(JSON.stringify(d)):undefined},metadata:{fromCache:false,hasPendingWrites:false}}}
  function snapColl(coll){var o=store[coll]||{};var docs=Object.keys(o).sort().map(function(id){return snapDoc(coll,id)});return {docs:docs,size:docs.length,empty:!docs.length,docChanges:function(){return []},metadata:{fromCache:false,hasPendingWrites:false}}}
  function notify(){docL.forEach(function(l){try{l.cb(snapDoc(l.coll,l.id))}catch(e){console.error(e)}});colL.forEach(function(l){try{l.cb(snapColl(l.coll))}catch(e){console.error(e)}})}
  function pull(force){
    return req("GET","data"+(ver!=null&&!force?"?v="+ver:"")).then(function(j){if(j.same)return;store=j.docs||{};ver=j.v;notify()})
      .catch(function(e){if(e.status===401){setCode("");location.reload()}});
  }
  function split(path){var p=path.split("/");return {coll:p[0],id:p[1]}}
  function local(coll,id,data){store[coll]=store[coll]||{};if(data===null)delete store[coll][id];else store[coll][id]=data;notify()}
  function docRef(path){var p=split(path);return {
    id:p.id,path:path,
    get:function(){return Promise.resolve(snapDoc(p.coll,p.id))},
    set:function(d){local(p.coll,p.id,JSON.parse(JSON.stringify(d)));return req("PUT","doc/"+p.coll+"/"+encodeURIComponent(p.id),d).then(function(){pull(true)})},
    update:function(d){var cur=(store[p.coll]||{})[p.id];if(cur)local(p.coll,p.id,Object.assign({},cur,d));return req("PATCH","doc/"+p.coll+"/"+encodeURIComponent(p.id),d).then(function(){pull(true)})},
    delete:function(){local(p.coll,p.id,null);return req("DELETE","doc/"+p.coll+"/"+encodeURIComponent(p.id)).then(function(){pull(true)})},
    onSnapshot:function(cb){var l={coll:p.coll,id:p.id,cb:cb};docL.push(l);if(ver!=null)setTimeout(function(){cb(snapDoc(p.coll,p.id))},0);return function(){docL=docL.filter(function(x){return x!==l})}}
  }}
  function collRef(coll){return {
    path:coll,
    doc:function(id){return docRef(coll+"/"+(id||("c"+Date.now().toString(36)+Math.random().toString(36).slice(2,8))))},
    add:function(d){return req("POST","doc/"+coll,d).then(function(j){local(coll,j.id,JSON.parse(JSON.stringify(d)));pull(true);return docRef(coll+"/"+j.id)})},
    onSnapshot:function(cb){var l={coll:coll,cb:cb};colL.push(l);if(ver!=null)setTimeout(function(){cb(snapColl(coll))},0);return function(){colL=colL.filter(function(x){return x!==l})}},
    get:function(){return Promise.resolve(snapColl(coll))}
  }}
  var db={doc:docRef,collection:collRef};

  function loginScreen(msg){
    return new Promise(function(resolve){
      var ov=document.createElement("div");ov.className="gb-login";
      ov.innerHTML='<form><h1>Produksjonsplan</h1><p>Logg inn med lederkoden din.</p><p class="e"></p><input id="gb-kode" type="password" autocomplete="current-password" placeholder="Lederkode" aria-label="Lederkode"><button type="submit">Logg inn</button></form>';
      document.body.appendChild(ov);var f=ov.querySelector("form"),i=ov.querySelector("input"),e=ov.querySelector(".e");if(msg)e.textContent=msg;setTimeout(function(){i.focus()},50);
      f.onsubmit=function(ev){ev.preventDefault();code=i.value.trim();req("POST","login").then(function(j){if(j.role!=="leder"){e.textContent="Dette er koden for ansatte. Bruk lederkoden.";return}setCode(code);me=j;ov.remove();resolve()}).catch(function(){e.textContent="Feil kode. Prøv igjen."})};
    });
  }
  var ready=(code?req("POST","login").then(function(j){if(j.role!=="leder")throw 0;me=j}).catch(function(){setCode("");return loginScreen("Logg inn på nytt.")}):loginScreen())
    .then(function(){return pull(true)}).then(function(){timer=setInterval(function(){if(document.visibilityState==="visible")pull(false)},5000);document.addEventListener("visibilitychange",function(){if(document.visibilityState==="visible")pull(false)})});

  var user={isOwner:function(){return Promise.resolve(true)},canEdit:function(){return Promise.resolve(true)},can:function(){return Promise.resolve(true)},
    id:function(){return Promise.resolve(me&&me.navn||null)},me:function(){return Promise.resolve({id:me&&me.navn,name:me&&me.navn||"",isOwner:true,canEdit:true,email:null,avatarUrl:"",color:"#666"})},profiles:function(){return Promise.resolve({})}};
  var downloads={save:function(o){var b=o.data instanceof Blob?o.data:new Blob([o.data]);var u=URL.createObjectURL(b);var a=document.createElement("a");a.href=u;a.download=o.filename;document.body.appendChild(a);a.click();setTimeout(function(){URL.revokeObjectURL(u);a.remove()},2000);return Promise.resolve({status:"saved"})}};
  window.gbLogout=function(){setCode("");location.reload()};
  window.gbMe=function(){return me};
  window.gbApi=function(m,p,b){return req(m,p,b)};
  window.claude={use:function(name){return ready.then(function(){if(name==="db")return db;if(name==="user")return user;if(name==="downloads")return downloads;return null})}};
})();
