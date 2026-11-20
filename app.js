const welcomeModal = document.querySelector("#welcome-modal");
const appShell = document.querySelector("#app-shell");
const enterButton = document.querySelector("#enter-button");
const createRoomButton = document.querySelector("#create-room-button");
const copyLinkButton = document.querySelector("#copy-link-button");
const roomLinkInput = document.querySelector("#room-link");
const connectionStatus = document.querySelector("#connection-status");
const statusDot = document.querySelector("#status-dot");
const errorMessage = document.querySelector("#error-message");
const localVideo = document.querySelector("#local-video");
const remoteVideo = document.querySelector("#remote-video");
const remotePlaceholder = document.querySelector("#remote-placeholder");
const micButton = document.querySelector("#mic-button");
const cameraButton = document.querySelector("#camera-button");
const shareScreenButton = document.querySelector("#share-screen-button");
const hangupButton = document.querySelector("#hangup-button");
const microphoneSelect = document.querySelector("#microphone-select");
const cameraSelect = document.querySelector("#camera-select");
const chatForm = document.querySelector("#chat-form");
const chatInput = document.querySelector("#chat-input");
const sendChatButton = document.querySelector("#send-chat-button");
const chatMessages = document.querySelector("#chat-messages");
const chatEmpty = document.querySelector("#chat-empty");

const ROOM_ID_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const rtcConfiguration = {
  iceServers: [
    { urls: "stun:stun.l.google.com:19302" }
    // For restrictive networks, add your own TURN server here:
    // { urls: "turn:turn.example.com:3478", username: "user", credential: "password" }
  ]
};

let roomId = null;
let socket = null;
let peerConnection = null;
let localStream = null;
let dataChannel = null;
let pendingIceCandidates = [];
let isInitiator = false;
let currentVideoSender = null;
let cameraTrack = null;
let screenTrack = null;
let hasTriedLink = false;

// DTLS-SRTP encrypts media and DTLS encrypts data-channel chat between peers. This
// does not verify who owns a room link: signaling can see SDP/ICE and network
// addresses, and a malicious signaling server could tamper with connection setup.

function setStatus(status) {
  const labels = {
    waiting: "Waiting",
    connecting: "Connecting",
    connected: "Connected",
    disconnected: "Disconnected"
  };
  connectionStatus.textContent = labels[status] || labels.waiting;
  statusDot.dataset.status = status;
}

function showError(message) {
  errorMessage.textContent = message;
  errorMessage.hidden = false;
}

function clearError() {
  errorMessage.textContent = "";
  errorMessage.hidden = true;
}

function showApp() {
  welcomeModal.hidden = true;
  appShell.hidden = false;
  if (!hasTriedLink) {
    hasTriedLink = true;
    const requestedRoom = new URLSearchParams(location.search).get("room");
    if (requestedRoom) {
      if (!ROOM_ID_PATTERN.test(requestedRoom)) {
        showError("That room link does not look valid.");
        return;
      }
      roomId = requestedRoom;
      roomLinkInput.value = location.href;
      copyLinkButton.disabled = false;
      connectToRoom(requestedRoom);
    }
  }
}

enterButton.addEventListener("click", showApp);
window.setTimeout(showApp, 4000);

function getUserMediaError(error) {
  if (error?.name === "NotAllowedError" || error?.name === "PermissionDeniedError") {
    return "Camera or microphone permission was denied. Allow access in your browser settings, then try again.";
  }
  if (error?.name === "NotFoundError" || error?.name === "DevicesNotFoundError") {
    return "No camera or microphone was found. Connect a device and try again.";
  }
  if (error?.name === "NotReadableError" || error?.name === "TrackStartError") {
    return "Your camera or microphone is already in use by another app.";
  }
  return "Could not start your camera and microphone. Check your devices and browser permissions.";
}

async function getLocalMedia() {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error("Camera and microphone access requires HTTPS or localhost in a supported browser.");
  }

  try {
    localStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: true });
  } catch (error) {
    throw new Error(getUserMediaError(error));
  }

  cameraTrack = localStream.getVideoTracks()[0] || null;
  localVideo.srcObject = localStream;
  await updateDeviceLists();
  setMediaControlsEnabled(true);
}

function setMediaControlsEnabled(enabled) {
  micButton.disabled = !enabled;
  cameraButton.disabled = !enabled;
  shareScreenButton.disabled = !enabled || !navigator.mediaDevices?.getDisplayMedia;
  hangupButton.disabled = !enabled && !socket;
  microphoneSelect.disabled = !enabled;
  cameraSelect.disabled = !enabled;
}

async function startNewRoom() {
  if (socket || localStream) return;
  clearError();
  createRoomButton.disabled = true;

  try {
    await getLocalMedia();
    const response = await fetch("/api/rooms", { method: "POST" });
    if (!response.ok) throw new Error("Could not create a room. Please try again.");
    const result = await response.json();
    if (!ROOM_ID_PATTERN.test(result.roomId)) throw new Error("The server returned an invalid room link.");

    roomId = result.roomId;
    const url = new URL(location.href);
    url.search = new URLSearchParams({ room: roomId }).toString();
    history.replaceState(null, "", url);
    roomLinkInput.value = url.href;
    copyLinkButton.disabled = false;
    setStatus("waiting");
    connectToRoom(roomId);
  } catch (error) {
    stopLocalMedia();
    showError(error.message || "Could not create a room.");
    createRoomButton.disabled = false;
  }
}

createRoomButton.addEventListener("click", startNewRoom);

copyLinkButton.addEventListener("click", async () => {
  if (!roomLinkInput.value) return;
  try {
    await navigator.clipboard.writeText(roomLinkInput.value);
    copyLinkButton.textContent = "Copied!";
    window.setTimeout(() => { copyLinkButton.textContent = "Copy link"; }, 1600);
  } catch {
    roomLinkInput.focus();
    roomLinkInput.select();
    showError("Could not copy automatically. Select and copy the room link above.");
  }
});

function makeSignalUrl() {
  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${location.host}/signal`;
}

function connectToRoom(id) {
  clearError();
  setStatus("waiting");
  createRoomButton.disabled = true;
  try {
    socket = new WebSocket(makeSignalUrl());
  } catch {
    showError("Could not connect to the signaling server.");
    setStatus("disconnected");
    createRoomButton.disabled = false;
    return;
  }

  const thisSocket = socket;
  thisSocket.addEventListener("open", () => {
    thisSocket.send(JSON.stringify({ type: "join", roomId: id }));
  });
  thisSocket.addEventListener("message", async (event) => {
    try {
      await handleServerMessage(JSON.parse(event.data), thisSocket);
    } catch (error) {
      showError(error.message || "A call connection error occurred.");
      thisSocket.close();
    }
  });
  thisSocket.addEventListener("close", () => {
    if (socket !== thisSocket) return;
    socket = null;
    closePeerConnection();
    stopLocalMedia();
    setStatus("disconnected");
    setMediaControlsEnabled(false);
    hangupButton.disabled = true;
    createRoomButton.disabled = false;
  });
  thisSocket.addEventListener("error", () => {
    if (socket === thisSocket) {
      showError("Could not reach the signaling server. Check your connection and try again.");
      setStatus("disconnected");
      thisSocket.close();
    }
  });
}

async function handleServerMessage(message, sourceSocket) {
  if (sourceSocket !== socket) return;

  switch (message.type) {
    case "joined":
      isInitiator = message.isInitiator === true;
      setStatus("waiting");
      try {
        if (!localStream) await getLocalMedia();
        if (sourceSocket === socket && sourceSocket.readyState === WebSocket.OPEN) {
          sourceSocket.send(JSON.stringify({ type: "ready" }));
        }
      } catch (error) {
        showError(error.message);
        sourceSocket.close();
      }
      break;
    case "peer-joined":
      closePeerConnection();
      setStatus("waiting");
      break;
    case "peer-ready":
      setStatus("connecting");
      await preparePeerConnection();
      if (isInitiator) await createAndSendOffer();
      break;
    case "offer":
      await receiveOffer(message.data);
      break;
    case "answer":
      await receiveAnswer(message.data);
      break;
    case "ice":
      await receiveIceCandidate(message.data);
      break;
    case "peer-left":
      isInitiator = message.isInitiator === true;
      closePeerConnection();
      clearChat();
      setStatus("waiting");
      break;
    case "error":
      showError(message.message || "The signaling server reported an error.");
      setStatus("disconnected");
      sourceSocket.close();
      break;
    default:
      showError("Received an unknown message from the signaling server.");
  }
}

function sendSignal(type, data) {
  if (!socket || socket.readyState !== WebSocket.OPEN) {
    showError("The signaling connection was lost.");
    return;
  }
  socket.send(JSON.stringify({ type, data }));
}

async function preparePeerConnection() {
  if (peerConnection) return;
  if (!localStream) throw new Error("Camera and microphone are not ready.");

  const connection = new RTCPeerConnection(rtcConfiguration);
  peerConnection = connection;
  pendingIceCandidates = [];

  for (const track of localStream.getTracks()) {
    const sender = connection.addTrack(track, localStream);
    if (track.kind === "video") currentVideoSender = sender;
  }

  connection.addEventListener("icecandidate", (event) => {
    if (event.candidate && peerConnection === connection) {
      sendSignal("ice", event.candidate.toJSON());
    }
  });
  connection.addEventListener("track", (event) => {
    const [remoteStream] = event.streams;
    if (remoteStream) {
      remoteVideo.srcObject = remoteStream;
      remotePlaceholder.hidden = true;
    }
  });
  connection.addEventListener("connectionstatechange", () => {
    if (peerConnection !== connection) return;
    if (connection.connectionState === "connected") {
      setStatus("connected");
    } else if (connection.connectionState === "disconnected" ||
               connection.connectionState === "failed" ||
               connection.connectionState === "closed") {
      setStatus("disconnected");
    }
  });

  if (isInitiator) {
    setDataChannel(connection.createDataChannel("private-chat"));
  } else {
    connection.addEventListener("datachannel", (event) => setDataChannel(event.channel));
  }
}

async function createAndSendOffer() {
  if (!peerConnection) return;
  const offer = await peerConnection.createOffer();
  await peerConnection.setLocalDescription(offer);
  sendSignal("offer", peerConnection.localDescription);
}

async function receiveOffer(offer) {
  if (!peerConnection) await preparePeerConnection();
  await peerConnection.setRemoteDescription(offer);
  await flushPendingIceCandidates();
  const answer = await peerConnection.createAnswer();
  await peerConnection.setLocalDescription(answer);
  sendSignal("answer", peerConnection.localDescription);
}

async function receiveAnswer(answer) {
  if (!peerConnection) return;
  await peerConnection.setRemoteDescription(answer);
  await flushPendingIceCandidates();
}

async function receiveIceCandidate(candidate) {
  if (!peerConnection) return;
  if (peerConnection.remoteDescription) {
    await peerConnection.addIceCandidate(candidate);
  } else {
    pendingIceCandidates.push(candidate);
  }
}

async function flushPendingIceCandidates() {
  for (const candidate of pendingIceCandidates) {
    await peerConnection.addIceCandidate(candidate);
  }
  pendingIceCandidates = [];
}

function closePeerConnection() {
  if (dataChannel) {
    dataChannel.close();
    dataChannel = null;
  }
  if (peerConnection) {
    peerConnection.close();
    peerConnection = null;
  }
  currentVideoSender = null;
  pendingIceCandidates = [];
  remoteVideo.srcObject = null;
  remotePlaceholder.hidden = false;
  setChatEnabled(false);
}

function setDataChannel(channel) {
  dataChannel = channel;
  channel.addEventListener("open", () => setChatEnabled(true));
  channel.addEventListener("close", () => setChatEnabled(false));
  channel.addEventListener("message", (event) => {
    if (typeof event.data === "string") addChatMessage(event.data, false);
  });
  channel.addEventListener("error", () => {
    showError("The private chat connection encountered an error.");
  });
}

function setChatEnabled(enabled) {
  chatInput.disabled = !enabled;
  sendChatButton.disabled = !enabled;
  if (enabled) chatInput.focus();
}

function addChatMessage(text, isMine) {
  chatEmpty.hidden = true;
  const messageElement = document.createElement("div");
  messageElement.className = isMine ? "chat-message mine" : "chat-message";
  messageElement.textContent = text;
  chatMessages.append(messageElement);
  chatMessages.scrollTop = chatMessages.scrollHeight;
}

function clearChat() {
  for (const message of chatMessages.querySelectorAll(".chat-message")) {
    message.remove();
  }
  chatEmpty.hidden = false;
}

chatForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const text = chatInput.value.trim();
  if (!text || !dataChannel || dataChannel.readyState !== "open") return;
  dataChannel.send(text);
  addChatMessage(text, true);
  chatInput.value = "";
});

micButton.addEventListener("click", () => {
  const track = localStream?.getAudioTracks()[0];
  if (!track) return;
  track.enabled = !track.enabled;
  micButton.querySelector("span:last-child").textContent = track.enabled ? "Mute mic" : "Unmute mic";
});

cameraButton.addEventListener("click", () => {
  const track = cameraTrack;
  if (!track) return;
  track.enabled = !track.enabled;
  cameraButton.querySelector("span:last-child").textContent = track.enabled ? "Turn camera off" : "Turn camera on";
});

shareScreenButton.addEventListener("click", async () => {
  if (screenTrack) {
    try {
      await stopScreenShare();
    } catch (error) {
      showError(error.message || "Could not stop screen sharing.");
    }
    return;
  }
  let selectedScreenTrack = null;
  try {
    const displayStream = await navigator.mediaDevices.getDisplayMedia({ video: true });
    selectedScreenTrack = displayStream.getVideoTracks()[0];
    if (!selectedScreenTrack) throw new Error("No screen was selected.");
    if (currentVideoSender) await currentVideoSender.replaceTrack(selectedScreenTrack);
    if (cameraTrack) localStream.removeTrack(cameraTrack);
    localStream.addTrack(selectedScreenTrack);
    screenTrack = selectedScreenTrack;
    localVideo.srcObject = localStream;
    shareScreenButton.querySelector("span:last-child").textContent = "Stop sharing";
    selectedScreenTrack.addEventListener("ended", () => {
      stopScreenShare().catch((error) => showError(error.message || "Could not stop screen sharing."));
    }, { once: true });
  } catch (error) {
    selectedScreenTrack?.stop();
    if (error.name !== "NotAllowedError") showError(error.message || "Could not share your screen.");
  }
});

async function stopScreenShare() {
  if (!screenTrack) return;
  const oldScreenTrack = screenTrack;
  screenTrack = null;
  try {
    if (currentVideoSender && cameraTrack) {
      await currentVideoSender.replaceTrack(cameraTrack);
    }
  } finally {
    localStream?.removeTrack(oldScreenTrack);
    if (cameraTrack && localStream) localStream.addTrack(cameraTrack);
    oldScreenTrack.stop();
    localVideo.srcObject = localStream;
    shareScreenButton.querySelector("span:last-child").textContent = "Share screen";
  }
}

async function updateDeviceLists() {
  const devices = await navigator.mediaDevices.enumerateDevices();
  updateDeviceSelect(microphoneSelect, devices.filter((device) => device.kind === "audioinput"), "Default microphone");
  updateDeviceSelect(cameraSelect, devices.filter((device) => device.kind === "videoinput"), "Default camera");

  const audioId = localStream?.getAudioTracks()[0]?.getSettings().deviceId;
  const videoId = cameraTrack?.getSettings().deviceId;
  if (audioId) microphoneSelect.value = audioId;
  if (videoId) cameraSelect.value = videoId;
}

function updateDeviceSelect(select, devices, defaultLabel) {
  const currentValue = select.value;
  select.replaceChildren(new Option(defaultLabel, ""));
  devices.forEach((device, index) => {
    select.add(new Option(device.label || `Device ${index + 1}`, device.deviceId));
  });
  if ([...select.options].some((option) => option.value === currentValue)) {
    select.value = currentValue;
  }
}

microphoneSelect.addEventListener("change", () => switchDevice("audio", microphoneSelect.value));
cameraSelect.addEventListener("change", () => switchDevice("video", cameraSelect.value));

async function switchDevice(kind, deviceId) {
  const constraints = {
    audio: kind === "audio" ? (deviceId ? { deviceId: { exact: deviceId } } : true) : false,
    video: kind === "video" ? (deviceId ? { deviceId: { exact: deviceId } } : true) : false
  };

  try {
    const replacementStream = await navigator.mediaDevices.getUserMedia(constraints);
    const replacementTrack = kind === "audio"
      ? replacementStream.getAudioTracks()[0]
      : replacementStream.getVideoTracks()[0];
    if (!replacementTrack) throw new Error(`The selected ${kind} device could not be started.`);

    const oldTrack = kind === "audio"
      ? localStream.getAudioTracks()[0]
      : cameraTrack;
    replacementTrack.enabled = oldTrack?.enabled ?? true;
    if (kind === "audio") {
      localStream.removeTrack(oldTrack);
      localStream.addTrack(replacementTrack);
    } else {
      if (screenTrack) {
        cameraTrack = replacementTrack;
        await stopScreenShare();
      } else {
        localStream.removeTrack(oldTrack);
        localStream.addTrack(replacementTrack);
        cameraTrack = replacementTrack;
        localVideo.srcObject = localStream;
      }
    }

    const sender = peerConnection?.getSenders().find((item) => item.track?.kind === kind);
    if (sender) await sender.replaceTrack(replacementTrack);
    oldTrack?.stop();
    for (const track of replacementStream.getTracks()) {
      if (track !== replacementTrack) track.stop();
    }
    await updateDeviceLists();
  } catch (error) {
    showError(getUserMediaError(error));
  }
}

async function hangUp() {
  if (socket) {
    const oldSocket = socket;
    socket = null;
    oldSocket.close();
  }
  closePeerConnection();
  stopLocalMedia();
  clearChat();
  setStatus("disconnected");
  setMediaControlsEnabled(false);
  hangupButton.disabled = true;
  createRoomButton.disabled = false;
}

hangupButton.addEventListener("click", hangUp);

function stopLocalMedia() {
  if (screenTrack) {
    screenTrack.stop();
    screenTrack = null;
  }
  if (localStream) {
    localStream.getTracks().forEach((track) => track.stop());
    localStream = null;
  }
  cameraTrack?.stop();
  cameraTrack = null;
  localVideo.srcObject = null;
  micButton.querySelector("span:last-child").textContent = "Mute mic";
  cameraButton.querySelector("span:last-child").textContent = "Turn camera off";
  shareScreenButton.querySelector("span:last-child").textContent = "Share screen";
}

window.addEventListener("pagehide", () => {
  if (socket) socket.close();
  closePeerConnection();
  stopLocalMedia();
});
