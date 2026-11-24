const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];

const state = {
  stream: null,
  roomCode: "",
  authMode: "login",
  channel: null,
  socket: null,
  peerId: crypto.randomUUID(),
  role: "host",
  peers: new Map()
};

function randomCode() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = crypto.getRandomValues(new Uint8Array(6));
  const chars = [...bytes].map((value) => alphabet[value % alphabet.length]);
  return `${chars.slice(0, 3).join("")}-${chars.slice(3).join("")}`;
}

function showToast(message) {
  const toast = $("#toast");
  toast.textContent = message;
  toast.classList.add("show");
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => toast.classList.remove("show"), 2200);
}

function openDialog(dialog) {
  if (typeof dialog.showModal === "function") dialog.showModal();
  else dialog.setAttribute("open", "");
}

function closeDialog(dialog) {
  if (typeof dialog.close === "function") dialog.close();
  else dialog.removeAttribute("open");
}

function setSessionMode(code) {
  state.roomCode = code || randomCode();
  $("#room-code").textContent = state.roomCode;
  $("#landing").classList.add("hidden");
  $("#session-app").classList.remove("hidden");
  drawQR();
  connectSignaling();
  history.replaceState({}, "", `#room=${encodeURIComponent(state.roomCode)}`);
}

function startSharing(isViewer = false) {
  if (isViewer) {
    openDialog($("#join-dialog"));
    return;
  }
  setSessionMode(randomCode());
  chooseScreen();
}

async function chooseScreen() {
  if (!navigator.mediaDevices?.getDisplayMedia) {
    showToast("Screen sharing is not supported in this browser.");
    return;
  }
  try {
    const stream = await navigator.mediaDevices.getDisplayMedia({
      video: { frameRate: { ideal: 30, max: 60 } },
      audio: true
    });
    state.stream = stream;
    const video = $("#shared-video");
    video.srcObject = stream;
    video.muted = true;
    $("#empty-stage").classList.add("hidden");
    $("#stream-controls").classList.remove("hidden");
    $("#self-status").textContent = "Sharing";
    $("#room-status-text").textContent = "Live";
    $("#room-status-dot").classList.add("live");
    if (state.channel) state.channel.postMessage({ type: "streaming", room: state.roomCode });
    stream.getVideoTracks()[0].addEventListener("ended", stopSharing);
    for (const peer of state.peers.values()) addStreamTracks(peer, stream);
    renegotiatePeers();
    showToast("Your screen is now being shared.");
  } catch (error) {
    if (error.name !== "NotAllowedError") showToast("Screen sharing could not start.");
  }
}

function stopSharing() {
  if (state.stream) {
    state.stream.getTracks().forEach((track) => track.stop());
  }
  state.stream = null;
  $("#shared-video").srcObject = null;
  $("#empty-stage").classList.remove("hidden");
  $("#stream-controls").classList.add("hidden");
  $("#self-status").textContent = "Ready";
  $("#room-status-text").textContent = "Ready";
  $("#room-status-dot").classList.remove("live");
  if (state.channel) state.channel.postMessage({ type: "stopped", room: state.roomCode });
}

function connectSignaling() {
  if (state.socket) state.socket.close();
  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  state.socket = new WebSocket(`${protocol}//${location.host}/ws`);

  state.socket.addEventListener("open", () => {
    state.socket.send(JSON.stringify({
      type: "join",
      room: state.roomCode,
      peerId: state.peerId
    }));
  });

  state.socket.addEventListener("message", async ({ data }) => {
    const message = JSON.parse(data);
    if (message.type === "peer_joined" && message.peerId !== state.peerId) {
      state.peers.set(message.peerId, createPeer(message.peerId));
      $("#peer-list").innerHTML = `<div class="device-item"><span class="device-icon">▰</span><div><strong>Remote device</strong><small>Connected</small></div><b>●</b></div>`;
      if (state.stream) {
        addStreamTracks(state.peers.get(message.peerId), state.stream);
        await renegotiatePeer(message.peerId);
      }
    } else if (message.type === "peer_left") {
      state.peers.get(message.peerId)?.close();
      state.peers.delete(message.peerId);
    } else if (message.type === "signal" && message.target === state.peerId) {
      await handleSignal(message.sender, message.payload);
    }
  });
}

function createPeer(peerId) {
  const peer = new RTCPeerConnection({
    iceServers: [
      { urls: "stun:stun.l.google.com:19302" },
      { urls: "stun:global.stun.twilio.com:3478" }
    ]
  });
  peer.onicecandidate = ({ candidate }) => {
    if (candidate) sendSignal(peerId, { type: "candidate", candidate });
  };
  peer.ontrack = ({ streams }) => {
    const video = $("#shared-video");
    video.srcObject = streams[0];
    $("#empty-stage").classList.add("hidden");
    $("#stream-controls").classList.remove("hidden");
  };
  state.peers.set(peerId, peer);
  return peer;
}

function addStreamTracks(peer, stream) {
  for (const track of stream.getTracks()) peer.addTrack(track, stream);
}

async function renegotiatePeer(peerId) {
  const peer = state.peers.get(peerId);
  if (!peer) return;
  const offer = await peer.createOffer();
  await peer.setLocalDescription(offer);
  sendSignal(peerId, { type: "offer", sdp: peer.localDescription });
}

async function renegotiatePeers() {
  for (const peerId of state.peers.keys()) await renegotiatePeer(peerId);
}

async function handleSignal(sender, payload) {
  let peer = state.peers.get(sender);
  if (!peer) peer = createPeer(sender);
  if (payload.type === "offer") {
    await peer.setRemoteDescription(payload.sdp);
    if (state.stream) addStreamTracks(peer, state.stream);
    const answer = await peer.createAnswer();
    await peer.setLocalDescription(answer);
    sendSignal(sender, { type: "answer", sdp: peer.localDescription });
  } else if (payload.type === "answer") {
    await peer.setRemoteDescription(payload.sdp);
  } else if (payload.type === "candidate") {
    await peer.addIceCandidate(payload.candidate);
  }
}

function sendSignal(target, payload) {
  if (state.socket?.readyState === WebSocket.OPEN) {
    state.socket.send(JSON.stringify({
      type: "signal",
      room: state.roomCode,
      sender: state.peerId,
      target,
      payload
    }));
  }
}

function drawQR() {
  if (window.QRCode) {
    const wrap = $("#qr-wrap");
    wrap.innerHTML = "";
    new QRCode(wrap, {
      text: `${location.origin}${location.pathname}#room=${encodeURIComponent(state.roomCode)}`,
      width: 180,
      height: 180,
      colorDark: "#0b1610",
      colorLight: "#ffffff",
      correctLevel: QRCode.CorrectLevel.M
    });
    return;
  }
  const canvas = $("#qr-canvas");
  const ctx = canvas.getContext("2d");
  const size = canvas.width;
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, size, size);

  const seed = [...`${location.origin}/#room=${state.roomCode}`].reduce((sum, char) => sum + char.charCodeAt(0), 0);
  ctx.fillStyle = "#0b1610";
  const module = 6;
  for (let y = 18; y < size - 18; y += module) {
    for (let x = 18; x < size - 18; x += module) {
      const value = ((x * 17 + y * 29 + seed) % 101) < 43;
      if (value) ctx.fillRect(x, y, module - 1, module - 1);
    }
  }

  ctx.fillStyle = "#ffffff";
  ctx.fillRect(18, 18, 44, 44);
  ctx.fillRect(size - 62, 18, 44, 44);
  ctx.fillRect(18, size - 62, 44, 44);
  ctx.fillStyle = "#0b1610";
  ctx.fillRect(24, 24, 32, 32);
  ctx.fillRect(size - 56, 24, 32, 32);
  ctx.fillRect(24, size - 56, 32, 32);
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(30, 30, 20, 20);
  ctx.fillRect(size - 50, 30, 20, 20);
  ctx.fillRect(30, size - 50, 20, 20);
  ctx.fillStyle = "#0b1610";
  ctx.fillRect(36, 36, 8, 8);
  ctx.fillRect(size - 44, 36, 8, 8);
  ctx.fillRect(36, size - 44, 8, 8);
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const input = document.createElement("textarea");
    input.value = text;
    document.body.appendChild(input);
    input.select();
    document.execCommand("copy");
    input.remove();
  }
  showToast("Copied to clipboard.");
}

function setAuthMode(mode) {
  state.authMode = mode;
  $("#auth-title").textContent = mode === "register" ? "Create your account" : "Welcome back";
  $("#auth-subtitle").textContent = mode === "register" ? "Create a private identity for your sessions." : "Sign in to manage your private sessions.";
  $(".auth-name").classList.toggle("hidden", mode !== "register");
  $("#auth-submit").textContent = mode === "register" ? "Create account" : "Log in";
  openDialog($("#auth-dialog"));
}

$("#start-share").addEventListener("click", () => startSharing(false));
$("#view-screen").addEventListener("click", () => startSharing(true));
$("#choose-screen").addEventListener("click", chooseScreen);
$("#stop-share").addEventListener("click", stopSharing);
$("#login-button").addEventListener("click", () => setAuthMode("login"));
$("#register-button").addEventListener("click", () => setAuthMode("register"));
$("#auth-guest").addEventListener("click", () => {
  closeDialog($("#auth-dialog"));
  showToast("Continuing as guest.");
});
$("#auth-form").addEventListener("submit", (event) => {
  event.preventDefault();
  const email = $("#auth-email").value.trim();
  const password = $("#auth-password").value;
  if (!email || password.length < 6) return;
  closeDialog($("#auth-dialog"));
  showToast(state.authMode === "register" ? "Account created on this device." : "Signed in.");
});

$("#join-form").addEventListener("submit", (event) => {
  event.preventDefault();
  const code = $("#join-code").value.trim().toUpperCase();
  if (!code) return;
  closeDialog($("#join-dialog"));
  setSessionMode(code);
  showToast("Joined session.");
});
$("#guest-button").addEventListener("click", () => {
  closeDialog($("#join-dialog"));
  setSessionMode(randomCode());
  showToast("Guest session ready.");
});

$("#copy-code").addEventListener("click", () => copyText(state.roomCode));
$("#copy-link").addEventListener("click", () => copyText(`${location.origin}${location.pathname}#room=${state.roomCode}`));
$("#leave-session").addEventListener("click", () => {
  stopSharing();
  if (state.channel) state.channel.close();
  state.channel = null;
  $("#session-app").classList.add("hidden");
  $("#landing").classList.remove("hidden");
  history.replaceState({}, "", location.pathname);
});
$("#home-button").addEventListener("click", () => $("#leave-session").click());
$("#toggle-mute").addEventListener("click", (event) => {
  const muted = $("#shared-video").muted;
  $("#shared-video").muted = !muted;
  event.currentTarget.textContent = muted ? "Mute" : "Unmute";
});
$("#toggle-fullscreen").addEventListener("click", () => {
  const stage = $(".stage");
  if (document.fullscreenElement) document.exitFullscreen();
  else stage.requestFullscreen?.();
});

const roomFromHash = location.hash.match(/room=([A-Z0-9-]+)/i)?.[1];
if (roomFromHash) setTimeout(() => setSessionMode(roomFromHash), 100);
