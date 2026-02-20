const startSessionBtn = document.getElementById("startSessionBtn");
const joinSessionBtn = document.getElementById("joinSessionBtn");
const joinForm = document.getElementById("joinForm");
const roomCodeInput = document.getElementById("roomCodeInput");
const landingMessage = document.getElementById("landingMessage");

function showMessage(text, isError = false) {
  landingMessage.textContent = text;
  landingMessage.style.fontWeight = isError ? "700" : "400";
}

function normalizeRoomCode(value) {
  return (value || "").trim().toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 6);
}

async function createRoomAndStart() {
  startSessionBtn.disabled = true;
  showMessage("creating your session...");

  try {
    const response = await fetch("/api/create-room", { method: "POST" });
    if (!response.ok) {
      throw new Error("could not create room.");
    }

    const data = await response.json();
    const roomCode = normalizeRoomCode(data.code);
    if (!roomCode) {
      throw new Error("server did not return a valid room code.");
    }

    window.location.href = `/room/${roomCode}?role=host`;
  } catch (err) {
    showMessage(err.message || "could not create room.", true);
    startSessionBtn.disabled = false;
  }
}

function joinRoomByCode() {
  const roomCode = normalizeRoomCode(roomCodeInput.value);
  roomCodeInput.value = roomCode;
  if (roomCode.length !== 6) {
    showMessage("enter a valid 6-character room code.", true);
    return;
  }
  window.location.href = `/room/${roomCode}?role=guest`;
}

startSessionBtn.addEventListener("click", createRoomAndStart);
joinSessionBtn.addEventListener("click", () => {
  roomCodeInput.focus();
  showMessage("enter your room code to join from phone.");
});

joinForm.addEventListener("submit", (event) => {
  event.preventDefault();
  joinRoomByCode();
});
