"use client";
import { useState, useRef, useEffect } from "react";
import styles from "./page.module.css";

export default function Home() {
  const [user, setUser] = useState("");
  const [peer, setPeer] = useState("");
  const [status, setStatus] = useState("");
  
  // Use refs for WebSocket and connection state
  const wsRef = useRef(null);
  const sessionIdRef = useRef(null);
  const handleIdRef = useRef(null);
  const pcRef = useRef(null);
  const localStreamRef = useRef(null);
  const keepAliveIntervalRef = useRef(null);

  // Clean up on unmount
  useEffect(() => {
    return () => {
      if (keepAliveIntervalRef.current) {
        clearInterval(keepAliveIntervalRef.current);
      }
      if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
        wsRef.current.close();
      }
      if (pcRef.current) {
        pcRef.current.close();
      }
    };
  }, []);

  function generateTxnId(prefix = 'txn') {
    return `${prefix}-${Math.random().toString(36).substring(2, 12)}`;
  }

  function startKeepAlive() {
    keepAliveIntervalRef.current = setInterval(() => {
      if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN && sessionIdRef.current) {
        const keepalive = {
          janus: "keepalive",
          session_id: sessionIdRef.current,
          transaction: generateTxnId("keepalive")
        };
        console.log("Sending keepalive...");
        wsRef.current.send(JSON.stringify(keepalive));
      }
    }, 25000);
  }

  function connectJanus(username) {
    // Close existing connection if any
    if (wsRef.current) {
      wsRef.current.close();
    }
    
    const janusUrl = 'wss://janus.hobenaki.com/';
    wsRef.current = new WebSocket(janusUrl, 'janus-protocol');

    wsRef.current.onopen = function() {
      console.log("Connected to Janus server.");
      const createSession = { janus: 'create', transaction: generateTxnId('create') };
      wsRef.current.send(JSON.stringify(createSession));
    };

    wsRef.current.onmessage = async function(event) {
      const message = JSON.parse(event.data);
      console.log("Received from Janus:", message);

      if (message.janus === 'success' && message.data?.id && !sessionIdRef.current) {
        sessionIdRef.current = message.data.id;
        console.log("Created session:", sessionIdRef.current);
        startKeepAlive();
        const attach = {
          janus: 'attach',
          plugin: 'janus.plugin.videocall',
          session_id: sessionIdRef.current,
          transaction: generateTxnId('attach')
        };
        wsRef.current.send(JSON.stringify(attach));
      } else if (message.janus === 'success' &&
                message.transaction?.startsWith('attach') &&
                message.data?.id &&
                sessionIdRef.current && !handleIdRef.current) {
        handleIdRef.current = message.data.id;
        console.log("Plugin attached. Handle ID:", handleIdRef.current);
        const register = {
          janus: 'message',
          session_id: sessionIdRef.current,
          handle_id: handleIdRef.current,
          transaction: generateTxnId('register'),
          body: { request: 'register', username: username }
        };
        wsRef.current.send(JSON.stringify(register));
      } else if (message.janus === 'event' &&
                message.plugindata?.data?.result === 'ok' &&
                message.plugindata.data.username === username) {
        console.log(`Successfully registered as ${username}`);
        setStatus(`Registered as ${username}`);
        await startLocalVideo();
      } else if (message.janus === 'event' && message.plugindata?.data?.videocall === 'event') {
        if (message.plugindata.data.result.event === 'incomingcall') {
          const caller = message.plugindata.data.result.username;
          if (confirm(`Incoming call from ${caller}. Answer?`)) {
            if (!localStreamRef.current) {
              await startLocalVideo();
            }
            await handleRemoteOffer(message.jsep);
          } else {
            wsRef.current.send(JSON.stringify({
              janus: 'message',
              session_id: sessionIdRef.current,
              handle_id: handleIdRef.current,
              transaction: generateTxnId('hangup'),
              body: { request: 'hangup' }
            }));
          }
        } else if (message.plugindata.data.result.event === 'accepted') {
          if (message.jsep) {
            await pcRef.current.setRemoteDescription(new RTCSessionDescription(message.jsep));
          } else {
            console.warn("⚠️ 'accepted' event received but no jsep found!");
          }
        } else if (message.plugindata.data.result.event === 'hangup') {
          alert("The call has ended.");
          if (pcRef.current) pcRef.current.close();
        }
      } else if (message.janus === 'webrtcup') {
        console.log("Call established!");
      } else if (message.janus === 'error') {
        console.error("Error from Janus:", message.error);
        setStatus(`Error: ${message.error.reason || 'Unknown error'}`);
      }
    };

    wsRef.current.onerror = function(err) {
      console.error("WebSocket error:", err);
      setStatus(`WebSocket error: ${err.message}`);
    };

    wsRef.current.onclose = function() {
      console.log("Disconnected from Janus server.");
      setStatus("Disconnected from Janus server.");
    };
  }

  async function startLocalVideo() {
    try {
      localStreamRef.current = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
      console.log("Local stream obtained:", localStreamRef.current);
      document.getElementById("localvideo").srcObject = localStreamRef.current;
      localStreamRef.current.getTracks().forEach(track => {
        console.log(`Local track added: ${track.kind} (${track.label})`);
      });
    } catch (err) {
      console.error("Error accessing local media:", err);
      setStatus("Error accessing local media.");
    }
  }

  function createPeerConnection() {
    const pc = new RTCPeerConnection();

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

    pc.ontrack = function(event) {
      console.log("Remote track received:", event.streams[0]);
      document.getElementById("remotevideo").srcObject = event.streams[0];
    };

    pc.onicecandidate = function(event) {
      if (event.candidate && wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
        console.log("ICE candidate:", event.candidate);
        wsRef.current.send(JSON.stringify({
          janus: 'trickle',
          session_id: sessionIdRef.current,
          handle_id: handleIdRef.current,
          candidate: event.candidate,
          transaction: generateTxnId('trickle')
        }));
      } else if (!event.candidate) {
        console.log("ICE gathering completed");
      }
    };

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

  async function callUser(peerUsername) {
    if (!localStreamRef.current) {
      console.warn("Local stream not initialized. Attempting to start now...");
      await startLocalVideo();

      if (!localStreamRef.current) {
        console.error("Failed to access local stream for call.");
        setStatus("Cannot start call: no local media available.");
        return;
      }
    }

    pcRef.current = createPeerConnection();

    localStreamRef.current.getTracks().forEach(track => {
      console.log("Adding local track:", track);
      pcRef.current.addTrack(track, localStreamRef.current);
    });

    console.log("Creating offer (iceDone=false)");
    const offer = await pcRef.current.createOffer();
    await pcRef.current.setLocalDescription(offer);

    pcRef.current.getTransceivers().forEach(t => {
      console.log(`Caller Transceiver for ${t.sender.track?.kind}: direction = ${t.direction}`);
    });

    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({
        janus: 'message',
        session_id: sessionIdRef.current,
        handle_id: handleIdRef.current,
        transaction: generateTxnId('call'),
        body: { request: 'call', username: peerUsername },
        jsep: offer
      }));
    } else {
      console.error("WebSocket is not connected");
      setStatus("Cannot make call: WebSocket disconnected");
    }
  }

  async function handleRemoteOffer(jsep) {
    if (!localStreamRef.current) {
      console.warn("Local stream not available, initializing...");
      await startLocalVideo();
    }

    pcRef.current = createPeerConnection();
    localStreamRef.current.getTracks().forEach(track => {
      console.log("Adding local track for remote offer:", track);
      pcRef.current.addTrack(track, localStreamRef.current);
    });

    console.log("Setting remote description with incoming offer.");
    await pcRef.current.setRemoteDescription(new RTCSessionDescription(jsep));

    const answer = await pcRef.current.createAnswer();
    await pcRef.current.setLocalDescription(answer);

    console.log("✅ Sending answer JSEP with accept request");
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({
        janus: 'message',
        session_id: sessionIdRef.current,
        handle_id: handleIdRef.current,
        transaction: generateTxnId('accept'),
        body: { request: 'accept' },
        jsep: answer
      }));
    } else {
      console.error("WebSocket is not connected");
      setStatus("Cannot answer call: WebSocket disconnected");
    }
  }

  function hangupCall() {
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({
        janus: 'message',
        session_id: sessionIdRef.current,
        handle_id: handleIdRef.current,
        transaction: generateTxnId('hangup'),
        body: { request: 'hangup' }
      }));
    }
    if (pcRef.current) pcRef.current.close();
    console.log("Call hung up, peer connection closed.");
  }

  const registerUser = () => {
    if (!user) {
      setStatus("Please enter a username");
      return;
    }
    connectJanus(user);
    console.log("UserName is: " + user);
  }

  const tryCall = () => {
    if (!peer) {
      setStatus("Please enter a peer username");
      return;
    }
    callUser(peer);
    console.log("peerName is: " + peer);
  }

  return (
    <div className={styles?.page}>
      <h2>Register to VideoCall</h2>
      <input type="text" id="username" onChange={(e) => setUser(e.target.value)} placeholder="Enter username" />
      <button id="registerBtn" onClick={registerUser}>Register</button>
      <div id="status">{status}</div>

      <div>
        <video id="localvideo" autoPlay muted style={{ width: "200px" }}></video>
        <video id="remotevideo" autoPlay style={{ width: "200px" }}></video>
      </div>

      <div>
        <input type="text" id="callUser" onChange={(e) => { setPeer(e.target.value) }} placeholder="Peer username" />
        <button id="callBtn" onClick={tryCall}>Call User</button>
        <button id="hangupBtn" onClick={hangupCall}>Hang Up</button>
      </div>
    </div>
  );
}