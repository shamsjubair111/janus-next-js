import styles from "./page.module.css";

export default function Home() {


    // const janusUrl = 'wss://103.209.42.30/';
    const janusUrl = 'wss://janus.hobenaki.com/';
    let ws = null;
    let sessionId = null;
    let handleId = null;
    let pc = null;
    let localStream = null;

    // Generates a unique transaction ID for Janus requests.
    function generateTxnId(prefix = 'txn') {
      return `${prefix}-${Math.random().toString(36).substring(2, 12)}`;
    }

    function startKeepAlive() {
setInterval(() => {
  if (ws && ws.readyState === WebSocket.OPEN && sessionId) {
    const keepalive = {
      janus: "keepalive",
      session_id: sessionId,
      transaction: generateTxnId("keepalive")
    };
    console.log("Sending keepalive...");
    ws.send(JSON.stringify(keepalive));
  }
}, 25000); // Every 25 seconds
}


    // Connects to the Janus server, creates a session, attaches the videocall plugin,
    // and sends a registration message with the provided username.
    function connectJanus(username) {
      ws = new WebSocket(janusUrl, 'janus-protocol');

      ws.onopen = function() {
        console.log("Connected to Janus server.");
        const createSession = { janus: 'create', transaction: generateTxnId('create') };
        ws.send(JSON.stringify(createSession));
      };

      ws.onmessage = async function(event) {
const message = JSON.parse(event.data);
console.log("Received from Janus:", message);

if (message.janus === 'success' && message.data?.id && !sessionId) {
  sessionId = message.data.id;
  console.log("Created session:", sessionId);
  startKeepAlive();
  const attach = {
    janus: 'attach',
    plugin: 'janus.plugin.videocall',
    session_id: sessionId,
    transaction: generateTxnId('attach')
  };
  ws.send(JSON.stringify(attach));
} else if (message.janus === 'success' &&
           message.transaction?.startsWith('attach') &&
           message.data?.id &&
           sessionId && !handleId) {
  handleId = message.data.id;
  console.log("Plugin attached. Handle ID:", handleId);
  const register = {
    janus: 'message',
    session_id: sessionId,
    handle_id: handleId,
    transaction: generateTxnId('register'),
    body: { request: 'register', username: username }
  };
  ws.send(JSON.stringify(register));
} else if (message.janus === 'event' &&
           message.plugindata?.data?.result === 'ok' &&
           message.plugindata.data.username === username) {
  console.log(`Successfully registered as ${username}`);
  document.getElementById("status").innerText = `Registered as ${username}`;
  await startLocalVideo();
} else if (message.janus === 'event' && message.plugindata?.data?.videocall === 'event') {
  if (message.plugindata.data.result.event === 'incomingcall') {
    const caller = message.plugindata.data.result.username;
    if (confirm(`Incoming call from ${caller}. Answer?`)) {
      if (!localStream) {
        await startLocalVideo();
      }
      await handleRemoteOffer(message.jsep);
    } else {
      ws.send(JSON.stringify({
        janus: 'message',
        session_id: sessionId,
        handle_id: handleId,
        transaction: generateTxnId('hangup'),
        body: { request: 'hangup' }
      }));
    }
  } else if (message.plugindata.data.result.event === 'accepted') {
    if (message.jsep) {
      await pc.setRemoteDescription(new RTCSessionDescription(message.jsep));
    }
    else {
  console.warn("⚠️ 'accepted' event received but no jsep found!");
}

  } else if (message.plugindata.data.result.event === 'hangup') {
    alert("The call has ended.");
    if (pc) pc.close();
  }
} else if (message.janus === 'webrtcup') {
  console.log("Call established!");
} else if (message.janus === 'error') {
  console.error("Error from Janus:", message.error);
  document.getElementById("status").innerText = `Error: ${message.error.reason || 'Unknown error'}`;
}
};


      ws.onerror = function(err) {
        console.error("WebSocket error:", err);
        document.getElementById("status").innerText = `WebSocket error: ${err.message}`;
      };

      ws.onclose = function() {
        console.log("Disconnected from Janus server.");
        document.getElementById("status").innerText = "Disconnected from Janus server.";
      };
    }

    // Requests access to the local video and audio, then displays it in the local video element.
    async function startLocalVideo() {
      try {
        localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
        console.log("Local stream obtained:", localStream);
        document.getElementById("localvideo").srcObject = localStream;
        // Log details of each track added to the local stream
        localStream.getTracks().forEach(track => {
          console.log(`Local track added: ${track.kind} (${track.label})`);
        });
      } catch (err) {
        console.error("Error accessing local media:", err);
        document.getElementById("status").innerText = "Error accessing local media.";
      }
    }

    // Creates a new RTCPeerConnection and sets up event listeners for tracks, ICE candidates, and data channel events.
    function createPeerConnection() {
      const pc = new RTCPeerConnection();

      // Create a default data channel and log its events
      try {
        const dataChannel = pc.createDataChannel("default");
        console.log("Creating default data channel:", dataChannel);
        dataChannel.onopen = function() {
          console.log("Data channel opened");
        };
        dataChannel.onmessage = function(e) {
          console.log("Data channel message:", e.data);
        };
      } catch (err) {
        console.error("Error creating data channel:", err);
      }

      // Handle remote track reception
      pc.ontrack = function(event) {
        console.log("Remote track received:", event.streams[0]);
        document.getElementById("remotevideo").srcObject = event.streams[0];
      };

      // Handle ICE candidates
      pc.onicecandidate = function(event) {
        if (event.candidate) {
          console.log("ICE candidate:", event.candidate);
          ws.send(JSON.stringify({
            janus: 'trickle',
            session_id: sessionId,
            handle_id: handleId,
            candidate: event.candidate,
            transaction: generateTxnId('trickle')
          }));
        } else {
          console.log("ICE gathering completed");
          }
      };

      // Additional event logging for debugging
      pc.onnegotiationneeded = function() {
        console.log("Negotiation needed");
      };
      pc.onconnectionstatechange = function() {
        console.log("Connection state change:", pc.connectionState);
      };
      pc.onicegatheringstatechange = function() {
        console.log("ICE gathering state change:", pc.iceGatheringState);
      };

      return pc;
    }

    // Initiates a call to the specified peer username by creating an offer.
    // Initiates a call to the specified peer username by creating an offer.
async function callUser(peerUsername) {
if (!localStream) {
  console.warn("Local stream not initialized. Attempting to start now...");
  await startLocalVideo();

  // If still not available after trying
  if (!localStream) {
    console.error("Failed to access local stream for call.");
    document.getElementById("status").innerText = "Cannot start call: no local media available.";
    return;
  }
}

pc = createPeerConnection();

localStream.getTracks().forEach(track => {
  console.log("Adding local track:", track);
  pc.addTrack(track, localStream);
});

console.log("Creating offer (iceDone=false)");
const offer = await pc.createOffer();
await pc.setLocalDescription(offer);

pc.getTransceivers().forEach(t => {
console.log(`Caller Transceiver for ${t.sender.track?.kind}: direction = ${t.direction}`);
});

pc.getTransceivers().forEach(transceiver => {
  console.log(`Transceiver for ${transceiver.sender.track.kind} set to direction: ${transceiver.direction}`);
});

ws.send(JSON.stringify({
  janus: 'message',
  session_id: sessionId,
  handle_id: handleId,
  transaction: generateTxnId('call'),
  body: { request: 'call', username: peerUsername },
  jsep: offer
}));
}


    // Handles the remote offer by setting the remote description,
    // creating an answer, and then setting the local description.
    async function handleRemoteOffer(jsep) {
if (!localStream) {
  console.warn("Local stream not available, initializing...");
  await startLocalVideo();
}

pc = createPeerConnection();
localStream.getTracks().forEach(track => {
  console.log("Adding local track for remote offer:", track);
  pc.addTrack(track, localStream);
});

console.log("Setting remote description with incoming offer.");
await pc.setRemoteDescription(new RTCSessionDescription(jsep));

const answer = await pc.createAnswer();
await pc.setLocalDescription(answer);

pc.getTransceivers().forEach(t => {
  console.log(`Transceiver for ${t.sender.track?.kind}: direction = ${t.direction}`);
});

console.log("✅ Sending answer JSEP with accept request");
ws.send(JSON.stringify({
  janus: 'message',
  session_id: sessionId,
  handle_id: handleId,
  transaction: generateTxnId('accept'),
  body: { request: 'accept' },
  jsep: answer   // ✅ required!
}));
}

    // Ends an active call.
    function hangupCall() {
      ws.send(JSON.stringify({
        janus: 'message',
        session_id: sessionId,
        handle_id: handleId,
        transaction: generateTxnId('hangup'),
        body: { request: 'hangup' }
      }));
      if (pc) pc.close();
      console.log("Call hung up, peer connection closed.");
    }

    // Set up event listeners when the DOM is fully loaded.
    document.addEventListener("DOMContentLoaded", function() {
      document.getElementById("registerBtn").addEventListener("click", function() {
        let username = document.getElementById("username").value.trim();
        if (!username) {
          username = "user-" + Math.random().toString(36).substr(2, 8);
          document.getElementById("username").value = username;
        }
        connectJanus(username);
      });

      document.getElementById("callBtn").addEventListener("click", function() {
        const peerUsername = document.getElementById("callUser").value.trim();
        if (!peerUsername) {
          alert("Please enter the peer's username to call.");
          return;
        }
        callUser(peerUsername);
      });

      document.getElementById("hangupBtn").addEventListener("click", function() {
        hangupCall();
      });
    });
  

  return (
    <div className={styles?.page}>
        <h2>Register to VideoCall</h2>
  <input type="text" id="username" placeholder="Enter username (or leave blank for random)" />
  <button id="registerBtn">Register</button>
  <div id="status"></div>

  <div>
    <video id="localvideo" autoPlay muted style={{width: "200px"}}></video>
    <video id="remotevideo" autoPlay style={{width: "200px"}}></video>
  </div>

  <div>
    <input type="text" id="callUser" placeholder="Peer username"/>
    <button id="callBtn">Call User</button>
    <button id="hangupBtn">Hang Up</button>
  </div>
    </div>
  );
}
