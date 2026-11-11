import assert from 'node:assert/strict';
const base = 'http://127.0.0.1:17891';
const alice = '11111111-1111-1111-1111-111111111111', bob = '22222222-2222-2222-2222-222222222222', denied = '99999999-9999-9999-9999-999999999999';
const item = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'; let assertions = 0;
function check(value,message){assert.ok(value,message);assertions++;}
async function api(user,path,body,expected=200){const r=await fetch(base+'/JellyfinParty/'+path,{method:body?'POST':'GET',headers:{'Test-User':user,'Test-Device':'test','Content-Type':'application/json'},body:body?JSON.stringify(body):undefined});assert.equal(r.status,expected,await (r.status!==expected?r.text():Promise.resolve('')));assertions++;return r.status===200?r.json():null;}
async function socket(user,purpose='control',peerId){const {ticket}=await api(user,'Ticket',{purpose,peerId});const ws=new WebSocket(base.replace('http','ws')+'/JellyfinParty/Socket/'+purpose+'?ticket='+ticket);ws.binaryType='arraybuffer';const queue=[];const waiters=[];ws.addEventListener('message',e=>{const data=typeof e.data==='string'?JSON.parse(e.data):e.data;const index=waiters.findIndex(w=>w.test(data));if(index>=0){const [w]=waiters.splice(index,1);clearTimeout(w.timer);w.resolve(data);}else queue.push(data);});await new Promise((resolve,reject)=>{ws.onopen=resolve;ws.onerror=reject;});return {ws,ticket,send:m=>ws.send(JSON.stringify(m)),next(test){const index=queue.findIndex(test);if(index>=0)return Promise.resolve(queue.splice(index,1)[0]);return new Promise((resolve,reject)=>{const w={test,resolve,timer:setTimeout(()=>{waiters.splice(waiters.indexOf(w),1);reject(new Error('Timed out waiting for a message'));},4000)};waiters.push(w);});},queue};}
const unauth=await fetch(base+'/JellyfinParty/Rooms');check(unauth.status===401,'unauthenticated rooms rejected');
await api(denied,'Rooms',{name:'No access',itemId:item},400);
await api(alice,'Rooms',{name:'',itemId:item},400);
const {roomId}=await api(alice,'Rooms',{name:'Integration test',itemId:item});
check((await api(denied,'Rooms')).length===0,'inaccessible rooms are hidden');
const a=await socket(alice),b=await socket(bob),d=await socket(denied);
const aw=await a.next(x=>x.type==='welcome'),bw=await b.next(x=>x.type==='welcome');await d.next(x=>x.type==='welcome');
a.send({op:'join',roomId});const aj=await a.next(x=>x.type==='joined');check(aj.timeline.paused,'party starts paused');
b.send({op:'join',roomId});await b.next(x=>x.type==='joined');await a.next(x=>x.type==='members'&&x.members.length===2);
d.send({op:'join',roomId});check((await d.next(x=>x.type==='error')).message.includes('cannot access'),'joining enforces library access');
a.send({op:'sync',action:'play',position:0,revision:0});const playing=await b.next(x=>x.type==='state'&&x.timeline.revision===1);check(!playing.timeline.paused,'play shared');
b.send({op:'sync',action:'seek',position:90,revision:1});const sought=await a.next(x=>x.type==='state'&&x.timeline.revision===2);check(sought.timeline.position>=90&&sought.timeline.position<92,'any user can seek');
a.send({op:'sync',action:'seek',position:500,revision:0});const stale=await a.next(x=>x.type==='state'&&x.timeline.revision===2);check(stale.timeline.position<95,'stale command cannot overwrite latest state');
b.send({op:'sync',action:'pause',position:0,revision:2});const paused=await a.next(x=>x.type==='state'&&x.timeline.revision===3);check(paused.timeline.paused,'any user can pause');
a.send({op:'chat',text:'<script>alert(1)</script>'});const chat=await b.next(x=>x.type==='chat');check(chat.message.user==='Alice'&&chat.message.text==='<script>alert(1)</script>','chat identity comes from authentication; text is preserved for textContent rendering');
d.send({op:'signal',target:aw.peerId,data:{relay:true}});check((await d.next(x=>x.type==='error')).message.includes('Join'),'outside-room signaling rejected');
const {ticket:replay}=await api(alice,'Ticket',{purpose:'control'});const first=await fetch(base+'/JellyfinParty/Socket/control?ticket='+replay);check(first.status===401,'non-websocket request rejected');const second=await fetch(base+'/JellyfinParty/Socket/control?ticket='+replay);check(second.status===401,'ticket consumed only once');
await api(bob,'Ticket',{purpose:'media',peerId:aw.peerId},400);
const am=await socket(alice,'media',aw.peerId),bm=await socket(bob,'media',bw.peerId);
a.send({op:'presence',camera:true,microphone:true,speaking:true});await b.next(x=>x.type==='presence'&&x.member.id===aw.peerId);
const frame=new Uint8Array(49);frame[0]=1;frame.set(new TextEncoder().encode(bw.peerId),1);frame.set([255,216,255,217],45);am.ws.send(frame);
const relayed=await bm.next(x=>x instanceof ArrayBuffer);check(new TextDecoder().decode(new Uint8Array(relayed).slice(1,37))===aw.peerId,'relay rewrites sender identity');
const voice=new Uint8Array(685);voice[0]=2;voice.set(new TextEncoder().encode(bw.peerId),1);am.ws.send(voice);check((await bm.next(x=>x instanceof ArrayBuffer)).byteLength===685,'PCM voice relayed');
// A new tab for the same account replaces its membership, without duplicating the user.
const a2=await socket(alice);await a2.next(x=>x.type==='welcome');a2.send({op:'join',roomId});await a2.next(x=>x.type==='joined');check((await a.next(x=>x.type==='replaced')).message.includes('another'),'same account replacement is explicit');
const roster=await a2.next(x=>x.type==='members'&&x.members.length===2);check(new Set(roster.members.map(p=>p.userId)).size===2,'one membership per account');
// Once Bob leaves, a former room member must not receive any relay traffic.
b.send({op:'leave'});await b.next(x=>x.type==='left');
const a2Media=await socket(alice,'media',roster.members.find(p=>p.userId===alice).id);
a2.send({op:'presence',camera:true,microphone:true,speaking:false});await a2.next(x=>x.type==='presence');
a2Media.ws.send(frame);await new Promise(resolve=>setTimeout(resolve,150));
check(!bm.queue.some(x=>x instanceof ArrayBuffer),'media is not delivered outside the room');
const closed=new Promise(resolve=>a2.ws.addEventListener('close',resolve,{once:true}));
a2.ws.send('x'.repeat(70000));await Promise.race([closed,new Promise((_,reject)=>setTimeout(()=>reject(new Error('Oversized frame was not closed')),3000))]);
check(a2.ws.readyState===WebSocket.CLOSED,'oversized control messages close the connection');
a2Media.ws.close();
for(const client of [a,b,d,am,bm,a2])client.ws.close();
console.log(`PASS: ${assertions} API, socket, synchronization, access-control, identity, and relay assertions.`);
