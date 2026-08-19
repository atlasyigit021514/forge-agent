const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];
let config, history = [], busy = false, waitingForInput = false, waitingInputSecret = false, shellId = null, shellPoll = null, activeSessionId = localStorage.getItem("forge.activeSession"), eventCursor = 0, eventStream = null;

async function api(url, options = {}) {
  const response = await fetch(url, { headers: { "content-type": "application/json" }, ...options });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
  return data;
}

function toast(text, bad = false) {
  const el = $("#toast"); el.textContent = text; el.style.borderColor = bad ? "#733" : "#46503f"; el.classList.add("show");
  setTimeout(() => el.classList.remove("show"), 2800);
}

function showView(name) {
  $$(".view,.nav").forEach((el) => el.classList.remove("active"));
  $(`#${name}`).classList.add("active"); $(`.nav[data-view='${name}']`).classList.add("active");
  if (name === "memory") loadMemories(); if (name === "skills") loadSkills();
  if (name === "terminal") resumeShell();
}

function fillSettings() {
  const p=config.provider,a=config.agent,c=config.context,co=config.compaction,o=config.optimization;
  const k=o.tokenKernel,v=o.contextVirtualMemory,d=o.deduplicateToolResults,g=o.graphify,s=o.semanticToolCompression;
  $("#providerName").value=p.name||"";$("#baseUrl").value=p.baseUrl;$("#apiKey").value=p.apiKey;$("#model").value=p.model;$("#maxRetries").value=p.maxRetries??3;$("#retryBaseMs").value=p.retryBaseMs??750;$("#includeUsage").checked=Boolean(p.includeUsage);
  $("#name").value = config.agent.name; $("#systemPrompt").value = config.agent.systemPrompt; $("#maxTurns").value = config.agent.maxTurns; $("#temperature").value = config.agent.temperature; $("#workspace").value = config.workspace;
  const thinkingMode = config.agent.thinkingMode || "none"; $("#thinkingMode").value = thinkingMode; $("#thinkingQuick").value = thinkingMode;
  $("#kernelEnabled").checked=Boolean(k.enabled);$("#kernelEntries").value=k.maxLedgerEntries;$("#kernelArgChars").value=k.ledgerArgChars;$("#kernelPreviewChars").value=k.ledgerPreviewChars;$("#kernelPrompt").value=k.prompt||"";$("#kernelState").textContent=k.enabled?"Enabled · bounded context active":"Disabled · normal context mode";
  $("#maxRecentMessages").value=c.maxRecentMessages;$("#maxToolResultChars").value=c.maxToolResultChars;$("#maxOutputChars").value=c.maxOutputChars;$("#memoryTopK").value=c.memoryTopK;$("#memoryMaxItemChars").value=c.memoryMaxItemChars;
  $("#compactionEnabled").checked=Boolean(co.enabled);$("#compactionThreshold").value=co.thresholdTokens;$("#compactionKeepRecent").value=co.keepRecent;$("#compactionSummaryTokens").value=co.maxSummaryTokens;
  $("#cvmEnabled").checked=Boolean(v.enabled);$("#cvmMinChars").value=v.minChars;$("#cvmPageChars").value=v.pageChars;$("#cvmPreviewChars").value=v.previewChars;$("#cvmMaxSessionChars").value=v.maxSessionChars;
  $("#dedupEnabled").checked=Boolean(d.enabled);$("#dedupMinChars").value=d.minChars;$("#graphifyEnabled").checked=Boolean(g.enabled);$("#graphifyCommand").value=g.command;$("#graphifyTimeout").value=g.timeoutMs;
  $("#compressionEnabled").checked=Boolean(s.enabled);$("#compressionEndpoint").value=s.endpoint||"";$("#compressionApiKey").value=s.apiKey||"";$("#compressionMinChars").value=s.minChars;$("#compressionRatio").value=s.targetRatio;$("#compressionTimeout").value=s.timeoutMs;$("#compressionFailOpen").checked=Boolean(s.failOpen);
  $("#agentName").textContent = config.agent.name; $("#providerLabel").textContent = config.provider.model || "Not configured";
}

const numberValue = (id) => Number($(id).value);

async function saveSettings() {
  config=await api("/api/config",{method:"PUT",body:JSON.stringify({
    provider:{name:$("#providerName").value,baseUrl:$("#baseUrl").value,apiKey:$("#apiKey").value,model:$("#model").value,maxRetries:numberValue("#maxRetries"),retryBaseMs:numberValue("#retryBaseMs"),includeUsage:$("#includeUsage").checked},
    agent:{name:$("#name").value,systemPrompt:$("#systemPrompt").value,maxTurns:numberValue("#maxTurns"),temperature:numberValue("#temperature"),thinkingMode:$("#thinkingMode").value},
    workspace:$("#workspace").value,
    compaction:{enabled:$("#compactionEnabled").checked,thresholdTokens:numberValue("#compactionThreshold"),keepRecent:numberValue("#compactionKeepRecent"),maxSummaryTokens:numberValue("#compactionSummaryTokens")},
    context:{maxRecentMessages:numberValue("#maxRecentMessages"),maxToolResultChars:numberValue("#maxToolResultChars"),maxOutputChars:numberValue("#maxOutputChars"),memoryTopK:numberValue("#memoryTopK"),memoryMaxItemChars:numberValue("#memoryMaxItemChars")},
    optimization:{
      tokenKernel:{enabled:$("#kernelEnabled").checked,maxLedgerEntries:numberValue("#kernelEntries"),ledgerArgChars:numberValue("#kernelArgChars"),ledgerPreviewChars:numberValue("#kernelPreviewChars"),prompt:$("#kernelPrompt").value},
      contextVirtualMemory:{enabled:$("#cvmEnabled").checked,minChars:numberValue("#cvmMinChars"),pageChars:numberValue("#cvmPageChars"),previewChars:numberValue("#cvmPreviewChars"),maxSessionChars:numberValue("#cvmMaxSessionChars")},
      deduplicateToolResults:{enabled:$("#dedupEnabled").checked,minChars:numberValue("#dedupMinChars")},
      graphify:{enabled:$("#graphifyEnabled").checked,command:$("#graphifyCommand").value,timeoutMs:numberValue("#graphifyTimeout")},
      semanticToolCompression:{enabled:$("#compressionEnabled").checked,endpoint:$("#compressionEndpoint").value,apiKey:$("#compressionApiKey").value,minChars:numberValue("#compressionMinChars"),targetRatio:numberValue("#compressionRatio"),timeoutMs:numberValue("#compressionTimeout"),failOpen:$("#compressionFailOpen").checked}
    }
  })});
  fillSettings();toast("Settings saved");return config;
}

function esc(text) { const d=document.createElement("div"); d.textContent=text; return d.innerHTML; }
function addMessage(role, content) {
  $(".welcome")?.remove(); const el=document.createElement("div"); el.className=`message ${role}`;
  el.innerHTML=`<div class="role">${role.toUpperCase()}</div>${esc(content)}`; $("#feed").append(el); $("#feed").scrollTop=$("#feed").scrollHeight;
}
function addAssistantDelta(data) {
  $(".welcome")?.remove(); let el=$(`.message.assistant[data-turn="${data.turn}"]`);
  if(!el){el=document.createElement("div");el.className="message assistant";el.dataset.turn=data.turn;el.innerHTML='<div class="role">ASSISTANT · STREAMING</div><span class="stream-content"></span>';$("#feed").append(el)}
  el.querySelector(".stream-content").textContent+=data.content;$("#feed").scrollTop=$("#feed").scrollHeight;
}
function finishAssistant(data) {
  const el=$(`.message.assistant[data-turn="${data.turn}"]`);
  if(el){el.querySelector(".role").textContent="ASSISTANT";el.querySelector(".stream-content").textContent=data.content;return}
  addMessage("assistant",data.content);
}
function addTool(data, result) {
  const el=document.createElement("details"); el.className="tool"; const payload=result?.error || result?.result || data.args;
  el.innerHTML=`<summary>${result ? (result.error?"×":"✓") : "→"} ${esc(data.name)}</summary><pre>${esc(JSON.stringify(payload,null,2))}</pre>`; $("#feed").append(el);
}
function setRunStatus(status, message) {
  const box=$("#runStatus"); box.className=`run-status ${status}`; box.querySelector("span").textContent=message||status; $("#activityText").textContent=message||status;
  const active=["queued","running","waiting","stopping"].includes(status); waitingForInput=status==="waiting"; $("#stopRun").hidden=!active; busy=active; $(".send").disabled=active&&!waitingForInput;
  $("#prompt").placeholder=waitingForInput?"Type the requested code or answer to resume this task…":"Ask Forge to build or operate…";
}
function addProgress(data) { const el=document.createElement("div");el.className=`progress-line ${data.phase||""}`;el.textContent=data.message;$("#feed").append(el);$("#feed").scrollTop=$("#feed").scrollHeight; }
function handleEvent(e) {
  eventCursor=Math.max(eventCursor,e.index+1);
  if(e.type==="assistant_delta") addAssistantDelta(e.data);
  if(e.type==="assistant") { e.data.streamed?finishAssistant(e.data):addMessage("assistant",e.data.content); history.push({role:"assistant",content:e.data.content}); }
  if(e.type==="tool_request") addTool(e.data);
  if(e.type==="tool_result") addTool({name:e.data.name},e.data);
  if(e.type==="progress") addProgress(e.data);
  if(e.type==="input_request") { waitingInputSecret=Boolean(e.data.secret); addProgress({phase:"waiting",message:`Input needed: ${e.data.prompt}`}); }
  if(e.type==="input_received") { waitingForInput=false; waitingInputSecret=false; addProgress({phase:"tool",message:e.data.deliveredToShell?"Input delivered to the running command":"Input received; task resumed"}); }
  if(e.type==="error") { addProgress({phase:"retry",message:e.data.message}); toast(e.data.message,true); }
  if(e.type==="status") { setRunStatus(e.data.status,e.data.message); if(e.data.status==="waiting") fetchSession(); if(["completed","failed","cancelled","limit"].includes(e.data.status)){eventStream?.close();eventStream=null;localStorage.removeItem("forge.activeSession");} }
}
async function fetchSession() { if(!activeSessionId)return; try{const session=await api(`/api/sessions/${activeSessionId}?after=${eventCursor}`);session.events.forEach(handleEvent);waitingInputSecret=Boolean(session.pending?.secret);setRunStatus(session.status,session.pending?.prompt||session.status);}catch(e){localStorage.removeItem("forge.activeSession");activeSessionId=null;} }
function connectEvents() {
  eventStream?.close(); if(!activeSessionId)return;
  eventStream=new EventSource(`/api/sessions/${activeSessionId}/events?after=${eventCursor}`);
  eventStream.onmessage=(message)=>handleEvent(JSON.parse(message.data));
  eventStream.onerror=()=>{eventStream?.close();eventStream=null;if(busy)setTimeout(()=>{fetchSession();connectEvents()},1200)};
}
async function send(text) {
  if(!text.trim())return;
  if(waitingForInput&&activeSessionId){const shown=waitingInputSecret?"••••••••":text;addMessage("user",shown);$("#prompt").value="";setRunStatus("queued","Sending input to the waiting task");try{await api(`/api/sessions/${activeSessionId}/input`,{method:"POST",body:JSON.stringify({input:text})});connectEvents()}catch(e){addMessage("assistant",`Error: ${e.message}`);setRunStatus("waiting","Input is still required")}return}
  if(busy)return; busy=true; addMessage("user",text); history.push({role:"user",content:text}); $("#prompt").value="";
  setRunStatus("queued","Starting autonomous run");
  try { const session=await api("/api/chat",{method:"POST",body:JSON.stringify({message:text,history:history.slice(0,-1)})}); activeSessionId=session.id;eventCursor=0;localStorage.setItem("forge.activeSession",activeSessionId);connectEvents(); }
  catch(e){addMessage("assistant",`Error: ${e.message}`);setRunStatus("failed","Failed to start")}
}

async function loadMemories() {
  const items=await api("/api/memories"); $("#memoryList").innerHTML=items.length?items.map(m=>`<div><button class="danger" data-forget="${m.id}">Forget</button><div>${esc(m.text)}</div><small>${esc(m.tags.join(", "))} · ${new Date(m.createdAt).toLocaleString()}</small></div>`).join(""):"<p>No memories saved yet. Ask the agent to remember something.</p>";
  $$('[data-forget]').forEach(b=>b.onclick=async()=>{await api(`/api/memories/${b.dataset.forget}`,{method:"DELETE"});loadMemories()});
}
async function loadSkills(){const items=await api("/api/skills");$("#skillList").innerHTML=items.length?items.map(s=>`<div><strong>${esc(s.name)}</strong><br><small>${esc(s.description)}</small></div>`).join(""):"<p>No skills installed.</p>"}

function appendTerminal(text) { if (!text) return; const output=$("#terminalOutput"); if(output.textContent==="Start a shell to begin.") output.textContent=""; output.textContent+=text; output.scrollTop=output.scrollHeight; }
async function pollShell() { if(!shellId)return; try { const result=await api(`/api/shells/${shellId}/read`); appendTerminal(result.output); if(!result.running){appendTerminal(`\n[process exited: ${result.exitCode}]\n`);clearInterval(shellPoll);shellPoll=null;} } catch(e){clearInterval(shellPoll);shellPoll=null;} }
function beginPolling(){if(shellPoll)clearInterval(shellPoll);shellPoll=setInterval(pollShell,350);pollShell()}
async function resumeShell(){if(shellId){beginPolling();return}try{const sessions=await api("/api/shells");const active=sessions.find(s=>s.running);if(active){shellId=active.id;beginPolling()}}catch{}}
$("#newShell").onclick=async()=>{try{const result=await api("/api/shells",{method:"POST",body:"{}"});shellId=result.id;$("#terminalOutput").textContent="";beginPolling();$("#terminalInput").focus()}catch(e){toast(e.message,true)}};
$("#terminalForm").onsubmit=async e=>{e.preventDefault();const input=$("#terminalInput").value;if(!shellId){toast("Start a shell first",true);return}appendTerminal(`PS › ${input}\n`);$("#terminalInput").value="";try{await api(`/api/shells/${shellId}/write`,{method:"POST",body:JSON.stringify({input})});pollShell()}catch(err){toast(err.message,true)}};
$("#stopShell").onclick=async()=>{if(!shellId)return;try{await api(`/api/shells/${shellId}/stop`,{method:"POST",body:"{}"});pollShell()}catch(e){toast(e.message,true)}};

$$('.nav').forEach(b=>b.onclick=()=>showView(b.dataset.view));
$$('.suggestions button').forEach(b=>b.onclick=()=>send(b.textContent));
$("#composer").onsubmit=e=>{e.preventDefault();send($("#prompt").value)};
$("#prompt").onkeydown=e=>{if(e.key==="Enter"&&!e.shiftKey){e.preventDefault();send(e.target.value)}};
$("#stopRun").onclick=async()=>{if(!activeSessionId)return;try{await api(`/api/sessions/${activeSessionId}/cancel`,{method:"POST",body:"{}"});setRunStatus("stopping","Stopping safely")}catch(e){toast(e.message,true)}};
$("#clearChat").onclick=()=>{if(busy){toast("Stop the active run first",true);return}history=[];eventCursor=0;activeSessionId=null;localStorage.removeItem("forge.activeSession");$("#feed").innerHTML='<div class="welcome"><div class="orb">✦</div><h2>Fresh session.</h2><p>What are we building?</p></div>';setRunStatus("idle","Ready")};
$("#saveSettings").onclick=()=>saveSettings().catch(e=>toast(e.message,true));
$("#reloadConfig").onclick=async()=>{try{config=await api("/api/config/reload",{method:"POST",body:"{}"});fillSettings();toast("Config reloaded from disk")}catch(e){toast(e.message,true)}};
$("#thinkingQuick").onchange=async()=>{try{config=await api("/api/config",{method:"PUT",body:JSON.stringify({agent:{thinkingMode:$("#thinkingQuick").value}})});$("#thinkingMode").value=$("#thinkingQuick").value;toast(`Thinking mode: ${$("#thinkingQuick").value}`)}catch(e){toast(e.message,true)}};
$("#testProvider").onclick=async()=>{try{$("#testResult").textContent="Testing…";await saveSettings();const r=await api("/api/provider/test",{method:"POST"});$("#testResult").textContent=r.response||"Connected"}catch(e){$("#testResult").textContent=e.message}};
$("#downloadSkill").onclick=async()=>{try{await api("/api/skills/download",{method:"POST",body:JSON.stringify({name:$("#skillName").value,url:$("#skillUrl").value})});toast("Skill installed");loadSkills()}catch(e){toast(e.message,true)}};

config=await api("/api/config"); fillSettings(); if(activeSessionId){await fetchSession();connectEvents()}
