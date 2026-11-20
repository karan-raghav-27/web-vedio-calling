const crypto = require("node:crypto");
const http = require("node:http");
const path = require("node:path");
const express = require("express");
const { WebSocket, WebSocketServer } = require("ws");

const app = express();
const server = http.createServer(app);
const webSocketServer = new WebSocketServer({
  noServer: true,
  maxPayload: 64 * 1024
});

const PORT = Number(process.env.PORT) || 3000;
const ROOM_IDLE_MS = 5 * 60 * 1000;
const rooms = new Map();

app.disable("x-powered-by");
app.use((request, response, next) => {
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("Referrer-Policy", "no-referrer");
  response.setHeader("Permissions-Policy", "camera=(self), microphone=(self), display-capture=(self)");
  response.setHeader(
    "Content-Security-Policy",
    "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self' ws: wss: stun: turn: turns:; " +
      "img-src 'self' data:; media-src 'self' blob:; object-src 'none'; base-uri 'self'; " +
      "form-action 'self'; frame-ancestors 'none'"
  );
  next();
});

app.get("/", (request, response) => {
  response.setHeader("Cache-Control", "no-store");
  response.sendFile(path.join(__dirname, "index.html"));
});
app.get("/style.css", (request, response) => {
  response.sendFile(path.join(__dirname, "style.css"));
});
app.get("/app.js", (request, response) => {
  response.sendFile(path.join(__dirname, "app.js"));
});

// Room IDs are bearer links: anyone who has the link can try to join.
app.post("/api/rooms", (request, response) => {
  const roomId = crypto.randomBytes(32).toString("base64url");
  rooms.set(roomId, {
    clients: new Set(),
    lastActivity: Date.now()
  });
  response.setHeader("Cache-Control", "no-store");
  response.status(201).json({ roomId });
});

function sendJson(socket, message) {
  if (socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(message));
  }
}

function closeRoom(roomId, message) {
  const room = rooms.get(roomId);
  if (!room) return;

  rooms.delete(roomId);
  for (const client of room.clients) {
    sendJson(client, { type: "error", message });
    client.close(1000, "Room expired");
  }
}

server.on("upgrade", (request, socket, head) => {
  let requestUrl;
  let origin;

  try {
    requestUrl = new URL(request.url, `http://${request.headers.host}`);
    origin = new URL(request.headers.origin);
  } catch {
    socket.destroy();
    return;
  }

  // Only accept browser connections from this same site.
  if (
    requestUrl.pathname !== "/signal" ||
    !request.headers.host ||
    !request.headers.origin ||
    origin.host !== request.headers.host
  ) {
    socket.destroy();
    return;
  }

  webSocketServer.handleUpgrade(request, socket, head, (webSocket) => {
    webSocketServer.emit("connection", webSocket);
  });
});

webSocketServer.on("connection", (socket) => {
  socket.roomId = null;
  socket.isAlive = true;
  socket.isInitiator = false;
  socket.isReady = false;

  socket.on("pong", () => {
    socket.isAlive = true;
    const room = rooms.get(socket.roomId);
    if (room) room.lastActivity = Date.now();
  });

  socket.on("message", (rawMessage) => {
    let message;
    try {
      message = JSON.parse(rawMessage.toString());
    } catch {
      sendJson(socket, { type: "error", message: "Invalid signaling message." });
      return;
    }

    if (!message || typeof message !== "object" || Array.isArray(message)) {
      sendJson(socket, { type: "error", message: "Invalid signaling message." });
      return;
    }

    if (socket.roomId === null) {
      if (message.type !== "join" || typeof message.roomId !== "string" ||
          !/^[A-Za-z0-9_-]{43}$/.test(message.roomId)) {
        sendJson(socket, { type: "error", message: "Invalid room link." });
        socket.close(1008, "Invalid join request");
        return;
      }

      const room = rooms.get(message.roomId);
      if (!room) {
        sendJson(socket, { type: "error", message: "This room was not found or has expired." });
        socket.close(1008, "Room not found");
        return;
      }
      if (room.clients.size >= 2) {
        sendJson(socket, { type: "error", message: "This room is full." });
        socket.close(1008, "Room full");
        return;
      }

      socket.roomId = message.roomId;
      socket.isInitiator = room.clients.size === 0;
      socket.isReady = false;
      room.clients.add(socket);
      room.lastActivity = Date.now();

      sendJson(socket, {
        type: "joined",
        isInitiator: socket.isInitiator,
        peerCount: room.clients.size
      });

      for (const peer of room.clients) {
        if (peer !== socket) {
          sendJson(peer, { type: "peer-joined" });
        }
      }
      return;
    }

    const room = rooms.get(socket.roomId);
    if (!room || !room.clients.has(socket)) return;
    room.lastActivity = Date.now();

    if (message.type === "ready") {
      socket.isReady = true;
      if (room.clients.size === 2 && [...room.clients].every((client) => client.isReady)) {
        for (const client of room.clients) {
          sendJson(client, { type: "peer-ready" });
        }
      }
      return;
    }

    // Chat is deliberately not a signaling message; it travels on the peer data channel.
    if (!["offer", "answer", "ice"].includes(message.type) ||
        !message.data || typeof message.data !== "object") {
      sendJson(socket, { type: "error", message: "Unsupported signaling message." });
      return;
    }

    const peer = [...room.clients].find((client) => client !== socket);
    if (!peer || !peer.isReady) {
      sendJson(socket, { type: "error", message: "The other person is not ready yet." });
      return;
    }

    sendJson(peer, { type: message.type, data: message.data });
  });

  socket.on("close", () => {
    const roomId = socket.roomId;
    const room = rooms.get(roomId);
    if (!room) return;

    room.clients.delete(socket);
    room.lastActivity = Date.now();

    const remaining = [...room.clients];
    if (remaining.length === 0) {
      // An empty joined room is removed immediately; an unjoined reservation expires below.
      rooms.delete(roomId);
      return;
    }

    remaining[0].isInitiator = true;
    sendJson(remaining[0], { type: "peer-left", isInitiator: true });
  });

  socket.on("error", (error) => {
    console.error("WebSocket error:", error.message);
  });
});

// Heartbeats clean up dead sockets; the same short timeout removes abandoned room links.
const heartbeatTimer = setInterval(() => {
  const now = Date.now();
  for (const [roomId, room] of rooms) {
    if (now - room.lastActivity > ROOM_IDLE_MS) {
      closeRoom(roomId, "This room expired after being idle.");
      continue;
    }

    for (const client of room.clients) {
      if (!client.isAlive) {
        client.terminate();
        continue;
      }
      client.isAlive = false;
      client.ping();
    }
  }
}, 30 * 1000);
heartbeatTimer.unref();

server.listen(PORT, () => {
  console.log(`Private video calling app is running at http://localhost:${PORT}`);
});
