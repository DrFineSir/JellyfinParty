import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { JellyfinPlayer } from '../src/Web/player.js';

function fixture() {
    const listeners=new Map();
    const video={dataset:{},currentTime:10,playbackRate:1,paused:true,readyState:4,currentSrc:'test.mp4'};
    globalThis.document={querySelectorAll:()=>[video],addEventListener:(key,fn)=>listeners.set(key,fn),removeEventListener:key=>listeners.delete(key)};
    const api={reportPlaybackStart:()=>Promise.resolve(),reportPlaybackProgress:()=>Promise.resolve(),reportPlaybackStopped:()=>Promise.resolve(),deviceId:()=> 'browser',getCurrentUserId:()=> '11111111111111111111111111111111'};
    const commands=[];const controls=[];
    const player=new JellyfinPlayer(api,async(path,params,method)=>{commands.push({path,params,method});if(path==='Sessions')return [{Id:'self',DeviceId:'browser',UserId:'11111111-1111-1111-1111-111111111111'}];},(...args)=>controls.push(args),()=>{});
    return {player,api,video,commands,controls};
}
test('native reports preserve the transcoding offset and accept both GUID formats',async()=>{
 const f=fixture();try{f.player.roomItem='aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';await f.api.reportPlaybackProgress({ItemId:'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',PositionTicks:110e7,EventName:'pause'});assert.equal(f.player.position(),110);assert.equal(f.controls[0][0],'pause');}finally{f.player.destroy();}
});
test('received corrections do not echo as new user commands',async()=>{
 const f=fixture();try{f.player.roomItem='aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';f.player.suppressUntil=Date.now()+5000;await f.api.reportPlaybackProgress({ItemId:f.player.roomItem,PositionTicks:20e7,EventName:'unpause'});assert.equal(f.controls.length,0);}finally{f.player.destroy();}
});
test('large drift uses Jellyfin session seek instead of seeking the transcode DOM directly',async()=>{
 const f=fixture();try{f.player.roomItem='aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';await f.api.reportPlaybackProgress({ItemId:f.player.roomItem,PositionTicks:10e7});f.player.state={position:80,paused:true,revision:2,serverTime:Date.now(),duration:200};await f.player.correct(true);assert.equal(f.commands.at(-1).path,'Sessions/self/Playing/Seek');assert.equal(f.commands.at(-1).params.seekPositionTicks,80e7);assert.equal(f.video.currentTime,10);}finally{f.player.destroy();}
});
test('small drift uses gentle playback speed correction and leaving restores speed',async()=>{
 const f=fixture();try{f.player.roomItem='aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';await f.api.reportPlaybackProgress({ItemId:f.player.roomItem,PositionTicks:10e7});f.video.paused=false;f.player.state={position:11,paused:false,revision:2,serverTime:Date.now(),duration:200};await f.player.correct();assert.equal(f.video.playbackRate,1.035);f.player.stop();assert.equal(f.video.playbackRate,1);}finally{f.player.destroy();}
});
test('older snapshots cannot overwrite the latest playback revision',()=>{
 const f=fixture();try{f.player.state={revision:5};f.player.update({revision:3});assert.equal(f.player.state.revision,5);}finally{f.player.destroy();}
});
test('relay audio worklet downsamples 48 kHz to bounded 20 ms PCM frames',async()=>{
 let processor;const frames=[];const sandbox={AudioWorkletProcessor:class{constructor(){this.port={postMessage:data=>frames.push(data)};}},sampleRate:48000,Int16Array,Math,registerProcessor:(_name,type)=>processor=type};vm.runInNewContext(await readFile(new URL('../src/Web/audio-worklet.js',import.meta.url),'utf8'),sandbox);const capture=new processor();for(let i=0;i<75;i++)capture.process([[new Float32Array(128).fill(.5)]]);assert.equal(frames.length,10);assert.equal(frames[0].byteLength,640);assert.ok(new Int16Array(frames[0])[0]>16000);
});
