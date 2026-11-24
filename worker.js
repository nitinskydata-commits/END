const rooms = new Map();

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/ws") {
      const upgrade = request.headers.get("Upgrade");
      if (upgrade !== "websocket") return new Response("WebSocket upgrade required", { status: 426 });

      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);
      server.accept();
      let roomCode = "";
      let peerId = "";
      let heartbeat;
      heartbeat = setInterval(() => {
        if (server.readyState === 1) server.send(JSON.stringify({ type: "ping" }));
      }, 25000);

      server.addEventListener("message", (event) => {
        let message;
        try { message = JSON.parse(event.data); } catch { return; }

        if (message.type === "join") {
          roomCode = String(message.room || "").replace(/[^A-Z0-9-]/gi, "").slice(0, 7).toUpperCase();
          peerId = String(message.peerId || "").slice(0, 64);
          if (!roomCode || !peerId) {
            server.send(JSON.stringify({ type: "error", message: "Invalid room" }));
            return;
          }
          if (!rooms.has(roomCode)) rooms.set(roomCode, { peers: new Map(), streaming: false });
          const room = rooms.get(roomCode);
          for (const [existingPeerId, existingSocket] of room.peers) {
            existingSocket.send(JSON.stringify({ type: "peer_joined", peerId, role: message.role }));
            server.send(JSON.stringify({ type: "peer_joined", peerId: existingPeerId, role: existingSocket.role }));
          }
          server.role = message.role || "viewer";
          room.peers.set(peerId, server);
          server.send(JSON.stringify({ type: "room_state", streaming: room.streaming }));
        }

        if (message.type === "signal" && rooms.has(roomCode)) {
          const target = rooms.get(roomCode).peers.get(message.target);
          if (target) target.send(JSON.stringify(message));
        }

        if (message.type === "request_stream" && rooms.has(roomCode)) {
          for (const [existingPeerId, socket] of rooms.get(roomCode).peers) {
            if (existingPeerId !== peerId) {
              socket.send(JSON.stringify({
                type: "request_stream",
                requester: message.requester
              }));
            }
          }
        }

        if ((message.type === "streaming" || message.type === "stopped") && rooms.has(roomCode)) {
          const room = rooms.get(roomCode);
          room.streaming = message.type === "streaming";
          for (const socket of room.peers.values()) {
            socket.send(JSON.stringify({
              type: "room_state",
              streaming: room.streaming,
              peerId
            }));
          }
        }
      });

      server.addEventListener("close", () => leaveRoom(roomCode, peerId));
      server.addEventListener("close", () => clearInterval(heartbeat));
      server.addEventListener("error", () => leaveRoom(roomCode, peerId));

      return new Response(null, { status: 101, webSocket: client });
    }

    if (env.ASSETS) return env.ASSETS.fetch(request);
    return new Response("Assets not configured", { status: 404 });
  }
};

function leaveRoom(roomCode, peerId) {
  if (!roomCode || !rooms.has(roomCode)) return;
  const room = rooms.get(roomCode);
  room.peers.delete(peerId);
  for (const socket of room.peers.values()) socket.send(JSON.stringify({ type: "peer_left", peerId }));
  if (room.peers.size === 0) rooms.delete(roomCode);
}
