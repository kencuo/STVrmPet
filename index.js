/* VRM Pet: floating overlay + settings layout */

#vrm-pet-settings .settings-title-text {
  font-weight: 600;
}

#vrm-pet-settings .vrm-pet-row {
  display: flex;
  gap: 8px;
  align-items: center;
  flex-wrap: wrap;
}

#vrm-pet-settings .vrm-pet-path {
  word-break: break-all;
  opacity: 0.9;
}

/* Floating "pet" container (renderer will be added later) */
#vrm-pet-overlay {
  position: fixed;
  right: 14px;
  bottom: 14px;
  width: 240px;
  height: 240px;
  z-index: 9999;
  pointer-events: auto;
}

#vrm-pet-overlay .vrm-pet-shell {
  position: relative;
  width: 100%;
  height: 100%;
  border-radius: 14px;
  background: rgba(0, 0, 0, 0.35);
  border: 1px solid rgba(255, 255, 255, 0.12);
  backdrop-filter: blur(6px);
  display: grid;
  place-items: center;
  user-select: none;
  touch-action: none; /* required for pointer-drag on mobile */
  overflow: hidden;
}

#vrm-pet-overlay .vrm-pet-menu-btn {
  position: absolute;
  right: 8px;
  top: 8px;
  z-index: 10010;
  width: 32px;
  height: 28px;
  border-radius: 10px;
  border: 1px solid rgba(255, 255, 255, 0.22);
  background: rgba(0, 0, 0, 0.18);
  color: rgba(255, 255, 255, 0.92);
  cursor: pointer;
  font-size: 18px;
  line-height: 1;
  display: grid;
  place-items: center;
  backdrop-filter: blur(6px);
}

#vrm-pet-overlay .vrm-pet-menu-btn:hover {
  background: rgba(0, 0, 0, 0.26);
}

#vrm-pet-overlay .vrm-pet-stage {
  position: absolute;
  inset: 0;
}

#vrm-pet-overlay canvas {
  width: 100%;
  height: 100%;
  display: block;
}

#vrm-pet-overlay .vrm-pet-shell .vrm-pet-hint {
  position: absolute;
  inset: 0;
  display: grid;
  place-items: center;
  font-size: 12px;
  opacity: 0.9;
  padding: 10px;
  text-align: center;
  background: rgba(0, 0, 0, 0.15);
  pointer-events: none;
}

/* Radial menu (right-click / long-press on the pet) */
#vrm-pet-overlay .vrm-pet-radial-overlay {
  /* Full-viewport overlay so the menu isn't clipped by the 240×240 pet box. */
  position: fixed;
  inset: 0;
  z-index: 10020;
  background: transparent;
  touch-action: none;
}

#vrm-pet-overlay .vrm-pet-quick-menu {
  position: fixed; /* positioned via JS */
  width: 200px;
  padding: 8px;
  border-radius: 14px;
  background: rgba(255, 255, 255, 0.96);
  border: 1.5px solid rgba(224, 198, 247, 0.95);
  box-shadow: 0 10px 22px rgba(0, 0, 0, 0.18);
  display: grid;
  gap: 8px;
}

#vrm-pet-overlay .vrm-pet-quick-item {
  width: 100%;
  height: 36px;
  border-radius: 12px;
  border: 1px solid rgba(0, 0, 0, 0.10);
  background: rgba(255, 255, 255, 0.98);
  cursor: pointer;
  font-size: 12px;
  font-weight: 700;
  color: #222;
  text-align: left;
  padding: 0 10px;
}

#vrm-pet-overlay .vrm-pet-quick-item:hover {
  filter: brightness(0.98);
}

#vrm-pet-overlay .vrm-pet-quick-close {
  position: absolute;
  right: 8px;
  top: 8px;
  width: 32px;
  height: 28px;
  border-radius: 10px;
  border: 1px solid rgba(224, 198, 247, 0.8);
  background: #fff;
  cursor: pointer;
  font-size: 18px;
  line-height: 1;
  color: #333;
}

#vrm-pet-overlay .vrm-pet-radial-menu {
  position: absolute;
  width: 220px;
  height: 220px;
  transform: translate(-50%, -50%);
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.92);
  border: 1.5px solid rgba(224, 198, 247, 0.95);
  box-shadow: 0 6px 20px rgba(224, 198, 247, 0.35);
  backdrop-filter: blur(8px);
}

#vrm-pet-overlay .vrm-pet-radial-center {
  position: absolute;
  left: 50%;
  top: 50%;
  width: 72px;
  height: 72px;
  transform: translate(-50%, -50%);
  border-radius: 999px;
  border: 1px solid rgba(224, 198, 247, 0.9);
  background: linear-gradient(180deg, #ffffff, #f8f1ff);
  box-shadow: 0 4px 10px rgba(0, 0, 0, 0.08);
  color: #222;
  font-size: 22px;
  cursor: pointer;
}

#vrm-pet-overlay .vrm-pet-radial-item {
  position: absolute;
  left: 50%;
  top: 50%;
  width: 64px;
  height: 64px;
  transform-origin: center;
  transform: translate(-50%, -50%) rotate(var(--angle, 0deg)) translate(var(--radius, 78px))
    rotate(calc(var(--angle, 0deg) * -1));
  border-radius: 18px;
  border: 1px solid rgba(224, 198, 247, 0.75);
  background: #fff;
  box-shadow: 0 3px 10px rgba(0, 0, 0, 0.08);
  cursor: pointer;
  display: grid;
  place-items: center;
  gap: 2px;
  padding: 0;
}

#vrm-pet-overlay .vrm-pet-radial-item:hover {
  filter: brightness(0.98);
}

#vrm-pet-overlay .vrm-pet-radial-icon {
  font-size: 20px;
  line-height: 1;
}

#vrm-pet-overlay .vrm-pet-radial-label {
  font-size: 11px;
  line-height: 1;
  color: #444;
  font-weight: 600;
}

/* Pet chat modal (separate from main SillyTavern chat input) */
#vrm-pet-overlay .vrm-pet-chat-overlay {
  /* Use viewport-sized modal; the pet overlay itself is only ~240px. */
  position: fixed;
  inset: 0;
  z-index: 10030;
  /* Keep the pet visible while chatting; only use this as a click-catcher. */
  background: transparent;
  backdrop-filter: none;
  touch-action: none;
  display: block; /* we position the panel near the pet via JS */
}

#vrm-pet-overlay .vrm-pet-chat {
  width: min(48vw, 620px);
  height: min(60vh, 700px);
  border-radius: 14px;
  background: rgba(255, 255, 255, 0.96);
  border: 1.5px solid rgba(224, 198, 247, 0.95);
  box-shadow: 0 10px 28px rgba(0, 0, 0, 0.18);
  display: grid;
  grid-template-rows: auto 1fr auto auto;
  overflow: hidden;
}

#vrm-pet-overlay .vrm-pet-editor-overlay {
  position: fixed;
  inset: 0;
  z-index: 10040;
  /* Keep the pet visible while editing; only use this as a click-catcher. */
  background: transparent;
  backdrop-filter: none;
  touch-action: none;
  display: block; /* we position the panel near the pet via JS */
}

#vrm-pet-overlay .vrm-pet-editor {
  width: min(48vw, 620px);
  height: min(60vh, 700px);
  border-radius: 14px;
  background: rgba(255, 255, 255, 0.96);
  border: 1.5px solid rgba(224, 198, 247, 0.95);
  box-shadow: 0 10px 28px rgba(0, 0, 0, 0.18);
  display: grid;
  grid-template-rows: auto 1fr auto;
  overflow: hidden;
}

#vrm-pet-overlay .vrm-pet-editor-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 10px;
  background: linear-gradient(180deg, #ffffff, #f8f1ff);
  border-bottom: 1px solid rgba(224, 198, 247, 0.65);
}

#vrm-pet-overlay .vrm-pet-editor-title {
  font-weight: 700;
  font-size: 13px;
  color: #333;
}

#vrm-pet-overlay .vrm-pet-editor-btn {
  width: 34px;
  height: 28px;
  border-radius: 10px;
  border: 1px solid rgba(224, 198, 247, 0.8);
  background: #fff;
  cursor: pointer;
  font-size: 18px;
  line-height: 1;
  color: #333;
}

#vrm-pet-overlay .vrm-pet-editor-textarea {
  width: calc(100% - 20px);
  margin: 10px;
  resize: none;
  border-radius: 12px;
  border: 1px solid rgba(0, 0, 0, 0.12);
  padding: 10px 12px;
  font-size: 12px;
  line-height: 1.35;
  background: #fff;
  color: #222;
}

#vrm-pet-overlay .vrm-pet-editor-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  padding: 10px;
  padding-top: 0;
  background: rgba(255, 255, 255, 0.9);
}

#vrm-pet-overlay .vrm-pet-editor-mini {
  border-radius: 12px;
  border: 1px solid rgba(0, 0, 0, 0.12);
  background: #fff;
  cursor: pointer;
  padding: 6px 10px;
  font-size: 12px;
}

#vrm-pet-overlay .vrm-pet-editor-save {
  border-radius: 12px;
  border: 1px solid rgba(224, 198, 247, 0.75);
  background: #fff;
  cursor: pointer;
  padding: 6px 12px;
  font-size: 12px;
  font-weight: 700;
}

#vrm-pet-overlay .vrm-pet-editor-save:disabled {
  opacity: 0.65;
  cursor: default;
}

#vrm-pet-overlay .vrm-pet-chat-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 10px;
  background: linear-gradient(180deg, #ffffff, #f8f1ff);
  border-bottom: 1px solid rgba(224, 198, 247, 0.65);
}

#vrm-pet-overlay .vrm-pet-chat-title {
  font-weight: 700;
  font-size: 13px;
  color: #333;
}

#vrm-pet-overlay .vrm-pet-chat-btn {
  width: 34px;
  height: 28px;
  border-radius: 10px;
  border: 1px solid rgba(224, 198, 247, 0.8);
  background: #fff;
  cursor: pointer;
  font-size: 18px;
  line-height: 1;
  color: #333;
}

#vrm-pet-overlay .vrm-pet-chat-body {
  padding: 10px;
  overflow: auto;
  display: flex;
  flex-direction: column;
  gap: 10px;
}

#vrm-pet-overlay .vrm-pet-chat-msg {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

#vrm-pet-overlay .vrm-pet-chat-msg.user {
  align-items: flex-end;
}

#vrm-pet-overlay .vrm-pet-chat-msg.assistant {
  align-items: flex-start;
}

#vrm-pet-overlay .vrm-pet-chat-who {
  font-size: 11px;
  opacity: 0.72;
}

#vrm-pet-overlay .vrm-pet-chat-bubble {
  max-width: 86%;
  padding: 8px 10px;
  border-radius: 12px;
  border: 1px solid rgba(0, 0, 0, 0.07);
  background: rgba(255, 255, 255, 0.95);
  color: #222;
  font-size: 12px;
  line-height: 1.35;
  word-break: break-word;
  white-space: pre-wrap;
}

#vrm-pet-overlay .vrm-pet-chat-bubble-wrap {
  position: relative;
  max-width: 86%;
}

#vrm-pet-overlay .vrm-pet-chat-del {
  position: absolute;
  right: -6px;
  top: -8px;
  width: 22px;
  height: 22px;
  border-radius: 999px;
  border: 1px solid rgba(0, 0, 0, 0.12);
  background: rgba(255, 255, 255, 0.95);
  cursor: pointer;
  font-size: 14px;
  line-height: 1;
  display: none;
}

#vrm-pet-overlay .vrm-pet-chat-msg:hover .vrm-pet-chat-del {
  display: grid;
  place-items: center;
}

#vrm-pet-overlay .vrm-pet-chat-msg.user .vrm-pet-chat-bubble {
  background: rgba(224, 198, 247, 0.20);
  border-color: rgba(224, 198, 247, 0.55);
}

#vrm-pet-overlay .vrm-pet-chat-input {
  display: grid;
  grid-template-columns: 1fr auto;
  gap: 8px;
  padding: 10px;
  border-top: 1px solid rgba(224, 198, 247, 0.55);
  background: rgba(255, 255, 255, 0.9);
}

#vrm-pet-overlay .vrm-pet-chat-textarea {
  width: 100%;
  resize: none;
  border-radius: 12px;
  border: 1px solid rgba(0, 0, 0, 0.12);
  padding: 8px 10px;
  font-size: 12px;
  line-height: 1.25;
  background: #fff;
  color: #222;
}

#vrm-pet-overlay .vrm-pet-chat-send {
  min-width: 62px;
  border-radius: 12px;
  border: 1px solid rgba(224, 198, 247, 0.75);
  background: #fff;
  cursor: pointer;
  font-weight: 700;
  font-size: 12px;
}

#vrm-pet-overlay .vrm-pet-chat-send:disabled {
  opacity: 0.65;
  cursor: default;
}

#vrm-pet-overlay .vrm-pet-chat-footer {
  display: flex;
  gap: 8px;
  padding: 10px;
  padding-top: 0;
  justify-content: flex-end;
  background: rgba(255, 255, 255, 0.9);
}

#vrm-pet-overlay .vrm-pet-chat-mini {
  border-radius: 12px;
  border: 1px solid rgba(0, 0, 0, 0.12);
  background: #fff;
  cursor: pointer;
  padding: 6px 10px;
  font-size: 12px;
}

/* FX layer (DOM particles) */
#vrm-pet-overlay .vrm-pet-fx {
  position: absolute;
  inset: 0;
  pointer-events: none;
}

#vrm-pet-overlay .vrm-pet-heart {
  position: absolute;
  width: 10px;
  height: 10px;
  transform: translate(-50%, -50%) rotate(45deg);
  background: rgba(255, 93, 162, 0.95);
  filter: drop-shadow(0 2px 4px rgba(0, 0, 0, 0.25));
  animation: vrmPetHeart var(--vrmPetDur, 700ms) ease-out forwards;
}

#vrm-pet-overlay .vrm-pet-heart::before,
#vrm-pet-overlay .vrm-pet-heart::after {
  content: "";
  position: absolute;
  width: 10px;
  height: 10px;
  border-radius: 50%;
  background: inherit;
}

#vrm-pet-overlay .vrm-pet-heart::before {
  left: -5px;
  top: 0;
}

#vrm-pet-overlay .vrm-pet-heart::after {
  left: 0;
  top: -5px;
}

@keyframes vrmPetHeart {
  from {
    opacity: 0.0;
    transform: translate(-50%, -50%) rotate(45deg) scale(0.85);
  }
  10% {
    opacity: 1.0;
  }
  to {
    opacity: 0.0;
    transform: translate(calc(-50% + var(--vrmPetDx, 0px)), calc(-50% - var(--vrmPetLift, 42px))) rotate(45deg) scale(1.35);
  }
}

/* Emoji / mood FX */
#vrm-pet-overlay .vrm-pet-emoji-fx {
  position: absolute;
  transform: translate(-50%, -50%);
  font-size: 18px;
  line-height: 1;
  opacity: 0;
  filter: drop-shadow(0 2px 4px rgba(0, 0, 0, 0.25));
  animation: vrmPetEmoji var(--vrmPetDur, 820ms) ease-out forwards;
}

@keyframes vrmPetEmoji {
  from {
    opacity: 0.0;
    transform: translate(-50%, -50%) scale(0.85);
  }
  12% {
    opacity: 1.0;
  }
  to {
    opacity: 0.0;
    transform: translate(calc(-50% + var(--vrmPetDx, 0px)), calc(-50% - var(--vrmPetLift, 26px))) scale(1.25);
  }
}

#vrm-pet-overlay .vrm-pet-blackface-fx {
  position: absolute;
  inset: 0;
  pointer-events: none;
  opacity: 0;
  /* A simple "black face" mood veil; works even if the VRM lacks expressions. */
  background:
    radial-gradient(circle at 50% 45%, rgba(0, 0, 0, 0.55), rgba(0, 0, 0, 0.0) 65%),
    linear-gradient(180deg, rgba(0, 0, 0, 0.38), rgba(0, 0, 0, 0.0) 70%);
  animation: vrmPetBlackface 900ms ease-in-out forwards;
}

@keyframes vrmPetBlackface {
  0% { opacity: 0.0; }
  18% { opacity: 1.0; }
  100% { opacity: 0.0; }
}

/* Emote picker panel */
#vrm-pet-overlay .vrm-pet-emote-overlay {
  position: fixed;
  inset: 0;
  z-index: 10035;
  background: transparent;
  touch-action: none;
}

#vrm-pet-overlay .vrm-pet-emote-panel {
  width: 210px;
  border-radius: 14px;
  background: rgba(255, 255, 255, 0.96);
  border: 1.5px solid rgba(224, 198, 247, 0.95);
  box-shadow: 0 10px 22px rgba(0, 0, 0, 0.18);
  padding: 10px;
  display: grid;
  grid-template-columns: 1fr auto;
  grid-template-rows: auto auto;
  gap: 8px;
}

#vrm-pet-overlay .vrm-pet-emote-title {
  grid-column: 1 / 2;
  font-weight: 800;
  font-size: 13px;
  color: #222;
  align-self: center;
}

#vrm-pet-overlay .vrm-pet-emote-close {
  grid-column: 2 / 3;
  width: 32px;
  height: 28px;
  border-radius: 10px;
  border: 1px solid rgba(224, 198, 247, 0.8);
  background: #fff;
  cursor: pointer;
  font-size: 18px;
  line-height: 1;
  color: #333;
}

#vrm-pet-overlay .vrm-pet-emote-grid {
  grid-column: 1 / 3;
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 8px;
}

#vrm-pet-overlay .vrm-pet-emote-btn {
  width: 100%;
  border-radius: 12px;
  border: 1px solid rgba(0, 0, 0, 0.10);
  background: rgba(255, 255, 255, 0.98);
  cursor: pointer;
  display: grid;
  grid-template-columns: auto 1fr;
  align-items: center;
  gap: 8px;
  padding: 8px 10px;
  color: #222;
}

#vrm-pet-overlay .vrm-pet-emote-btn:hover {
  filter: brightness(0.98);
}

/* Speech bubble (show AI replies beside the pet) */
#vrm-pet-overlay .vrm-pet-speech-bubble {
  position: fixed; /* positioned via JS */
  z-index: 10050;
  pointer-events: none;
  max-width: min(42vw, 360px);
  max-height: 180px;
  overflow: hidden;
  padding: 10px 12px;
  border-radius: 14px;
  background: rgba(255, 255, 255, 0.98);
  border: 1.5px solid rgba(224, 198, 247, 0.95);
  box-shadow: 0 10px 22px rgba(0, 0, 0, 0.18);
  color: #222;
  font-size: 12px;
  line-height: 1.35;
  opacity: 1;
  transform: translateY(0);
  transition: opacity 180ms ease, transform 180ms ease;
  white-space: pre-wrap;
  word-break: break-word;
}

#vrm-pet-overlay .vrm-pet-speech-bubble.vrm-pet-hide {
  opacity: 0;
  transform: translateY(-6px);
}

#vrm-pet-overlay .vrm-pet-speech-bubble::after {
  content: "";
  position: absolute;
  width: 0;
  height: 0;
  border: 9px solid transparent;
}

/* Arrow points toward the pet */
#vrm-pet-overlay .vrm-pet-speech-bubble::before {
  content: "";
  position: absolute;
  width: 0;
  height: 0;
  border: 10px solid transparent;
}

#vrm-pet-overlay .vrm-pet-speech-bubble[data-side="right"]::before {
  left: -20px;
  top: 17px;
  border-right-color: rgba(224, 198, 247, 0.95);
}

#vrm-pet-overlay .vrm-pet-speech-bubble[data-side="right"]::after {
  left: -18px;
  top: 18px;
  border-right-color: rgba(255, 255, 255, 0.98);
}

#vrm-pet-overlay .vrm-pet-speech-bubble[data-side="left"]::before {
  right: -20px;
  top: 17px;
  border-left-color: rgba(224, 198, 247, 0.95);
}

#vrm-pet-overlay .vrm-pet-speech-bubble[data-side="left"]::after {
  right: -18px;
  top: 18px;
  border-left-color: rgba(255, 255, 255, 0.98);
}

#vrm-pet-overlay .vrm-pet-emote-ico {
  font-size: 16px;
  line-height: 1;
}

#vrm-pet-overlay .vrm-pet-emote-lbl {
  font-size: 12px;
  font-weight: 800;
}
