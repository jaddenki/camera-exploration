const path = require("path");
const http = require("http");
const os = require("os");
const express = require("express");
const { WebSocketServer } = require("ws");

const PORT = process.env.PORT || 3000;
const ROOM_CODE_LENGTH = 6;
const ROOM_ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789";

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

app.use(express.static(path.join(__dirname, "public")));

const rooms = new Map();

function generateRoomCode() {
  let code = "";
  for (let i = 0; i < ROOM_CODE_LENGTH; i += 1) {
    const idx = Math.floor(Math.random() * ROOM_ALPHABET.length);
    code += ROOM_ALPHABET[idx];
  }
  return code;
}

function createUniqueRoomCode() {
  for (let i = 0; i < 20; i += 1) {
    const code = generateRoomCode();
    if (!rooms.has(code)) return code;
  }
  throw new Error("could not generate a unique room code");
}

function getOrCreateRoom(roomCode) {
  if (!rooms.has(roomCode)) {
    rooms.set(roomCode, {
      host: null,
      guest: null
    });
  }
  return rooms.get(roomCode);
}

function sendJSON(ws, payload) {
  if (ws && ws.readyState === 1) {
    ws.send(JSON.stringify(payload));
  }
}

function getPeer(room, role) {
  if (role === "host") return room.guest;
  if (role === "guest") return room.host;
  return null;
}

function cleanupRoomIfEmpty(roomCode) {
  const room = rooms.get(roomCode);
  if (!room) return;
  if (!room.host && !room.guest) {
    rooms.delete(roomCode);
  }
}

app.post("/api/create-room", (_req, res) => {
  const code = createUniqueRoomCode();
  rooms.set(code, { host: null, guest: null });
  res.json({ code });
});

function localIpv4Addresses() {
  const interfaces = os.networkInterfaces();
  const addresses = [];
  Object.values(interfaces).forEach((ifaceList) => {
    (ifaceList || []).forEach((iface) => {
      if (iface && iface.family === "IPv4" && !iface.internal) {
        addresses.push(iface.address);
      }
    });
  });
  return addresses;
}

app.get("/api/network-addresses", (req, res) => {
  const hostHeader = req.get("host") || "";
  const [, hostPort] = hostHeader.split(":");
  const port = hostPort || String(PORT);
  const protocol = req.get("x-forwarded-proto") || req.protocol || "http";
  const origin = `${protocol}://${hostHeader}`;
  const addresses = localIpv4Addresses();
  const lanUrls = addresses.map((ip) => `${protocol}://${ip}:${port}`);
  const isLocalHost =
    hostHeader.startsWith("localhost") || hostHeader.startsWith("127.0.0.1");
  const suggestedJoinBase = isLocalHost && lanUrls.length > 0 ? lanUrls[0] : origin;

  res.json({
    origin,
    suggestedJoinBase,
    lanUrls
  });
});

app.get("/room/:code", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "room.html"));
});

app.get("/health", (_req, res) => {
  res.type("text/plain").send("ok");
});

wss.on("connection", (ws) => {
  ws.roomCode = null;
  ws.role = null;

  ws.on("message", (rawData) => {
    let message;
    try {
      message = JSON.parse(rawData.toString());
    } catch (_err) {
      sendJSON(ws, { type: "error", payload: { message: "invalid json payload." } });
      return;
    }

    const { type, roomCode, payload } = message || {};
    if (!type || !roomCode) {
      sendJSON(ws, { type: "error", payload: { message: "missing type or roomcode." } });
      return;
    }

    const normalizedCode = String(roomCode).trim().toLowerCase();
    const room = getOrCreateRoom(normalizedCode);

    if (type === "join-room") {
      const role = payload && payload.role;
      if (role !== "host" && role !== "guest") {
        sendJSON(ws, { type: "error", payload: { message: "invalid role." } });
        return;
      }

      if (room.host && room.guest && room[role] !== ws) {
        sendJSON(ws, { type: "room-full", roomCode: normalizedCode });
        ws.close();
        return;
      }

      if (room[role] && room[role] !== ws) {
        sendJSON(ws, { type: "room-full", roomCode: normalizedCode });
        ws.close();
        return;
      }

      ws.roomCode = normalizedCode;
      ws.role = role;
      room[role] = ws;

      sendJSON(ws, {
        type: "joined-room",
        roomCode: normalizedCode,
        payload: { role }
      });

      const peer = getPeer(room, role);
      if (peer) {
        sendJSON(ws, { type: "peer-joined", roomCode: normalizedCode, payload: { role: "self" } });
        sendJSON(peer, { type: "peer-joined", roomCode: normalizedCode, payload: { role } });
      }
      return;
    }

    const senderRole = ws.role;
    if (!senderRole || ws.roomCode !== normalizedCode) {
      sendJSON(ws, { type: "error", payload: { message: "join room before signaling." } });
      return;
    }

    const relayTypes = new Set(["offer", "answer", "ice-candidate", "peer-left"]);
    if (relayTypes.has(type)) {
      const peer = getPeer(room, senderRole);
      if (peer) {
        sendJSON(peer, {
          type,
          roomCode: normalizedCode,
          payload
        });
      }
      return;
    }

    sendJSON(ws, { type: "error", payload: { message: "unknown message type." } });
  });

  ws.on("close", () => {
    const { roomCode, role } = ws;
    if (!roomCode || !role) return;

    const room = rooms.get(roomCode);
    if (!room) return;

    if (room[role] === ws) {
      room[role] = null;
    }

    const peer = getPeer(room, role);
    if (peer) {
      sendJSON(peer, { type: "peer-left", roomCode, payload: { role } });
    }

    cleanupRoomIfEmpty(roomCode);
  });
});

server.listen(PORT, () => {
  console.log(`jadden demo running on port ${PORT}`);
});
