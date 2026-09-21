// nx-voice.js — REAL voice chat for NX Chat (v4).
//
// The AUDIO is peer-to-peer: each member opens an RTCPeerConnection with every
// other member (DTLS-SRTP encrypted by the browser, mandatory in WebRTC). The
// Supabase database is only the SIGNALING mailbox — offer/answer/ICE envelopes
// ride the nx_voice_signals table (polled ~1.2s while in a call).
//
// Mesh topology: every peer pairs with every peer, so a chat with N people is
// N-1 outgoing connections each — fine for the group sizes NX Chat targets.
// Deterministic offer direction (the peer with the lexicographically smaller
// UUID offers) avoids glare/duplicate negotiation.
'use strict';

const ICE_SERVERS = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
  { urls: 'stun:global.stun.twilio.com:3478' },
];
const POLL_MS = 1200;      // signaling + participant heartbeat while in a call
const GLARE_WAIT_MS = 900; // let the "smaller uuid" side win before offering

export const voiceCtl = {
  state: {
    roomId: null,
    chatId: null,
    participants: [],   // [{ uuid, name, muted }]
    muted: false,
  },
  speaking: new Set(),  // uuids currently talking (level meter)
  activeRooms: {},      // chatId -> room summary (from the 5s engine tick)
  onChange: null,       // UI hook
};

let localStream = null;
let peers = new Map();      // uuid -> RTCPeerConnection
let audioEls = new Map();   // uuid -> HTMLAudioElement
let analysers = new Map();  // uuid -> { ctx, analyser, data, last }
let pollTimer = null;
let cursor = 0;             // signaling mailbox cursor
let micLevelTimer = null;

function emit() { try { voiceCtl.onChange && voiceCtl.onChange(); } catch {} }

function myUuid() { return String(window.__nxSelfUuid || voiceCtl.state.selfUuid || ''); }

async function getMic() {
  if (localStream) return localStream;
  localStream = await navigator.mediaDevices.getUserMedia({
    audio: {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    },
    video: false,
  });
  return localStream;
}

function createPeer(peerUuid) {
  const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
  for (const track of localStream.getAudioTracks()) pc.addTrack(track, localStream);
  pc.onicecandidate = (e) => {
    if (e.candidate) signal(peerUuid, { type: 'ice', candidate: e.candidate.toJSON() }).catch(() => {});
  };
  pc.ontrack = (e) => {
    const [stream] = e.streams;
    attachAudio(peerUuid, stream);
  };
  pc.onconnectionstatechange = () => {
    if (['failed', 'closed'].includes(pc.connectionState)) {
      // participant likely gone — the next participant-list diff cleans up
    }
  };
  peers.set(peerUuid, pc);
  return pc;
}

function attachAudio(peerUuid, stream) {
  let a = audioEls.get(peerUuid);
  if (!a) {
    a = document.createElement('audio');
    a.autoplay = true;
    a.dataset.peer = peerUuid;
    document.body.append(a);
    audioEls.set(peerUuid, a);
  }
  if (a.srcObject !== stream) a.srcObject = stream;
  a.play?.().catch(() => {}); // autoplay is allowed: user gesture (Join click) started the flow
  startLevelMeter(peerUuid, stream);
}

function startLevelMeter(peerUuid, stream) {
  if (analysers.has(peerUuid)) return;
  try {
    const ctx = new AudioContext();
    const src = ctx.createMediaStreamSource(stream);
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 256;
    src.connect(analyser);
    analysers.set(peerUuid, { ctx, analyser, data: new Uint8Array(analyser.frequencyBinCount), last: 0 });
  } catch { /* audio meter is cosmetic — never fatal */ }
}

function sampleLevels() {
  if (!analysers.size) return;
  let changed = false;
  for (const [uuid, a] of analysers) {
    a.analyser.getByteFrequencyData(a.data);
    let sum = 0;
    for (let i = 0; i < a.data.length; i++) sum += a.data[i];
    const loud = (sum / a.data.length) > 14; // speaking threshold
    const was = voiceCtl.speaking.has(uuid);
    if (loud !== was) { loud ? voiceCtl.speaking.add(uuid) : voiceCtl.speaking.delete(uuid); changed = true; }
  }
  if (changed) emit();
}

async function signal(to, payload) {
  await window.neurax.invoke('nx:voiceSignal', { roomId: voiceCtl.state.roomId, to, payload });
}

async function ensurePeer(peerUuid, offerDirection) {
  let pc = peers.get(peerUuid);
  if (pc) return pc;
  pc = createPeer(peerUuid);
  if (offerDirection) {
    // small random delay breaks symmetric-offer glare deterministically
    setTimeout(async () => {
      try {
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        await signal(peerUuid, { type: 'offer', sdp: pc.localDescription.sdp });
      } catch { /* peer vanished — cleanup handles it */ }
    }, GLARE_WAIT_MS);
  }
  return pc;
}

function diffParticipants(list) {
  const alive = new Set(list.map((p) => String(p.uuid).toLowerCase()));
  // drop peers that left
  for (const [uuid, pc] of peers) {
    if (!alive.has(uuid)) {
      try { pc.close(); } catch {}
      peers.delete(uuid);
      audioEls.get(uuid)?.remove?.();
      audioEls.delete(uuid);
      analysers.get(uuid)?.ctx?.close?.().catch?.(() => {});
      analysers.delete(uuid);
      voiceCtl.speaking.delete(uuid);
    }
  }
  voiceCtl.state.participants = list;
  const me = myUuid().toLowerCase();
  for (const p of list) {
    const uid = String(p.uuid).toLowerCase();
    if (uid === me) continue;
    if (!peers.has(uid)) {
      // deterministic: the smaller uuid creates the offer
      ensurePeer(uid, uid < me);
    }
  }
  emit();
}

async function handleSignal(sig) {
  const from = String(sig.from).toLowerCase();
  const pl = sig.payload || {};
  let pc = peers.get(from);
  if (pl.type === 'offer') {
    pc = pc || (await ensurePeer(from, false));
    await pc.setRemoteDescription({ type: 'offer', sdp: pl.sdp });
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    await signal(from, { type: 'answer', sdp: pc.localDescription.sdp });
  } else if (pl.type === 'answer') {
    if (pc && pc.signalingState === 'have-local-offer') {
      await pc.setRemoteDescription({ type: 'answer', sdp: pl.sdp });
    }
  } else if (pl.type === 'ice' && pl.candidate) {
    try { pc && await pc.addIceCandidate(pl.candidate); } catch { /* late candidate — harmless */ }
  }
}

async function pollOnce() {
  if (!voiceCtl.state.roomId) return;
  const r = await window.neurax.invoke('nx:voiceTick', { roomId: voiceCtl.state.roomId, since: cursor });
  cursor = r.cursor ?? cursor;
  diffParticipants(r.participants || []);
  for (const s of r.signals || []) await handleSignal(s);
}

voiceCtl.join = async function join(chat) {
  if (voiceCtl.state.roomId) await voiceCtl.leave();
  const me = await window.neurax.invoke('nx:identity').catch(() => null);
  if (me && me.uuid) voiceCtl.state.selfUuid = me.uuid;
  const r = await window.neurax.invoke('nx:voiceJoin', { chatId: chat.id });
  voiceCtl.state.roomId = r.roomId;
  voiceCtl.state.chatId = chat.id;
  voiceCtl.state.muted = false;
  cursor = 0;
  await getMic();
  diffParticipants(r.participants || []);
  pollTimer = setInterval(() => { pollOnce().catch(() => {}); }, POLL_MS);
  micLevelTimer = setInterval(sampleLevels, 300);
  emit();
};

voiceCtl.leave = async function leave() {
  clearInterval(pollTimer); pollTimer = null;
  clearInterval(micLevelTimer); micLevelTimer = null;
  const roomId = voiceCtl.state.roomId;
  for (const [uuid, pc] of peers) { try { pc.close(); } catch {} }
  peers.clear();
  for (const [uuid, a] of audioEls) { try { a.remove(); } catch {} }
  audioEls.clear();
  for (const [uuid, a] of analysers) { try { a.ctx.close(); } catch {} }
  analysers.clear();
  voiceCtl.speaking.clear();
  voiceCtl.state.roomId = null;
  voiceCtl.state.chatId = null;
  voiceCtl.state.participants = [];
  if (localStream) {
    for (const t of localStream.getTracks()) { try { t.stop(); } catch {} }
    localStream = null;
  }
  if (roomId) { await window.neurax.invoke('nx:voiceLeave', { roomId }).catch(() => {}); }
  emit();
};

voiceCtl.toggleMute = function toggleMute() {
  voiceCtl.state.muted = !voiceCtl.state.muted;
  if (localStream) for (const t of localStream.getAudioTracks()) t.enabled = !voiceCtl.state.muted;
  if (voiceCtl.state.roomId) {
    window.neurax.invoke('nx:voiceUpdate', { roomId: voiceCtl.state.roomId, muted: voiceCtl.state.muted }).catch(() => {});
  }
  emit();
};
