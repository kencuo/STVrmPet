/**
 * VRM Pet (Per Character) - SillyTavern Extension
 * - Upload a .vrm file to SillyTavern server via /api/files/upload
 * - Save the returned URL into the current character's extensions field
 * - Show a draggable floating placeholder (renderer can be added later)
 */

import { getContext } from '/scripts/extensions.js';
import { getStringHash } from '/scripts/utils.js';

const MODULE_NAME = 'vrm-pet';

const DEFAULT_CONFIG = {
  enabled: true,
  maxVrmFileSizeMB: 80,
  showOverlay: true,
  overlayWidth: 240,
  overlayHeight: 240,
  // persisted per-user overlay position (in viewport px). If null, use bottom-right default.
  overlayPos: null,
  enableLogging: false,
};

let pluginConfig = {};

function log(...args) {
  if (pluginConfig.enableLogging) console.log('[VRM Pet]', ...args);
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
    if (character?.data?.extensions?.[MODULE_NAME]) return character.data.extensions[MODULE_NAME];
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
  const out = { ...(base && typeof base === 'object' ? base : {}) };
  for (const [k, v] of Object.entries(patch || {})) {
    if (v && typeof v === 'object' && !Array.isArray(v)) out[k] = mergeDeep(out[k], v);
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
  log('Config loaded', pluginConfig);
}

function ensureOverlay() {
  const ctx = getContext();
  let el = document.getElementById('vrm-pet-overlay');

  if (!pluginConfig.enabled || !pluginConfig.showOverlay) {
    if (el) el.remove();
    return;
  }

  if (!el) {
    el = document.createElement('div');
    el.id = 'vrm-pet-overlay';
    el.innerHTML = `
      <div class="vrm-pet-shell" title="Drag to move">
        <div class="vrm-pet-hint">VRM Pet 占位框（后续接 three-vrm 渲染）<br/>拖动可移动</div>
      </div>
    `;
    document.body.appendChild(el);
  }

  // Size
  el.style.width = `${Number(pluginConfig.overlayWidth) || 240}px`;
  el.style.height = `${Number(pluginConfig.overlayHeight) || 240}px`;

  // Position
  if (pluginConfig.overlayPos && typeof pluginConfig.overlayPos.x === 'number' && typeof pluginConfig.overlayPos.y === 'number') {
    el.style.left = `${pluginConfig.overlayPos.x}px`;
    el.style.top = `${pluginConfig.overlayPos.y}px`;
    el.style.right = 'auto';
    el.style.bottom = 'auto';
  } else {
    el.style.left = 'auto';
    el.style.top = 'auto';
    el.style.right = '14px';
    el.style.bottom = '14px';
  }

  bindOverlayDrag(el);
}

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

function bindOverlayDrag(overlayEl) {
  const shell = overlayEl.querySelector('.vrm-pet-shell');
  if (!shell) return;
  if (shell.__vrmPetDragBound) return;
  shell.__vrmPetDragBound = true;

  let dragging = false;
  let pointerId = null;
  let start = null;

  shell.addEventListener('pointerdown', (e) => {
    if (!pluginConfig.enabled || !pluginConfig.showOverlay) return;
    dragging = true;
    pointerId = e.pointerId;
    shell.setPointerCapture(pointerId);

    const rect = overlayEl.getBoundingClientRect();
    start = { x: e.clientX, y: e.clientY, left: rect.left, top: rect.top };
    e.preventDefault();
  });

  shell.addEventListener('pointermove', (e) => {
    if (!dragging || pointerId !== e.pointerId || !start) return;
    const dx = e.clientX - start.x;
    const dy = e.clientY - start.y;

    const w = overlayEl.offsetWidth;
    const h = overlayEl.offsetHeight;
    const x = clamp(start.left + dx, 0, window.innerWidth - w);
    const y = clamp(start.top + dy, 0, window.innerHeight - h);

    overlayEl.style.left = `${x}px`;
    overlayEl.style.top = `${y}px`;
    overlayEl.style.right = 'auto';
    overlayEl.style.bottom = 'auto';

    // live-update (but save only on pointerup)
    pluginConfig.overlayPos = { x: Math.round(x), y: Math.round(y) };
  });

  const stop = async (e) => {
    if (!dragging || pointerId !== e.pointerId) return;
    dragging = false;
    pointerId = null;
    start = null;
    try {
      const ctx = getContext();
      ctx.extensionSettings[MODULE_NAME] = pluginConfig;
      ctx.saveSettingsDebounced();
    } catch (_) {}
  };

  shell.addEventListener('pointerup', stop);
  shell.addEventListener('pointercancel', stop);
}

function readFileAsBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const res = String(reader.result || '');
      const comma = res.indexOf(',');
      if (comma === -1) return reject(new Error('Invalid data URL'));
      resolve(res.slice(comma + 1));
    };
    reader.onerror = () => reject(new Error('File read failed'));
    reader.readAsDataURL(file);
  });
}

async function uploadVrmToServer(file) {
  if (!file) throw new Error('No file selected');
  const ext = String(file.name || '').split('.').pop()?.toLowerCase();
  if (ext !== 'vrm') throw new Error('Only .vrm is supported');

  const maxBytes = Number(pluginConfig.maxVrmFileSizeMB) * 1024 * 1024;
  if (file.size > maxBytes) throw new Error(`VRM too large (limit: ${pluginConfig.maxVrmFileSizeMB}MB)`);

  const base64Data = await readFileAsBase64(file);
  const safeName = `vrm_${Date.now()}_${getStringHash(file.name)}.vrm`;

  const ctx = getContext();
  const result = await fetch('/api/files/upload', {
    method: 'POST',
    headers: ctx.getRequestHeaders(),
    body: JSON.stringify({ name: safeName, data: base64Data }),
  });

  if (!result.ok) {
    const text = await result.text().catch(() => '');
    throw new Error(text || `Upload failed (HTTP ${result.status})`);
  }

  const json = await result.json();
  if (!json?.path) throw new Error('Upload response missing path');
  return { url: json.path, storedName: safeName };
}

async function saveVrmToCurrentCharacter(vrmInfo) {
  const ctx = getContext();
  const character = getCurrentCharacter();
  if (!character) throw new Error('No character selected (group chat not supported yet)');

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
  if (document.getElementById('vrm-pet-settings')) return;

  const root = document.createElement('div');
  root.id = 'vrm-pet-settings';
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
              <input type="checkbox" id="${MODULE_NAME}_enabled" class="toggle-input" ${pluginConfig.enabled ? 'checked' : ''} />
              <label for="${MODULE_NAME}_enabled" class="toggle-label"><span class="toggle-handle"></span></label>
            </div>
          </div>

          <div class="extension-content-item box-container">
            <div class="flex flexFlowColumn wide100p">
              <div class="settings-title-text">为当前角色上传 VRM</div>
              <div class="settings-title-description">文件会保存到酒馆服务器（/api/files/upload）</div>
              <div class="vrm-pet-row marginTop5">
                <input type="file" id="${MODULE_NAME}_file" accept=".vrm" />
                <button class="menu_button" id="${MODULE_NAME}_upload_btn">上传并绑定到当前角色</button>
                <button class="menu_button" id="${MODULE_NAME}_clear_btn">清除当前角色绑定</button>
              </div>
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

        </div>
      </div>
    </div>
  `;

  const container = document.getElementById('extensions_settings');
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
    el.textContent = '当前未选择角色（群聊/未进角色聊天）。';
    return;
  }

  const ext = getCharacterExtensionData(character);
  const url = ext?.vrm?.url;
  if (!url) {
    el.textContent = '当前角色未绑定 VRM。';
    return;
  }
  el.textContent = `当前角色 VRM：${url}`;
}

function saveSettings() {
  const ctx = getContext();
  ctx.extensionSettings[MODULE_NAME] = pluginConfig;
  ctx.saveSettingsDebounced();
}

function bindSettingsEvents() {
  document.addEventListener('change', (e) => {
    const t = e.target;
    if (!(t instanceof HTMLElement)) return;
    if (t.id === `${MODULE_NAME}_enabled`) {
      pluginConfig.enabled = /** @type {HTMLInputElement} */ (t).checked;
      saveSettings();
      ensureOverlay();
    }
  });

  document.addEventListener('input', (e) => {
    const t = e.target;
    if (!(t instanceof HTMLElement)) return;
    if (t.id === `${MODULE_NAME}_max_mb`) {
      const v = parseInt(/** @type {HTMLInputElement} */ (t).value, 10);
      pluginConfig.maxVrmFileSizeMB = Number.isFinite(v) ? v : DEFAULT_CONFIG.maxVrmFileSizeMB;
      const out = document.getElementById(`${MODULE_NAME}_max_mb_val`);
      if (out) out.textContent = String(pluginConfig.maxVrmFileSizeMB);
      saveSettings();
    }
  });

  document.addEventListener('click', async (e) => {
    const t = e.target;
    if (!(t instanceof HTMLElement)) return;

    if (t.id === `${MODULE_NAME}_upload_btn`) {
      e.preventDefault();
      try {
        const fileInput = /** @type {HTMLInputElement|null} */ (document.getElementById(`${MODULE_NAME}_file`));
        const file = fileInput?.files?.[0];
        if (!file) throw new Error('请选择一个 .vrm 文件');

        toastr?.info?.('正在上传 VRM…', 'VRM Pet');
        const uploaded = await uploadVrmToServer(file);
        const saved = await saveVrmToCurrentCharacter({
          url: uploaded.url,
          storedName: uploaded.storedName,
          originalName: file.name,
        });
        log('Saved character extension data', saved);
        toastr?.success?.('已上传并绑定到当前角色', 'VRM Pet');
        refreshCurrentBindingText();
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error('[VRM Pet] Upload failed', err);
        toastr?.error?.(msg, 'VRM Pet');
      }
    }

    if (t.id === `${MODULE_NAME}_clear_btn`) {
      e.preventDefault();
      try {
        const ctx = getContext();
        const character = getCurrentCharacter();
        if (!character) throw new Error('当前未选择角色');
        const existing = getCharacterExtensionData(character) || {};
        const next = mergeDeep(existing, { vrm: { url: '', storedName: '', originalName: '', uploadedAt: 0 } });
        await ctx.writeExtensionField(ctx.characterId, MODULE_NAME, next);
        toastr?.success?.('已清除当前角色绑定（未删除服务器文件）', 'VRM Pet');
        refreshCurrentBindingText();
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        toastr?.error?.(msg, 'VRM Pet');
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
      refreshCurrentBindingText();
    });
  }
}

function init() {
  initConfig();
  createSettingsInterface();
  ensureOverlay();
  bindCharacterChangeRefresh();
  log('Initialized');
}

$(document).ready(() => init());

