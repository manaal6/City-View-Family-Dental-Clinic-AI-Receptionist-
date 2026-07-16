import express from "express";
import http from "http";
import https from "https";
import { WebSocketServer } from "ws";
import WebSocket from "ws";
import dotenv from "dotenv";
import Groq from "groq-sdk";
import path from "path";
import { fileURLToPath } from "url";
import fs from "fs";

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

const envPath = path.join(__dirname, ".env");
if (fs.existsSync(envPath)) {
  dotenv.config({ path: envPath });
  console.log(`✅  Loaded .env from: ${envPath}`);
} else {
  console.error(`❌  .env file NOT found at: ${envPath}`);
  process.exit(1);
}

const clinic = JSON.parse(fs.readFileSync(path.join(__dirname, "clinic.json"), "utf8"));

const DEEPGRAM_API_KEY = process.env.DEEPGRAM_API_KEY;
const GROQ_API_KEY     = process.env.GROQ_API_KEY;
const VOICE            = process.env.VOICE || "aura-asteria-en";
const PORT             = process.env.PORT  || 3000;

if (!DEEPGRAM_API_KEY || DEEPGRAM_API_KEY === "your_deepgram_api_key_here") {
  console.error("❌  DEEPGRAM_API_KEY missing"); process.exit(1);
}
if (!GROQ_API_KEY || GROQ_API_KEY === "your_groq_api_key_here") {
  console.error("❌  GROQ_API_KEY missing"); process.exit(1);
}

const groq = new Groq({ apiKey: GROQ_API_KEY });

const app    = express();
const server = http.createServer(app);
const wss    = new WebSocketServer({ server, path: "/ws" });

app.use(express.static(path.join(__dirname)));
app.get("/", (_req, res) => res.sendFile(path.join(__dirname, "index.html")));
const LEADS_FILE = path.join(__dirname, 'leads.json');

app.get('/api/clinic', (_req, res) => res.json(clinic));

app.get('/api/leads', (_req, res) => {
  try {
    const data = fs.existsSync(LEADS_FILE)
      ? JSON.parse(fs.readFileSync(LEADS_FILE, 'utf8')) : [];
    res.json(Array.isArray(data) ? data : []);
  } catch { res.json([]); }
});

// ─── TTS with connection keep-alive agent (reuses TCP connection) ─────────────
const httpsAgent = new https.Agent({ keepAlive: true, maxSockets: 6 });

function ttsAudioBase64(text) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ text });
    const req  = https.request({
      hostname: "api.deepgram.com",
      path:     `/v1/speak?model=${VOICE}&encoding=linear16&container=wav`,
      method:   "POST",
      agent:    httpsAgent,
      headers: {
        "Authorization":  `Token ${DEEPGRAM_API_KEY}`,
        "Content-Type":   "application/json",
        "Content-Length": Buffer.byteLength(body),
      },
    }, (res) => {
      if (res.statusCode !== 200) {
        let e = ""; res.on("data", d => e += d);
        res.on("end", () => reject(new Error(`TTS ${res.statusCode}: ${e}`))); return;
      }
      const chunks = [];
      res.on("data", c => chunks.push(c));
      res.on("end",  () => resolve(Buffer.concat(chunks).toString("base64")));
      res.on("error", reject);
    });
    req.on("error", reject); req.write(body); req.end();
  });
}

// ─── Sentence splitter ────────────────────────────────────────────────────────
function splitSentences(text) {
  const parts = []; let last = 0;
  const re = /([.!?])\s+/g; let m;
  while ((m = re.exec(text)) !== null) {
    const chunk = text.slice(last, m.index + 1).trim();
    if (chunk.length > 2) parts.push(chunk);
    last = m.index + m[0].length;
  }
  const tail = text.slice(last).trim();
  if (tail.length > 2) parts.push(tail);
  return parts.length ? parts : [text.trim()];
}

// ─── Handle one user turn ─────────────────────────────────────────────────────
async function handleUserTurn(ws, text, history, speakingRef) {
  if (!text?.trim()) return;
  console.log(`  👤 User : ${text}`);
  history.push({ role: "user", content: text });
  safeSend(ws, { type: "user_transcript", text });

  try {
    const t0 = Date.now();

    const stream = await groq.chat.completions.create({
      model:       "llama-3.1-8b-instant",
      stream:      true,
      max_tokens:  180,
      temperature: 0.7,
      messages: [
        {
          role: "system",
          content: `You are ${clinic.name}, the AI Reception Agent for ${clinic.name} in ${clinic.location} (${clinic.website}).
Speak warmly, professionally, and naturally — like a real, friendly front-desk receptionist on the phone.

CLINIC FACTS (use only if relevant/asked):
- ${clinic.practices}
- Phone: ${clinic.phone}. Also bookable via WhatsApp.
- Hours: ${clinic.hours}.
- Services: ${clinic.services}.
- ${clinic.offer}
- ${clinic.rating}

Follow this call flow STRICTLY in order. Do NOT skip any step.

STEP 1 — Greeting (first message only)
Greet warmly, introduce yourself as receptionist from ${clinic.name} in ${clinic.location}. Max 2 sentences.

STEP 2 — Understand the Need
Ask: "What can I help you with today — are you looking to book an appointment, or do you have a question about a treatment?"

STEP 3 — Follow-up
Ask ONE follow-up question to understand what treatment or concern they have (e.g. check-up, hygiene, whitening, emergency, implants, etc).

STEP 4 — Collect Name
Ask for their name naturally if not already given.

STEP 5 — Collect Phone Number
Ask: "Could I also grab your phone number so our team can confirm your appointment?"
WAIT for a numeric response. Do NOT proceed until you have received an actual phone number.
If they do not give a number, ask again politely. Never assume or invent a number.

STEP 6 — Confirm
Read back: name, phone number, and the treatment/service they need — all three. Keep it to 2 sentences.

STEP 7 — Close
Thank them and say someone from the team will be in touch soon to confirm their appointment.

STRICT RULES:
- Maximum 2 sentences per reply. Never longer.
- NEVER say you have a phone number unless the caller explicitly said one in this conversation.
- Never quote exact prices beyond any stated offer unless asked — offer to have the team confirm pricing.
- Never output JSON, bullet points, or markdown.
- Never break character.
- Plain spoken language only.
- If asked something off-topic, gently steer back to booking or their dental needs.`,
        },
        ...history,
      ],
    });

    let fullReply  = "";
    let buffer     = "";
    let ttsChain   = Promise.resolve();
    let idx        = 0;
    let firstToken = true;

    // FIX 1: Mark Aura as speaking so STT ignores mic input during playback
    speakingRef.active = true;

    const flush = (force = false) => {
      const sentences = splitSentences(buffer);
      const toSend    = force ? sentences : sentences.slice(0, -1);
      const leftover  = force ? "" : (sentences[sentences.length - 1] || "");

      for (const s of toSend) {
        if (!s) continue;
        const i    = idx++;
        const text = s;

        ttsChain = ttsChain.then(async () => {
          try {
            if (i === 0) console.log(`  ⚡ First audio in ${Date.now() - t0}ms`);
            const audio = await ttsAudioBase64(text);
            safeSend(ws, { type: "ai_audio", audio, idx: i });
            console.log(`  🔊 TTS[${i}] sent (${Date.now() - t0}ms total)`);
          } catch (e) { console.error(`  ❌ TTS[${i}]:`, e.message); }
        });
      }
      buffer = leftover;
    };

    for await (const chunk of stream) {
      const token = chunk.choices[0]?.delta?.content ?? "";
      if (!token) continue;
      if (firstToken) {
        console.log(`  ⚡ First token in ${Date.now() - t0}ms`);
        firstToken = false;
      }
      fullReply += token;
      buffer    += token;
      if (/[.!?]\s/.test(buffer)) flush();
    }

    if (buffer.trim()) flush(true);
    await ttsChain;

    // FIX 1: Aura finished speaking — re-enable STT
    speakingRef.active = false;

    const reply = fullReply.trim();
    console.log(`  🤖 Aura : ${reply} (${Date.now() - t0}ms total)`);
    history.push({ role: "assistant", content: reply });
    safeSend(ws, { type: "ai_text", text: reply });

    // ── Push lead to Google Sheets — only when phone was actually collected ─────
    const lowerReply = reply.toLowerCase();
    const isClosing  =
      (lowerReply.includes("someone") && lowerReply.includes("follow")) ||
      (lowerReply.includes("team") && lowerReply.includes("touch")) ||
      lowerReply.includes("have a great day") ||
      lowerReply.includes("have a good day");
    if (isClosing) {
      const lead = extractLead(history);
      if (lead.name && lead.phone && !history._leadPushed) {
        history._leadPushed = true;
        await pushLeadToSheets(lead, history);
      } else if (!history._leadPushed) {
        console.log(`  ⚠️  Call closed but lead incomplete — name:"${lead.name}" phone:"${lead.phone}" — NOT pushed`);
      }
    }

  } catch (err) {
    speakingRef.active = false; // always reset even on error
    console.error("  ❌ handleUserTurn:", err.message);
    safeSend(ws, { type: "ai_text", text: "Sorry, something went wrong." });
  }
}

function safeSend(ws, payload) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(payload));
}

// ─── Google Sheets Lead Capture ───────────────────────────────────────────────
const SHEETS_WEBHOOK = process.env.SHEETS_WEBHOOK_URL;

async function pushLeadToSheets(lead, history) {
const leadsArr = fs.existsSync(LEADS_FILE)
  ? JSON.parse(fs.readFileSync(LEADS_FILE, 'utf8')) : [];
leadsArr.push({ ...lead, timestamp: new Date().toISOString(), completed: true, duration: Math.round((Date.now() - (history._callStart || Date.now())) / 1000) });
fs.writeFileSync(LEADS_FILE, JSON.stringify(leadsArr, null, 2));
  if (!SHEETS_WEBHOOK) return;
  try {
    await fetch(SHEETS_WEBHOOK, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify(lead),
    });
    console.log("  📋 Lead pushed to Google Sheets:", lead.name);
  } catch (err) {
    console.error("  ❌ Sheets push failed:", err.message);
  }
}

function extractLead(history) {
  const wordToDigit = {
    zero:"0", one:"1", two:"2", three:"3", four:"4",
    five:"5", six:"6", seven:"7", eight:"8", nine:"9"
  };

  const userMsgs      = history.filter(m => m.role === "user");
  const assistantMsgs = history.filter(m => m.role === "assistant");
  const userText      = userMsgs.map(m => m.content).join(" ");
  const assistantText = assistantMsgs.map(m => m.content).join(" ");

  // ── Name — case-insensitive, STT gives lowercase ──────────────────────────
  const nameMatch =
    userText.match(/(?:my\s+name\s+is|i['\u2019]?m|this\s+is|call\s+me|i\s+am)\s+([a-zA-Z]+(?:\s+[a-zA-Z]+)?)/i) ||
    userText.match(/\bhi\.?\s+i['\u2019]?m\s+([a-zA-Z]+)/i) ||
    userMsgs[0]?.content.match(/\bi['\u2019]?m\s+([a-zA-Z]+)/i) ||
    // Last resort: scan all assistant messages for a name they addressed the user by
    assistantMsgs.map(m => m.content.match(/\b(?:hello|hi|thanks?|thank you)[,.]?\s+([A-Z][a-z]+)/i)?.[1]).filter(Boolean).pop();

  // ── Phone: convert spoken words → digits, then strip ALL non-digits and find
  //    the longest run of 7+ consecutive digits anywhere in the full user text.
  //    This handles "three three three four three five six seven six eight"
  //    regardless of punctuation/spaces between chunks. ────────────────────────
  const normalisedUser = userText.replace(
    /\b(zero|one|two|three|four|five|six|seven|eight|nine)\b/gi,
    w => wordToDigit[w.toLowerCase()]
  );
  // Collapse all digit sequences into one long string, then find 7+ digit runs
  const digitsOnly   = normalisedUser.replace(/[^0-9]/g, " ").trim();
  // Find all runs of 7 or more consecutive digits
  const digitMatches = digitsOnly.match(/[0-9]{7,}/g) || [];
  // Also try PK-style full number
  const pkMatch      = normalisedUser.match(/(?:\+92[\s-]?|0)[0-9]{9,10}/);

  // Prefer longest digit run (most complete number), fall back to PK match
  const bestDigitRun = digitMatches.sort((a, b) => b.length - a.length)[0] || "";
  const phoneRaw     = pkMatch?.[0]?.replace(/\D/g, "") || bestDigitRun;

// ── Notes: AI's step-6 confirmation line ──────────────────────────────────────
  const confirmMsg = [...assistantMsgs].reverse().find(m =>
    /\d{4,}/.test(m.content.replace(/\b(zero|one|two|three|four|five|six|seven|eight|nine)\b/gi, d => wordToDigit[d.toLowerCase()]))
  );

  // ── Service ───────────────────────────────────────────────────────────────────
  const serviceFromConfirm = confirmMsg?.content.match(
    /(?:inquir(?:ing|ed)\s+about|looking\s+for|interested\s+in|regarding|about\s+(?:prices?\s+for)?|you\s+(?:were|are)\s+(?:looking\s+for|interested\s+in))\s+(?:prices?\s+(?:for|on)\s+)?([^,.!?\n]{3,60})/i
  );
  const serviceFromUser = userText.match(
    /(?:i\s+want(?:\s+to\s+(?:know|buy|get|purchase))?(?:\s+about)?(?:\s+the\s+prices?\s+of)?|i\s+need|looking\s+for|buy|get|purchase|know\s+about(?:\s+the\s+prices?\s+of)?)\s+(?:a\s+|your\s+)?([^,.!?\n]{3,60})/i
  );
  const service = (serviceFromConfirm?.[1] || serviceFromUser?.[1] || "").replace(/\s+/g, " ").trim();

  // Capitalise first letter of each word in name (STT gives lowercase)
  const rawName = (typeof nameMatch === "string" ? nameMatch : nameMatch?.[1])?.trim() || "";
  const name    = rawName.replace(/\b\w/g, c => c.toUpperCase());

  return {
    name,
    phone:   phoneRaw                  || "",
    service: service || "",
    notes:   confirmMsg?.content?.trim() || "",
  };
}

// ─── Raw WebSocket STT ────────────────────────────────────────────────────────
function createSTTSession(clientWs, history, processingRef, speakingRef, sessionRef) {
  let dgWs           = null;
  let keepAlive      = null;
  let shouldRun      = true;
  let reconnectTimer = null;
  let audioQueue     = [];
  let finalBuffer    = "";      // FIX 3: scoped per session, resets on reconnect
  let silenceTimer   = null;    // fallback flush when speech_final never arrives
  let reconnectDelay = 1000;

  const DG_URL =
    'wss://api.deepgram.com/v1/listen' +
    '?model=nova-2' +
    '&language=en-US' +
    '&encoding=linear16' +
    '&sample_rate=16000' +
    '&channels=1' +
    '&punctuate=true' +
    '&interim_results=true' +
    '&endpointing=300';

  function connect() {
    if (!shouldRun) return;
    finalBuffer = "";   // FIX 3: clear buffer on every reconnect
    if (silenceTimer) { clearTimeout(silenceTimer); silenceTimer = null; }
    console.log("  🟡 Deepgram STT: connecting…");

    dgWs = new WebSocket(DG_URL, {
      headers: { Authorization: `Token ${DEEPGRAM_API_KEY}` },
    });

    dgWs.on("open", () => {
      console.log("  🟢 Deepgram STT open ✔");
      reconnectDelay = 1000;

      if (audioQueue.length > 0) {
        console.log(`  📤 Flushing ${audioQueue.length} queued audio frames`);
        audioQueue.forEach(frame => dgWs.send(frame));
        audioQueue = [];
      }

      keepAlive = setInterval(() => {
        if (dgWs && dgWs.readyState === 1) {
          dgWs.send(JSON.stringify({ type: "KeepAlive" }));
        }
      }, 8000);
    });

    dgWs.on("message", async (raw) => {
      let data;
      try { data = JSON.parse(raw.toString()); } catch { return; }
      if (data.type !== "Results") return;

      const transcript = data.channel?.alternatives?.[0]?.transcript?.trim();
      if (!transcript) return;

      if (!data.is_final) {
        // FIX 1: Don't forward interim transcripts while Aura is speaking
        if (!speakingRef.active) {
          safeSend(clientWs, { type: "interim_transcript", text: transcript });
        }
        return;
      }

      // FIX 1: Completely ignore is_final results while Aura is speaking
      // This prevents the mic picking up TTS audio and feeding it back as user input
      if (speakingRef.active) return;

      // Accumulate is_final chunks — fixes short phrases dropped & long phrases truncated
      finalBuffer = (finalBuffer + " " + transcript).trim();

      // Clear any pending silence timer — we just got fresh text
      if (silenceTimer) { clearTimeout(silenceTimer); silenceTimer = null; }

      const flush = async () => {
        silenceTimer = null;
        if (!finalBuffer || processingRef.active) return;
        const utterance = finalBuffer;
        finalBuffer = "";
        processingRef.active = true;
        try   { await handleUserTurn(clientWs, utterance, history, speakingRef); }
        finally { processingRef.active = false; }
      };

      if (data.speech_final) {
        await flush();
      } else {
        // Fallback: if speech_final never arrives, flush after 600ms of silence
        silenceTimer = setTimeout(flush, 600);
      }
    });

    dgWs.on("error", (err) => {
      console.error("  ❌ STT WebSocket error:", err.message);
      if (err.message.includes("ENOTFOUND") || err.message.includes("ECONNREFUSED")) {
        reconnectDelay = Math.min(reconnectDelay * 2, 16000);
        console.log(`  ⏳ DNS failure — retrying in ${reconnectDelay / 1000}s`);
      }
    });

    dgWs.on("close", (code, reason) => {
      clearInterval(keepAlive);
      const msg = reason?.toString() || "";
      console.log(`  🔴 Deepgram STT closed (code ${code}${msg ? ": " + msg : ""})`);
      if (shouldRun && code !== 1000) {
        if (code === 1008) { shouldRun = false; return; }
        reconnectTimer = setTimeout(connect, reconnectDelay);
      }
    });
  }

  sessionRef.send = (data) => {
    // FIX 1: Drop audio frames while Aura is speaking (suppress mic echo)
    if (speakingRef.active) return;
    if (dgWs && dgWs.readyState === 1) {
      dgWs.send(data);
    } else if (shouldRun) {
      audioQueue.push(data);
      if (audioQueue.length > 200) audioQueue.shift();
    }
  };

  sessionRef.stop = () => {
    shouldRun = false;
    audioQueue = [];
    finalBuffer = "";
    if (silenceTimer) { clearTimeout(silenceTimer); silenceTimer = null; }
    clearInterval(keepAlive);
    clearTimeout(reconnectTimer);
    if (dgWs) { try { dgWs.close(1000, "mic stopped"); } catch (_) {} dgWs = null; }
    console.log("  🎙️  Mic stopped — STT session closed");
  };

  connect();
}

// ─── WebSocket handler ────────────────────────────────────────────────────────
wss.on("connection", (ws) => {
  console.log("\n📞 Client connected");
  const history       = [];
  const processingRef = { active: false };
  const speakingRef   = { active: false };
  const sessionRef    = {};
  history._callStart  = Date.now();

  createSTTSession(ws, history, processingRef, speakingRef, sessionRef);
  let sttActive = true;

  ws.on("message", async (data, isBinary) => {
    if (isBinary) {
      sessionRef.send?.(data);
      return;
    }
    try {
      const msg = JSON.parse(data.toString());
      switch (msg.type) {
        case "user_message":
          if (msg.text?.trim() && !processingRef.active) {
            processingRef.active = true;
            try   { await handleUserTurn(ws, msg.text.trim(), history, speakingRef); }
            finally { processingRef.active = false; }
          }
          break;
        case "start_mic":
          if (!sttActive) {
            createSTTSession(ws, history, processingRef, speakingRef, sessionRef);
            sttActive = true;
          }
          break;
        case "stop_mic":
          sessionRef.stop?.();
          sttActive = false;
          break;
      }
    } catch (e) { console.warn("  ⚠️  Parse error:", e.message); }
  });

  ws.on("close", () => { console.log("📵 Client disconnected"); sessionRef.stop?.(); });
  ws.on("error", (e) => console.error("  ❌ WS error:", e.message));
});

server.listen(PORT, () => {
  console.log(`\n✅  Aura AI Agent running → http://localhost:${PORT}`);
  console.log(`   WebSocket endpoint   → ws://localhost:${PORT}/ws`);
  console.log(`   Voice model          → ${VOICE}\n`);
});
