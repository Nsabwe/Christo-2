// relay.js - simple WebSocket relay/hub
// Run: node relay.js  (or node relay.js 8080)
const WebSocket = require('ws');
const { v4: uuidv4 } = require('uuid');

const PORT = process.argv[2] || 8080;
const wss = new WebSocket.Server({ port: PORT });
console.log(`Relay server listening on ws://0.0.0.0:${PORT}`);

//
// Protocol (JSON messages):
// 1) Phone (provider) connects and sends: { type: "register", role: "phone", id: "<phone-id>", token: "<secret>" }
// 2) Friend (client) connects and sends: { type: "register", role: "client", target: "<phone-id>", token: "<secret>" }
// 3) Client sends proxy request: { type: "proxy_req", reqId: "<uuid>", method:"GET", url: "...", headers: {...}, body: "<base64>" }
// 4) Server forwards proxy_req to the target phone. Phone performs HTTP and replies with { type:"proxy_res", reqId: "...", status:200, headers:{}, body:"<base64>" }
// 5) Server forwards proxy_res back to client.
// (Very small, single phone <-> many clients)
//

const phones = new Map(); // phoneId -> { ws, token }
wss.on('connection', (ws) => {
  ws.isAlive = true;
  ws.on('pong', () => ws.isAlive = true);

  ws.on('message', (msg) => {
    let data;
    try { data = JSON.parse(msg); } catch(e) { return ws.send(JSON.stringify({error:"bad-json"})); }

    if (data.type === 'register') {
      if (data.role === 'phone' && data.id && data.token) {
        phones.set(data.id, { ws, token: data.token });
        ws._role = 'phone'; ws._id = data.id;
        ws.send(JSON.stringify({ ok:true, msg:"phone registered" }));
        console.log(`Phone registered: ${data.id}`);
        return;
      }
      if (data.role === 'client' && data.target && data.token) {
        ws._role = 'client'; ws._target = data.target; ws._token = data.token;
        // Check if phone exists and token matches
        const p = phones.get(data.target);
        if (!p || p.token !== data.token) {
          ws.send(JSON.stringify({ ok:false, error:"target_not_found_or_bad_token" }));
          ws.close();
          return;
        }
        ws.send(JSON.stringify({ ok:true, msg:"client registered" }));
        console.log(`Client connected for target ${data.target}`);
        return;
      }
      ws.send(JSON.stringify({ ok:false, error:"invalid_register" }));
      return;
    }

    // proxy request from client -> phone
    if (data.type === 'proxy_req') {
      // validate
      if (ws._role !== 'client' || !ws._target) {
        return ws.send(JSON.stringify({ error:"not_registered_as_client" }));
      }
      const phone = phones.get(ws._target);
      if (!phone || phone.token !== ws._token) {
        return ws.send(JSON.stringify({ error:"target_not_available" }));
      }
      // forward to phone
      try {
        phone.ws.send(JSON.stringify(data));
        // store map to route responses back: attach ws reference
        if (!ws._requests) ws._requests = new Map();
        ws._requests.set(data.reqId, ws); // key->client ws
      } catch(e) {
        ws.send(JSON.stringify({ error:"failed_forward" }));
      }
      return;
    }

    // proxy response from phone -> server -> client
    if (data.type === 'proxy_res') {
      if (ws._role !== 'phone') return;
      // find the client waiting for this reqId
      // naive search: loop clients
      wss.clients.forEach((c) => {
        if (c._role === 'client' && c._target === ws._id && c._requests && c._requests.has(data.reqId)) {
          try { c.send(JSON.stringify(data)); c._requests.delete(data.reqId); }
          catch(e) {}
        }
      });
      return;
    }

    // other messages
    ws.send(JSON.stringify({ ok:false, error:"unknown_type" }));
  });

  ws.on('close', () => {
    if (ws._role === 'phone' && ws._id) {
      phones.delete(ws._id);
      console.log(`Phone disconnected: ${ws._id}`);
    }
  });
});

// simple heartbeat
setInterval(() => {
  wss.clients.forEach((ws) => {
    if (!ws.isAlive) return ws.terminate();
    ws.isAlive = false; ws.ping();
  });
}, 30000);