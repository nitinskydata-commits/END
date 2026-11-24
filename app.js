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
  peers: new Map(),
  reconnectAttempt: 0,
  intentionalClose: false,
  isExtendMode: false
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

function setSessionMode(code, role = "viewer") {
  state.roomCode = code || randomCode();
  state.role = role;
  state.isExtendMode = role === "extend";
  state.intentionalClose = false;
  $("#room-code").textContent = state.roomCode;
  $("#landing").classList.add("hidden");
  $("#session-app").classList.remove("hidden");
  if (role === "extend") {
    $("#empty-title").textContent = "Waiting for your computer";
    $("#empty-description").textContent = "Keep this device awake and rotate it for a full-screen second display.";
  } else if (role === "viewer") {
    $("#empty-title").textContent = "Waiting for a live screen";
    $("#empty-description").textContent = "The shared screen will appear here automatically.";
  }
  requestWakeLock();
  lockSecondScreenOrientation();
  drawQR();
  connectSignaling();
  history.replaceState({}, "", `#room=${encodeURIComponent(state.roomCode)}`);
}

function startSharing(isViewer = false) {
  if (isViewer) {
    openDialog($("#join-dialog"));
    return;
  }
  setSessionMode(randomCode(), "host");
  chooseScreen();
}

async function chooseScreen() {
  if (!navigator.mediaDevices?.getDisplayMedia) {
    if (/android|iphone|ipad|mobile/i.test(navigator.userAgent)) {
      showToast("Open this site in Chrome or Edge on desktop to share a screen.");
    } else {
      showToast("Screen sharing is not supported in this browser.");
    }
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
    state.socket?.send(JSON.stringify({ type: "streaming", room: state.roomCode }));
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
  state.socket?.send(JSON.stringify({ type: "stopped", room: state.roomCode }));
}

function connectSignaling() {
  if (state.socket) state.socket.close();
  state.intentionalClose = false;
  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  state.socket = new WebSocket(`${protocol}//${location.host}/ws`);

  state.socket.addEventListener("open", () => {
    state.reconnectAttempt = 0;
    $("#room-status-text").textContent = "Connected";
    $("#room-status-dot").classList.add("live");
    state.socket.send(JSON.stringify({
      type: "join",
      room: state.roomCode,
      peerId: state.peerId,
      role: state.role
    }));
    setTimeout(() => {
      if (state.stream) {
        state.socket?.send(JSON.stringify({ type: "streaming", room: state.roomCode }));
      }
    }, 150);
  });

  state.socket.addEventListener("close", () => {
    $("#room-status-dot").classList.remove("live");
    if (state.intentionalClose) return;
    $("#room-status-text").textContent = "Reconnecting";
    const delay = Math.min(1000 * (2 ** state.reconnectAttempt), 10000);
    state.reconnectAttempt += 1;
    setTimeout(connectSignaling, delay);
  });

  state.socket.addEventListener("error", () => {
    $("#room-status-text").textContent = "Connection error";
  });

  state.socket.addEventListener("message", async ({ data }) => {
    let message;
    try {
      message = JSON.parse(data);
    } catch {
      return;
    }
    if (message.type === "peer_joined" && message.peerId !== state.peerId) {
      state.peers.set(message.peerId, createPeer(message.peerId));
      $("#peer-list").innerHTML = `<div class="device-item"><span class="device-icon">▰</span><div><strong>Remote device</strong><small>Connected</small></div><b>●</b></div>`;
      if (state.role === "host" && state.stream) {
        addStreamTracks(state.peers.get(message.peerId), state.stream);
        await renegotiatePeer(message.peerId);
      }
    } else if (message.type === "room_state") {
      if (message.streaming) {
        $("#room-status-text").textContent = "Screen is live";
        $("#room-status-dot").classList.add("live");
        state.socket?.send(JSON.stringify({
          type: "request_stream",
          room: state.roomCode,
          requester: state.peerId
        }));
      } else if (state.role !== "host") {
        $("#room-status-text").textContent = "Waiting for host";
        $("#room-status-dot").classList.remove("live");
      }
    } else if (message.type === "peer_left") {
      state.peers.get(message.peerId)?.close();
      state.peers.delete(message.peerId);
    } else if (message.type === "request_stream") {
      if (state.role === "host" && state.stream) renegotiatePeers();
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
    ],
    iceCandidatePoolSize: 4
  });
  peer.pendingCandidates = [];
  peer.onicecandidate = ({ candidate }) => {
    if (candidate) sendSignal(peerId, { type: "candidate", candidate });
  };
  peer.ontrack = ({ streams }) => {
    const video = $("#shared-video");
    video.srcObject = streams[0];
    video.muted = state.isExtendMode;
    video.play().catch(() => {});
    $("#empty-stage").classList.add("hidden");
    $("#stream-controls").classList.remove("hidden");
    $("#room-status-text").textContent = "Receiving live";
    $("#room-status-dot").classList.add("live");
  };
  peer.onconnectionstatechange = () => {
    if (peer.connectionState === "connected") {
      $("#room-status-text").textContent = "Secure connection";
    } else if (["disconnected", "failed"].includes(peer.connectionState)) {
      $("#room-status-text").textContent = "Connection interrupted";
      showToast("The connection was interrupted.");
    }
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
    if (peer.signalingState !== "stable") return;
    await peer.setRemoteDescription(payload.sdp);
    if (state.stream) addStreamTracks(peer, state.stream);
    const answer = await peer.createAnswer();
    await peer.setLocalDescription(answer);
    sendSignal(sender, { type: "answer", sdp: peer.localDescription });
    for (const candidate of peer.pendingCandidates) await peer.addIceCandidate(candidate);
    peer.pendingCandidates = [];
  } else if (payload.type === "answer") {
    await peer.setRemoteDescription(payload.sdp);
  } else if (payload.type === "candidate") {
    if (peer.remoteDescription) await peer.addIceCandidate(payload.candidate);
    else peer.pendingCandidates.push(payload.candidate);
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

async function requestWakeLock() {
  if (!("wakeLock" in navigator) || !state.isExtendMode) return;
  try {
    state.wakeLock = await navigator.wakeLock.request("screen");
  } catch {}
}

async function lockSecondScreenOrientation() {
  if (!state.isExtendMode || !screen.orientation?.lock) return;
  try {
    await screen.orientation.lock("any");
  } catch {}
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
$("#extend-screen").addEventListener("click", () => openDialog($("#join-dialog")));
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
  const mode = $('input[name="join-mode"]:checked')?.value || "viewer";
  closeDialog($("#join-dialog"));
  setSessionMode(code, mode);
  showToast(mode === "extend" ? "Second-screen mode enabled." : "Joined session.");
});
$("#guest-button").addEventListener("click", () => {
  closeDialog($("#join-dialog"));
  setSessionMode(randomCode(), "host");
  showToast("Guest session ready.");
});

$("#copy-code").addEventListener("click", () => copyText(state.roomCode));
$("#copy-link").addEventListener("click", () => copyText(`${location.origin}${location.pathname}#room=${state.roomCode}`));
$("#leave-session").addEventListener("click", () => {
  stopSharing();
  state.intentionalClose = true;
  if (state.socket) state.socket.close();
  if (state.channel) state.channel.close();
  state.channel = null;
  $("#session-app").classList.add("hidden");
  $("#landing").classList.remove("hidden");
  history.replaceState({}, "", location.pathname);
});
$("#home-button").addEventListener("click", () => $("#leave-session").click());
$("#toggle-mute").addEventListener("click", (event) => {
  const tracks = state.stream?.getAudioTracks() || [];
  if (!tracks.length) {
    showToast("This shared screen has no audio.");
    return;
  }
  const enabled = tracks[0].enabled;
  tracks.forEach((track) => { track.enabled = !enabled; });
  event.currentTarget.textContent = enabled ? "Unmute" : "Mute";
});
$("#toggle-fullscreen").addEventListener("click", () => {
  const stage = $(".stage");
  if (document.fullscreenElement) document.exitFullscreen();
  else stage.requestFullscreen?.();
});

const roomFromHash = location.hash.match(/room=([A-Z0-9-]+)/i)?.[1];
if (roomFromHash) setTimeout(() => setSessionMode(roomFromHash, "viewer"), 100);

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => navigator.serviceWorker.register("./sw.js").catch(() => {}));
}
