// server.js — proxy som anropar Assistant-API:t (Retrieval v2, med sidnummer)
import express from "express";
import fetch   from "node-fetch";
import * as dotenv from "dotenv";
dotenv.config();

const { OPENAI_API_KEY, ASSISTANT_ID, PORT = 3000 } = process.env;
if (!OPENAI_API_KEY || !ASSISTANT_ID) {
  console.error("Saknar OPENAI_API_KEY eller ASSISTANT_ID i .env");
  process.exit(1);
}

const app = express();
app.use(express.json());

/* -------- hjälpfunktioner -------- */

/* vänta tills run är klar */
async function waitForRun(threadId, runId) {
  while (true) {
    const res = await fetch(
      `https://api.openai.com/v1/threads/${threadId}/runs/${runId}`,
      { headers:{ Authorization:`Bearer ${OPENAI_API_KEY}`,"OpenAI-Beta":"assistants=v2"} }
    );
    if (!res.ok) throw new Error(`RUN-fel ${res.status}: ${await res.text()}`);
    const run = await res.json();
    if (run.status === "completed") return;
    if (["cancelled","failed","expired"].includes(run.status))
      throw new Error(`Run ${run.status}: ${run.last_error?.message || "okänt fel"}`);
    await new Promise(r => setTimeout(r, 800));
  }
}

/* hämta filnamn */
async function getFileLabel(file_id){
  const r = await fetch(`https://api.openai.com/v1/files/${file_id}`,{
    headers:{ Authorization:`Bearer ${OPENAI_API_KEY}` }
  });
  if(!r.ok) return `fil-${file_id.slice(-6)}`;
  const f = await r.json();
  return f.filename.replace(/\.pdf$/i,"");
}

/* hämta sidnummer (om chunk-id finns) */
async function getPageNumber(file_id, chunk_id){
  if(!chunk_id) return "?";
  const r = await fetch(
    `https://api.openai.com/v1/files/${file_id}/content?chunk_id=${chunk_id}`,
    { headers:{ Authorization:`Bearer ${OPENAI_API_KEY}` } }
  ).catch(()=>null);
  if(!r || !r.ok) return "?";
  const c = await r.json();
  return c.page_range?.start ?? c.page_number ?? "?";
}

/* -------- endpoint -------- */
app.post("/api/chat", async (req,res)=>{
  try{
    const fråga = req.body.question?.trim();
    if(!fråga) return res.status(400).json({error:"Ingen fråga skickades"});

    /* 1. skapa thread */
    const thread = await fetch("https://api.openai.com/v1/threads",{
      method:"POST",
      headers:{
        "Content-Type":"application/json",
        Authorization:`Bearer ${OPENAI_API_KEY}`,
        "OpenAI-Beta":"assistants=v2"
      },
      body:JSON.stringify({messages:[{role:"user",content:fråga}]})
    }).then(r=>r.json());

    /* 2. starta run */
    const run = await fetch(
      `https://api.openai.com/v1/threads/${thread.id}/runs`,
      {
        method:"POST",
        headers:{
          "Content-Type":"application/json",
          Authorization:`Bearer ${OPENAI_API_KEY}`,
          "OpenAI-Beta":"assistants=v2"
        },
        body:JSON.stringify({assistant_id:ASSISTANT_ID})
      }
    ).then(r=>r.json());

    await waitForRun(thread.id, run.id);

    /* 3. hämta run-steps för chunk-id → page */
    const steps = await fetch(
      `https://api.openai.com/v1/threads/${thread.id}/runs/${run.id}/steps`,
      { headers:{ Authorization:`Bearer ${OPENAI_API_KEY}`,"OpenAI-Beta":"assistants=v2"} }
    ).then(r=>r.json());

    const chunkMap = {}; // { file_id : första chunk_id }
    for(const s of steps.data){
      const fc = s.step_details?.tool_calls?.[0]?.file_citation;
      if(fc && !chunkMap[fc.file_id]) chunkMap[fc.file_id] = fc.file_chunk_id;
    }

    /* 4. hämta assistantsvaret */
    const msgs = await fetch(
      `https://api.openai.com/v1/threads/${thread.id}/messages`,
      { headers:{ Authorization:`Bearer ${OPENAI_API_KEY}`,"OpenAI-Beta":"assistants=v2"} }
    ).then(r=>r.json());

    const assistantMsg = msgs.data.find(m=>m.role==="assistant");
    if(!assistantMsg) throw new Error("Inget assistantsvar");

    const textBlocks = assistantMsg.content.filter(c=>c.type==="text");
    let   svar       = textBlocks.map(t=>t.text.value).join("\n\n");

    /* 5. bygg annotationer */
    const annRaw = textBlocks.flatMap(t=>t.text.annotations || [])
      .filter(a=>a.type==="file_citation");

    const annotations = await Promise.all(
      annRaw.map(async a=>{
        const fid = a.file_citation.file_id;
        const cid = chunkMap[fid];
        const label = await getFileLabel(fid);
        const page  = await getPageNumber(fid,cid);
        return { file_id:fid, label, page, token:a.text };
      })
    );

    /* 6. ersätt token → [Fil s.X] eller [Fil] */
    annotations.forEach(a=>{
      const nice = a.page === "?"
  ? ` [${a.label}]`              // ← leder med mellanslag
  : ` [${a.label} s.${a.page}]`; // ← samma här

      svar = svar.split(a.token).join(nice);
    });

    /* 7. skicka */
    res.set("Access-Control-Allow-Origin","*");
    res.json({ content:svar, citations:annotations });

  }catch(err){
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

/* statiska filer */
app.use(express.static("./"));
app.listen(PORT,()=>console.log(`Proxy lyssnar på http://localhost:${PORT}`));
