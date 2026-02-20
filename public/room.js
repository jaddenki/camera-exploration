const ICE_SERVERS = [{ urls: "stun:stun.l.google.com:19302" }];

const roomCodeDisplay = document.getElementById("roomCodeDisplay");
const joinUrlText = document.getElementById("joinUrlText");
const qrWrap = document.getElementById("qrWrap");
const statusBadge = document.getElementById("statusBadge");
const deviceLabel = document.getElementById("deviceLabel");
const localLabel = document.getElementById("localLabel");
const remoteLabel = document.getElementById("remoteLabel");
const localVideo = document.getElementById("localVideo");
const remoteVideo = document.getElementById("remoteVideo");
const rejoinBtn = document.getElementById("rejoinBtn");
const roomError = document.getElementById("roomError");

const pathParts = window.location.pathname.split("/").filter(Boolean);
const roomCodeFromPath = (pathParts[1] || "").toLowerCase();
const params = new URLSearchParams(window.location.search);
const role = params.get("role") === "guest" ? "guest" : "host";
const roomCode = roomCodeFromPath.replace(/[^a-z0-9]/g, "").slice(0, 6);

let ws = null;
let localStream = null;
let peerConnection = null;
let reconnecting = false;
let hasPeer = false;

function setStatus(text, color) {
  statusBadge.textContent = text;
  statusBadge.classList.remove("status-yellow", "status-green", "status-red");
  statusBadge.classList.add(color);
}

function showError(text) {
  roomError.textContent = text;
}

function clearError() {
  roomError.textContent = "";
}

function wsUrl() {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${window.location.host}`;
}

function safeSend(payload) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(payload));
  }
}

function hasGetUserMedia() {
  return !!(typeof navigator !== "undefined" && navigator.mediaDevices && typeof navigator.mediaDevices.getUserMedia === "function");
}

async function ensureLocalMedia() {
  if (localStream) return localStream;
  if (!hasGetUserMedia()) {
    const isSecure = window.location.protocol === "https:" || window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1";
    throw new Error(
      isSecure
        ? "camera/mic not available in this browser."
        : "camera and mic require a secure page (https)"
    );
  }
  localStream = await navigator.mediaDevices.getUserMedia({
    video: {
      width: { ideal: 1920 },
      height: { ideal: 1080 },
      aspectRatio: { ideal: 16 / 9 }
    },
    audio: true
  });
  localVideo.srcObject = localStream;
  return localStream;
}

async function resolveJoinBase() {
  const isLocalHost =
    window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1";
  if (!isLocalHost) {
    return window.location.origin;
  }

  try {
    const response = await fetch("/api/network-addresses");
    if (!response.ok) return window.location.origin;
    const data = await response.json();
    return data.suggestedJoinBase || window.location.origin;
  } catch (_err) {
    return window.location.origin;
  }
}

function createPeerConnection() {
  if (peerConnection) return peerConnection;

  peerConnection = new RTCPeerConnection({ iceServers: ICE_SERVERS });

  peerConnection.onicecandidate = (event) => {
    if (!event.candidate) return;
    safeSend({
      type: "ice-candidate",
      roomCode,
      payload: event.candidate
    });
  };

  peerConnection.ontrack = (event) => {
    remoteVideo.srcObject = event.streams[0];
  };

  peerConnection.onconnectionstatechange = () => {
    const state = peerConnection.connectionState;
    if (state === "connected") {
      setStatus(role === "host" ? "phone connected" : "connected", "status-green");
    } else if (state === "connecting") {
      setStatus(role === "host" ? "waiting for phone" : "connecting", "status-yellow");
    } else if (state === "failed" || state === "disconnected" || state === "closed") {
      setStatus(role === "host" ? "disconnected" : "retry", "status-red");
    }
  };

  peerConnection.oniceconnectionstatechange = () => {
    const ice = peerConnection.iceConnectionState;
    if (ice === "connected" || ice === "completed") {
      setStatus(role === "host" ? "phone connected" : "connected", "status-green");
    } else if (ice === "checking") {
      setStatus(role === "host" ? "waiting for phone" : "connecting", "status-yellow");
    } else if (ice === "failed" || ice === "disconnected") {
      setStatus(role === "host" ? "disconnected" : "retry", "status-red");
    }
  };

  return peerConnection;
}

async function attachTracks() {
  const stream = await ensureLocalMedia();
  const pc = createPeerConnection();
  const existingTrackIds = new Set(pc.getSenders().map((sender) => sender.track && sender.track.id));
  stream.getTracks().forEach((track) => {
    if (!existingTrackIds.has(track.id)) {
      pc.addTrack(track, stream);
    }
  });
}

async function createAndSendOffer() {
  if (role !== "host" || !hasPeer) return;
  await attachTracks();
  const pc = createPeerConnection();
  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  safeSend({
    type: "offer",
    roomCode,
    payload: offer
  });
}

async function handleOffer(offer) {
  await attachTracks();
  const pc = createPeerConnection();
  await pc.setRemoteDescription(new RTCSessionDescription(offer));
  const answer = await pc.createAnswer();
  await pc.setLocalDescription(answer);
  safeSend({
    type: "answer",
    roomCode,
    payload: answer
  });
}

async function handleAnswer(answer) {
  if (!peerConnection) return;
  await peerConnection.setRemoteDescription(new RTCSessionDescription(answer));
}

async function handleIceCandidate(candidate) {
  if (!peerConnection || !candidate) return;
  try {
    await peerConnection.addIceCandidate(new RTCIceCandidate(candidate));
  } catch (_err) {
  }
}

async function updateRoleUI() {
  roomCodeDisplay.textContent = roomCode;
  if (role === "host") {
    const joinBase = await resolveJoinBase();
    const joinUrl = `${joinBase}/room/${roomCode}?role=guest`;
    deviceLabel.textContent = "laptop host";
    localLabel.textContent = "laptop cam";
    remoteLabel.textContent = "phone cam";
    setStatus("waiting for phone", "status-yellow");
    joinUrlText.textContent = joinUrl;

    if (window.QRCode) {
      qrWrap.innerHTML = "";
      new QRCode(qrWrap, {
        text: joinUrl,
        width: 116,
        height: 116
      });
    }
  } else {
    deviceLabel.textContent = "phone guest";
    localLabel.textContent = "phone cam";
    remoteLabel.textContent = "laptop cam";
    setStatus("connecting", "status-yellow");
    joinUrlText.textContent = "";
    qrWrap.innerHTML = "";
  }
}

function closePeerConnection() {
  if (peerConnection) {
    peerConnection.ontrack = null;
    peerConnection.onicecandidate = null;
    peerConnection.close();
  }
  peerConnection = null;
}

function disconnectSocket() {
  if (ws) {
    ws.onopen = null;
    ws.onmessage = null;
    ws.onclose = null;
    ws.onerror = null;
    ws.close();
  }
  ws = null;
}

async function startSession() {
  clearError();
  if (roomCode.length !== 6) {
    showError("this room code is invalid.");
    setStatus(role === "host" ? "disconnected" : "retry", "status-red");
    return;
  }

  await ensureLocalMedia();
  await attachTracks();

  ws = new WebSocket(wsUrl());

  ws.onopen = () => {
    safeSend({
      type: "join-room",
      roomCode,
      payload: { role }
    });
  };

  ws.onmessage = async (event) => {
    const message = JSON.parse(event.data);
    const { type, payload } = message;

    if (type === "joined-room") {
      if (role === "guest") {
        setStatus("connecting", "status-yellow");
      }
      return;
    }

    if (type === "peer-joined") {
      hasPeer = true;
      if (role === "host") {
        setStatus("waiting for phone", "status-yellow");
        await createAndSendOffer();
      } else {
        setStatus("connecting", "status-yellow");
      }
      return;
    }

    if (type === "offer") {
      hasPeer = true;
      await handleOffer(payload);
      return;
    }

    if (type === "answer") {
      await handleAnswer(payload);
      return;
    }

    if (type === "ice-candidate") {
      await handleIceCandidate(payload);
      return;
    }

    if (type === "peer-left") {
      hasPeer = false;
      closePeerConnection();
      await attachTracks();
      setStatus(role === "host" ? "waiting for phone" : "retry", "status-red");
      return;
    }

    if (type === "room-full") {
      document.body.innerHTML = `
        <main class="shell" style="padding: 24px;">
          <section class="card" style="padding: 24px; max-width: 640px; margin: 0 auto;">
            <h1 style="font-size: 28px; margin-top: 0;">room is already full</h1>
            <p>
              host and guest already found
            </p>
            <a class="small-link" href="/">back to home</a>
          </section>
        </main>
      `;
      return;
    }
  };

  ws.onclose = () => {
    hasPeer = false;
    if (reconnecting) return;
    setStatus(role === "host" ? "disconnected" : "retry", "status-red");
  };

  ws.onerror = () => {
    setStatus(role === "host" ? "disconnected" : "retry", "status-red");
  };
}

async function rejoin() {
  reconnecting = true;
  setStatus(role === "host" ? "waiting for phone" : "connecting", "status-yellow");
  hasPeer = false;
  closePeerConnection();
  disconnectSocket();
  await startSession();
  reconnecting = false;
}

rejoinBtn.addEventListener("click", () => {
  rejoin().catch(() => {
    setStatus(role === "host" ? "disconnected" : "retry", "status-red");
    showError("could not rejoin. please refresh and try again.");
  });
});

window.addEventListener("beforeunload", () => {
  safeSend({ type: "peer-left", roomCode, payload: { role } });
  disconnectSocket();
  closePeerConnection();
  if (localStream) {
    localStream.getTracks().forEach((track) => track.stop());
  }
});

updateRoleUI();
startSession().catch((err) => {
  showError(err.message || "could not start camera/microphone.");
  setStatus(role === "host" ? "disconnected" : "retry", "status-red");
});
