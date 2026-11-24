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

      server.addEventListener("message", (event) => {
        let message;
        try { message = JSON.parse(event.data); } catch { return; }

        if (message.type === "join") {
          roomCode = message.room;
          peerId = message.peerId;
          if (!rooms.has(roomCode)) rooms.set(roomCode, new Map());
          const room = rooms.get(roomCode);
          for (const [existingPeerId, socket] of room) {
            socket.send(JSON.stringify({ type: "peer_joined", peerId }));
            server.send(JSON.stringify({ type: "peer_joined", peerId: existingPeerId }));
          }
          room.set(peerId, server);
        }

        if (message.type === "signal" && rooms.has(roomCode)) {
          const target = rooms.get(roomCode).get(message.target);
          if (target) target.send(JSON.stringify(message));
        }
      });

      server.addEventListener("close", () => leaveRoom(roomCode, peerId));
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
  room.delete(peerId);
  for (const socket of room.values()) socket.send(JSON.stringify({ type: "peer_left", peerId }));
  if (room.size === 0) rooms.delete(roomCode);
}
