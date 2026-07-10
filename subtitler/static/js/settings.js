const WHISPER_MODEL_PRESETS = [
  { value: "large-v3", label: "large-v3 — default, any language" },
  { value: "medium", label: "medium — faster, weaker" },
  { value: "kotoba-tech/kotoba-whisper-v2.0-faster", label: "kotoba-whisper v2.0 — Japanese only, ~6× faster" },
];

function openSettingsModal() {
  const root = document.getElementById("settings-root");
  root.innerHTML = `
    <div class="settings-modal-backdrop" id="settings-backdrop">
      <div class="settings-modal">
        <h2>Settings</h2>
        <div class="field"><span class="flab">LLM base URL</span>
          <input type="text" class="fval" id="s-llm-base-url"></div>
        <div class="field"><span class="flab">LLM API key</span>
          <input type="text" class="fval" id="s-llm-api-key"></div>
        <div class="field"><span class="flab">LLM model</span>
          <input type="text" class="fval" id="s-llm-model"></div>
        <div class="field">
          <button class="btn btn-quiet btn-sm" id="s-test-btn">Test connection</button>
          <div class="test-msg" id="s-test-msg"></div>
        </div>
        <hr class="rule" style="margin: 16px 0;">
        <div class="field"><span class="flab">ASR engine</span>
          <select class="fval" id="s-asr-engine">
            <option value="faster-whisper">faster-whisper</option>
            <option value="stable-ts">stable-ts (better timestamps on music/BGM)</option>
          </select></div>
        <div class="field"><span class="flab">Whisper model</span>
          <select class="fval" id="s-whisper-model">
            ${WHISPER_MODEL_PRESETS.map((p) => `<option value="${p.value}">${p.label}</option>`).join("")}
            <option value="__custom__">Custom…</option>
          </select>
          <input type="text" class="fval" id="s-whisper-model-custom" style="display:none; margin-top:6px;" placeholder="custom model name or HF repo">
        </div>
        <div class="two-col">
          <div class="field"><span class="flab">Default source lang</span><input type="text" class="fval" id="s-src-lang"></div>
          <div class="field"><span class="flab">Default target lang</span><input type="text" class="fval" id="s-tgt-lang"></div>
        </div>
        <div class="row-end">
          <button class="btn btn-quiet" id="s-cancel">Cancel</button>
          <button class="btn btn-primary" id="s-save">Save</button>
        </div>
      </div>
    </div>`;

  Api.get("/api/settings").then((s) => {
    document.getElementById("s-llm-base-url").value = s.llm_base_url;
    document.getElementById("s-llm-api-key").value = s.llm_api_key;
    document.getElementById("s-llm-model").value = s.llm_model;
    document.getElementById("s-asr-engine").value = s.asr_engine;
    document.getElementById("s-src-lang").value = s.default_source_lang;
    document.getElementById("s-tgt-lang").value = s.default_target_lang;

    const sel = document.getElementById("s-whisper-model");
    const customInput = document.getElementById("s-whisper-model-custom");
    const preset = WHISPER_MODEL_PRESETS.find((p) => p.value === s.whisper_model);
    if (preset) {
      sel.value = s.whisper_model;
    } else {
      sel.value = "__custom__";
      customInput.style.display = "block";
      customInput.value = s.whisper_model;
    }
    sel.addEventListener("change", () => {
      customInput.style.display = sel.value === "__custom__" ? "block" : "none";
    });
  });

  document.getElementById("s-test-btn").addEventListener("click", async () => {
    const msg = document.getElementById("s-test-msg");
    msg.textContent = "Testing…";
    msg.className = "test-msg";
    await saveCurrentSettingsForm();
    try {
      const res = await Api.post("/api/settings/test", {});
      msg.textContent = res.message;
      msg.className = "test-msg " + (res.ok ? "ok" : "bad");
    } catch (e) {
      msg.textContent = String(e.message || e);
      msg.className = "test-msg bad";
    }
  });

  document.getElementById("s-cancel").addEventListener("click", closeSettingsModal);
  document.getElementById("settings-backdrop").addEventListener("click", (e) => {
    if (e.target.id === "settings-backdrop") closeSettingsModal();
  });
  document.getElementById("s-save").addEventListener("click", async () => {
    await saveCurrentSettingsForm();
    closeSettingsModal();
  });
}

async function saveCurrentSettingsForm() {
  const sel = document.getElementById("s-whisper-model");
  const whisperModel = sel.value === "__custom__" ? document.getElementById("s-whisper-model-custom").value : sel.value;
  await Api.put("/api/settings", {
    llm_base_url: document.getElementById("s-llm-base-url").value,
    llm_api_key: document.getElementById("s-llm-api-key").value,
    llm_model: document.getElementById("s-llm-model").value,
    asr_engine: document.getElementById("s-asr-engine").value,
    whisper_model: whisperModel,
    default_source_lang: document.getElementById("s-src-lang").value,
    default_target_lang: document.getElementById("s-tgt-lang").value,
  });
}

function closeSettingsModal() {
  document.getElementById("settings-root").innerHTML = "";
}

document.addEventListener("DOMContentLoaded", () => {
  const btn = document.getElementById("settings-btn");
  if (btn) btn.addEventListener("click", openSettingsModal);
});
