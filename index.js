/**
 * VRM Pet (Per Character) - SillyTavern Extension
 * - Upload a .vrm file to SillyTavern server via /api/files/upload
 * - Save the returned URL into the current character's extensions field
 * - Show a draggable floating placeholder (renderer can be added later)
 */

import { getContext } from "/scripts/extensions.js";
import { getStringHash } from "/scripts/utils.js";

// NOTE: Keep `?v=` in sync across local vendor modules to avoid duplicate module instances in the browser cache.
import { GLTFLoader } from "./vendor/GLTFLoader.js?v=2026012707";
import {
    VRMLoaderPlugin,
    VRMUtils,
} from "./vendor/three-vrm.module.js?v=2026012707";
import * as THREE from "./vendor/three.module.js?v=2026012707";

const MODULE_NAME = "vrm-pet";

// Base system prompt for the radial-menu "AI reply" button.
// Edit this template to tune tone/style. Keep it safe: don't try to disable model safety.
const PET_AI_SYSTEM_PROMPT_BASE = `
You are the VRM desktop-pet character in SillyTavern.
Stay in-character and reply as a chat message.

Style:
- Calm, cute, slightly playful.
- No meta talk (no "as an AI", no policy mentions).
- Prefer 1-3 short sentences unless the user clearly asked for more.
`.trim();

const PET_CHAT_MAX_MESSAGES = 80;

const DEFAULT_CONFIG = {
    enabled: true,
    maxVrmFileSizeMB: 80,
    showOverlay: true,
    overlayWidth: 240,
    overlayHeight: 240,
    // Show a rounded background/border behind the model.
    overlayFrameEnabled: false,
    // 0.0 - 0.9 (only used when overlayFrameEnabled=true)
    overlayFrameOpacity: 0.35,
    // Scales the loaded VRM model (relative).
    modelScale: 1.0,
    // Make the pet window wander around the desktop.
    wanderEnabled: true,
    // Pixels per second.
    wanderSpeed: 80,
    // Add a simple "walk in place" gait while the window is wandering.
    wanderGaitEnabled: true,
    // 0.0 - 2.0
    wanderGaitIntensity: 1.0,
    // Turn the model to a side-view while wandering (e.g. 45deg).
    wanderFaceEnabled: true,
    // 0 - 90
    wanderFaceAngleDeg: 45,
    // "Pick up" effect while dragging the overlay window.
    dragLiftEnabled: true,
    // Relative lift height = modelHeight * factor.
    dragLiftHeightFactor: 0.08,
    // Max tilt (deg) while dragging.
    dragLiftMaxTiltDeg: 10,
    // persisted per-user overlay position (in viewport px). If null, use bottom-right default.
    overlayPos: null,

    // -----------------------------
    // Desktop-pet interactions
    // -----------------------------
    headTrackEnabled: true,
    // Max yaw/pitch for head/neck tracking (deg). Keep small for cross-model compatibility.
    headTrackMaxYawDeg: 16,
    headTrackMaxPitchDeg: 10,

    // "Eye tracking": if the model doesn't support VRM lookAt, we approximate with tiny extra head/neck offsets.
    eyeTrackEnabled: true,
    eyeTrackMaxYawDeg: 6,
    eyeTrackMaxPitchDeg: 4,

    // Idle action scheduler: when no interactions for a while, play a random "cute" action.
    idleEnabled: true,
    idleMinMs: 6000,
    idleMaxMs: 12000,
    // Consider "relaxing" only when not wandering.
    idleOnlyWhenNotWandering: true,

    // Occasional blink even when idle.
    blinkEnabled: true,
    blinkMinMs: 3500,
    blinkMaxMs: 6500,

    // Head pat: click/tap near the head -> special action + hearts.
    patEnabled: true,
    patHeartCount: 7,
    // Head hit radius ~= modelHeight * factor (tuned for typical VRM proportions).
    patHeadRadiusFactor: 0.22,

    // Relaxed pose: lower arms when idle (some VRMs appear T-posed in this simplified renderer).
    relaxArmsEnabled: true,
    // Apply the same "relax arms" offsets during wander gait (walk-in-place).
    // This keeps the arms lowered while walking, while still allowing the gait swing to animate on top.
    relaxArmsDuringWanderGait: true,
    // Different VRMs use different local bone axes; provide a simple mode switch.
    // - "auto": pick best axis per model (recommended)
    // - "zroll": rotate around local Z (works for many T-pose rigs)
    // - "xpitch": rotate around local X (use if arms go "back" instead of down)
    relaxArmsMode: "auto",
    // How far to lower arms from a typical T-pose (deg).
    relaxArmsDownDeg: 55,
    // Pull arms slightly forward to avoid hands going inside the torso (deg).
    relaxArmsForwardDeg: 10,
    // Push arms slightly outward to avoid clipping (deg).
    relaxArmsOutDeg: 8,
    // Slight elbow bend (deg).
    relaxArmsElbowBendDeg: 16,

    // While dragging, add a "being picked up" pose on top of root lift/tilt.
    dragHeldPoseEnabled: true,
    // 0.0 - 2.0
    dragHeldPoseIntensity: 1.0,

    enableLogging: false,
};

let pluginConfig = {};

const vrmRenderState = {
    initialized: false,
    initPromise: null,
    renderer: null,
    scene: null,
    camera: null,
    clock: null,
    rafId: null,
    legGaitRafId: null,
    legGaitLastAt: 0,
    resizeObserver: null,
    currentVrm: null,
    currentUrl: "",
    loadingToken: 0,
    // Simple procedural "pet actions" (no external animation clips required).
    petAction: {
        active: null,
        t: 0,
        duration: 0,
        cooldownUntil: 0,
    },
    stageInteractionBound: false,
    actionTriggersBound: false,
    wander: {
        vx: 1,
        vy: 0,
        pausedUntil: 0,
        gaitTime: 0,
        faceYaw: 0,
    },
    dragLift: {
        active: false,
        lift: 0,
        targetLift: 0,
        tiltX: 0,
        tiltZ: 0,
        targetTiltX: 0,
        targetTiltZ: 0,
        time: 0,
    },

    // "Idle scheduler" + "blink scheduler" + interaction state.
    interaction: {
        lastAt: 0,
    },
    idle: {
        nextAt: 0,
    },
    blink: {
        nextAt: 0,
        active: false,
        t: 0,
        duration: 0.18,
    },

    // Facial expression + simple overlay effects.
    expressionFx: {
        // 'happy' | 'angry' | 'speechless' | 'blackface' | 'neutral' | null
        active: null,
        // ms timestamps (performance.now)
        startedAt: 0,
        until: 0,
        // 0..1
        strength: 0,
        // ms
        fadeInMs: 140,
        fadeOutMs: 220,
    },

    // Mouse tracking state (for head/eye follow).
    pointer: {
        bound: false,
        ndcX: 0,
        ndcY: 0,
        smoothX: 0,
        smoothY: 0,
        lastMoveAt: 0,
    },

    // Radial menu UI (right-click / long-press on the pet)
    ui: {
        menuOpen: false,
        chatOpen: false,
        editorOpen: false,
        emoteOpen: false,
        longPressTimer: null,
        longPressTriggered: false,
        longPressStart: null,
        bubbleToken: 0,
        bubbleHideTimer: null,
        bubbleRemoveTimer: null,
    },
};

function log(...args) {
    if (pluginConfig.enableLogging) console.log("[VRM Pet]", ...args);
}

function getCurrentCharacter() {
    const ctx = getContext();
    const chid = ctx.characterId;
    if (chid === undefined || chid === null) return null;
    return ctx.characters?.[chid] ?? null;
}

function getCharacterExtensionData(character) {
    // In ST, character data can exist in `character.data` and/or inside `character.json_data`.
    try {
        if (character?.data?.extensions?.[MODULE_NAME])
            return character.data.extensions[MODULE_NAME];
    } catch (_) {}

    try {
        if (character?.json_data) {
            const json = JSON.parse(character.json_data);
            return json?.data?.extensions?.[MODULE_NAME] ?? null;
        }
    } catch (_) {}

    return null;
}

function mergeDeep(base, patch) {
    const out = { ...(base && typeof base === "object" ? base : {}) };
    for (const [k, v] of Object.entries(patch || {})) {
        if (v && typeof v === "object" && !Array.isArray(v))
            out[k] = mergeDeep(out[k], v);
        else out[k] = v;
    }
    return out;
}

function initConfig() {
    const ctx = getContext();
    const existing = ctx.extensionSettings?.[MODULE_NAME] || {};
    pluginConfig = { ...DEFAULT_CONFIG, ...existing };
    ctx.extensionSettings[MODULE_NAME] = pluginConfig;
    ctx.saveSettingsDebounced();
    log("Config loaded", pluginConfig);
}

function ensureOverlay() {
    const ctx = getContext();
    let el = document.getElementById("vrm-pet-overlay");

    if (!pluginConfig.enabled || !pluginConfig.showOverlay) {
        if (el) el.remove();
        stopRenderLoop();
        return;
    }

    if (!el) {
        el = document.createElement("div");
        el.id = "vrm-pet-overlay";
        el.innerHTML = `
      <div class="vrm-pet-shell" title="Drag to move">
        <button class="vrm-pet-menu-btn" type="button" title="菜单">≡</button>
        <div class="vrm-pet-stage"></div>
        <div class="vrm-pet-hint" id="vrm-pet-hint">未加载模型<br/>可在设置里上传并绑定 VRM</div>
      </div>
    `;
        document.body.appendChild(el);
    }

    // Size
    el.style.width = `${Number(pluginConfig.overlayWidth) || 240}px`;
    el.style.height = `${Number(pluginConfig.overlayHeight) || 240}px`;

    // Position
    if (
        pluginConfig.overlayPos &&
        typeof pluginConfig.overlayPos.x === "number" &&
        typeof pluginConfig.overlayPos.y === "number"
    ) {
        el.style.left = `${pluginConfig.overlayPos.x}px`;
        el.style.top = `${pluginConfig.overlayPos.y}px`;
        el.style.right = "auto";
        el.style.bottom = "auto";
    } else {
        el.style.left = "auto";
        el.style.top = "auto";
        el.style.right = "14px";
        el.style.bottom = "14px";
    }

    bindOverlayDrag(el);
    bindOverlayMenuButton(el);

    // Frame (background/border) can be disabled for a "pure model" look.
    try {
        const shell = el.querySelector(".vrm-pet-shell");
        if (shell) {
            const enabled = !!pluginConfig.overlayFrameEnabled;
            const o = Number(pluginConfig.overlayFrameOpacity);
            const opacity = Number.isFinite(o) ? clamp(o, 0, 0.9) : 0.35;
            shell.style.background = enabled
                ? `rgba(0, 0, 0, ${opacity})`
                : "transparent";
            shell.style.border = enabled
                ? "1px solid rgba(255, 255, 255, 0.12)"
                : "none";
            shell.style.backdropFilter = enabled ? "blur(6px)" : "none";
        }
    } catch (_) {}

    // Ensure renderer is mounted once overlay exists.
    ensureRenderer(el).catch((err) => {
        console.error("[VRM Pet] Renderer init failed", err);
        setHint(
            `渲染初始化失败：${err instanceof Error ? err.message : String(err)}`,
        );
    });
}

function clamp(n, min, max) {
    return Math.max(min, Math.min(max, n));
}

function randRange(min, max) {
    const a = Number(min);
    const b = Number(max);
    if (!Number.isFinite(a) || !Number.isFinite(b)) return 0;
    if (a === b) return a;
    const lo = Math.min(a, b);
    const hi = Math.max(a, b);
    return lo + Math.random() * (hi - lo);
}

function markInteraction() {
    const now = performance.now();
    vrmRenderState.interaction.lastAt = now;
    // Push the next idle action further out so it doesn't trigger right after user input.
    vrmRenderState.idle.nextAt =
        now + randRange(pluginConfig.idleMinMs, pluginConfig.idleMaxMs);
}

function scheduleNextBlink(now) {
    vrmRenderState.blink.nextAt =
        now + randRange(pluginConfig.blinkMinMs, pluginConfig.blinkMaxMs);
}

function setHint(text) {
    const el = document.getElementById("vrm-pet-hint");
    if (!el) return;
    el.textContent = text || "";
    el.style.display = text ? "grid" : "none";
}

function bindOverlayDrag(overlayEl) {
    const shell = overlayEl.querySelector(".vrm-pet-shell");
    if (!shell) return;
    if (shell.__vrmPetDragBound) return;
    shell.__vrmPetDragBound = true;

    // Start dragging only after a small move threshold, so clicking the model can trigger actions.
    let dragging = false;
    let captured = false;
    let pointerId = null;
    let start = null;
    const DRAG_THRESHOLD_PX = 6;

    shell.addEventListener("pointerdown", (e) => {
        if (!pluginConfig.enabled || !pluginConfig.showOverlay) return;
        // Don't start drag on right-click (we use it for the radial menu on the model canvas).
        if (typeof e.button === "number" && e.button === 2) return;
        // When the radial menu is open, don't allow dragging.
        if (
            vrmRenderState.ui?.menuOpen ||
            vrmRenderState.ui?.chatOpen ||
            vrmRenderState.ui?.editorOpen ||
            vrmRenderState.ui?.emoteOpen
        )
            return;
        markInteraction();
        dragging = false;
        captured = false;
        pointerId = e.pointerId;

        const rect = overlayEl.getBoundingClientRect();
        start = { x: e.clientX, y: e.clientY, left: rect.left, top: rect.top };

        // Pause wandering while user interacts.
        vrmRenderState.wander.pausedUntil = performance.now() + 2000;
    });

    shell.addEventListener("pointermove", (e) => {
        // When the radial menu is open, ignore drag moves (prevents accidental dragging after long-press).
        if (
            vrmRenderState.ui?.menuOpen ||
            vrmRenderState.ui?.chatOpen ||
            vrmRenderState.ui?.editorOpen ||
            vrmRenderState.ui?.emoteOpen
        )
            return;
        if (pointerId !== e.pointerId || !start) return;
        const dx = e.clientX - start.x;
        const dy = e.clientY - start.y;

        if (!dragging) {
            if (Math.hypot(dx, dy) < DRAG_THRESHOLD_PX) return;
            dragging = true;
            try {
                shell.setPointerCapture(pointerId);
                captured = true;
            } catch (_) {}
            e.preventDefault();
            markInteraction();

            // Start "pick up" effect once we're actually dragging.
            if (pluginConfig.dragLiftEnabled) {
                vrmRenderState.dragLift.active = true;
                vrmRenderState.dragLift.time = 0;
            }
        }

        const w = overlayEl.offsetWidth;
        const h = overlayEl.offsetHeight;
        const x = clamp(start.left + dx, 0, window.innerWidth - w);
        const y = clamp(start.top + dy, 0, window.innerHeight - h);

        overlayEl.style.left = `${x}px`;
        overlayEl.style.top = `${y}px`;
        overlayEl.style.right = "auto";
        overlayEl.style.bottom = "auto";

        // live-update (but save only on pointerup)
        pluginConfig.overlayPos = { x: Math.round(x), y: Math.round(y) };

        // While dragging, "lift" and tilt the model a bit (like grabbing a desktop pet).
        if (pluginConfig.dragLiftEnabled && vrmRenderState.dragLift.active) {
            const mag = clamp(Math.hypot(dx, dy) / 80, 0, 1); // ramp up quickly
            const sizeY =
                vrmRenderState.currentVrm?.scene?.userData?.__vrmPetBBoxSizeY ??
                1.6;
            const factor = Number(pluginConfig.dragLiftHeightFactor);
            const liftFactor = Number.isFinite(factor) ? factor : 0.08;
            vrmRenderState.dragLift.targetLift =
                Math.max(0, sizeY) *
                clamp(liftFactor, 0, 0.25) *
                (0.35 + 0.65 * mag);

            const maxTiltDeg = Number(pluginConfig.dragLiftMaxTiltDeg);
            const deg = Number.isFinite(maxTiltDeg) ? maxTiltDeg : 10;
            const maxTilt = THREE.MathUtils.degToRad(clamp(deg, 0, 25));
            const nx = clamp(dx / Math.max(1, w), -1, 1);
            const ny = clamp(dy / Math.max(1, h), -1, 1);
            // Slight roll with horizontal drag, slight pitch with vertical drag.
            vrmRenderState.dragLift.targetTiltZ = nx * maxTilt;
            vrmRenderState.dragLift.targetTiltX = -ny * maxTilt * 0.85;
        }
    });

    const stop = async (e) => {
        if (pointerId !== e.pointerId) return;
        const didDrag = dragging;
        dragging = false;
        if (captured) {
            try {
                shell.releasePointerCapture(pointerId);
            } catch (_) {}
        }
        captured = false;
        pointerId = null;
        start = null;
        if (!didDrag) return;
        try {
            const ctx = getContext();
            ctx.extensionSettings[MODULE_NAME] = pluginConfig;
            ctx.saveSettingsDebounced();
        } catch (_) {}

        // Release "pick up" effect.
        vrmRenderState.dragLift.active = false;
        vrmRenderState.dragLift.targetLift = 0;
        vrmRenderState.dragLift.targetTiltX = 0;
        vrmRenderState.dragLift.targetTiltZ = 0;
    };

    shell.addEventListener("pointerup", stop);
    shell.addEventListener("pointercancel", stop);
}

function bindOverlayMenuButton(overlayEl) {
    const shell = overlayEl?.querySelector?.(".vrm-pet-shell");
    if (!shell) return;
    const btn = shell.querySelector(".vrm-pet-menu-btn");
    if (!btn) return;
    if (btn.__vrmPetMenuBound) return;
    btn.__vrmPetMenuBound = true;

    btn.addEventListener("pointerdown", (e) => {
        // Don't let this start a drag.
        e.stopPropagation();
    });

    btn.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        const r = btn.getBoundingClientRect();
        showPetRadialMenu(r.left + r.width / 2, r.top + r.height / 2);
    });
}

function getSendTextarea() {
    /** @type {HTMLTextAreaElement|null} */
    const el = document.querySelector("#send_textarea");
    return el;
}

function insertTextIntoSendTextarea(text) {
    const el = getSendTextarea();
    if (!el) return false;
    const t = stripThinkTags(String(text ?? ""));
    if (!t) return false;

    // Insert at cursor if possible, else append.
    try {
        const start =
            typeof el.selectionStart === "number"
                ? el.selectionStart
                : el.value.length;
        const end =
            typeof el.selectionEnd === "number"
                ? el.selectionEnd
                : el.value.length;
        const before = el.value.slice(0, start);
        const after = el.value.slice(end);
        const needsNewline =
            before.length > 0 && !before.endsWith("\n") && !t.startsWith("\n");
        el.value = before + (needsNewline ? "\n" : "") + t + after;
        const caret = (before + (needsNewline ? "\n" : "") + t).length;
        el.setSelectionRange(caret, caret);
        el.dispatchEvent(new Event("input", { bubbles: true }));
        el.focus();
        return true;
    } catch (_) {
        el.value = (el.value ? el.value + "\n" : "") + t;
        el.dispatchEvent(new Event("input", { bubbles: true }));
        el.focus();
        return true;
    }
}

function stripThinkTags(text) {
    // Remove common chain-of-thought wrappers so we don't show them in UI.
    // Drops the entire tagged content.
    let s = String(text ?? "");
    s = s.replace(/<thinking\b[^>]*>[\s\S]*?<\/thinking>/gi, "");
    s = s.replace(/<think\b[^>]*>[\s\S]*?<\/think>/gi, "");
    return s.trim();
}

function getPetPersonaForCurrentCharacter() {
    const character = getCurrentCharacter();
    if (!character) return "";
    const ext = getCharacterExtensionData(character) || {};
    const p = ext?.petPersona;
    return typeof p === "string" ? p : "";
}

function getPetSystemPromptExtraForCurrentCharacter() {
    const character = getCurrentCharacter();
    if (!character) return "";
    const ext = getCharacterExtensionData(character) || {};
    const p = ext?.petSystemPromptExtra;
    return typeof p === "string" ? p : "";
}

async function savePetPersonaForCurrentCharacter(personaText) {
    const ctx = getContext();
    const character = getCurrentCharacter();
    if (!character)
        throw new Error("No character selected (group chat not supported yet)");

    const existing = getCharacterExtensionData(character) || {};
    const next = mergeDeep(existing, {
        petPersona: String(personaText ?? "").trim(),
        petPersonaUpdatedAt: Date.now(),
    });
    await ctx.writeExtensionField(ctx.characterId, MODULE_NAME, next);
    return next;
}

async function savePetSystemPromptExtraForCurrentCharacter(extraText) {
    const ctx = getContext();
    const character = getCurrentCharacter();
    if (!character)
        throw new Error("No character selected (group chat not supported yet)");

    const existing = getCharacterExtensionData(character) || {};
    const next = mergeDeep(existing, {
        petSystemPromptExtra: String(extraText ?? "").trim(),
        petSystemPromptExtraUpdatedAt: Date.now(),
    });
    await ctx.writeExtensionField(ctx.characterId, MODULE_NAME, next);
    return next;
}

function getPetChatDataForCurrentCharacter() {
    const character = getCurrentCharacter();
    if (!character) return { messages: [] };
    const ext = getCharacterExtensionData(character) || {};
    const raw = ext?.petChat ?? null;

    const rawMsgs = Array.isArray(raw?.messages)
        ? raw.messages
        : Array.isArray(raw)
          ? raw
          : [];

    const out = [];
    for (const m of rawMsgs) {
        if (!m) continue;
        const role = m.role === "assistant" ? "assistant" : "user";
        const text = String(m.text ?? "").trim();
        if (!text) continue;
        const at = Number.isFinite(Number(m.at)) ? Number(m.at) : Date.now();
        out.push({ role, text, at });
    }

    // Keep newest tail to avoid bloating character data.
    const trimmed =
        out.length > PET_CHAT_MAX_MESSAGES
            ? out.slice(out.length - PET_CHAT_MAX_MESSAGES)
            : out;

    return { messages: trimmed };
}

async function savePetChatMessagesForCurrentCharacter(messages) {
    const ctx = getContext();
    const character = getCurrentCharacter();
    if (!character)
        throw new Error("No character selected (group chat not supported yet)");

    const existing = getCharacterExtensionData(character) || {};
    const next = mergeDeep(existing, {
        petChat: {
            messages: Array.isArray(messages) ? messages : [],
            updatedAt: Date.now(),
        },
    });
    await ctx.writeExtensionField(ctx.characterId, MODULE_NAME, next);
    return next;
}

function removePetChatModal() {
    const overlayEl = document.getElementById("vrm-pet-overlay");
    const el = overlayEl?.querySelector?.(".vrm-pet-chat-overlay") ?? null;
    try {
        el?.remove?.();
    } catch (_) {}
    if (vrmRenderState.ui) vrmRenderState.ui.chatOpen = false;
}

function removePetSpeechBubble() {
    const overlayEl = document.getElementById("vrm-pet-overlay");
    const el = overlayEl?.querySelector?.(".vrm-pet-speech-bubble") ?? null;
    try {
        el?.remove?.();
    } catch (_) {}
    if (vrmRenderState.ui) {
        vrmRenderState.ui.bubbleToken = (vrmRenderState.ui.bubbleToken || 0) + 1;
        if (vrmRenderState.ui.bubbleHideTimer) {
            clearTimeout(vrmRenderState.ui.bubbleHideTimer);
            vrmRenderState.ui.bubbleHideTimer = null;
        }
        if (vrmRenderState.ui.bubbleRemoveTimer) {
            clearTimeout(vrmRenderState.ui.bubbleRemoveTimer);
            vrmRenderState.ui.bubbleRemoveTimer = null;
        }
    }
}

function removePetEditorModal() {
    const overlayEl = document.getElementById("vrm-pet-overlay");
    const el = overlayEl?.querySelector?.(".vrm-pet-editor-overlay") ?? null;
    try {
        el?.remove?.();
    } catch (_) {}
    if (vrmRenderState.ui) vrmRenderState.ui.editorOpen = false;
}

function removePetEmotePanel() {
    const overlayEl = document.getElementById("vrm-pet-overlay");
    const el = overlayEl?.querySelector?.(".vrm-pet-emote-overlay") ?? null;
    try {
        el?.remove?.();
    } catch (_) {}
    if (vrmRenderState.ui) vrmRenderState.ui.emoteOpen = false;
}

function positionPetSpeechBubbleNearOverlay(bubbleEl) {
    try {
        const overlayEl = document.getElementById("vrm-pet-overlay");
        if (!overlayEl || !bubbleEl) return;

        const petRect = overlayEl.getBoundingClientRect();
        const r = bubbleEl.getBoundingClientRect();

        const gap = 10;
        const margin = 12;

        const leftX = petRect.left - gap - r.width;
        const rightX = petRect.right + gap;
        const canLeft = leftX >= margin;
        const canRight = rightX + r.width <= window.innerWidth - margin;

        // Prefer to the side of the pet so the model remains visible.
        const side = canRight ? "right" : canLeft ? "left" : "left";
        let x = side === "right" ? rightX : leftX;
        let y = petRect.top + 14;

        x = clamp(x, margin, Math.max(margin, window.innerWidth - r.width - margin));
        y = clamp(y, margin, Math.max(margin, window.innerHeight - r.height - margin));

        bubbleEl.dataset.side = side;
        bubbleEl.style.position = "fixed";
        bubbleEl.style.left = `${Math.round(x)}px`;
        bubbleEl.style.top = `${Math.round(y)}px`;
    } catch (_) {}
}

function showPetSpeechBubble(text, opts = {}) {
    if (!pluginConfig.enabled || !pluginConfig.showOverlay) return;
    const overlayEl = document.getElementById("vrm-pet-overlay");
    if (!overlayEl) return;
    if (!vrmRenderState.ui) return;

    const s = stripThinkTags(String(text ?? ""));
    if (!s) return;

    removePetSpeechBubble();

    const bubble = document.createElement("div");
    bubble.className = "vrm-pet-speech-bubble";
    bubble.textContent = s;
    overlayEl.appendChild(bubble);

    const durationMsRaw = Number(opts?.durationMs);
    const durationMs = Number.isFinite(durationMsRaw) ? durationMsRaw : 5000;

    const token =
        (vrmRenderState.ui.bubbleToken = (vrmRenderState.ui.bubbleToken || 0) + 1);

    setTimeout(() => {
        if (vrmRenderState.ui && token !== vrmRenderState.ui.bubbleToken) return;
        positionPetSpeechBubbleNearOverlay(bubble);
    }, 0);

    vrmRenderState.ui.bubbleHideTimer = setTimeout(() => {
        if (!vrmRenderState.ui || token !== vrmRenderState.ui.bubbleToken) return;
        try {
            bubble.classList.add("vrm-pet-hide");
        } catch (_) {}
        if (!vrmRenderState.ui) return;
        vrmRenderState.ui.bubbleRemoveTimer = setTimeout(() => {
            if (!vrmRenderState.ui || token !== vrmRenderState.ui.bubbleToken) return;
            try {
                bubble.remove();
            } catch (_) {}
        }, 220);
    }, clamp(durationMs, 1200, 20000));
}

function getHumanoidBoneNode(vrm, name) {
    try {
        const h = vrm?.humanoid ?? null;
        if (!h) return null;
        // Try common APIs across three-vrm versions.
        if (typeof h.getNormalizedBoneNode === "function") {
            const n = h.getNormalizedBoneNode(name);
            if (n) return n;
        }
        if (typeof h.getBoneNode === "function") {
            const n = h.getBoneNode(name);
            if (n) return n;
        }
        if (typeof h.getRawBoneNode === "function") {
            const n = h.getRawBoneNode(name);
            if (n) return n;
        }
        const hb = h?.humanBones?.[name] ?? null;
        if (hb?.node) return hb.node;
    } catch (_) {}
    return null;
}

function ensureRestQuaternion(bone, key) {
    if (!bone) return null;
    if (!bone.userData) bone.userData = {};
    if (!bone.userData[key]) bone.userData[key] = bone.quaternion.clone();
    return bone.userData[key];
}

function applyLocalAxisAngleFromRest(bone, restQ, axis, angleRad) {
    if (!bone || !restQ) return;
    const ax =
        axis === "y"
            ? new THREE.Vector3(0, 1, 0)
            : axis === "z"
              ? new THREE.Vector3(0, 0, 1)
              : new THREE.Vector3(1, 0, 0);
    const dq = new THREE.Quaternion().setFromAxisAngle(ax, angleRad);
    bone.quaternion.copy(restQ).multiply(dq);
}

function inferKneeBendAxisAndSign(lowerLeg, foot) {
    // Heuristic: choose the local axis/sign that most increases the foot's world Y when bending the knee a bit.
    // This isn't perfect, but works reasonably across many VRM rigs with different local axes.
    try {
        if (!lowerLeg || !foot) return { axis: "x", sign: 1 };

        lowerLeg.updateMatrixWorld(true);
        foot.updateMatrixWorld(true);

        const orig = new THREE.Vector3();
        foot.getWorldPosition(orig);

        const rest = ensureRestQuaternion(lowerLeg, "__vrmPetKneeRestQ");
        if (!rest) return { axis: "x", sign: 1 };

        const testAngle = THREE.MathUtils.degToRad(8);
        const candidates = [
            { axis: "x", sign: 1 },
            { axis: "x", sign: -1 },
            { axis: "z", sign: 1 },
            { axis: "z", sign: -1 },
        ];

        let best = candidates[0];
        let bestDy = -Infinity;
        const p = new THREE.Vector3();

        for (const c of candidates) {
            applyLocalAxisAngleFromRest(
                lowerLeg,
                rest,
                c.axis,
                c.sign * testAngle,
            );
            lowerLeg.updateMatrixWorld(true);
            foot.updateMatrixWorld(true);
            foot.getWorldPosition(p);
            const dy = p.y - orig.y;
            if (dy > bestDy) {
                bestDy = dy;
                best = c;
            }
        }

        // Restore.
        lowerLeg.quaternion.copy(rest);
        lowerLeg.updateMatrixWorld(true);
        return best;
    } catch (_) {
        return { axis: "x", sign: 1 };
    }
}

function applyProceduralLegGait(vrm, tSec, intensity) {
    if (!vrm) return;
    if (!pluginConfig.wanderGaitEnabled) return;
    const k = Number.isFinite(Number(intensity)) ? Number(intensity) : 1.0;
    if (k <= 0.001) return;

    const lUpper = getHumanoidBoneNode(vrm, "leftUpperLeg");
    const lLower = getHumanoidBoneNode(vrm, "leftLowerLeg");
    const lFoot = getHumanoidBoneNode(vrm, "leftFoot");
    const rUpper = getHumanoidBoneNode(vrm, "rightUpperLeg");
    const rLower = getHumanoidBoneNode(vrm, "rightLowerLeg");
    const rFoot = getHumanoidBoneNode(vrm, "rightFoot");

    if (!lUpper || !lLower || !lFoot || !rUpper || !rLower || !rFoot) return;

    // Cache per-model knee axis choices.
    const cache =
        vrm.scene?.userData?.__vrmPetKneeAxisCache ??
        (vrm.scene.userData.__vrmPetKneeAxisCache = {});

    if (!cache.left) cache.left = inferKneeBendAxisAndSign(lLower, lFoot);
    if (!cache.right) cache.right = inferKneeBendAxisAndSign(rLower, rFoot);

    const freqBase = 1.55; // steps per second at default speed
    const speed = Number(pluginConfig.wanderSpeed) || 80;
    const speedMul = clamp(speed / 80, 0.55, 2.4);
    const freq = freqBase * speedMul;
    const w = 2 * Math.PI * freq;

    const phaseL = tSec * w;
    const phaseR = phaseL + Math.PI;

    const swingL = Math.sin(phaseL);
    const swingR = Math.sin(phaseR);
    const liftL = Math.max(0, swingL);
    const liftR = Math.max(0, swingR);

    const upperSwing = THREE.MathUtils.degToRad(18) * k;
    const kneeBend = THREE.MathUtils.degToRad(28) * k;
    const ankle = THREE.MathUtils.degToRad(10) * k;

    // Left leg.
    const lUpperRest = ensureRestQuaternion(lUpper, "__vrmPetLegUpperRestQ");
    const lLowerRest = ensureRestQuaternion(lLower, "__vrmPetLegLowerRestQ");
    const lFootRest = ensureRestQuaternion(lFoot, "__vrmPetLegFootRestQ");
    const la = cache.left;

    applyLocalAxisAngleFromRest(lUpper, lUpperRest, la.axis, la.sign * swingL * upperSwing);
    applyLocalAxisAngleFromRest(lLower, lLowerRest, la.axis, la.sign * liftL * kneeBend);
    applyLocalAxisAngleFromRest(lFoot, lFootRest, la.axis, -la.sign * liftL * ankle);

    // Right leg.
    const rUpperRest = ensureRestQuaternion(rUpper, "__vrmPetLegUpperRestQ");
    const rLowerRest = ensureRestQuaternion(rLower, "__vrmPetLegLowerRestQ");
    const rFootRest = ensureRestQuaternion(rFoot, "__vrmPetLegFootRestQ");
    const ra = cache.right;

    applyLocalAxisAngleFromRest(rUpper, rUpperRest, ra.axis, ra.sign * swingR * upperSwing);
    applyLocalAxisAngleFromRest(rLower, rLowerRest, ra.axis, ra.sign * liftR * kneeBend);
    applyLocalAxisAngleFromRest(rFoot, rFootRest, ra.axis, -ra.sign * liftR * ankle);
}

function resetProceduralLegGait(vrm) {
    try {
        if (!vrm) return;
        const lUpper = getHumanoidBoneNode(vrm, "leftUpperLeg");
        const lLower = getHumanoidBoneNode(vrm, "leftLowerLeg");
        const lFoot = getHumanoidBoneNode(vrm, "leftFoot");
        const rUpper = getHumanoidBoneNode(vrm, "rightUpperLeg");
        const rLower = getHumanoidBoneNode(vrm, "rightLowerLeg");
        const rFoot = getHumanoidBoneNode(vrm, "rightFoot");

        if (lUpper?.userData?.__vrmPetLegUpperRestQ)
            lUpper.quaternion.copy(lUpper.userData.__vrmPetLegUpperRestQ);
        if (lLower?.userData?.__vrmPetLegLowerRestQ)
            lLower.quaternion.copy(lLower.userData.__vrmPetLegLowerRestQ);
        else if (lLower?.userData?.__vrmPetKneeRestQ)
            lLower.quaternion.copy(lLower.userData.__vrmPetKneeRestQ);
        if (lFoot?.userData?.__vrmPetLegFootRestQ)
            lFoot.quaternion.copy(lFoot.userData.__vrmPetLegFootRestQ);

        if (rUpper?.userData?.__vrmPetLegUpperRestQ)
            rUpper.quaternion.copy(rUpper.userData.__vrmPetLegUpperRestQ);
        if (rLower?.userData?.__vrmPetLegLowerRestQ)
            rLower.quaternion.copy(rLower.userData.__vrmPetLegLowerRestQ);
        else if (rLower?.userData?.__vrmPetKneeRestQ)
            rLower.quaternion.copy(rLower.userData.__vrmPetKneeRestQ);
        if (rFoot?.userData?.__vrmPetLegFootRestQ)
            rFoot.quaternion.copy(rFoot.userData.__vrmPetLegFootRestQ);
    } catch (_) {}
}

function ensureLegGaitLoop() {
    if (vrmRenderState.legGaitRafId) return;
    vrmRenderState.legGaitLastAt = performance.now();

    const tick = () => {
        const now = performance.now();
        const dt = clamp((now - (vrmRenderState.legGaitLastAt || now)) / 1000, 0, 0.05);
        vrmRenderState.legGaitLastAt = now;

        const vrm = vrmRenderState.currentVrm;
        const shouldGait =
            !!vrm &&
            !!pluginConfig.enabled &&
            !!pluginConfig.showOverlay &&
            !!pluginConfig.wanderEnabled &&
            !!pluginConfig.wanderGaitEnabled &&
            now >= (vrmRenderState.wander?.pausedUntil ?? 0);

        if (shouldGait) {
            // Advance gait phase while wandering.
            vrmRenderState.wander.gaitTime =
                (vrmRenderState.wander.gaitTime || 0) + dt;
            applyProceduralLegGait(
                vrm,
                vrmRenderState.wander.gaitTime || 0,
                pluginConfig.wanderGaitIntensity,
            );
        } else if (vrm) {
            resetProceduralLegGait(vrm);
        }

        vrmRenderState.legGaitRafId = requestAnimationFrame(tick);
    };

    vrmRenderState.legGaitRafId = requestAnimationFrame(tick);
}

function showPetEmotePanel() {
    if (!pluginConfig.enabled || !pluginConfig.showOverlay) return;
    const overlayEl = document.getElementById("vrm-pet-overlay");
    if (!overlayEl) return;

    removePetEmotePanel();
    if (vrmRenderState.ui) vrmRenderState.ui.emoteOpen = true;

    const overlay = document.createElement("div");
    overlay.className = "vrm-pet-emote-overlay";
    overlay.addEventListener(
        "pointerdown",
        (e) => {
            if (e.target === overlay) {
                e.preventDefault();
                e.stopPropagation();
                removePetEmotePanel();
            }
        },
        { capture: true },
    );

    const panel = document.createElement("div");
    panel.className = "vrm-pet-emote-panel";
    panel.addEventListener("pointerdown", (e) => e.stopPropagation());

    const title = document.createElement("div");
    title.className = "vrm-pet-emote-title";
    title.textContent = "表情";

    const btnClose = document.createElement("button");
    btnClose.type = "button";
    btnClose.className = "vrm-pet-emote-close";
    btnClose.textContent = "×";
    btnClose.title = "关闭";
    btnClose.addEventListener("click", (e) => {
        e.preventDefault();
        removePetEmotePanel();
    });

    const grid = document.createElement("div");
    grid.className = "vrm-pet-emote-grid";

    const presets = [
        { id: "happy", label: "开心", icon: "\u263A" }, // ☺
        { id: "angry", label: "愤怒", icon: "\uD83D\uDCA2" }, // 💢
        { id: "speechless", label: "无语", icon: "\uD83D\uDE11" }, // 😑
        { id: "blackface", label: "黑脸", icon: "\u2026" }, // …
        { id: "neutral", label: "恢复", icon: "\u21BA" }, // ↺
    ];

    for (const p of presets) {
        const b = document.createElement("button");
        b.type = "button";
        b.className = "vrm-pet-emote-btn";
        b.dataset.emote = p.id;
        b.innerHTML = `<span class="vrm-pet-emote-ico">${p.icon}</span><span class="vrm-pet-emote-lbl">${p.label}</span>`;
        grid.appendChild(b);
    }

    panel.appendChild(title);
    panel.appendChild(btnClose);
    panel.appendChild(grid);
    overlay.appendChild(panel);
    overlayEl.appendChild(overlay);

    // Position near the pet (after layout).
    setTimeout(() => positionPetModalPanelNearOverlay(panel), 0);

    panel.addEventListener("click", (e) => {
        const t = e.target;
        if (!(t instanceof HTMLElement)) return;
        const btn = t.closest?.(".vrm-pet-emote-btn");
        if (!(btn instanceof HTMLElement)) return;
        e.preventDefault();
        const id = String(btn.dataset.emote || "");
        if (!id) return;
        if (id === "neutral") {
            // Clear immediately.
            const vrm = vrmRenderState.currentVrm;
            if (vrm) clearPetExpressionPresets(vrm);
            vrmRenderState.expressionFx.active = null;
            vrmRenderState.expressionFx.strength = 0;
            return;
        }
        applyPetEmotion(id, { durationMs: 1600 });
    });
}

function positionPetModalPanelNearOverlay(panelEl) {
    try {
        const overlayEl = document.getElementById("vrm-pet-overlay");
        if (!overlayEl || !panelEl) return;

        // Ensure the panel is measurable (it uses CSS width/height).
        const petRect = overlayEl.getBoundingClientRect();
        const panelRect = panelEl.getBoundingClientRect();

        const gap = 12;
        const margin = 12;

        // Prefer to the left of the pet, aligned to bottom.
        let x = petRect.left - gap - panelRect.width;
        let y = petRect.bottom - panelRect.height;

        // If there isn't enough room on the left, fallback to above the pet.
        if (x < margin) {
            x = Math.min(
                Math.max(margin, petRect.right - panelRect.width),
                window.innerWidth - panelRect.width - margin,
            );
            y = petRect.top - gap - panelRect.height;
        }

        x = clamp(
            x,
            margin,
            Math.max(margin, window.innerWidth - panelRect.width - margin),
        );
        y = clamp(
            y,
            margin,
            Math.max(margin, window.innerHeight - panelRect.height - margin),
        );

        panelEl.style.position = "fixed";
        panelEl.style.left = `${Math.round(x)}px`;
        panelEl.style.top = `${Math.round(y)}px`;
    } catch (_) {}
}

function showPetEditorModal(kind) {
    if (!pluginConfig.enabled || !pluginConfig.showOverlay) return;
    const character = getCurrentCharacter();
    if (!character) {
        toastr?.warning?.("请先选择一个角色（当前不支持群聊）", "VRM Pet");
        return;
    }

    const overlayEl = document.getElementById("vrm-pet-overlay");
    if (!overlayEl) return;

    removePetEmotePanel();
    removePetEditorModal();
    if (vrmRenderState.ui) vrmRenderState.ui.editorOpen = true;

    const isPersona = kind === "persona";
    const titleText = isPersona ? "桌宠人设" : "提示词补充";
    const initial = isPersona
        ? getPetPersonaForCurrentCharacter()
        : getPetSystemPromptExtraForCurrentCharacter();

    const overlay = document.createElement("div");
    overlay.className = "vrm-pet-editor-overlay";
    overlay.addEventListener(
        "pointerdown",
        (e) => {
            if (e.target === overlay) {
                e.preventDefault();
                e.stopPropagation();
                removePetEditorModal();
            }
        },
        { capture: true },
    );

    const panel = document.createElement("div");
    panel.className = "vrm-pet-editor";
    panel.addEventListener("pointerdown", (e) => e.stopPropagation());

    const header = document.createElement("div");
    header.className = "vrm-pet-editor-header";

    const title = document.createElement("div");
    title.className = "vrm-pet-editor-title";
    title.textContent = titleText;

    const btnClose = document.createElement("button");
    btnClose.type = "button";
    btnClose.className = "vrm-pet-editor-btn";
    btnClose.textContent = "×";
    btnClose.title = "关闭";
    btnClose.addEventListener("click", (e) => {
        e.preventDefault();
        removePetEditorModal();
    });

    header.appendChild(title);
    header.appendChild(btnClose);

    const ta = document.createElement("textarea");
    ta.className = "vrm-pet-editor-textarea";
    ta.placeholder = isPersona
        ? "写桌宠专用人设（不会修改角色卡原有人设）"
        : "写桌宠系统提示词补充（可选）";
    ta.value = String(initial || "");

    const actions = document.createElement("div");
    actions.className = "vrm-pet-editor-actions";

    const btnCancel = document.createElement("button");
    btnCancel.type = "button";
    btnCancel.className = "vrm-pet-editor-mini";
    btnCancel.textContent = "取消";
    btnCancel.addEventListener("click", (e) => {
        e.preventDefault();
        removePetEditorModal();
    });

    const btnSave = document.createElement("button");
    btnSave.type = "button";
    btnSave.className = "vrm-pet-editor-save";
    btnSave.textContent = "保存";

    actions.appendChild(btnCancel);
    actions.appendChild(btnSave);

    panel.appendChild(header);
    panel.appendChild(ta);
    panel.appendChild(actions);

    overlay.appendChild(panel);
    // Append on the outer overlay so full-screen modals aren't clipped by the pet shell.
    overlayEl.appendChild(overlay);

    // Position near the pet (after layout).
    setTimeout(() => positionPetModalPanelNearOverlay(panel), 0);

    const save = async () => {
        const v = String(ta.value ?? "").trim();
        btnSave.disabled = true;
        try {
            if (isPersona) await savePetPersonaForCurrentCharacter(v);
            else await savePetSystemPromptExtraForCurrentCharacter(v);
            toastr?.success?.("已保存", "VRM Pet");
            removePetEditorModal();
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            toastr?.error?.(msg, "VRM Pet");
        } finally {
            btnSave.disabled = false;
        }
    };

    btnSave.addEventListener("click", (e) => {
        e.preventDefault();
        save().catch(() => {});
    });

    try {
        ta.focus();
    } catch (_) {}
}

function buildPetSystemPrompt(persona) {
    const extra = getPetSystemPromptExtraForCurrentCharacter();
    return [
        PET_AI_SYSTEM_PROMPT_BASE,
        persona ? `Character persona:\n${persona}` : "",
        extra ? `Extra instructions:\n${extra}` : "",
    ]
        .filter(Boolean)
        .join("\n\n");
}

function renderPetChatMessages(container, messages, nameUser, namePet) {
    if (!container) return;
    container.textContent = "";

    const frag = document.createDocumentFragment();
    const arr = Array.isArray(messages) ? messages : [];
    for (let i = 0; i < arr.length; i++) {
        const m = arr[i];
        const row = document.createElement("div");
        row.className =
            m.role === "assistant"
                ? "vrm-pet-chat-msg assistant"
                : "vrm-pet-chat-msg user";

        const who = document.createElement("div");
        who.className = "vrm-pet-chat-who";
        who.textContent = m.role === "assistant" ? namePet : nameUser;

        const wrap = document.createElement("div");
        wrap.className = "vrm-pet-chat-bubble-wrap";

        const bubble = document.createElement("div");
        bubble.className = "vrm-pet-chat-bubble";
        bubble.textContent = stripThinkTags(String(m.text ?? ""));

        row.appendChild(who);
        wrap.appendChild(bubble);

        const del = document.createElement("button");
        del.type = "button";
        del.className = "vrm-pet-chat-del";
        del.dataset.index = String(i);
        del.title = "删除";
        del.textContent = "×";
        wrap.appendChild(del);

        row.appendChild(wrap);
        frag.appendChild(row);
    }
    container.appendChild(frag);

    // Scroll to bottom.
    try {
        container.scrollTop = container.scrollHeight;
    } catch (_) {}
}

function showPetChatModal() {
    if (!pluginConfig.enabled || !pluginConfig.showOverlay) return;
    const character = getCurrentCharacter();
    if (!character) {
        toastr?.warning?.("请先选择一个角色（当前不支持群聊）", "VRM Pet");
        return;
    }

    const overlayEl = document.getElementById("vrm-pet-overlay");
    if (!overlayEl) return;

    removePetEmotePanel();
    removePetChatModal();
    if (vrmRenderState.ui) vrmRenderState.ui.chatOpen = true;

    const overlay = document.createElement("div");
    overlay.className = "vrm-pet-chat-overlay";
    overlay.addEventListener(
        "pointerdown",
        (e) => {
            // click outside closes
            if (e.target === overlay) {
                e.preventDefault();
                e.stopPropagation();
                removePetChatModal();
            }
        },
        { capture: true },
    );

    const panel = document.createElement("div");
    panel.className = "vrm-pet-chat";
    panel.addEventListener("pointerdown", (e) => e.stopPropagation());

    const header = document.createElement("div");
    header.className = "vrm-pet-chat-header";

    const title = document.createElement("div");
    title.className = "vrm-pet-chat-title";
    title.textContent = "桌宠聊天";

    const btnClose = document.createElement("button");
    btnClose.type = "button";
    btnClose.className = "vrm-pet-chat-btn";
    btnClose.textContent = "×";
    btnClose.title = "关闭";
    btnClose.addEventListener("click", (e) => {
        e.preventDefault();
        removePetChatModal();
    });

    header.appendChild(title);
    header.appendChild(btnClose);

    const body = document.createElement("div");
    body.className = "vrm-pet-chat-body";

    const inputRow = document.createElement("div");
    inputRow.className = "vrm-pet-chat-input";

    const ta = document.createElement("textarea");
    ta.className = "vrm-pet-chat-textarea";
    ta.placeholder = "对桌宠说点什么…（Enter 发送，Shift+Enter 换行）";
    ta.rows = 2;

    const btnSend = document.createElement("button");
    btnSend.type = "button";
    btnSend.className = "vrm-pet-chat-send";
    btnSend.textContent = "发送";

    inputRow.appendChild(ta);
    inputRow.appendChild(btnSend);

    const footer = document.createElement("div");
    footer.className = "vrm-pet-chat-footer";

    const btnPrompt = document.createElement("button");
    btnPrompt.type = "button";
    btnPrompt.className = "vrm-pet-chat-mini";
    btnPrompt.textContent = "提示词";

    const btnPersona = document.createElement("button");
    btnPersona.type = "button";
    btnPersona.className = "vrm-pet-chat-mini";
    btnPersona.textContent = "人设";

    const btnClear = document.createElement("button");
    btnClear.type = "button";
    btnClear.className = "vrm-pet-chat-mini";
    btnClear.textContent = "清空";

    footer.appendChild(btnPrompt);
    footer.appendChild(btnPersona);
    footer.appendChild(btnClear);

    panel.appendChild(header);
    panel.appendChild(body);
    panel.appendChild(inputRow);
    panel.appendChild(footer);

    overlay.appendChild(panel);
    // Append on the outer overlay so full-screen modals aren't clipped by the pet shell.
    overlayEl.appendChild(overlay);

    // Position near the pet (after layout).
    setTimeout(() => positionPetModalPanelNearOverlay(panel), 0);

    const ctx = getContext();
    const nameUser = String(ctx.name1 || "User");
    const namePet = String(character?.name || ctx.name2 || "Pet");

    const refresh = () => {
        const data = getPetChatDataForCurrentCharacter();
        renderPetChatMessages(body, data.messages, nameUser, namePet);
    };

    refresh();

    body.addEventListener("click", async (e) => {
        const t = e.target;
        if (!(t instanceof HTMLElement)) return;
        const btn = t.closest?.(".vrm-pet-chat-del");
        if (!(btn instanceof HTMLElement)) return;
        e.preventDefault();
        e.stopPropagation();

        const idx = Number(btn.dataset.index);
        if (!Number.isFinite(idx)) return;

        // Safer UX: confirm delete (Shift bypass).
        const doDelete =
            e instanceof MouseEvent && e.shiftKey
                ? true
                : confirm("删除这条消息？");
        if (!doDelete) return;

        try {
            const data = getPetChatDataForCurrentCharacter();
            const msgs = Array.isArray(data.messages) ? [...data.messages] : [];
            if (idx < 0 || idx >= msgs.length) return;
            msgs.splice(idx, 1);
            await savePetChatMessagesForCurrentCharacter(msgs);
            refresh();
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            toastr?.error?.(msg, "VRM Pet");
        }
    });

    const send = async () => {
        const text = String(ta.value ?? "").trim();
        if (!text) return;
        ta.value = "";
        markInteraction();

        btnSend.disabled = true;
        btnSend.textContent = "…";
        try {
            const data = getPetChatDataForCurrentCharacter();
            const msgs = Array.isArray(data.messages) ? [...data.messages] : [];
            msgs.push({ role: "user", text, at: Date.now() });

            // Persist the user message first (feels responsive and survives refresh/crash).
            await savePetChatMessagesForCurrentCharacter(msgs);
            refresh();

            if (!ctx?.generateRaw) throw new Error("generateRaw unavailable");
            const persona = getPetPersonaForCurrentCharacter();
            const systemPrompt = buildPetSystemPrompt(persona);

            const tail = msgs.slice(-24);
            const lines = [];
            for (const m of tail) {
                const who = m.role === "assistant" ? namePet : nameUser;
                const mes = String(m.text ?? "")
                    .replace(/\s+/g, " ")
                    .trim();
                if (!mes) continue;
                lines.push(`${who}: ${mes}`);
            }

            const promptText = [
                `Conversation (most recent last):`,
                lines.length ? lines.join("\n") : "(no chat context available)",
                ``,
                `Now write ${namePet}'s next reply.`,
            ].join("\n");

            const reply = await ctx.generateRaw({
                prompt: promptText,
                systemPrompt,
            });

            const out = stripThinkTags(String(reply ?? ""));
            if (!out) throw new Error("Empty reply");
            msgs.push({ role: "assistant", text: out, at: Date.now() });
            await savePetChatMessagesForCurrentCharacter(msgs);
            refresh();
            triggerPetEmotionFromText(out);
            showPetSpeechBubble(out, { durationMs: 5200 });
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            toastr?.error?.(msg, "VRM Pet");
        } finally {
            btnSend.disabled = false;
            btnSend.textContent = "发送";
            try {
                ta.focus();
            } catch (_) {}
        }
    };

    btnSend.addEventListener("click", (e) => {
        e.preventDefault();
        send().catch(() => {});
    });

    ta.addEventListener("keydown", (e) => {
        // Enter sends, Shift+Enter newline.
        if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            send().catch(() => {});
        }
    });

    btnPersona.addEventListener("click", (e) => {
        e.preventDefault();
        showPetEditorModal("persona");
    });

    btnPrompt.addEventListener("click", (e) => {
        e.preventDefault();
        showPetEditorModal("prompt");
    });

    btnClear.addEventListener("click", async (e) => {
        e.preventDefault();
        try {
            await savePetChatMessagesForCurrentCharacter([]);
            refresh();
            toastr?.success?.("已清空桌宠聊天记录", "VRM Pet");
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            toastr?.error?.(msg, "VRM Pet");
        }
    });

    // Focus input by default.
    try {
        ta.focus();
    } catch (_) {}
}

function removePetRadialMenu() {
    const overlayEl = document.getElementById("vrm-pet-overlay");
    const el = overlayEl?.querySelector?.(".vrm-pet-radial-overlay") ?? null;
    try {
        el?.remove?.();
    } catch (_) {}
    if (vrmRenderState.ui) vrmRenderState.ui.menuOpen = false;
}

function showPetRadialMenu(clientX, clientY) {
    if (!pluginConfig.enabled || !pluginConfig.showOverlay) return;
    const overlayEl = document.getElementById("vrm-pet-overlay");
    if (!overlayEl) return;

    removePetEmotePanel();
    removePetRadialMenu();
    if (vrmRenderState.ui) vrmRenderState.ui.menuOpen = true;
    const margin = 10;

    const overlay = document.createElement("div");
    overlay.className = "vrm-pet-radial-overlay";
    overlay.addEventListener(
        "pointerdown",
        (e) => {
            // click outside closes
            if (e.target === overlay) {
                e.preventDefault();
                e.stopPropagation();
                removePetRadialMenu();
            }
        },
        { capture: true },
    );
    overlay.addEventListener("contextmenu", (e) => {
        e.preventDefault();
        removePetRadialMenu();
    });

    const menu = document.createElement("div");
    menu.className = "vrm-pet-quick-menu";
    menu.addEventListener("pointerdown", (e) => {
        // keep events from reaching drag handlers
        e.stopPropagation();
    });

    const close = document.createElement("button");
    close.type = "button";
    close.className = "vrm-pet-quick-close";
    close.textContent = "×";
    close.title = "关闭";
    close.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        removePetRadialMenu();
    });

    const items = [
        { id: "chat", label: "聊天" },
        { id: "emote", label: "表情" },
        { id: "persona", label: "人设" },
        { id: "prompt", label: "提示词" },
        { id: "ai", label: "AI 回复（填入输入框）" },
    ];

    const mkItem = (it) => {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "vrm-pet-quick-item";
        btn.dataset.action = it.id;
        btn.textContent = it.label;
        return btn;
    };

    for (const it of items) menu.appendChild(mkItem(it));
    menu.appendChild(close);

    // Position in viewport coords. Measure after mount so clamping is accurate.
    menu.style.left = "0px";
    menu.style.top = "0px";

    menu.addEventListener("click", async (e) => {
        const t = e.target;
        if (!(t instanceof HTMLElement)) return;
        const btn = t.closest?.(".vrm-pet-quick-item");
        const action = btn?.dataset?.action ?? "";
        if (!action) return;
        e.preventDefault();
        e.stopPropagation();
        removePetRadialMenu();

        try {
            if (action === "persona") {
                showPetEditorModal("persona");
                return;
            }
            if (action === "prompt") {
                showPetEditorModal("prompt");
                return;
            }
            if (action === "chat") {
                showPetChatModal();
                return;
            }
            if (action === "emote") {
                showPetEmotePanel();
                return;
            }
            if (action === "ai") {
                const ctx = getContext();
                if (!ctx?.generateRaw)
                    throw new Error("generateRaw unavailable");
                const persona = getPetPersonaForCurrentCharacter();
                const extra = getPetSystemPromptExtraForCurrentCharacter();

                // Prefer SillyTavern's native prompt assembly (Generate dry-run) so character card, WI/AN, etc match.
                // Still use generateRaw() to actually query the model (so you can bypass the main "send" workflow).
                let promptForModel = null;
                try {
                    const nameChar = String(ctx?.name2 || "Assistant");
                    const quietPrompt = [
                        PET_AI_SYSTEM_PROMPT_BASE,
                        persona ? `Character persona:\n${persona}` : "",
                        extra ? `Extra instructions:\n${extra}` : "",
                        `Now write ${nameChar}'s next reply. Output only the reply text (no name prefix).`,
                    ]
                        .filter(Boolean)
                        .join("\n\n");
                    promptForModel = await captureNativeGeneratePrompt({
                        ctx,
                        quietPrompt,
                    });
                } catch (_) {
                    promptForModel = null;
                }

                // Fallback: local minimal prompt with WI scan (best-effort).
                if (!promptForModel) {
                    const systemPrompt = buildPetSystemPrompt(persona);
                    promptForModel = await buildAiReplyContextText({
                        ctx,
                        maxMessages: 24,
                    });

                    const reply = await ctx.generateRaw({
                        prompt: promptForModel,
                        systemPrompt,
                        trimNames: true,
                    });

                    const text = stripThinkTags(String(reply ?? ""));
                    if (!text) throw new Error("Empty reply");
                    insertTextIntoSendTextarea(text);
                    toastr?.success?.("已生成回复并填入输入框", "VRM Pet");
                    triggerPetEmotionFromText(text);
                    return;
                }

                // When using native prompt capture, the prompt already includes system/story/WI etc.
                const reply = await ctx.generateRaw({
                    prompt: promptForModel,
                    systemPrompt: "",
                    trimNames: true,
                });

                const text = stripThinkTags(String(reply ?? ""));
                if (!text) throw new Error("Empty reply");
                insertTextIntoSendTextarea(text);
                toastr?.success?.("已生成回复并填入输入框", "VRM Pet");
                triggerPetEmotionFromText(text);
                return;
            }
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            toastr?.error?.(msg, "VRM Pet");
        }
    });

    overlay.appendChild(menu);
    // Append on the outer overlay so the menu isn't clipped by the pet shell.
    overlayEl.appendChild(overlay);

    setTimeout(() => {
        try {
            const r = menu.getBoundingClientRect();
            const petRect = overlayEl.getBoundingClientRect();
            const gap = 12;
            const maxX = Math.max(margin, window.innerWidth - r.width - margin);
            const maxY = Math.max(
                margin,
                window.innerHeight - r.height - margin,
            );

            // Prefer staying beside the pet when invoked from the pet area; otherwise anchor near the pointer.
            const invokedFromPet =
                clientX >= petRect.left &&
                clientX <= petRect.right &&
                clientY >= petRect.top &&
                clientY <= petRect.bottom;

            let x = clientX;
            let y = clientY;

            if (invokedFromPet) {
                // Prefer to the left of the pet, aligned to bottom.
                x = petRect.left - gap - r.width;
                y = petRect.bottom - r.height;

                // If no space on the left, try the right side.
                if (x < margin) x = petRect.right + gap;
            }

            x = clamp(x, margin, maxX);
            y = clamp(y, margin, maxY);
            menu.style.left = `${Math.round(x)}px`;
            menu.style.top = `${Math.round(y)}px`;
        } catch (_) {}
    }, 0);
}

function stopRenderLoop() {
    if (vrmRenderState.rafId) {
        cancelAnimationFrame(vrmRenderState.rafId);
        vrmRenderState.rafId = null;
    }
    if (vrmRenderState.resizeObserver) {
        try {
            vrmRenderState.resizeObserver.disconnect();
        } catch (_) {}
        vrmRenderState.resizeObserver = null;
    }
}

function bindGlobalPointerTracking() {
    if (vrmRenderState.pointer.bound) return;
    vrmRenderState.pointer.bound = true;

    // Track pointer anywhere in the app window (not just inside the overlay).
    window.addEventListener(
        "pointermove",
        (e) => {
            const w = Math.max(1, window.innerWidth);
            const h = Math.max(1, window.innerHeight);
            // Normalized device coords (-1..1). y is up.
            vrmRenderState.pointer.ndcX = (e.clientX / w) * 2 - 1;
            vrmRenderState.pointer.ndcY = 1 - (e.clientY / h) * 2;
            vrmRenderState.pointer.lastMoveAt = performance.now();
        },
        { passive: true },
    );
}

function applyLookTracking(delta) {
    const vrm = vrmRenderState.currentVrm;
    if (!vrm) return;
    if (!pluginConfig.enabled || !pluginConfig.showOverlay) return;
    if (!pluginConfig.headTrackEnabled && !pluginConfig.eyeTrackEnabled) return;

    if (!vrm.scene.userData.__vrmPetBones) initPetActionRig(vrm);
    const bones = vrm.scene.userData.__vrmPetBones ?? null;
    const rest = vrm.scene.userData.__vrmPetBoneRest ?? null;
    if (!bones || !rest) return;

    const now = performance.now();
    const recentlyMoved = now - (vrmRenderState.pointer.lastMoveAt || 0) < 1800;

    const targetX = recentlyMoved
        ? clamp(vrmRenderState.pointer.ndcX || 0, -1, 1)
        : 0;
    const targetY = recentlyMoved
        ? clamp(vrmRenderState.pointer.ndcY || 0, -1, 1)
        : 0;

    // Smoothly approach target to reduce jitter.
    const k = 10;
    const a = 1 - Math.exp(-k * Math.max(0, delta));
    vrmRenderState.pointer.smoothX +=
        (targetX - vrmRenderState.pointer.smoothX) * a;
    vrmRenderState.pointer.smoothY +=
        (targetY - vrmRenderState.pointer.smoothY) * a;

    // Clamp to small angles; different models have different axes, so keep it subtle.
    const headYawMax = THREE.MathUtils.degToRad(
        clamp(Number(pluginConfig.headTrackMaxYawDeg) || 16, 0, 35),
    );
    const headPitchMax = THREE.MathUtils.degToRad(
        clamp(Number(pluginConfig.headTrackMaxPitchDeg) || 10, 0, 25),
    );

    const eyeYawMax = THREE.MathUtils.degToRad(
        clamp(Number(pluginConfig.eyeTrackMaxYawDeg) || 6, 0, 18),
    );
    const eyePitchMax = THREE.MathUtils.degToRad(
        clamp(Number(pluginConfig.eyeTrackMaxPitchDeg) || 4, 0, 12),
    );

    // Map mouse -> yaw/pitch (note: yaw sign feels more natural with -X).
    const sx = vrmRenderState.pointer.smoothX || 0;
    const sy = vrmRenderState.pointer.smoothY || 0;
    const baseYaw = -sx * headYawMax;
    const basePitch = sy * headPitchMax;

    const extraYaw = pluginConfig.eyeTrackEnabled ? -sx * eyeYawMax : 0;
    const extraPitch = pluginConfig.eyeTrackEnabled ? sy * eyePitchMax : 0;

    const neck = bones.neck;
    const head = bones.head;
    const spine = bones.spine;
    const chest = bones.chest ?? bones.upperChest;

    const qTmp = new THREE.Quaternion();
    const eTmp = new THREE.Euler();

    // Apply small offsets on top of whatever pose was computed this frame (idle action / gait / etc).
    // Because those systems reset from rest every frame, this won't accumulate.
    if (pluginConfig.headTrackEnabled) {
        if (spine && rest.spine) {
            eTmp.set(basePitch * 0.1, baseYaw * 0.1, 0, "XYZ");
            qTmp.setFromEuler(eTmp);
            spine.quaternion.multiply(qTmp);
        }
        if (chest) {
            eTmp.set(basePitch * 0.12, baseYaw * 0.12, 0, "XYZ");
            qTmp.setFromEuler(eTmp);
            chest.quaternion.multiply(qTmp);
        }
        if (neck) {
            eTmp.set(basePitch * 0.38, baseYaw * 0.38, 0, "XYZ");
            qTmp.setFromEuler(eTmp);
            neck.quaternion.multiply(qTmp);
        }
        if (head) {
            eTmp.set(
                basePitch * 0.52 + extraPitch,
                baseYaw * 0.52 + extraYaw,
                0,
                "XYZ",
            );
            qTmp.setFromEuler(eTmp);
            head.quaternion.multiply(qTmp);
        }
    } else if (pluginConfig.eyeTrackEnabled) {
        // Eye-only mode: tiny head/neck offsets.
        if (neck) {
            eTmp.set(extraPitch * 0.45, extraYaw * 0.45, 0, "XYZ");
            qTmp.setFromEuler(eTmp);
            neck.quaternion.multiply(qTmp);
        }
        if (head) {
            eTmp.set(extraPitch * 0.55, extraYaw * 0.55, 0, "XYZ");
            qTmp.setFromEuler(eTmp);
            head.quaternion.multiply(qTmp);
        }
    }
}

function updateIdleScheduler() {
    if (!pluginConfig.enabled || !pluginConfig.showOverlay) return;
    if (!pluginConfig.idleEnabled) return;
    if (!vrmRenderState.currentVrm) return;
    if (vrmRenderState.petAction.active) return;
    if (pluginConfig.idleOnlyWhenNotWandering && pluginConfig.wanderEnabled)
        return;
    if (vrmRenderState.dragLift.active) return;

    const now = performance.now();
    const last = vrmRenderState.interaction.lastAt || 0;

    // Ensure we have a schedule.
    if (!vrmRenderState.idle.nextAt) {
        vrmRenderState.idle.nextAt =
            now + randRange(pluginConfig.idleMinMs, pluginConfig.idleMaxMs);
        return;
    }

    // If the user recently interacted, don't run idle actions.
    if (now - last < Math.max(0, Number(pluginConfig.idleMinMs) || 6000) * 0.85)
        return;

    if (now >= vrmRenderState.idle.nextAt) {
        playRandomPetAction("idle");
        // Treat idle action as an "interaction" so we don't spam actions back-to-back.
        markInteraction();
    }
}

function updateBlink(delta) {
    if (!pluginConfig.enabled || !pluginConfig.showOverlay) return;
    if (!pluginConfig.blinkEnabled) return;
    const vrm = vrmRenderState.currentVrm;
    if (!vrm) return;

    const em = vrm.expressionManager;
    if (!em?.setValue) return;

    const now = performance.now();
    if (!vrmRenderState.blink.nextAt) scheduleNextBlink(now);

    // Avoid starting a blink mid-action; actions already may blink near the end.
    if (!vrmRenderState.blink.active && vrmRenderState.petAction.active) return;

    if (!vrmRenderState.blink.active && now >= vrmRenderState.blink.nextAt) {
        vrmRenderState.blink.active = true;
        vrmRenderState.blink.t = 0;
    }

    if (!vrmRenderState.blink.active) return;

    vrmRenderState.blink.t += Math.max(0, delta);
    const d = Math.max(0.06, Number(vrmRenderState.blink.duration) || 0.18);
    const p = clamp01(vrmRenderState.blink.t / d);
    // Close then open (triangular pulse).
    const v = p < 0.5 ? p * 2 : (1 - p) * 2;
    try {
        em.setValue("blink", clamp01(v));
    } catch (_) {}

    if (p >= 1) {
        vrmRenderState.blink.active = false;
        vrmRenderState.blink.t = 0;
        try {
            em.setValue("blink", 0);
        } catch (_) {}
        scheduleNextBlink(now);
    }
}

function updateWander(delta) {
    if (!pluginConfig.enabled || !pluginConfig.showOverlay) return;
    if (!pluginConfig.wanderEnabled) return;

    const now = performance.now();
    if (now < (vrmRenderState.wander.pausedUntil || 0)) return;

    const overlayEl = document.getElementById("vrm-pet-overlay");
    if (!overlayEl) return;

    const w = overlayEl.offsetWidth || Number(pluginConfig.overlayWidth) || 240;
    const h =
        overlayEl.offsetHeight || Number(pluginConfig.overlayHeight) || 240;

    // Keep it inside viewport with a small margin.
    const margin = 14;
    const maxX = Math.max(margin, window.innerWidth - w - margin);
    const maxY = Math.max(margin, window.innerHeight - h - margin);

    let x =
        typeof pluginConfig.overlayPos?.x === "number"
            ? pluginConfig.overlayPos.x
            : maxX;
    let y =
        typeof pluginConfig.overlayPos?.y === "number"
            ? pluginConfig.overlayPos.y
            : maxY;

    const speed = Math.max(10, Number(pluginConfig.wanderSpeed) || 80);
    const dx = (vrmRenderState.wander.vx || 1) * speed * delta;
    const dy = (vrmRenderState.wander.vy || 0) * speed * delta;

    x += dx;
    y += dy;

    // Bounce on edges.
    if (x <= margin) {
        x = margin;
        vrmRenderState.wander.vx = 1;
    } else if (x >= maxX) {
        x = maxX;
        vrmRenderState.wander.vx = -1;
    }

    // Default: keep near bottom if user never set a y.
    if (
        pluginConfig.overlayPos == null ||
        typeof pluginConfig.overlayPos?.y !== "number"
    ) {
        y = maxY;
    } else {
        if (y <= margin) {
            y = margin;
            vrmRenderState.wander.vy = 1;
        } else if (y >= maxY) {
            y = maxY;
            vrmRenderState.wander.vy = -1;
        }
    }

    overlayEl.style.left = `${Math.round(x)}px`;
    overlayEl.style.top = `${Math.round(y)}px`;
    overlayEl.style.right = "auto";
    overlayEl.style.bottom = "auto";

    pluginConfig.overlayPos = { x: Math.round(x), y: Math.round(y) };
}

function updateWanderGait(delta) {
    if (!pluginConfig.enabled || !pluginConfig.showOverlay) return;
    if (!pluginConfig.wanderEnabled || !pluginConfig.wanderGaitEnabled) return;
    if (vrmRenderState.petAction.active) return; // don't fight explicit actions
    const vrm = vrmRenderState.currentVrm;
    if (!vrm) return;

    const now = performance.now();
    if (now < (vrmRenderState.wander.pausedUntil || 0)) return;

    const bones = vrm.scene.userData.__vrmPetBones ?? null;
    const rest = vrm.scene.userData.__vrmPetBoneRest ?? null;
    if (!bones || !rest) return;

    const intensityRaw = Number(pluginConfig.wanderGaitIntensity);
    const intensity = Number.isFinite(intensityRaw)
        ? Math.max(0, Math.min(2, intensityRaw))
        : 1.0;
    if (intensity <= 0) return;

    // Advance gait phase. Faster wander -> slightly faster gait.
    const speed = Math.max(10, Number(pluginConfig.wanderSpeed) || 80);
    const freq = 2.2 + (speed / 200) * 1.2; // ~2.2 - 3.4 Hz
    vrmRenderState.wander.gaitTime += delta * freq;
    const phase = vrmRenderState.wander.gaitTime;

    // Reset to rest pose before applying gait offsets.
    resetPetRigToRest(vrm);

    const s = Math.sin(phase * Math.PI * 2);
    const c = Math.cos(phase * Math.PI * 2);
    const dir = (vrmRenderState.wander.vx || 1) >= 0 ? 1 : -1; // mirror when moving left

    const qTmp = new THREE.Quaternion();
    const eTmp = new THREE.Euler();

    const hips = bones.hips;
    const spine = bones.spine;
    const chest = bones.chest ?? bones.upperChest;
    const head = bones.head;
    const rUA = bones.rightUpperArm;
    const lUA = bones.leftUpperArm;
    const rLA = bones.rightLowerArm;
    const lLA = bones.leftLowerArm;
    const lUL = bones.leftUpperLeg;
    const rUL = bones.rightUpperLeg;
    const lLL = bones.leftLowerLeg;
    const rLL = bones.rightLowerLeg;
    const lF = bones.leftFoot;
    const rF = bones.rightFoot;

    // Subtle vertical bob.
    if (hips && rest.hips) {
        const amp = 0.02 * intensity;
        hips.position.y = rest.hips.position.y + amp * Math.abs(s);
    }

    // Tiny torso sway.
    if (spine) {
        const sway = THREE.MathUtils.degToRad(3.5) * intensity;
        eTmp.set(0, 0, dir * sway * s, "XYZ");
        qTmp.setFromEuler(eTmp);
        spine.quaternion.multiply(qTmp);
    }
    if (chest) {
        const sway = THREE.MathUtils.degToRad(2.0) * intensity;
        eTmp.set(0, 0, -dir * sway * s, "XYZ");
        qTmp.setFromEuler(eTmp);
        chest.quaternion.multiply(qTmp);
    }

    // Head bob.
    if (head) {
        const nod = THREE.MathUtils.degToRad(4.5) * intensity;
        eTmp.set(-nod * Math.abs(s) * 0.6, 0, 0, "XYZ");
        qTmp.setFromEuler(eTmp);
        head.quaternion.multiply(qTmp);
    }

    // Arm swing (walk in place).
    const armSwing = THREE.MathUtils.degToRad(22) * intensity;
    const armOut = THREE.MathUtils.degToRad(6) * intensity;
    if (lUA) {
        eTmp.set(armSwing * s * 0.75, 0, -dir * armOut * c, "XYZ");
        qTmp.setFromEuler(eTmp);
        lUA.quaternion.multiply(qTmp);
    }
    if (rUA) {
        eTmp.set(-armSwing * s * 0.75, 0, dir * armOut * c, "XYZ");
        qTmp.setFromEuler(eTmp);
        rUA.quaternion.multiply(qTmp);
    }

    // Slight elbow bend.
    const elbow = THREE.MathUtils.degToRad(18) * intensity;
    if (lLA) {
        eTmp.set(-elbow * (0.35 + 0.65 * Math.abs(s)), 0, 0, "XYZ");
        qTmp.setFromEuler(eTmp);
        lLA.quaternion.multiply(qTmp);
    }
    if (rLA) {
        eTmp.set(-elbow * (0.35 + 0.65 * Math.abs(s)), 0, 0, "XYZ");
        qTmp.setFromEuler(eTmp);
        rLA.quaternion.multiply(qTmp);
    }

    // Leg swing (simple walk cycle).
    // Note: raw bone axes can vary by model, but this is usually "good enough" for a cute overlay gait.
    const legSwing = THREE.MathUtils.degToRad(28) * intensity;
    if (lUL) {
        eTmp.set(-legSwing * s * 0.9, 0, 0, "XYZ");
        qTmp.setFromEuler(eTmp);
        lUL.quaternion.multiply(qTmp);
    }
    if (rUL) {
        eTmp.set(legSwing * s * 0.9, 0, 0, "XYZ");
        qTmp.setFromEuler(eTmp);
        rUL.quaternion.multiply(qTmp);
    }

    // Knee bend: bend more when the leg is moving back (approx) + always a bit for "bounce".
    const knee = THREE.MathUtils.degToRad(26) * intensity;
    const kneeL = Math.max(0, -s); // left bends when left leg goes back
    const kneeR = Math.max(0, s); // right bends when right leg goes back
    if (lLL) {
        eTmp.set(-knee * (0.15 + 0.85 * kneeL), 0, 0, "XYZ");
        qTmp.setFromEuler(eTmp);
        lLL.quaternion.multiply(qTmp);
    }
    if (rLL) {
        eTmp.set(-knee * (0.15 + 0.85 * kneeR), 0, 0, "XYZ");
        qTmp.setFromEuler(eTmp);
        rLL.quaternion.multiply(qTmp);
    }

    // Foot compensation so it doesn't look like toes are always pointing down.
    const foot = THREE.MathUtils.degToRad(10) * intensity;
    if (lF) {
        eTmp.set(foot * kneeL, 0, 0, "XYZ");
        qTmp.setFromEuler(eTmp);
        lF.quaternion.multiply(qTmp);
    }
    if (rF) {
        eTmp.set(foot * kneeR, 0, 0, "XYZ");
        qTmp.setFromEuler(eTmp);
        rF.quaternion.multiply(qTmp);
    }
}

function updateWanderFacing(delta) {
    const vrm = vrmRenderState.currentVrm;
    if (!vrm) return;
    if (!pluginConfig.enabled || !pluginConfig.showOverlay) return;

    const now = performance.now();
    const paused = now < (vrmRenderState.wander.pausedUntil || 0);
    const activelyWandering = !!pluginConfig.wanderEnabled && !paused;

    const rest = vrm.scene?.userData?.__vrmPetRootRest ?? null;
    if (!rest?.quaternion) return;

    const faceEnabled = !!pluginConfig.wanderFaceEnabled;
    const angleDegRaw = Number(pluginConfig.wanderFaceAngleDeg);
    const angleDeg = Number.isFinite(angleDegRaw)
        ? Math.max(0, Math.min(90, angleDegRaw))
        : 45;

    // When wandering: face 45deg in movement direction. Otherwise: face front (0deg).
    const targetYaw =
        faceEnabled && activelyWandering
            ? THREE.MathUtils.degToRad(angleDeg) *
              ((vrmRenderState.wander.vx || 1) >= 0 ? 1 : -1)
            : 0;

    // Smoothly approach the target yaw.
    const k = 10; // larger = snappier
    const a = 1 - Math.exp(-k * Math.max(0, delta));
    vrmRenderState.wander.faceYaw +=
        (targetYaw - vrmRenderState.wander.faceYaw) * a;
}

function updateDragLift(delta) {
    if (!pluginConfig.enabled || !pluginConfig.showOverlay) return;
    if (!pluginConfig.dragLiftEnabled) return;

    const st = vrmRenderState.dragLift;
    const k = 14; // larger = snappier
    const a = 1 - Math.exp(-k * Math.max(0, delta));
    st.lift += (st.targetLift - st.lift) * a;
    st.tiltX += (st.targetTiltX - st.tiltX) * a;
    st.tiltZ += (st.targetTiltZ - st.tiltZ) * a;
    st.time += Math.max(0, delta);

    // When released and nearly at rest, stop applying tiny residuals.
    if (!st.active) {
        if (Math.abs(st.lift) < 1e-4) st.lift = 0;
        if (Math.abs(st.tiltX) < 1e-4) st.tiltX = 0;
        if (Math.abs(st.tiltZ) < 1e-4) st.tiltZ = 0;
    }
}

function ensureBaseRigPose() {
    const vrm = vrmRenderState.currentVrm;
    if (!vrm) return;
    if (!pluginConfig.enabled || !pluginConfig.showOverlay) return;

    if (!vrm.scene.userData.__vrmPetBones) initPetActionRig(vrm);
    const bones = vrm.scene.userData.__vrmPetBones ?? null;
    const rest = vrm.scene.userData.__vrmPetBoneRest ?? null;
    if (!bones || !rest) return;

    // If no explicit action and no wander gait, keep a stable base pose (prevents drift).
    const now = performance.now();
    const gaitActive =
        !!pluginConfig.wanderEnabled &&
        !!pluginConfig.wanderGaitEnabled &&
        now >= (vrmRenderState.wander.pausedUntil || 0);
    if (!vrmRenderState.petAction.active && !gaitActive) {
        resetPetRigToRest(vrm);
    }
}

function applyRelaxOrDragPose(delta) {
    const vrm = vrmRenderState.currentVrm;
    if (!vrm) return;
    if (!pluginConfig.enabled || !pluginConfig.showOverlay) return;
    if (vrmRenderState.petAction.active) return; // don't fight actions

    if (!vrm.scene.userData.__vrmPetBones) initPetActionRig(vrm);
    const bones = vrm.scene.userData.__vrmPetBones ?? null;
    const rest = vrm.scene.userData.__vrmPetBoneRest ?? null;
    if (!bones || !rest) return;

    const now = performance.now();
    const gaitActive =
        !!pluginConfig.wanderEnabled &&
        !!pluginConfig.wanderGaitEnabled &&
        now >= (vrmRenderState.wander.pausedUntil || 0);
    if (gaitActive && !pluginConfig.relaxArmsDuringWanderGait) return;

    const lUA = bones.leftUpperArm;
    const rUA = bones.rightUpperArm;
    const lLA = bones.leftLowerArm;
    const rLA = bones.rightLowerArm;
    if (!lUA && !rUA) return;

    const qTmp = new THREE.Quaternion();
    const eTmp = new THREE.Euler();

    // Drag pose has priority.
    if (pluginConfig.dragHeldPoseEnabled && vrmRenderState.dragLift.active) {
        const v = Number(pluginConfig.dragHeldPoseIntensity);
        const intensity = Number.isFinite(v) ? clamp(v, 0, 2) : 1.0;
        if (intensity <= 0) return;

        // Map lift (0..?) to 0..1 strength.
        const sizeY = vrm.scene.userData.__vrmPetBBoxSizeY ?? 1.6;
        const liftNorm = clamp(
            (vrmRenderState.dragLift.lift || 0) / Math.max(0.25, sizeY * 0.12),
            0,
            1,
        );

        // A little sway while held.
        const t = vrmRenderState.dragLift.time || 0;
        const sway = Math.sin(t * 6.0) * 0.5 + Math.sin(t * 3.2) * 0.5;

        const raise =
            THREE.MathUtils.degToRad(28) * intensity * (0.35 + 0.65 * liftNorm);
        const out = THREE.MathUtils.degToRad(10) * intensity;
        const roll = THREE.MathUtils.degToRad(14) * intensity;
        const bend = THREE.MathUtils.degToRad(22) * intensity;

        if (lUA) {
            eTmp.set(
                -raise * 0.75,
                0,
                +roll * 0.6 + out * 0.6 + roll * 0.25 * sway,
                "XYZ",
            );
            qTmp.setFromEuler(eTmp);
            lUA.quaternion.multiply(qTmp);
        }
        if (rUA) {
            eTmp.set(
                -raise * 0.75,
                0,
                -roll * 0.6 - out * 0.6 - roll * 0.25 * sway,
                "XYZ",
            );
            qTmp.setFromEuler(eTmp);
            rUA.quaternion.multiply(qTmp);
        }
        if (lLA) {
            eTmp.set(-bend * (0.35 + 0.65 * liftNorm), 0, 0, "XYZ");
            qTmp.setFromEuler(eTmp);
            lLA.quaternion.multiply(qTmp);
        }
        if (rLA) {
            eTmp.set(-bend * (0.35 + 0.65 * liftNorm), 0, 0, "XYZ");
            qTmp.setFromEuler(eTmp);
            rLA.quaternion.multiply(qTmp);
        }

        return;
    }

    if (!pluginConfig.relaxArmsEnabled) return;

    const modeRaw = String(pluginConfig.relaxArmsMode || "auto");
    const mode =
        modeRaw === "xpitch"
            ? "xpitch"
            : modeRaw === "zroll"
              ? "zroll"
              : "auto";

    const downDegRaw = Number(pluginConfig.relaxArmsDownDeg);
    const downDeg = Number.isFinite(downDegRaw) ? clamp(downDegRaw, 0, 80) : 55;
    const fwdDegRaw = Number(pluginConfig.relaxArmsForwardDeg);
    const fwdDeg = Number.isFinite(fwdDegRaw) ? clamp(fwdDegRaw, -25, 35) : 10;
    const outDegRaw = Number(pluginConfig.relaxArmsOutDeg);
    const outDeg = Number.isFinite(outDegRaw) ? clamp(outDegRaw, -25, 25) : 8;
    const bendDegRaw = Number(pluginConfig.relaxArmsElbowBendDeg);
    const bendDeg = Number.isFinite(bendDegRaw) ? clamp(bendDegRaw, 0, 35) : 16;

    const down = THREE.MathUtils.degToRad(downDeg);
    const fwd = THREE.MathUtils.degToRad(fwdDeg);
    const out = THREE.MathUtils.degToRad(outDeg);
    const bend = THREE.MathUtils.degToRad(bendDeg);

    if (mode === "auto") {
        const picked = ensureRelaxAxisCache(vrm);

        const applyPicked = (ua, pickedSide, sideZSign) => {
            if (!ua) return;
            const p = pickedSide ?? { axis: "z", sign: sideZSign };

            // Base offsets to keep hands visible.
            let rx = -fwd;
            let ry = sideZSign > 0 ? +out : -out;
            let rz = 0;

            const radDown = down * (p.sign || 1);
            if (p.axis === "x") rx += radDown;
            else if (p.axis === "y") ry += radDown;
            else rz += radDown;

            eTmp.set(rx, ry, rz, "XYZ");
            qTmp.setFromEuler(eTmp);
            ua.quaternion.multiply(qTmp);
        };

        applyPicked(lUA, picked?.left, 1);
        applyPicked(rUA, picked?.right, -1);
    } else if (mode === "zroll") {
        // Many rigs: lowering arms from T-pose looks reasonable by rolling upper arms around Z.
        if (lUA) {
            // Add a small forward + outward bias so hands stay visible instead of clipping into the chest.
            eTmp.set(-fwd, +out, +down, "XYZ");
            qTmp.setFromEuler(eTmp);
            lUA.quaternion.multiply(qTmp);
        }
        if (rUA) {
            eTmp.set(-fwd, -out, -down, "XYZ");
            qTmp.setFromEuler(eTmp);
            rUA.quaternion.multiply(qTmp);
        }
    } else {
        // Some rigs: Z-roll sends arms "behind" instead of down; try X-pitch as a simpler alternative.
        if (lUA) {
            eTmp.set(+down, +fwd * 0.35, +out * 0.85, "XYZ");
            qTmp.setFromEuler(eTmp);
            lUA.quaternion.multiply(qTmp);
        }
        if (rUA) {
            eTmp.set(+down, -fwd * 0.35, -out * 0.85, "XYZ");
            qTmp.setFromEuler(eTmp);
            rUA.quaternion.multiply(qTmp);
        }
    }
    if (lLA) {
        eTmp.set(-bend, 0, 0, "XYZ");
        qTmp.setFromEuler(eTmp);
        lLA.quaternion.multiply(qTmp);
    }
    if (rLA) {
        eTmp.set(-bend, 0, 0, "XYZ");
        qTmp.setFromEuler(eTmp);
        rLA.quaternion.multiply(qTmp);
    }
}

function applyRootPose() {
    const vrm = vrmRenderState.currentVrm;
    if (!vrm) return;

    const rest = vrm.scene?.userData?.__vrmPetRootRest ?? null;
    if (!rest?.position || !rest?.quaternion) return;

    // Position: base + drag lift offset.
    const dragEnabled = !!pluginConfig.dragLiftEnabled;
    const liftY = dragEnabled ? vrmRenderState.dragLift.lift || 0 : 0;
    vrm.scene.position.copy(rest.position);
    vrm.scene.position.y += liftY;

    // Rotation: base * wander yaw * drag tilt.
    const qBase = rest.quaternion;
    const qYaw = new THREE.Quaternion().setFromAxisAngle(
        new THREE.Vector3(0, 1, 0),
        vrmRenderState.wander.faceYaw || 0,
    );
    const qTilt = new THREE.Quaternion().setFromEuler(
        new THREE.Euler(
            dragEnabled ? vrmRenderState.dragLift.tiltX || 0 : 0,
            0,
            dragEnabled ? vrmRenderState.dragLift.tiltZ || 0 : 0,
            "XYZ",
        ),
    );

    vrm.scene.quaternion.copy(qBase).multiply(qYaw).multiply(qTilt);
}

function replaceVrmMaterialsForCompatibility(root) {
    if (!root) return;

    // Our vendored three-vrm (v2.0.0) MToon shaders are not compatible with Three r161.
    // Fallback to MeshBasicMaterial so models render (skinning included) and colors are visible even without lighting.
    //
    // Additionally, some models may ship with MeshStandard/Physical materials; for consistent "has color" UX
    // we also downgrade those to MeshBasicMaterial.
    let meshCount = 0;
    let replacedCount = 0;
    let withMapCount = 0;
    let hiddenOutlineMeshCount = 0;
    let forcedWhiteCount = 0;

    root.traverse((obj) => {
        if (!obj || !obj.isMesh) return;
        meshCount++;

        const hasUv = !!obj.geometry?.getAttribute?.("uv");
        const mats = Array.isArray(obj.material)
            ? obj.material
            : [obj.material];

        // VRM0 MToon often creates separate outline meshes/materials.
        // If we downgrade those outline materials to MeshBasic without the outline vertex expansion,
        // the outline draw-call can z-fight and overwrite the base mesh, resulting in a black silhouette.
        //
        // Hide outline-only meshes; we only want the "base" mesh for the pet overlay.
        const isOutlineLike = (m) =>
            !!m &&
            (m.isOutline === true ||
                (typeof m.name === "string" && m.name.includes("Outline")) ||
                (typeof obj.name === "string" && obj.name.includes("Outline")));
        if (mats.length > 0 && mats.every(isOutlineLike)) {
            obj.visible = false;
            hiddenOutlineMeshCount++;
            return;
        }

        let changed = false;

        const nextMats = mats.map((m) => {
            if (!m) return m;

            // If the mesh uses multi-material and one of them is an outline material, make it fully invisible.
            // Otherwise it can overwrite the base draw with a solid color.
            if (isOutlineLike(m)) {
                changed = true;
                replacedCount++;
                const invisible = new THREE.MeshBasicMaterial({
                    color: 0x000000,
                    transparent: true,
                    opacity: 0.0,
                    depthWrite: false,
                    depthTest: m.depthTest,
                    side: m.side ?? THREE.DoubleSide,
                });
                if (obj.isSkinnedMesh) invisible.skinning = true;
                return invisible;
            }

            const isMToon = !!(m.isShaderMaterial && m.isMToonMaterial);
            // In the overlay, prefer "always visible" unlit materials.
            // Downgrade most lit/shader materials to MeshBasicMaterial to avoid black renders when lighting/shaders mismatch.
            const isLitMaterial = !!(
                m.isMeshStandardMaterial ||
                m.isMeshPhysicalMaterial ||
                m.isMeshPhongMaterial ||
                m.isMeshLambertMaterial ||
                m.isMeshToonMaterial ||
                m.isMeshMatcapMaterial
            );
            const isUnknownShader = !!(
                m.isShaderMaterial && !m.isMeshBasicMaterial
            );
            if (!isMToon && !isLitMaterial && !isUnknownShader) return m;
            changed = true;
            replacedCount++;

            const mapTexRaw =
                m.map ??
                m.uniforms?.map?.value ??
                m.emissiveMap ??
                m.uniforms?.emissiveMap?.value ??
                null;
            // If the mesh has no UVs, sampling a texture will produce a solid (often black) silhouette.
            const mapTex = hasUv ? mapTexRaw : null;

            // If we end up without a texture, prefer a visible base color (some materials may default to black).
            const baseColor = m.color?.clone?.() ?? new THREE.Color(1, 1, 1);
            if (
                (!mapTex || mapTex === null) &&
                baseColor.r <= 0.01 &&
                baseColor.g <= 0.01 &&
                baseColor.b <= 0.01
            ) {
                baseColor.setRGB(1, 1, 1);
                forcedWhiteCount++;
            }
            // Textures are multiplied by `color`; if the source material color is (near) black, it will blacken the map.
            if (
                mapTex &&
                baseColor.r <= 0.01 &&
                baseColor.g <= 0.01 &&
                baseColor.b <= 0.01
            ) {
                baseColor.setRGB(1, 1, 1);
                forcedWhiteCount++;
            }

            const base = new THREE.MeshBasicMaterial({
                color: baseColor,
                // Prefer baseColor map; fall back to emissive map if that's all we have.
                map: mapTex,
                transparent: !!m.transparent,
                opacity: typeof m.opacity === "number" ? m.opacity : 1,
                // For the overlay, DoubleSide avoids "hair disappears when side-walking" on plane-based meshes.
                side: THREE.DoubleSide,
            });

            // Ensure baseColor textures show correct colors (srgb).
            if (base.map) {
                // glTF baseColor textures are sRGB. If we got an emissive map as a fallback, sRGB is also typically correct.
                base.map.colorSpace = THREE.SRGBColorSpace;
                // glTF textures should be flipY=false; enforce for robustness (some custom pipelines leave it true).
                if (typeof base.map.flipY === "boolean") base.map.flipY = false;
                base.map.needsUpdate = true;
                withMapCount++;
            }

            // Vertex colors can accidentally turn meshes black if the attribute exists but is all-zero.
            // Only enable vertex colors as a last resort when no texture is present and the source material opted into it.
            if (!base.map && m.vertexColors === true) base.vertexColors = true;

            // Always double-side in overlay.

            // Skinned meshes need skinning enabled on the material.
            if (obj.isSkinnedMesh) base.skinning = true;

            if (typeof m.alphaTest === "number") base.alphaTest = m.alphaTest;
            if (m.alphaMap) base.alphaMap = m.alphaMap;
            base.depthWrite = m.depthWrite;
            base.depthTest = m.depthTest;

            return base;
        });

        if (!changed) return;

        obj.material = Array.isArray(obj.material) ? nextMats : nextMats[0];
    });

    log(
        `Material compat: meshes=${meshCount} replaced=${replacedCount} maps=${withMapCount} hiddenOutlineMeshes=${hiddenOutlineMeshCount} forcedWhite=${forcedWhiteCount}`,
    );
}

function disposeCurrentVrm() {
    if (!vrmRenderState.scene) return;
    if (!vrmRenderState.currentVrm) return;

    try {
        vrmRenderState.scene.remove(vrmRenderState.currentVrm.scene);
        // Dispose GPU resources as much as possible.
        VRMUtils.deepDispose(vrmRenderState.currentVrm.scene);
    } catch (e) {
        console.warn("[VRM Pet] Failed disposing VRM", e);
    }

    vrmRenderState.currentVrm = null;
    vrmRenderState.currentUrl = "";
}

function resizeRendererToOverlay(overlayEl) {
    const stage = overlayEl.querySelector(".vrm-pet-stage");
    if (!stage) return;
    if (!vrmRenderState.renderer || !vrmRenderState.camera) return;

    const w = stage.clientWidth || overlayEl.clientWidth || 1;
    const h = stage.clientHeight || overlayEl.clientHeight || 1;

    vrmRenderState.renderer.setSize(w, h, false);
    vrmRenderState.camera.aspect = w / h;
    vrmRenderState.camera.updateProjectionMatrix();
}

async function ensureRenderer(overlayEl) {
    if (vrmRenderState.initialized) return;
    if (vrmRenderState.initPromise) return vrmRenderState.initPromise;

    vrmRenderState.initPromise = (async () => {
        const stage = overlayEl.querySelector(".vrm-pet-stage");
        if (!stage) throw new Error("Overlay stage not found");

        // Prefer WebGL2 (VRMs are usually skinned; Three r161 skinning shaders require WebGL2 for bone textures).
        const canvas = document.createElement("canvas");
        const context =
            canvas.getContext("webgl2", {
                alpha: true,
                antialias: true,
                premultipliedAlpha: false,
            }) ||
            canvas.getContext("webgl", {
                alpha: true,
                antialias: true,
                premultipliedAlpha: false,
            }) ||
            canvas.getContext("experimental-webgl", {
                alpha: true,
                antialias: true,
                premultipliedAlpha: false,
            });
        if (!context) throw new Error("WebGL not supported");

        const renderer = new THREE.WebGLRenderer({
            canvas,
            context,
            antialias: true,
            alpha: true,
        });
        THREE.ColorManagement.enabled = true;
        renderer.outputColorSpace = THREE.SRGBColorSpace;
        renderer.toneMapping = THREE.NoToneMapping;
        renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
        renderer.setClearColor(0x000000, 0);
        stage.appendChild(renderer.domElement);

        const scene = new THREE.Scene();
        const camera = new THREE.PerspectiveCamera(30, 1, 0.01, 1000);
        camera.position.set(0, 1.4, 2.2);
        // three-vrm may assign some meshes to non-default layers (e.g. first-person setup).
        // To avoid "loaded but invisible" issues, render all layers in the overlay.
        camera.layers.enableAll();

        const ambient = new THREE.AmbientLight(0xffffff, 0.65);
        scene.add(ambient);
        const dir = new THREE.DirectionalLight(0xffffff, 0.85);
        dir.position.set(1, 2, 3);
        scene.add(dir);

        vrmRenderState.renderer = renderer;
        vrmRenderState.scene = scene;
        vrmRenderState.camera = camera;
        vrmRenderState.clock = new THREE.Clock();
        vrmRenderState.initialized = true;

        resizeRendererToOverlay(overlayEl);

        // Keep renderer sized to the overlay.
        vrmRenderState.resizeObserver = new ResizeObserver(() =>
            resizeRendererToOverlay(overlayEl),
        );
        vrmRenderState.resizeObserver.observe(overlayEl);

        startRenderLoop();
        bindStageInteractions(overlayEl);
    })();

    return vrmRenderState.initPromise;
}

function startRenderLoop() {
    if (vrmRenderState.rafId) return;
    if (
        !vrmRenderState.renderer ||
        !vrmRenderState.scene ||
        !vrmRenderState.camera ||
        !vrmRenderState.clock
    )
        return;

    const tick = () => {
        vrmRenderState.rafId = requestAnimationFrame(tick);
        const delta = vrmRenderState.clock.getDelta();
        if (vrmRenderState.currentVrm) {
            try {
                vrmRenderState.currentVrm.update(delta);
            } catch (_) {}
        }
        ensureBaseRigPose();
        updatePetAction(delta);
        updateIdleScheduler();
        updateWander(delta);
        updateWanderGait(delta);
        applyRelaxOrDragPose(delta);
        applyLookTracking(delta);
        updateWanderFacing(delta);
        updateDragLift(delta);
        applyRootPose();
        updateExpressionFx(delta);
        updateBlink(delta);
        vrmRenderState.renderer.render(
            vrmRenderState.scene,
            vrmRenderState.camera,
        );
    };

    vrmRenderState.rafId = requestAnimationFrame(tick);
}

// -----------------------------
// Procedural "pet actions"
// -----------------------------

function easeInOutSine(t) {
    return 0.5 - 0.5 * Math.cos(Math.PI * t);
}

function clamp01(t) {
    return Math.max(0, Math.min(1, t));
}

function setExpressionValueSafe(vrm, name, value) {
    try {
        const em = vrm?.expressionManager;
        if (!em?.setValue) return false;
        em.setValue(String(name), clamp01(Number(value) || 0));
        return true;
    } catch (_) {
        return false;
    }
}

function clearPetExpressionPresets(vrm) {
    // Keep this list small and safe: only presets we control.
    const names = [
        "happy",
        "angry",
        "sad",
        "relaxed",
        "surprised",
        // some VRM0 models use different blendshape names
        "joy",
        "smile",
        "sorrow",
    ];
    for (const n of names) setExpressionValueSafe(vrm, n, 0);
}

function applyPetEmotion(emotion, opts = {}) {
    const e = String(emotion || "").toLowerCase();
    const now = performance.now();

    vrmRenderState.expressionFx.active = e || null;
    vrmRenderState.expressionFx.startedAt = now;
    vrmRenderState.expressionFx.until =
        now + clamp(Number(opts.durationMs) || 1400, 300, 6000);
    vrmRenderState.expressionFx.fadeInMs = clamp(
        Number(opts.fadeInMs) || 140,
        0,
        1200,
    );
    vrmRenderState.expressionFx.fadeOutMs = clamp(
        Number(opts.fadeOutMs) || 220,
        0,
        1200,
    );
    vrmRenderState.expressionFx.strength = 0;

    // Trigger lightweight overlay FX immediately (optional; doesn't depend on VRM expressions).
    if (e === "happy") {
        const overlayEl = document.getElementById("vrm-pet-overlay");
        const r = overlayEl?.getBoundingClientRect?.();
        if (r)
            spawnHeartsAtClientPoint(
                r.left + r.width * 0.55,
                r.top + r.height * 0.2,
            );
    } else if (e === "angry") {
        spawnPetEmojiFx("\uD83D\uDCA2"); // 💢
    } else if (e === "speechless") {
        spawnPetEmojiFx("\uD83D\uDE11"); // 😑
    } else if (e === "blackface") {
        spawnPetBlackFaceFx();
    }
}

function updateExpressionFx(delta) {
    const vrm = vrmRenderState.currentVrm;
    const fx = vrmRenderState.expressionFx;
    if (!vrm || !fx?.active) return;

    const now = performance.now();
    const fadeIn = Math.max(0, Number(fx.fadeInMs) || 0);
    const fadeOut = Math.max(0, Number(fx.fadeOutMs) || 0);
    const tIn =
        fadeIn <= 0 ? 1 : clamp01((now - (fx.startedAt || now)) / fadeIn);
    const tOut =
        fadeOut <= 0
            ? 0
            : now >= (fx.until || 0)
              ? clamp01((now - (fx.until || now)) / fadeOut)
              : 0;
    const target = clamp01(tIn * (1 - tOut));

    // Smooth it slightly so it doesn't snap with variable FPS.
    const k = 14;
    const a = 1 - Math.exp(-k * Math.max(0, delta));
    fx.strength += (target - (fx.strength || 0)) * a;
    const s = clamp01(fx.strength || 0);

    // When finished, fully clear.
    if (now > (fx.until || 0) + fadeOut + 10) {
        clearPetExpressionPresets(vrm);
        fx.active = null;
        fx.strength = 0;
        return;
    }

    // Apply expression presets (best-effort).
    // Many VRMs don't support all presets; failures are ignored.
    clearPetExpressionPresets(vrm);

    if (fx.active === "happy") {
        setExpressionValueSafe(vrm, "happy", s);
        setExpressionValueSafe(vrm, "joy", s);
        setExpressionValueSafe(vrm, "smile", s);
        setExpressionValueSafe(vrm, "relaxed", s * 0.35);
    } else if (fx.active === "angry") {
        setExpressionValueSafe(vrm, "angry", s);
    } else if (fx.active === "speechless") {
        // There is no guaranteed VRM preset for "speechless"; approximate gently.
        setExpressionValueSafe(vrm, "sad", s * 0.25);
        setExpressionValueSafe(vrm, "sorrow", s * 0.25);
        setExpressionValueSafe(vrm, "angry", s * 0.1);
    } else if (fx.active === "blackface") {
        // Some models have a "sad/angry" look that works for "blackface"; prefer overlay FX anyway.
        setExpressionValueSafe(vrm, "angry", s * 0.35);
        setExpressionValueSafe(vrm, "sad", s * 0.25);
    }
}

function detectPetEmotionFromText(text) {
    const s = String(text ?? "");
    if (!s.trim()) return null;

    // Blackface.
    if (/[（(]?\s*黑脸\s*[)）]?/.test(s) || /(黑脸|黑著脸|黑着脸)/.test(s))
        return "blackface";

    // Speechless / annoyed / awkward silence.
    if (
        /(无语|呵呵|呵呵哒|服了|沉默|尴尬|好吧|行吧|算了|……{2,}|(?:\.\.){3,})/.test(
            s,
        )
    )
        return "speechless";

    // Angry.
    if (/(生气|气死|愤怒|怒|火大|别闹|讨厌|哼|气炸|爆炸|怒了|翻车)/.test(s))
        return "angry";

    // Happy.
    if (
        /(开心|高兴|好耶|太好啦|喜欢|爱你|可爱|棒|耶|哈哈|笑死|嘻嘻|嘿嘿)/.test(
            s,
        )
    )
        return "happy";

    return null;
}

function triggerPetEmotionFromText(text) {
    const emo = detectPetEmotionFromText(stripThinkTags(text));
    if (!emo) return;
    applyPetEmotion(emo, { durationMs: 1600 });
}

async function buildAiReplyContextText({ ctx, maxMessages = 24 }) {
    const nameUser = String(ctx?.name1 || "User");
    const nameChar = String(ctx?.name2 || "Assistant");
    const chat = Array.isArray(ctx?.chat) ? ctx.chat : [];
    const tail = chat.slice(-Math.max(4, Number(maxMessages) || 24));

    const lines = [];
    for (const m of tail) {
        const isUser = !!m?.is_user;
        const who = isUser ? nameUser : m?.name || nameChar;
        const mes = stripThinkTags(String(m?.mes ?? ""));
        if (!mes) continue;
        // Keep whitespace readable but stable.
        lines.push(`${who}: ${mes.replace(/\s+/g, " ")}`);
    }

    // Best-effort world info scan. ST expects reverse-order strings for scanning.
    let wi = "";
    try {
        if (typeof ctx?.getWorldInfoPrompt === "function") {
            const scan = [...lines].reverse();
            const maxContext = Number(ctx?.maxContext) || 0;
            const res = await ctx.getWorldInfoPrompt(scan, maxContext, true);
            wi = String(res?.worldInfoString ?? "").trim();
        }
    } catch (_) {}

    const parts = [];
    if (wi) {
        parts.push(`World Info / Author's Note:\n${wi}`);
    }
    parts.push(
        `Chat history (most recent last):\n${lines.length ? lines.join("\n") : "(no chat context available)"}`,
    );
    parts.push(`Now write ${nameChar}'s next reply.`);
    return parts.join("\n\n");
}

async function captureNativeGeneratePrompt({ ctx, quietPrompt }) {
    // Build the same prompt that SillyTavern's Generate() would send (chat history + WI/AN + story string etc),
    // but capture it via dry-run and then use generateRaw() to actually query the model.
    if (!ctx?.generate || !ctx?.eventSource || !ctx?.eventTypes)
        throw new Error("Context missing generate/eventSource");

    return new Promise((resolve, reject) => {
        let done = false;
        const timeoutMs = 12_000;
        const timer = setTimeout(() => {
            if (done) return;
            done = true;
            cleanup();
            reject(new Error("Prompt capture timed out"));
        }, timeoutMs);

        const cleanup = () => {
            try {
                clearTimeout(timer);
            } catch (_) {}
            try {
                ctx.eventSource.removeListener(
                    ctx.eventTypes.GENERATE_AFTER_DATA,
                    handler,
                );
            } catch (_) {}
        };

        const handler = (generateData, dryRun) => {
            // Only capture dry-run prompts.
            if (!dryRun) return;
            const p = generateData?.prompt ?? generateData?.input ?? null;
            if (!p) return;
            if (done) return;
            done = true;
            cleanup();
            resolve(p);
        };

        try {
            ctx.eventSource.on(ctx.eventTypes.GENERATE_AFTER_DATA, handler);
        } catch (err) {
            done = true;
            cleanup();
            reject(err);
            return;
        }

        // Dry-run: Generate() will emit GENERATE_AFTER_DATA with the prompt, then resolve without generating.
        Promise.resolve()
            .then(() =>
                ctx.generate(
                    "quiet",
                    {
                        quiet_prompt: String(quietPrompt ?? ""),
                        quietToLoud: true, // produce a character reply
                        skipWIAN: false, // include WI/AN injections in the prompt
                        force_name2: true,
                    },
                    true, // dryRun
                ),
            )
            .then(() => {
                // In case Generate() returns without emitting (shouldn't happen), rely on timeout.
            })
            .catch((err) => {
                if (done) return;
                done = true;
                cleanup();
                reject(err);
            });
    });
}

function initPetActionRig(vrm) {
    // Cache bone nodes + their "rest" transforms so actions don't accumulate drift.
    const humanoid = vrm?.humanoid;
    const getBone = (name) => {
        try {
            return humanoid?.getRawBoneNode?.(name) ?? null;
        } catch (_) {
            return null;
        }
    };

    const boneNames = [
        "hips",
        "spine",
        "chest",
        "upperChest",
        "neck",
        "head",
        "leftUpperArm",
        "leftLowerArm",
        "leftHand",
        "rightUpperArm",
        "rightLowerArm",
        "rightHand",
        "leftUpperLeg",
        "leftLowerLeg",
        "leftFoot",
        "rightUpperLeg",
        "rightLowerLeg",
        "rightFoot",
    ];

    const bones = {};
    const rest = {};
    for (const n of boneNames) {
        const node = getBone(n);
        if (!node) continue;
        bones[n] = node;
        rest[n] = {
            position: node.position.clone(),
            quaternion: node.quaternion.clone(),
        };
    }

    vrm.scene.userData.__vrmPetBones = bones;
    vrm.scene.userData.__vrmPetBoneRest = rest;
}

function ensureRelaxAxisCache(vrm) {
    if (!vrm?.scene?.userData) return null;
    const cached = vrm.scene.userData.__vrmPetRelaxArmAxis ?? null;
    if (cached) return cached;

    const bones = vrm.scene.userData.__vrmPetBones ?? null;
    const rest = vrm.scene.userData.__vrmPetBoneRest ?? null;
    if (!bones || !rest) return null;

    const cam = vrmRenderState.camera ?? null;
    const forward = new THREE.Vector3(0, 0, 1);
    if (cam?.position) forward.copy(cam.position).normalize(); // "toward viewer" in world space

    const testOneSide = (side) => {
        const ua = side === "left" ? bones.leftUpperArm : bones.rightUpperArm;
        const hand = side === "left" ? bones.leftHand : bones.rightHand;
        if (!ua || !hand) return { axis: "z", sign: side === "left" ? 1 : -1 };

        const baseQ =
            rest[side === "left" ? "leftUpperArm" : "rightUpperArm"]
                ?.quaternion ?? null;
        if (!baseQ) return { axis: "z", sign: side === "left" ? 1 : -1 };

        const basePos = new THREE.Vector3();
        const tmpPos = new THREE.Vector3();
        hand.getWorldPosition(basePos);

        const axes = [
            { axis: "x", sign: 1 },
            { axis: "x", sign: -1 },
            { axis: "y", sign: 1 },
            { axis: "y", sign: -1 },
            { axis: "z", sign: 1 },
            { axis: "z", sign: -1 },
        ];

        let best = null;
        let bestScore = -Infinity;
        const qTmp = new THREE.Quaternion();
        const eTmp = new THREE.Euler();

        for (const a of axes) {
            // Restore to rest before each probe.
            ua.quaternion.copy(baseQ);
            ua.updateMatrixWorld(true);

            const rad = THREE.MathUtils.degToRad(22) * a.sign;
            if (a.axis === "x") eTmp.set(rad, 0, 0, "XYZ");
            else if (a.axis === "y") eTmp.set(0, rad, 0, "XYZ");
            else eTmp.set(0, 0, rad, "XYZ");
            qTmp.setFromEuler(eTmp);
            ua.quaternion.multiply(qTmp);
            ua.updateMatrixWorld(true);

            hand.getWorldPosition(tmpPos);
            const d = tmpPos.clone().sub(basePos);

            // Prefer down + toward viewer + outward.
            const dy = -d.y; // down is positive score
            const df = d.dot(forward); // toward viewer
            const dx = Math.abs(d.x);
            const score = dy * 1.8 + df * 1.0 + dx * 0.6;

            if (score > bestScore) {
                bestScore = score;
                best = { axis: a.axis, sign: a.sign };
            }
        }

        // Restore to rest.
        ua.quaternion.copy(baseQ);
        ua.updateMatrixWorld(true);

        return best ?? { axis: "z", sign: side === "left" ? 1 : -1 };
    };

    const out = {
        left: testOneSide("left"),
        right: testOneSide("right"),
    };
    vrm.scene.userData.__vrmPetRelaxArmAxis = out;
    log("Relax arms axis picked", out);
    return out;
}

function resetPetRigToRest(vrm) {
    const rest = vrm?.scene?.userData?.__vrmPetBoneRest ?? null;
    const bones = vrm?.scene?.userData?.__vrmPetBones ?? null;
    if (!rest || !bones) return;
    for (const [name, st] of Object.entries(rest)) {
        const node = bones[name];
        if (!node) continue;
        node.position.copy(st.position);
        node.quaternion.copy(st.quaternion);
    }
}

function playPetAction(actionName) {
    const now = performance.now();
    if (now < vrmRenderState.petAction.cooldownUntil) return;
    if (!vrmRenderState.currentVrm) return;

    const vrm = vrmRenderState.currentVrm;
    if (!vrm.scene.userData.__vrmPetBones) initPetActionRig(vrm);

    // Do not stack; restart from rest each time for predictable results.
    resetPetRigToRest(vrm);

    let duration = 0.8;
    if (actionName === "tap") duration = 0.55;
    if (actionName === "nod") duration = 0.8;
    if (actionName === "bounce") duration = 0.7;
    if (actionName === "wave") duration = 1.0;
    if (actionName === "tilt") duration = 0.9;
    if (actionName === "cheer") duration = 0.9;
    if (actionName === "pat") duration = 0.75;

    vrmRenderState.petAction.active = actionName;
    vrmRenderState.petAction.t = 0;
    vrmRenderState.petAction.duration = duration;
    vrmRenderState.petAction.cooldownUntil = now + 250; // prevent double-trigger by pointer events
}

function playRandomPetAction(kind = "gen") {
    // Small set of "cute" actions.
    const pool =
        kind === "tap"
            ? ["tap", "nod", "wave", "tilt", "cheer"]
            : kind === "idle"
              ? ["nod", "bounce", "tilt", "wave", "cheer"]
              : ["nod", "bounce", "wave", "tilt"];
    const idx = Math.floor(Math.random() * pool.length);
    playPetAction(pool[idx]);
}

function updatePetAction(delta) {
    const vrm = vrmRenderState.currentVrm;
    if (!vrm) return;

    const a = vrmRenderState.petAction.active;
    if (!a) return;

    const bones = vrm.scene.userData.__vrmPetBones ?? null;
    const rest = vrm.scene.userData.__vrmPetBoneRest ?? null;
    if (!bones || !rest) return;

    vrmRenderState.petAction.t += delta;
    const t = vrmRenderState.petAction.t;
    const d = Math.max(0.001, vrmRenderState.petAction.duration);
    const p = clamp01(t / d);
    const e = easeInOutSine(p);

    // Re-apply rest every frame, then layer our small offsets (so VRM updates don't drift us).
    resetPetRigToRest(vrm);

    const qTmp = new THREE.Quaternion();
    const eTmp = new THREE.Euler();

    const head = bones.head;
    const neck = bones.neck;
    const hips = bones.hips;
    const rUA = bones.rightUpperArm;
    const rLA = bones.rightLowerArm;
    const lUA = bones.leftUpperArm;
    const lLA = bones.leftLowerArm;

    if (a === "tap") {
        // Tiny bounce + quick nod.
        if (hips && rest.hips) {
            const amp = 0.04;
            hips.position.y =
                rest.hips.position.y +
                amp * Math.sin(Math.PI * p) * (1.0 - 0.2 * p);
        }
        if (head) {
            const amp = THREE.MathUtils.degToRad(10);
            eTmp.set(-amp * Math.sin(Math.PI * p), 0, 0, "XYZ");
            qTmp.setFromEuler(eTmp);
            head.quaternion.multiply(qTmp);
        }
    } else if (a === "nod") {
        if (head) {
            const amp = THREE.MathUtils.degToRad(18);
            // two nods with envelope
            const phase = Math.sin(p * Math.PI * 2 * 2);
            eTmp.set(-amp * phase * (0.6 + 0.4 * (1 - p)), 0, 0, "XYZ");
            qTmp.setFromEuler(eTmp);
            head.quaternion.multiply(qTmp);
        }
        if (neck) {
            const amp = THREE.MathUtils.degToRad(8);
            const phase = Math.sin(p * Math.PI * 2 * 2);
            eTmp.set(-amp * phase * 0.7, 0, 0, "XYZ");
            qTmp.setFromEuler(eTmp);
            neck.quaternion.multiply(qTmp);
        }
    } else if (a === "bounce") {
        if (hips && rest.hips) {
            const amp = 0.07;
            hips.position.y =
                rest.hips.position.y +
                amp * Math.sin(Math.PI * p) * (0.3 + 0.7 * (1 - p));
        }
        if (head) {
            const amp = THREE.MathUtils.degToRad(6);
            eTmp.set(-amp * Math.sin(Math.PI * p) * 0.8, 0, 0, "XYZ");
            qTmp.setFromEuler(eTmp);
            head.quaternion.multiply(qTmp);
        }
    } else if (a === "wave") {
        // Simple right-hand wave. If missing right arm bones, fall back to nod.
        if (!rUA) {
            vrmRenderState.petAction.active = "nod";
            return;
        }
        const wave = Math.sin(p * Math.PI * 2 * 3); // 3 swings
        const ampZ = THREE.MathUtils.degToRad(35);
        const ampY = THREE.MathUtils.degToRad(12);

        eTmp.set(
            0,
            ampY * wave * (0.6 + 0.4 * (1 - p)),
            ampZ * (0.7 + 0.3 * wave) * (0.5 + 0.5 * e),
            "XYZ",
        );
        qTmp.setFromEuler(eTmp);
        rUA.quaternion.multiply(qTmp);

        if (rLA) {
            const bend = THREE.MathUtils.degToRad(25);
            eTmp.set(-bend * (0.2 + 0.8 * e), 0, 0, "XYZ");
            qTmp.setFromEuler(eTmp);
            rLA.quaternion.multiply(qTmp);
        }

        if (lUA) {
            const amp = THREE.MathUtils.degToRad(10);
            eTmp.set(0, 0, -amp * e, "XYZ");
            qTmp.setFromEuler(eTmp);
            lUA.quaternion.multiply(qTmp);
        }
    } else if (a === "tilt") {
        // Cute head tilt + tiny shoulder/arm counterbalance.
        if (head) {
            const tilt = THREE.MathUtils.degToRad(18);
            const roll = Math.sin(p * Math.PI * 2) * 0.55;
            eTmp.set(0, 0, tilt * roll, "XYZ");
            qTmp.setFromEuler(eTmp);
            head.quaternion.multiply(qTmp);
        }
        if (neck) {
            const tilt = THREE.MathUtils.degToRad(10);
            const roll = Math.sin(p * Math.PI * 2) * 0.45;
            eTmp.set(0, 0, tilt * roll, "XYZ");
            qTmp.setFromEuler(eTmp);
            neck.quaternion.multiply(qTmp);
        }
        if (lUA) {
            const amp = THREE.MathUtils.degToRad(10);
            eTmp.set(amp * (0.2 + 0.8 * e), 0, 0, "XYZ");
            qTmp.setFromEuler(eTmp);
            lUA.quaternion.multiply(qTmp);
        }
        if (rUA) {
            const amp = THREE.MathUtils.degToRad(10);
            eTmp.set(-amp * (0.2 + 0.8 * e), 0, 0, "XYZ");
            qTmp.setFromEuler(eTmp);
            rUA.quaternion.multiply(qTmp);
        }
    } else if (a === "cheer") {
        // Both arms up + small bounce.
        if (hips && rest.hips) {
            const amp = 0.06;
            hips.position.y =
                rest.hips.position.y +
                amp * Math.sin(Math.PI * p) * (0.35 + 0.65 * (1 - p));
        }
        const raise = THREE.MathUtils.degToRad(55) * e;
        const out =
            THREE.MathUtils.degToRad(14) *
            Math.sin(p * Math.PI * 2 * 3) *
            (0.25 + 0.75 * (1 - p));
        if (lUA) {
            eTmp.set(-raise, 0, -out, "XYZ");
            qTmp.setFromEuler(eTmp);
            lUA.quaternion.multiply(qTmp);
        }
        if (rUA) {
            eTmp.set(-raise, 0, out, "XYZ");
            qTmp.setFromEuler(eTmp);
            rUA.quaternion.multiply(qTmp);
        }
        if (lLA) {
            const bend = THREE.MathUtils.degToRad(18);
            eTmp.set(-bend * (0.4 + 0.6 * e), 0, 0, "XYZ");
            qTmp.setFromEuler(eTmp);
            lLA.quaternion.multiply(qTmp);
        }
        if (rLA) {
            const bend = THREE.MathUtils.degToRad(18);
            eTmp.set(-bend * (0.4 + 0.6 * e), 0, 0, "XYZ");
            qTmp.setFromEuler(eTmp);
            rLA.quaternion.multiply(qTmp);
        }
    } else if (a === "pat") {
        // Head pat reaction: a quick happy shake + tiny bounce.
        if (hips && rest.hips) {
            const amp = 0.05;
            hips.position.y =
                rest.hips.position.y +
                amp * Math.sin(Math.PI * p) * (0.45 + 0.55 * (1 - p));
        }
        if (neck) {
            const yaw = THREE.MathUtils.degToRad(10);
            const roll = THREE.MathUtils.degToRad(10);
            const phase = Math.sin(p * Math.PI * 2 * 3);
            eTmp.set(
                0,
                yaw * phase * (0.4 + 0.6 * (1 - p)),
                roll * Math.sin(p * Math.PI * 2) * 0.35,
                "XYZ",
            );
            qTmp.setFromEuler(eTmp);
            neck.quaternion.multiply(qTmp);
        }
        if (head) {
            const yaw = THREE.MathUtils.degToRad(18);
            const pitch = THREE.MathUtils.degToRad(8);
            const roll = THREE.MathUtils.degToRad(14);
            const phase = Math.sin(p * Math.PI * 2 * 3);
            eTmp.set(
                -pitch * Math.sin(Math.PI * p) * 0.7,
                yaw * phase,
                roll * Math.sin(p * Math.PI * 2) * 0.6,
                "XYZ",
            );
            qTmp.setFromEuler(eTmp);
            head.quaternion.multiply(qTmp);
        }
    }

    // Tiny blink near the end (if expressions exist).
    try {
        const em = vrm.expressionManager;
        if (em?.setValue) {
            const blink = p > 0.78 && p < 0.9 ? 1.0 : 0.0;
            em.setValue("blink", blink);
        }
    } catch (_) {}

    if (p >= 1) {
        resetPetRigToRest(vrm);
        vrmRenderState.petAction.active = null;
        vrmRenderState.petAction.t = 0;
        vrmRenderState.petAction.duration = 0;
        vrmRenderState.petAction.cooldownUntil = performance.now() + 500;
    }
}

function bindStageInteractions(overlayEl) {
    if (vrmRenderState.stageInteractionBound) return;
    if (!vrmRenderState.renderer || !vrmRenderState.camera) return;
    const canvas = vrmRenderState.renderer.domElement;
    if (!canvas) return;

    vrmRenderState.stageInteractionBound = true;
    canvas.style.touchAction = "none";

    const raycaster = new THREE.Raycaster();
    const ndc = new THREE.Vector2();

    let down = null;
    let lpMoveCancelBound = false;

    const clearLongPress = () => {
        if (vrmRenderState.ui?.longPressTimer) {
            clearTimeout(vrmRenderState.ui.longPressTimer);
            vrmRenderState.ui.longPressTimer = null;
        }
        if (vrmRenderState.ui) {
            vrmRenderState.ui.longPressTriggered = false;
            vrmRenderState.ui.longPressStart = null;
        }
    };

    const armLongPress = (e) => {
        if (!vrmRenderState.ui) return;
        if (
            vrmRenderState.ui.menuOpen ||
            vrmRenderState.ui.chatOpen ||
            vrmRenderState.ui.editorOpen ||
            vrmRenderState.ui.emoteOpen
        )
            return;
        // Only arm long-press for touch pointers.
        if (e.pointerType !== "touch") return;
        clearLongPress();
        vrmRenderState.ui.longPressTriggered = false;
        vrmRenderState.ui.longPressStart = {
            x: e.clientX,
            y: e.clientY,
            id: e.pointerId,
        };
        vrmRenderState.ui.longPressTimer = setTimeout(() => {
            if (!vrmRenderState.ui) return;
            vrmRenderState.ui.longPressTriggered = true;
            // Pause wandering so the pet doesn't run away during menu interaction.
            vrmRenderState.wander.pausedUntil = performance.now() + 2000;
            markInteraction();
            showPetRadialMenu(e.clientX, e.clientY);
        }, 520);

        // Bind move cancel once (keeps code local to this canvas).
        if (!lpMoveCancelBound) {
            lpMoveCancelBound = true;
            canvas.addEventListener(
                "pointermove",
                (ev) => {
                    const st = vrmRenderState.ui;
                    if (!st?.longPressStart || st.longPressTriggered) return;
                    if (st.longPressStart.id !== ev.pointerId) return;
                    const dx = ev.clientX - st.longPressStart.x;
                    const dy = ev.clientY - st.longPressStart.y;
                    if (Math.hypot(dx, dy) > 8) clearLongPress();
                },
                { passive: true },
            );
        }
    };

    canvas.addEventListener("contextmenu", (e) => {
        e.preventDefault();
        e.stopPropagation();
        vrmRenderState.wander.pausedUntil = performance.now() + 2000;
        markInteraction();
        showPetRadialMenu(e.clientX, e.clientY);
    });

    canvas.addEventListener("pointerdown", (e) => {
        // Long-press radial menu (touch).
        armLongPress(e);
        down = {
            x: e.clientX,
            y: e.clientY,
            t: performance.now(),
            id: e.pointerId,
        };
    });

    canvas.addEventListener("pointerup", (e) => {
        if (!down || down.id !== e.pointerId) return;
        const dx = e.clientX - down.x;
        const dy = e.clientY - down.y;
        const dt = performance.now() - down.t;
        down = null;
        const lp = vrmRenderState.ui?.longPressTriggered;
        clearLongPress();
        if (lp) return; // long-press consumed this interaction
        // treat as "tap" (not drag) if movement small and quick
        if (dt > 600 || Math.hypot(dx, dy) > 6) return;
        if (!vrmRenderState.currentVrm) return;

        markInteraction();

        const rect = canvas.getBoundingClientRect();
        const x = (e.clientX - rect.left) / Math.max(1, rect.width);
        const y = (e.clientY - rect.top) / Math.max(1, rect.height);
        ndc.set(x * 2 - 1, -(y * 2 - 1));
        raycaster.setFromCamera(ndc, vrmRenderState.camera);
        const hits = raycaster.intersectObject(
            vrmRenderState.currentVrm.scene,
            true,
        );
        if (!hits || hits.length === 0) return;

        // Head pat: if click is near head bone, play a special action + hearts.
        if (pluginConfig.patEnabled) {
            const vrm = vrmRenderState.currentVrm;
            if (vrm && !vrm.scene.userData.__vrmPetBones) initPetActionRig(vrm);
            const bones = vrm?.scene?.userData?.__vrmPetBones ?? null;
            const headBone = bones?.head ?? null;
            if (headBone) {
                const headPos = new THREE.Vector3();
                headBone.getWorldPosition(headPos);
                const hitPos = hits[0].point;
                const sizeY =
                    vrmRenderState.currentVrm?.scene?.userData
                        ?.__vrmPetBBoxSizeY ?? 1.6;
                const fRaw = Number(pluginConfig.patHeadRadiusFactor);
                const f = Number.isFinite(fRaw) ? clamp(fRaw, 0.08, 0.4) : 0.22;
                const threshold = Math.max(0.05, Math.max(0.1, sizeY) * f);
                if (headPos.distanceTo(hitPos) <= threshold) {
                    playPetAction("pat");
                    spawnHeartsAtClientPoint(e.clientX, e.clientY);
                    return;
                }
            }
        }

        playRandomPetAction("tap");
    });

    canvas.addEventListener("pointercancel", () => {
        down = null;
        clearLongPress();
    });
}

function bindActionTriggers() {
    if (vrmRenderState.actionTriggersBound) return;
    const ctx = getContext();
    if (!ctx?.eventSource || !ctx?.eventTypes) return;
    vrmRenderState.actionTriggersBound = true;

    ctx.eventSource.on(ctx.eventTypes.GENERATION_ENDED, () => {
        if (!pluginConfig.enabled || !pluginConfig.showOverlay) return;
        if (!vrmRenderState.currentVrm) return;
        markInteraction();
        playRandomPetAction("gen");

        // Also react with an expression based on the newly generated text (best-effort).
        try {
            const chat = Array.isArray(ctx.chat) ? ctx.chat : [];
            const last = chat.length ? chat[chat.length - 1] : null;
            if (last && !last.is_user) {
                const mes = String(last.mes ?? "").trim();
                if (mes) triggerPetEmotionFromText(mes);
            }
        } catch (_) {}
    });
}

function ensureFxLayer() {
    const overlayEl = document.getElementById("vrm-pet-overlay");
    if (!overlayEl) return null;
    const shell = overlayEl.querySelector(".vrm-pet-shell");
    if (!shell) return null;
    let fx = shell.querySelector(".vrm-pet-fx");
    if (!fx) {
        fx = document.createElement("div");
        fx.className = "vrm-pet-fx";
        shell.appendChild(fx);
    }
    return fx;
}

function spawnPetEmojiFx(emojiText) {
    try {
        const fx = ensureFxLayer();
        if (!fx) return;

        const overlayEl = document.getElementById("vrm-pet-overlay");
        const rect = overlayEl?.getBoundingClientRect?.();
        if (!rect) return;

        const el = document.createElement("div");
        el.className = "vrm-pet-emoji-fx";
        el.textContent = String(emojiText || "");

        // Start near top area of the pet.
        const x0 = rect.width * randRange(0.35, 0.7);
        const y0 = rect.height * randRange(0.08, 0.28);
        el.style.left = `${clamp(x0, 0, rect.width)}px`;
        el.style.top = `${clamp(y0, 0, rect.height)}px`;

        el.style.setProperty(
            "--vrmPetDx",
            `${randRange(-10, 10).toFixed(1)}px`,
        );
        el.style.setProperty(
            "--vrmPetLift",
            `${randRange(18, 34).toFixed(1)}px`,
        );
        el.style.setProperty(
            "--vrmPetDur",
            `${randRange(650, 950).toFixed(0)}ms`,
        );

        fx.appendChild(el);
        el.addEventListener(
            "animationend",
            () => {
                try {
                    el.remove();
                } catch (_) {}
            },
            { once: true },
        );
    } catch (_) {}
}

function spawnPetBlackFaceFx() {
    try {
        const fx = ensureFxLayer();
        if (!fx) return;
        // Don't stack too many.
        const existing = fx.querySelector(".vrm-pet-blackface-fx");
        if (existing) existing.remove();

        const el = document.createElement("div");
        el.className = "vrm-pet-blackface-fx";
        fx.appendChild(el);
        el.addEventListener(
            "animationend",
            () => {
                try {
                    el.remove();
                } catch (_) {}
            },
            { once: true },
        );
    } catch (_) {}
}

function spawnHeartsAtClientPoint(clientX, clientY) {
    try {
        const fx = ensureFxLayer();
        if (!fx) return;
        const overlayEl = document.getElementById("vrm-pet-overlay");
        if (!overlayEl) return;

        const rect = overlayEl.getBoundingClientRect();
        const x0 = clientX - rect.left;
        const y0 = clientY - rect.top;

        const count = clamp(
            parseInt(String(pluginConfig.patHeartCount ?? 7), 10) || 7,
            1,
            20,
        );
        for (let i = 0; i < count; i++) {
            const el = document.createElement("div");
            el.className = "vrm-pet-heart";
            // Randomize spawn around click point.
            const dx = randRange(-10, 10);
            const dy = randRange(-6, 8);
            const x = clamp(x0 + dx, 0, rect.width);
            const y = clamp(y0 + dy, 0, rect.height);
            el.style.left = `${x}px`;
            el.style.top = `${y}px`;
            el.style.setProperty(
                "--vrmPetDx",
                `${randRange(-14, 14).toFixed(1)}px`,
            );
            el.style.setProperty(
                "--vrmPetLift",
                `${randRange(28, 56).toFixed(1)}px`,
            );
            el.style.setProperty(
                "--vrmPetDur",
                `${randRange(520, 900).toFixed(0)}ms`,
            );
            fx.appendChild(el);
            el.addEventListener(
                "animationend",
                () => {
                    try {
                        el.remove();
                    } catch (_) {}
                },
                { once: true },
            );
        }
    } catch (_) {}
}

function fitCameraToObject(object3d) {
    if (!vrmRenderState.camera) return;

    const cam = vrmRenderState.camera;

    const box = new THREE.Box3().setFromObject(object3d);
    const size = box.getSize(new THREE.Vector3());
    const center = box.getCenter(new THREE.Vector3());

    // Cache model size for other effects (e.g., drag-lift height scaling).
    try {
        object3d.userData.__vrmPetBBoxSizeY = size.y;
    } catch (_) {}

    // For a "pet overlay", keep feet visible:
    // center on XZ, but align the bottom of the model to y=0.
    const bottomCenter = new THREE.Vector3(center.x, box.min.y, center.z);
    object3d.position.sub(bottomCenter);
    object3d.updateMatrixWorld(true);

    // Fit camera to bounding box based on FOV & aspect.
    const fov = THREE.MathUtils.degToRad(cam.fov);
    const fitHeight = size.y / (2 * Math.tan(fov / 2));
    // Use diagonal XZ to better tolerate model yaw (e.g. 45deg side-walk) without clipping hair/skirts.
    const sizeXZ = Math.hypot(size.x, size.z);
    const fitWidth = sizeXZ / (2 * Math.tan(fov / 2)) / (cam.aspect || 1);
    const distance = 1.25 * Math.max(fitHeight, fitWidth, size.z);

    cam.near = Math.max(0.01, distance / 100);
    cam.far = distance * 100;
    cam.position.set(0, Math.max(0.1, size.y * 0.6), distance);
    cam.lookAt(0, Math.max(0.05, size.y * 0.55), 0);
    cam.updateProjectionMatrix();
}

function applyModelScaleAndRefit() {
    const vrm = vrmRenderState.currentVrm;
    if (!vrm) return;

    const base = vrm.scene?.userData?.__vrmPetBaseTransform ?? null;
    if (base) {
        vrm.scene.position.copy(base.position);
        vrm.scene.quaternion.copy(base.quaternion);
        vrm.scene.scale.copy(base.scale);
    }

    const v = Number(pluginConfig.modelScale);
    const scale = Number.isFinite(v) && v > 0 ? v : 1.0;
    vrm.scene.scale.multiplyScalar(scale);
    vrm.scene.updateMatrixWorld(true);

    fitCameraToObject(vrm.scene);

    // Root baseline used for yaw/drag effects (kept stable until next refit).
    try {
        vrm.scene.userData.__vrmPetRootRest = {
            position: vrm.scene.position.clone(),
            quaternion: vrm.scene.quaternion.clone(),
        };
    } catch (_) {}
}

async function loadVrmFromUrl(url) {
    const overlayEl = document.getElementById("vrm-pet-overlay");
    if (!overlayEl) return;

    await ensureRenderer(overlayEl);

    const normalizedUrl = String(url || "").trim();
    if (!normalizedUrl) {
        disposeCurrentVrm();
        setHint("当前角色未绑定 VRM。\n可在设置里上传并绑定。");
        return;
    }

    if (normalizedUrl === vrmRenderState.currentUrl) {
        // Already loaded.
        setHint("");
        return;
    }

    // Cancel previous load attempts (best-effort).
    const token = ++vrmRenderState.loadingToken;

    setHint("正在加载 VRM…");
    disposeCurrentVrm();

    const loader = new GLTFLoader();
    loader.register((parser) => new VRMLoaderPlugin(parser));

    return new Promise((resolve) => {
        loader.load(
            normalizedUrl,
            (gltf) => {
                if (token !== vrmRenderState.loadingToken) return resolve();
                try {
                    const vrm = gltf.userData.vrm;
                    if (!vrm)
                        throw new Error(
                            "Not a VRM (missing gltf.userData.vrm)",
                        );

                    // Optimize and normalize orientation.
                    VRMUtils.removeUnnecessaryJoints(vrm.scene);
                    // NOTE: removeUnnecessaryVertices can break UV/attributes on some models, leading to solid-color silhouettes.
                    // Keep it disabled for stability in the overlay renderer.
                    VRMUtils.rotateVRM0(vrm);

                    // Workaround: avoid incompatible MToon shaders and make sure colors are visible.
                    replaceVrmMaterialsForCompatibility(vrm.scene);

                    // Store a stable baseline transform so refitting/scale changes don't accumulate offsets.
                    vrm.scene.updateMatrixWorld(true);
                    vrm.scene.userData.__vrmPetBaseTransform = {
                        position: vrm.scene.position.clone(),
                        quaternion: vrm.scene.quaternion.clone(),
                        scale: vrm.scene.scale.clone(),
                    };

                    vrmRenderState.currentVrm = vrm;
                    initPetActionRig(vrm);
                    applyModelScaleAndRefit();

                    vrmRenderState.scene.add(vrm.scene);
                    vrmRenderState.currentUrl = normalizedUrl;
                    setHint("");
                    log("VRM loaded", normalizedUrl);
                } catch (e) {
                    console.error("[VRM Pet] VRM init failed", e);
                    setHint(
                        `模型初始化失败：${e instanceof Error ? e.message : String(e)}`,
                    );
                }
                resolve();
            },
            undefined,
            (err) => {
                if (token !== vrmRenderState.loadingToken) return resolve();
                console.error("[VRM Pet] VRM load failed", err);
                setHint("加载失败：请确认 VRM 已上传成功且路径可访问");
                resolve();
            },
        );
    });
}

function readFileAsBase64(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => {
            const res = String(reader.result || "");
            const comma = res.indexOf(",");
            if (comma === -1) return reject(new Error("Invalid data URL"));
            resolve(res.slice(comma + 1));
        };
        reader.onerror = () => reject(new Error("File read failed"));
        reader.readAsDataURL(file);
    });
}

async function uploadVrmToServer(file) {
    if (!file) throw new Error("No file selected");
    const ext = String(file.name || "")
        .split(".")
        .pop()
        ?.toLowerCase();
    if (ext !== "vrm") throw new Error("Only .vrm is supported");

    const maxBytes = Number(pluginConfig.maxVrmFileSizeMB) * 1024 * 1024;
    if (file.size > maxBytes)
        throw new Error(
            `VRM too large (limit: ${pluginConfig.maxVrmFileSizeMB}MB)`,
        );

    const base64Data = await readFileAsBase64(file);
    const safeName = `vrm_${Date.now()}_${getStringHash(file.name)}.vrm`;

    const ctx = getContext();
    const result = await fetch("/api/files/upload", {
        method: "POST",
        headers: ctx.getRequestHeaders(),
        body: JSON.stringify({ name: safeName, data: base64Data }),
    });

    if (!result.ok) {
        const text = await result.text().catch(() => "");
        throw new Error(text || `Upload failed (HTTP ${result.status})`);
    }

    const json = await result.json();
    if (!json?.path) throw new Error("Upload response missing path");
    return { url: json.path, storedName: safeName };
}

async function saveVrmToCurrentCharacter(vrmInfo) {
    const ctx = getContext();
    const character = getCurrentCharacter();
    if (!character)
        throw new Error("No character selected (group chat not supported yet)");

    const existing = getCharacterExtensionData(character) || {};
    const next = mergeDeep(existing, {
        vrm: {
            url: vrmInfo.url,
            storedName: vrmInfo.storedName,
            originalName: vrmInfo.originalName,
            uploadedAt: Date.now(),
        },
    });

    await ctx.writeExtensionField(ctx.characterId, MODULE_NAME, next);
    return next;
}

function createSettingsInterface() {
    if (document.getElementById("vrm-pet-settings")) return;

    const root = document.createElement("div");
    root.id = "vrm-pet-settings";
    root.innerHTML = `
    <div class="inline-drawer">
      <div class="inline-drawer-toggle inline-drawer-header">
        <b>VRM Pet</b>
        <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
      </div>
      <div class="inline-drawer-content">
        <div class="extension-content flex flexFlowColumn gap10px">

          <div class="extension-content-item box-container">
            <div class="flex flexFlowColumn">
              <div class="settings-title-text">启用 VRM Pet</div>
              <div class="settings-title-description">每个角色可绑定一个 VRM；右下角显示桌宠（可拖动）</div>
            </div>
            <div class="toggle-switch">
              <input type="checkbox" id="${MODULE_NAME}_enabled" class="toggle-input" ${pluginConfig.enabled ? "checked" : ""} />
              <label for="${MODULE_NAME}_enabled" class="toggle-label"><span class="toggle-handle"></span></label>
            </div>
          </div>

          <div class="extension-content-item box-container">
            <div class="flex flexFlowColumn">
              <div class="settings-title-text">调试日志</div>
              <div class="settings-title-description">在控制台输出 VRM 材质/贴图信息</div>
            </div>
            <div class="toggle-switch">
              <input type="checkbox" id="${MODULE_NAME}_enableLogging" class="toggle-input" ${pluginConfig.enableLogging ? "checked" : ""} />
              <label for="${MODULE_NAME}_enableLogging" class="toggle-label"><span class="toggle-handle"></span></label>
            </div>
          </div>

          <div class="extension-content-item box-container">
            <div class="flex flexFlowColumn wide100p">
              <div class="settings-title-text">为当前角色上传 VRM</div>
              <div class="settings-title-description">文件会保存到酒馆服务器（/api/files/upload）</div>
              <div class="vrm-pet-row marginTop5">
                <input type="file" id="${MODULE_NAME}_file" accept=".vrm" style="display:none" />
                <button class="menu_button" id="${MODULE_NAME}_select_btn">选择 VRM</button>
                <button class="menu_button" id="${MODULE_NAME}_upload_btn" title="已选文件时可用">上传并绑定</button>
                <button class="menu_button" id="${MODULE_NAME}_clear_btn">清除当前角色绑定</button>
              </div>
              <div class="vrm-pet-path marginTop5" id="${MODULE_NAME}_selected"></div>
              <div class="vrm-pet-path marginTop5" id="${MODULE_NAME}_current"></div>
            </div>
          </div>

          <div class="extension-content-item box-container">
            <div class="flex flexFlowColumn wide100p">
              <div class="settings-title-text">VRM 大小限制：<span id="${MODULE_NAME}_max_mb_val">${pluginConfig.maxVrmFileSizeMB}</span>MB</div>
              <div class="range-row">
                <input type="range" id="${MODULE_NAME}_max_mb" min="5" max="300" step="5" value="${pluginConfig.maxVrmFileSizeMB}">
              </div>
            </div>
          </div>

          <div class="extension-content-item box-container">
            <div class="flex flexFlowColumn wide100p">
              <div class="settings-title-text">Overlay size: <span id="${MODULE_NAME}_overlay_size_val">${pluginConfig.overlayWidth}×${pluginConfig.overlayHeight}</span></div>
              <div class="range-row">
                <div style="display:flex; align-items:center; gap:8px;">
                  <span style="min-width:64px;">Width</span>
                  <input type="range" id="${MODULE_NAME}_overlay_w" min="120" max="800" step="10" value="${pluginConfig.overlayWidth}">
                  <span id="${MODULE_NAME}_overlay_w_val" style="min-width:48px; text-align:right;">${pluginConfig.overlayWidth}</span>
                </div>
              </div>
              <div class="range-row">
                <div style="display:flex; align-items:center; gap:8px;">
                  <span style="min-width:64px;">Height</span>
                  <input type="range" id="${MODULE_NAME}_overlay_h" min="120" max="800" step="10" value="${pluginConfig.overlayHeight}">
                  <span id="${MODULE_NAME}_overlay_h_val" style="min-width:48px; text-align:right;">${pluginConfig.overlayHeight}</span>
                </div>
              </div>
            </div>
          </div>

          <div class="extension-content-item box-container">
            <div class="flex flexFlowColumn">
              <div class="settings-title-text">显示外框</div>
              <div class="settings-title-description">关闭后桌宠只显示模型</div>
            </div>
            <div class="toggle-switch">
              <input type="checkbox" id="${MODULE_NAME}_frame_enabled" class="toggle-input" ${pluginConfig.overlayFrameEnabled ? "checked" : ""} />
              <label for="${MODULE_NAME}_frame_enabled" class="toggle-label"><span class="toggle-handle"></span></label>
            </div>
          </div>

          <div class="extension-content-item box-container">
            <div class="flex flexFlowColumn wide100p">
              <div class="settings-title-text">外框透明度：<span id="${MODULE_NAME}_frame_opacity_val">${Number.isFinite(Number(pluginConfig.overlayFrameOpacity)) ? Number(pluginConfig.overlayFrameOpacity).toFixed(2) : "0.35"}</span></div>
              <div class="range-row">
                <input type="range" id="${MODULE_NAME}_frame_opacity" min="0" max="0.9" step="0.05" value="${Number.isFinite(Number(pluginConfig.overlayFrameOpacity)) ? Number(pluginConfig.overlayFrameOpacity) : 0.35}">
              </div>
            </div>
          </div>

          <div class="extension-content-item box-container">
            <div class="flex flexFlowColumn wide100p">
              <div class="settings-title-text">Model scale: <span id="${MODULE_NAME}_model_scale_val">${Number(pluginConfig.modelScale || 1).toFixed(2)}</span>x</div>
              <div class="range-row">
                <input type="range" id="${MODULE_NAME}_model_scale" min="0.5" max="3.0" step="0.05" value="${pluginConfig.modelScale}">
              </div>
            </div>
          </div>

          <div class="extension-content-item box-container">
            <div class="flex flexFlowColumn">
              <div class="settings-title-text">桌面走动</div>
              <div class="settings-title-description">让桌宠窗口在屏幕内来回走动（拖拽/点击会暂时暂停）</div>
            </div>
            <div class="toggle-switch">
              <input type="checkbox" id="${MODULE_NAME}_wander_enabled" class="toggle-input" ${pluginConfig.wanderEnabled ? "checked" : ""} />
              <label for="${MODULE_NAME}_wander_enabled" class="toggle-label"><span class="toggle-handle"></span></label>
            </div>
          </div>

          <div class="extension-content-item box-container">
            <div class="flex flexFlowColumn wide100p">
              <div class="settings-title-text">走动速度：<span id="${MODULE_NAME}_wander_speed_val">${Number(pluginConfig.wanderSpeed) || 80}</span> px/s</div>
              <div class="range-row">
                <input type="range" id="${MODULE_NAME}_wander_speed" min="20" max="260" step="10" value="${Number(pluginConfig.wanderSpeed) || 80}">
              </div>
            </div>
          </div>

          <div class="extension-content-item box-container">
            <div class="flex flexFlowColumn">
              <div class="settings-title-text">走路摆动</div>
              <div class="settings-title-description">走动时做“原地走路”的摆臂/点头</div>
            </div>
            <div class="toggle-switch">
              <input type="checkbox" id="${MODULE_NAME}_wander_gait_enabled" class="toggle-input" ${pluginConfig.wanderGaitEnabled ? "checked" : ""} />
              <label for="${MODULE_NAME}_wander_gait_enabled" class="toggle-label"><span class="toggle-handle"></span></label>
            </div>
          </div>

          <div class="extension-content-item box-container">
            <div class="flex flexFlowColumn wide100p">
              <div class="settings-title-text">摆动强度：<span id="${MODULE_NAME}_wander_gait_intensity_val">${Number(pluginConfig.wanderGaitIntensity ?? 1).toFixed(2)}</span>x</div>
              <div class="range-row">
                <input type="range" id="${MODULE_NAME}_wander_gait_intensity" min="0" max="2" step="0.05" value="${Number.isFinite(Number(pluginConfig.wanderGaitIntensity)) ? Number(pluginConfig.wanderGaitIntensity) : 1}">
              </div>
            </div>
          </div>

          <div class="extension-content-item box-container">
            <div class="flex flexFlowColumn">
              <div class="settings-title-text">侧身朝向</div>
              <div class="settings-title-description">走动时让模型朝向侧面</div>
            </div>
            <div class="toggle-switch">
              <input type="checkbox" id="${MODULE_NAME}_wander_face_enabled" class="toggle-input" ${pluginConfig.wanderFaceEnabled ? "checked" : ""} />
              <label for="${MODULE_NAME}_wander_face_enabled" class="toggle-label"><span class="toggle-handle"></span></label>
            </div>
          </div>

          <div class="extension-content-item box-container">
            <div class="flex flexFlowColumn wide100p">
              <div class="settings-title-text">侧身角度：<span id="${MODULE_NAME}_wander_face_angle_val">${Number.isFinite(Number(pluginConfig.wanderFaceAngleDeg)) ? Math.round(Number(pluginConfig.wanderFaceAngleDeg)) : 45}</span>°</div>
              <div class="range-row">
                <input type="range" id="${MODULE_NAME}_wander_face_angle" min="0" max="90" step="1" value="${Number.isFinite(Number(pluginConfig.wanderFaceAngleDeg)) ? Math.round(Number(pluginConfig.wanderFaceAngleDeg)) : 45}">
              </div>
            </div>
          </div>

          <div class="extension-content-item box-container">
            <div class="flex flexFlowColumn">
              <div class="settings-title-text">头部追踪</div>
              <div class="settings-title-description">头/颈会轻微跟随鼠标（幅度很小）</div>
            </div>
            <div class="toggle-switch">
              <input type="checkbox" id="${MODULE_NAME}_head_track" class="toggle-input" ${pluginConfig.headTrackEnabled ? "checked" : ""} />
              <label for="${MODULE_NAME}_head_track" class="toggle-label"><span class="toggle-handle"></span></label>
            </div>
          </div>

          <div class="extension-content-item box-container">
            <div class="flex flexFlowColumn">
              <div class="settings-title-text">眼动追踪（简化版）</div>
              <div class="settings-title-description">没有 VRM LookAt 时，用更小幅度头/颈动作来“假装看”</div>
            </div>
            <div class="toggle-switch">
              <input type="checkbox" id="${MODULE_NAME}_eye_track" class="toggle-input" ${pluginConfig.eyeTrackEnabled ? "checked" : ""} />
              <label for="${MODULE_NAME}_eye_track" class="toggle-label"><span class="toggle-handle"></span></label>
            </div>
          </div>

          <div class="extension-content-item box-container">
            <div class="flex flexFlowColumn">
              <div class="settings-title-text">空闲动作</div>
              <div class="settings-title-description">一段时间没交互会随机做一个小动作</div>
            </div>
            <div class="toggle-switch">
              <input type="checkbox" id="${MODULE_NAME}_idle_enabled" class="toggle-input" ${pluginConfig.idleEnabled ? "checked" : ""} />
              <label for="${MODULE_NAME}_idle_enabled" class="toggle-label"><span class="toggle-handle"></span></label>
            </div>
          </div>

          <div class="extension-content-item box-container">
            <div class="flex flexFlowColumn">
              <div class="settings-title-text">偶尔眨眼</div>
              <div class="settings-title-description">无动作时也会随机眨眼（需要模型支持 blink 表情）</div>
            </div>
            <div class="toggle-switch">
              <input type="checkbox" id="${MODULE_NAME}_blink_enabled" class="toggle-input" ${pluginConfig.blinkEnabled ? "checked" : ""} />
              <label for="${MODULE_NAME}_blink_enabled" class="toggle-label"><span class="toggle-handle"></span></label>
            </div>
          </div>

          <div class="extension-content-item box-container">
            <div class="flex flexFlowColumn">
              <div class="settings-title-text">拍拍头</div>
              <div class="settings-title-description">点击头部附近触发“摸头反应”+ 爱心粒子</div>
            </div>
            <div class="toggle-switch">
              <input type="checkbox" id="${MODULE_NAME}_pat_enabled" class="toggle-input" ${pluginConfig.patEnabled ? "checked" : ""} />
              <label for="${MODULE_NAME}_pat_enabled" class="toggle-label"><span class="toggle-handle"></span></label>
            </div>
          </div>

          <div class="extension-content-item box-container">
            <div class="flex flexFlowColumn">
              <div class="settings-title-text">手臂自然下垂</div>
              <div class="settings-title-description">解决某些模型“平举/T Pose”站姿</div>
            </div>
            <div class="toggle-switch">
              <input type="checkbox" id="${MODULE_NAME}_relax_arms" class="toggle-input" ${pluginConfig.relaxArmsEnabled ? "checked" : ""} />
              <label for="${MODULE_NAME}_relax_arms" class="toggle-label"><span class="toggle-handle"></span></label>
            </div>
          </div>

          <div class="extension-content-item box-container">
            <div class="flex flexFlowColumn">
              <div class="settings-title-text">走路时也下压</div>
              <div class="settings-title-description">开启后，走动/走路摆动期间也叠加手臂下垂</div>
            </div>
            <div class="toggle-switch">
              <input type="checkbox" id="${MODULE_NAME}_relax_arms_gait" class="toggle-input" ${pluginConfig.relaxArmsDuringWanderGait ? "checked" : ""} />
              <label for="${MODULE_NAME}_relax_arms_gait" class="toggle-label"><span class="toggle-handle"></span></label>
            </div>
          </div>

          <div class="extension-content-item box-container">
            <div class="flex flexFlowColumn wide100p">
              <div class="settings-title-text">下垂方式</div>
              <div class="settings-title-description">不同模型骨骼轴向不一样；推荐用“自动”</div>
              <div class="marginTop5">
                <select id="${MODULE_NAME}_relax_arms_mode" class="text_pole">
                  <option value="auto" ${String(pluginConfig.relaxArmsMode || "auto") === "auto" ? "selected" : ""}>自动（推荐）</option>
                  <option value="zroll" ${String(pluginConfig.relaxArmsMode || "auto") === "zroll" ? "selected" : ""}>Z 轴滚转（手动）</option>
                  <option value="xpitch" ${String(pluginConfig.relaxArmsMode || "auto") === "xpitch" ? "selected" : ""}>X 轴下压（手动）</option>
                </select>
              </div>
            </div>
          </div>

          <div class="extension-content-item box-container">
            <div class="flex flexFlowColumn wide100p">
              <div class="settings-title-text">下垂幅度：<span id="${MODULE_NAME}_relax_arms_down_val">${Number.isFinite(Number(pluginConfig.relaxArmsDownDeg)) ? Math.round(Number(pluginConfig.relaxArmsDownDeg)) : 55}</span>°</div>
              <div class="range-row">
                <input type="range" id="${MODULE_NAME}_relax_arms_down" min="0" max="80" step="1" value="${Number.isFinite(Number(pluginConfig.relaxArmsDownDeg)) ? Math.round(Number(pluginConfig.relaxArmsDownDeg)) : 55}">
              </div>
            </div>
          </div>

          <div class="extension-content-item box-container">
            <div class="flex flexFlowColumn wide100p">
              <div class="settings-title-text">手肘弯曲：<span id="${MODULE_NAME}_relax_arms_bend_val">${Number.isFinite(Number(pluginConfig.relaxArmsElbowBendDeg)) ? Math.round(Number(pluginConfig.relaxArmsElbowBendDeg)) : 16}</span>°</div>
              <div class="range-row">
                <input type="range" id="${MODULE_NAME}_relax_arms_bend" min="0" max="35" step="1" value="${Number.isFinite(Number(pluginConfig.relaxArmsElbowBendDeg)) ? Math.round(Number(pluginConfig.relaxArmsElbowBendDeg)) : 16}">
              </div>
            </div>
          </div>

          <div class="extension-content-item box-container">
            <div class="flex flexFlowColumn wide100p">
              <div class="settings-title-text">向前一点：<span id="${MODULE_NAME}_relax_arms_fwd_val">${Number.isFinite(Number(pluginConfig.relaxArmsForwardDeg)) ? Math.round(Number(pluginConfig.relaxArmsForwardDeg)) : 10}</span>°</div>
              <div class="range-row">
                <input type="range" id="${MODULE_NAME}_relax_arms_fwd" min="-25" max="35" step="1" value="${Number.isFinite(Number(pluginConfig.relaxArmsForwardDeg)) ? Math.round(Number(pluginConfig.relaxArmsForwardDeg)) : 10}">
              </div>
            </div>
          </div>

          <div class="extension-content-item box-container">
            <div class="flex flexFlowColumn wide100p">
              <div class="settings-title-text">向外一点：<span id="${MODULE_NAME}_relax_arms_out_val">${Number.isFinite(Number(pluginConfig.relaxArmsOutDeg)) ? Math.round(Number(pluginConfig.relaxArmsOutDeg)) : 8}</span>°</div>
              <div class="range-row">
                <input type="range" id="${MODULE_NAME}_relax_arms_out" min="-25" max="25" step="1" value="${Number.isFinite(Number(pluginConfig.relaxArmsOutDeg)) ? Math.round(Number(pluginConfig.relaxArmsOutDeg)) : 8}">
              </div>
            </div>
          </div>

          <div class="extension-content-item box-container">
            <div class="flex flexFlowColumn">
              <div class="settings-title-text">拖拽“被提起来”动作</div>
              <div class="settings-title-description">拖动桌宠时手臂有被拎起的摆动感</div>
            </div>
            <div class="toggle-switch">
              <input type="checkbox" id="${MODULE_NAME}_drag_pose" class="toggle-input" ${pluginConfig.dragHeldPoseEnabled ? "checked" : ""} />
              <label for="${MODULE_NAME}_drag_pose" class="toggle-label"><span class="toggle-handle"></span></label>
            </div>
          </div>

          <div class="extension-content-item box-container">
            <div class="flex flexFlowColumn wide100p">
              <div class="settings-title-text">拖拽动作强度：<span id="${MODULE_NAME}_drag_pose_intensity_val">${Number.isFinite(Number(pluginConfig.dragHeldPoseIntensity)) ? Number(pluginConfig.dragHeldPoseIntensity).toFixed(2) : "1.00"}</span>x</div>
              <div class="range-row">
                <input type="range" id="${MODULE_NAME}_drag_pose_intensity" min="0" max="2" step="0.05" value="${Number.isFinite(Number(pluginConfig.dragHeldPoseIntensity)) ? Number(pluginConfig.dragHeldPoseIntensity) : 1}">
              </div>
            </div>
          </div>

        </div>
      </div>
    </div>
  `;

    const container = document.getElementById("extensions_settings");
    if (container) container.appendChild(root);

    bindSettingsEvents();
    refreshCurrentBindingText();
}

function refreshCurrentBindingText() {
    const ctx = getContext();
    const el = document.getElementById(`${MODULE_NAME}_current`);
    if (!el) return;

    const character = getCurrentCharacter();
    if (!character) {
        el.textContent = "当前未选择角色（群聊/未进角色聊天）。";
        return;
    }

    const ext = getCharacterExtensionData(character);
    const url = ext?.vrm?.url;
    if (!url) {
        el.textContent = "当前角色未绑定 VRM。";
        return;
    }
    el.textContent = `当前角色 VRM：${url}`;
}

function refreshSelectedFileText() {
    const el = document.getElementById(`${MODULE_NAME}_selected`);
    if (!el) return;
    const fileInput = /** @type {HTMLInputElement|null} */ (
        document.getElementById(`${MODULE_NAME}_file`)
    );
    const file = fileInput?.files?.[0];
    el.textContent = file
        ? `已选择文件：${file.name} (${Math.round(file.size / 1024 / 1024)}MB)`
        : "未选择文件。";
}

function saveSettings() {
    const ctx = getContext();
    ctx.extensionSettings[MODULE_NAME] = pluginConfig;
    ctx.saveSettingsDebounced();
}

async function handleUploadSelectedFile() {
    const fileInput = /** @type {HTMLInputElement|null} */ (
        document.getElementById(`${MODULE_NAME}_file`)
    );
    const file = fileInput?.files?.[0];
    if (!file) {
        // More convenient UX: clicking "upload" without selecting triggers file picker.
        fileInput?.click();
        toastr?.warning?.("请选择一个 .vrm 文件", "VRM Pet");
        return;
    }

    toastr?.info?.("正在上传 VRM…", "VRM Pet");
    const uploaded = await uploadVrmToServer(file);
    const saved = await saveVrmToCurrentCharacter({
        url: uploaded.url,
        storedName: uploaded.storedName,
        originalName: file.name,
    });
    log("Saved character extension data", saved);
    toastr?.success?.("已上传并绑定到当前角色", "VRM Pet");
    refreshCurrentBindingText();
    loadVrmForCurrentCharacter().catch(() => {});
}

function bindSettingsEvents() {
    document.addEventListener("change", (e) => {
        const t = e.target;
        if (!(t instanceof HTMLElement)) return;
        if (t.id === `${MODULE_NAME}_enabled`) {
            pluginConfig.enabled = /** @type {HTMLInputElement} */ (t).checked;
            saveSettings();
            ensureOverlay();
        }
        if (t.id === `${MODULE_NAME}_enableLogging`) {
            pluginConfig.enableLogging = /** @type {HTMLInputElement} */ (
                t
            ).checked;
            saveSettings();
        }
        if (t.id === `${MODULE_NAME}_frame_enabled`) {
            pluginConfig.overlayFrameEnabled = /** @type {HTMLInputElement} */ (
                t
            ).checked;
            saveSettings();
            ensureOverlay();
        }
        if (t.id === `${MODULE_NAME}_wander_enabled`) {
            pluginConfig.wanderEnabled = /** @type {HTMLInputElement} */ (
                t
            ).checked;
            // Nudge it to start moving soon.
            vrmRenderState.wander.pausedUntil = performance.now() + 200;
            saveSettings();
        }
        if (t.id === `${MODULE_NAME}_wander_gait_enabled`) {
            pluginConfig.wanderGaitEnabled = /** @type {HTMLInputElement} */ (
                t
            ).checked;
            saveSettings();
        }
        if (t.id === `${MODULE_NAME}_wander_face_enabled`) {
            pluginConfig.wanderFaceEnabled = /** @type {HTMLInputElement} */ (
                t
            ).checked;
            saveSettings();

            // If disabled, immediately restore to the baseline (front-facing) pose.
            if (!pluginConfig.wanderFaceEnabled && vrmRenderState.currentVrm) {
                const rest =
                    vrmRenderState.currentVrm.scene?.userData
                        ?.__vrmPetRootRest ?? null;
                vrmRenderState.wander.faceYaw = 0;
                if (rest?.quaternion) {
                    // Ensure we snap back to front-facing immediately.
                    vrmRenderState.currentVrm.scene.quaternion.copy(
                        rest.quaternion,
                    );
                }
                applyRootPose();
            }
        }

        if (t.id === `${MODULE_NAME}_head_track`) {
            pluginConfig.headTrackEnabled = /** @type {HTMLInputElement} */ (
                t
            ).checked;
            saveSettings();
        }
        if (t.id === `${MODULE_NAME}_eye_track`) {
            pluginConfig.eyeTrackEnabled = /** @type {HTMLInputElement} */ (
                t
            ).checked;
            saveSettings();
        }
        if (t.id === `${MODULE_NAME}_idle_enabled`) {
            pluginConfig.idleEnabled = /** @type {HTMLInputElement} */ (
                t
            ).checked;
            // Reset idle schedule immediately.
            markInteraction();
            saveSettings();
        }
        if (t.id === `${MODULE_NAME}_blink_enabled`) {
            pluginConfig.blinkEnabled = /** @type {HTMLInputElement} */ (
                t
            ).checked;
            // Restart schedule so it feels responsive.
            const now = performance.now();
            vrmRenderState.blink.active = false;
            vrmRenderState.blink.t = 0;
            vrmRenderState.blink.nextAt = 0;
            if (pluginConfig.blinkEnabled) scheduleNextBlink(now);
            saveSettings();
        }
        if (t.id === `${MODULE_NAME}_pat_enabled`) {
            pluginConfig.patEnabled = /** @type {HTMLInputElement} */ (
                t
            ).checked;
            saveSettings();
        }
        if (t.id === `${MODULE_NAME}_relax_arms`) {
            pluginConfig.relaxArmsEnabled = /** @type {HTMLInputElement} */ (
                t
            ).checked;
            saveSettings();
        }
        if (t.id === `${MODULE_NAME}_relax_arms_gait`) {
            pluginConfig.relaxArmsDuringWanderGait =
                /** @type {HTMLInputElement} */ (t).checked;
            saveSettings();
        }
        if (t.id === `${MODULE_NAME}_relax_arms_mode`) {
            pluginConfig.relaxArmsMode = String(
                /** @type {HTMLSelectElement} */ (t).value || "zroll",
            );
            saveSettings();
        }
        if (t.id === `${MODULE_NAME}_drag_pose`) {
            pluginConfig.dragHeldPoseEnabled = /** @type {HTMLInputElement} */ (
                t
            ).checked;
            saveSettings();
        }

        // Auto-upload after file picked (button click opens the picker).
        if (t.id === `${MODULE_NAME}_file`) {
            refreshSelectedFileText();
            handleUploadSelectedFile().catch((err) => {
                const msg = err instanceof Error ? err.message : String(err);
                console.error("[VRM Pet] Upload failed", err);
                toastr?.error?.(msg, "VRM Pet");
            });
        }
    });

    document.addEventListener("input", (e) => {
        const t = e.target;
        if (!(t instanceof HTMLElement)) return;
        if (t.id === `${MODULE_NAME}_max_mb`) {
            const v = parseInt(/** @type {HTMLInputElement} */ (t).value, 10);
            pluginConfig.maxVrmFileSizeMB = Number.isFinite(v)
                ? v
                : DEFAULT_CONFIG.maxVrmFileSizeMB;
            const out = document.getElementById(`${MODULE_NAME}_max_mb_val`);
            if (out) out.textContent = String(pluginConfig.maxVrmFileSizeMB);
            saveSettings();
        }

        if (t.id === `${MODULE_NAME}_overlay_w`) {
            const v = parseInt(/** @type {HTMLInputElement} */ (t).value, 10);
            pluginConfig.overlayWidth = Number.isFinite(v)
                ? v
                : DEFAULT_CONFIG.overlayWidth;
            const out = document.getElementById(`${MODULE_NAME}_overlay_w_val`);
            if (out) out.textContent = String(pluginConfig.overlayWidth);
            const out2 = document.getElementById(
                `${MODULE_NAME}_overlay_size_val`,
            );
            if (out2)
                out2.textContent = `${pluginConfig.overlayWidth}×${pluginConfig.overlayHeight}`;
            saveSettings();
            ensureOverlay();
        }

        if (t.id === `${MODULE_NAME}_overlay_h`) {
            const v = parseInt(/** @type {HTMLInputElement} */ (t).value, 10);
            pluginConfig.overlayHeight = Number.isFinite(v)
                ? v
                : DEFAULT_CONFIG.overlayHeight;
            const out = document.getElementById(`${MODULE_NAME}_overlay_h_val`);
            if (out) out.textContent = String(pluginConfig.overlayHeight);
            const out2 = document.getElementById(
                `${MODULE_NAME}_overlay_size_val`,
            );
            if (out2)
                out2.textContent = `${pluginConfig.overlayWidth}×${pluginConfig.overlayHeight}`;
            saveSettings();
            ensureOverlay();
        }

        if (t.id === `${MODULE_NAME}_frame_opacity`) {
            const v = parseFloat(/** @type {HTMLInputElement} */ (t).value);
            pluginConfig.overlayFrameOpacity = Number.isFinite(v)
                ? clamp(v, 0, 0.9)
                : DEFAULT_CONFIG.overlayFrameOpacity;
            const out = document.getElementById(
                `${MODULE_NAME}_frame_opacity_val`,
            );
            if (out)
                out.textContent = Number(
                    pluginConfig.overlayFrameOpacity ?? 0.35,
                ).toFixed(2);
            saveSettings();
            ensureOverlay();
        }

        if (t.id === `${MODULE_NAME}_model_scale`) {
            const v = parseFloat(/** @type {HTMLInputElement} */ (t).value);
            pluginConfig.modelScale = Number.isFinite(v)
                ? v
                : DEFAULT_CONFIG.modelScale;
            const out = document.getElementById(
                `${MODULE_NAME}_model_scale_val`,
            );
            if (out)
                out.textContent = Number(pluginConfig.modelScale || 1).toFixed(
                    2,
                );
            saveSettings();
            applyModelScaleAndRefit();
        }

        if (t.id === `${MODULE_NAME}_wander_speed`) {
            const v = parseInt(/** @type {HTMLInputElement} */ (t).value, 10);
            pluginConfig.wanderSpeed = Number.isFinite(v)
                ? v
                : DEFAULT_CONFIG.wanderSpeed;
            const out = document.getElementById(
                `${MODULE_NAME}_wander_speed_val`,
            );
            if (out) out.textContent = String(pluginConfig.wanderSpeed);
            saveSettings();
        }

        if (t.id === `${MODULE_NAME}_wander_gait_intensity`) {
            const v = parseFloat(/** @type {HTMLInputElement} */ (t).value);
            pluginConfig.wanderGaitIntensity = Number.isFinite(v)
                ? v
                : DEFAULT_CONFIG.wanderGaitIntensity;
            const out = document.getElementById(
                `${MODULE_NAME}_wander_gait_intensity_val`,
            );
            if (out)
                out.textContent = Number(
                    pluginConfig.wanderGaitIntensity ?? 1,
                ).toFixed(2);
            saveSettings();
        }

        if (t.id === `${MODULE_NAME}_wander_face_angle`) {
            const v = parseFloat(/** @type {HTMLInputElement} */ (t).value);
            const deg = Number.isFinite(v) ? Math.max(0, Math.min(90, v)) : 45;
            pluginConfig.wanderFaceAngleDeg = deg;
            const out = document.getElementById(
                `${MODULE_NAME}_wander_face_angle_val`,
            );
            if (out) out.textContent = String(Math.round(deg));
            saveSettings();
            // Camera fit uses diagonal XZ now; this is mostly optional, but refit helps immediately.
            applyModelScaleAndRefit();
        }

        if (t.id === `${MODULE_NAME}_relax_arms_down`) {
            const v = parseFloat(/** @type {HTMLInputElement} */ (t).value);
            const deg = Number.isFinite(v) ? clamp(v, 0, 80) : 55;
            pluginConfig.relaxArmsDownDeg = deg;
            const out = document.getElementById(
                `${MODULE_NAME}_relax_arms_down_val`,
            );
            if (out) out.textContent = String(Math.round(deg));
            saveSettings();
        }

        if (t.id === `${MODULE_NAME}_relax_arms_bend`) {
            const v = parseFloat(/** @type {HTMLInputElement} */ (t).value);
            const deg = Number.isFinite(v) ? clamp(v, 0, 35) : 16;
            pluginConfig.relaxArmsElbowBendDeg = deg;
            const out = document.getElementById(
                `${MODULE_NAME}_relax_arms_bend_val`,
            );
            if (out) out.textContent = String(Math.round(deg));
            saveSettings();
        }

        if (t.id === `${MODULE_NAME}_relax_arms_fwd`) {
            const v = parseFloat(/** @type {HTMLInputElement} */ (t).value);
            const deg = Number.isFinite(v) ? clamp(v, -25, 35) : 10;
            pluginConfig.relaxArmsForwardDeg = deg;
            const out = document.getElementById(
                `${MODULE_NAME}_relax_arms_fwd_val`,
            );
            if (out) out.textContent = String(Math.round(deg));
            saveSettings();
        }

        if (t.id === `${MODULE_NAME}_relax_arms_out`) {
            const v = parseFloat(/** @type {HTMLInputElement} */ (t).value);
            const deg = Number.isFinite(v) ? clamp(v, -25, 25) : 8;
            pluginConfig.relaxArmsOutDeg = deg;
            const out = document.getElementById(
                `${MODULE_NAME}_relax_arms_out_val`,
            );
            if (out) out.textContent = String(Math.round(deg));
            saveSettings();
        }

        if (t.id === `${MODULE_NAME}_drag_pose_intensity`) {
            const v = parseFloat(/** @type {HTMLInputElement} */ (t).value);
            pluginConfig.dragHeldPoseIntensity = Number.isFinite(v)
                ? clamp(v, 0, 2)
                : 1.0;
            const out = document.getElementById(
                `${MODULE_NAME}_drag_pose_intensity_val`,
            );
            if (out)
                out.textContent = Number(
                    pluginConfig.dragHeldPoseIntensity ?? 1,
                ).toFixed(2);
            saveSettings();
        }
    });

    document.addEventListener("click", async (e) => {
        const t = e.target;
        if (!(t instanceof HTMLElement)) return;

        if (t.id === `${MODULE_NAME}_select_btn`) {
            e.preventDefault();
            const fileInput = /** @type {HTMLInputElement|null} */ (
                document.getElementById(`${MODULE_NAME}_file`)
            );
            fileInput?.click();
            return;
        }

        if (t.id === `${MODULE_NAME}_upload_btn`) {
            e.preventDefault();
            try {
                await handleUploadSelectedFile();
            } catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                console.error("[VRM Pet] Upload failed", err);
                toastr?.error?.(msg, "VRM Pet");
            }
        }

        if (t.id === `${MODULE_NAME}_clear_btn`) {
            e.preventDefault();
            try {
                const ctx = getContext();
                const character = getCurrentCharacter();
                if (!character) throw new Error("当前未选择角色");
                const existing = getCharacterExtensionData(character) || {};
                const next = mergeDeep(existing, {
                    vrm: {
                        url: "",
                        storedName: "",
                        originalName: "",
                        uploadedAt: 0,
                    },
                });
                await ctx.writeExtensionField(
                    ctx.characterId,
                    MODULE_NAME,
                    next,
                );
                toastr?.success?.(
                    "已清除当前角色绑定（未删除服务器文件）",
                    "VRM Pet",
                );
                refreshCurrentBindingText();
            } catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                toastr?.error?.(msg, "VRM Pet");
            }
        }
    });
}

function bindCharacterChangeRefresh() {
    const ctx = getContext();
    // Refresh text on common navigation events
    const events = [
        ctx.eventTypes.CHAT_CHANGED,
        ctx.eventTypes.CHARACTER_PAGE_LOADED,
        ctx.eventTypes.GROUP_UPDATED,
    ];
    for (const ev of events) {
        ctx.eventSource.on(ev, () => {
            removePetRadialMenu();
            removePetChatModal();
            removePetEditorModal();
            removePetEmotePanel();
            removePetSpeechBubble();
            refreshCurrentBindingText();
            loadVrmForCurrentCharacter().catch(() => {});
        });
    }
}

async function loadVrmForCurrentCharacter() {
    const character = getCurrentCharacter();
    const ext = character ? getCharacterExtensionData(character) : null;
    const url = ext?.vrm?.url || "";
    await loadVrmFromUrl(url);
}

function init() {
    initConfig();
    createSettingsInterface();
    refreshSelectedFileText();
    ensureOverlay();
    ensureLegGaitLoop();
    bindGlobalPointerTracking();
    markInteraction();
    bindCharacterChangeRefresh();
    bindActionTriggers();
    loadVrmForCurrentCharacter().catch(() => {});
    log("Initialized");
}

$(document).ready(() => init());
