/**
 * VRM Pet (Per Character) - SillyTavern Extension
 * - Upload a .vrm file to SillyTavern server via /api/files/upload
 * - Save the returned URL into the current character's extensions field
 * - Show a draggable floating placeholder (renderer can be added later)
 */

import { getContext } from '/scripts/extensions.js';
import { getStringHash } from '/scripts/utils.js';

// NOTE: Keep `?v=` in sync across local vendor modules to avoid duplicate module instances in the browser cache.
import * as THREE from './vendor/three.module.js?v=2026012702';
import { GLTFLoader } from './vendor/GLTFLoader.js?v=2026012702';
import { VRMLoaderPlugin, VRMUtils } from './vendor/three-vrm.module.js?v=2026012702';

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

const vrmRenderState = {
  initialized: false,
  initPromise: null,
  renderer: null,
  scene: null,
  camera: null,
  clock: null,
  rafId: null,
  resizeObserver: null,
  currentVrm: null,
  currentUrl: '',
  loadingToken: 0,
};

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
    stopRenderLoop();
    return;
  }

  if (!el) {
    el = document.createElement('div');
    el.id = 'vrm-pet-overlay';
    el.innerHTML = `
      <div class="vrm-pet-shell" title="Drag to move">
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

  // Ensure renderer is mounted once overlay exists.
  ensureRenderer(el).catch((err) => {
    console.error('[VRM Pet] Renderer init failed', err);
    setHint(`渲染初始化失败：${err instanceof Error ? err.message : String(err)}`);
  });
}

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

function setHint(text) {
  const el = document.getElementById('vrm-pet-hint');
  if (!el) return;
  el.textContent = text || '';
  el.style.display = text ? 'grid' : 'none';
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

function replaceMToonMaterialsWithStandard(root) {
  if (!root) return;

  // @pixiv/three-vrm's MToonMaterial currently isn't compatible with our vendored Three r161 shader chunks.
  // Fallback to MeshBasicMaterial so models render (skinning included) and colors are visible even without lighting.
  root.traverse((obj) => {
    if (!obj || !obj.isMesh) return;

    const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
    let changed = false;

    const nextMats = mats.map((m) => {
      if (!m || !m.isShaderMaterial || !m.isMToonMaterial) return m;
      changed = true;

      const base = new THREE.MeshBasicMaterial({
        color: m.color?.clone?.() ?? new THREE.Color(1, 1, 1),
        map: m.map ?? null,
        transparent: !!m.transparent,
        opacity: typeof m.opacity === 'number' ? m.opacity : 1,
        side: m.side,
      });

      // Ensure baseColor textures show correct colors (srgb).
      if (base.map) {
        base.map.colorSpace = THREE.SRGBColorSpace;
        base.map.needsUpdate = true;
      }

      // Skinned meshes need skinning enabled on the material.
      if (obj.isSkinnedMesh) base.skinning = true;

      if (typeof m.alphaTest === 'number') base.alphaTest = m.alphaTest;
      base.depthWrite = m.depthWrite;
      base.depthTest = m.depthTest;

      return base;
    });

    if (!changed) return;

    obj.material = Array.isArray(obj.material) ? nextMats : nextMats[0];
  });
}

function disposeCurrentVrm() {
  if (!vrmRenderState.scene) return;
  if (!vrmRenderState.currentVrm) return;

  try {
    vrmRenderState.scene.remove(vrmRenderState.currentVrm.scene);
    // Dispose GPU resources as much as possible.
    VRMUtils.deepDispose(vrmRenderState.currentVrm.scene);
  } catch (e) {
    console.warn('[VRM Pet] Failed disposing VRM', e);
  }

  vrmRenderState.currentVrm = null;
  vrmRenderState.currentUrl = '';
}

function resizeRendererToOverlay(overlayEl) {
  const stage = overlayEl.querySelector('.vrm-pet-stage');
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
    const stage = overlayEl.querySelector('.vrm-pet-stage');
    if (!stage) throw new Error('Overlay stage not found');

    // Prefer WebGL2 (VRMs are usually skinned; Three r161 skinning shaders require WebGL2 for bone textures).
    const canvas = document.createElement('canvas');
    const context =
      canvas.getContext('webgl2', { alpha: true, antialias: true, premultipliedAlpha: false }) ||
      canvas.getContext('webgl', { alpha: true, antialias: true, premultipliedAlpha: false }) ||
      canvas.getContext('experimental-webgl', { alpha: true, antialias: true, premultipliedAlpha: false });
    if (!context) throw new Error('WebGL not supported');

    const renderer = new THREE.WebGLRenderer({ canvas, context, antialias: true, alpha: true });
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.NoToneMapping;
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.setClearColor(0x000000, 0);
    stage.appendChild(renderer.domElement);

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(30, 1, 0.01, 1000);
    camera.position.set(0, 1.4, 2.2);

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
    vrmRenderState.resizeObserver = new ResizeObserver(() => resizeRendererToOverlay(overlayEl));
    vrmRenderState.resizeObserver.observe(overlayEl);

    startRenderLoop();
  })();

  return vrmRenderState.initPromise;
}

function startRenderLoop() {
  if (vrmRenderState.rafId) return;
  if (!vrmRenderState.renderer || !vrmRenderState.scene || !vrmRenderState.camera || !vrmRenderState.clock) return;

  const tick = () => {
    vrmRenderState.rafId = requestAnimationFrame(tick);
    const delta = vrmRenderState.clock.getDelta();
    if (vrmRenderState.currentVrm) {
      try {
        vrmRenderState.currentVrm.update(delta);
      } catch (_) {}
    }
    vrmRenderState.renderer.render(vrmRenderState.scene, vrmRenderState.camera);
  };

  vrmRenderState.rafId = requestAnimationFrame(tick);
}

function fitCameraToObject(object3d) {
  if (!vrmRenderState.camera) return;

  const box = new THREE.Box3().setFromObject(object3d);
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());

  // Recenter the model to origin for stable camera/lighting.
  object3d.position.sub(center);

  const maxDim = Math.max(size.x, size.y, size.z) || 1;
  const camZ = maxDim * 1.6;
  vrmRenderState.camera.near = Math.max(0.01, camZ / 100);
  vrmRenderState.camera.far = camZ * 100;
  vrmRenderState.camera.position.set(0, maxDim * 0.15, camZ);
  vrmRenderState.camera.lookAt(0, maxDim * 0.12, 0);
  vrmRenderState.camera.updateProjectionMatrix();
}

async function loadVrmFromUrl(url) {
  const overlayEl = document.getElementById('vrm-pet-overlay');
  if (!overlayEl) return;

  await ensureRenderer(overlayEl);

  const normalizedUrl = String(url || '').trim();
  if (!normalizedUrl) {
    disposeCurrentVrm();
    setHint('当前角色未绑定 VRM\n可在设置里上传并绑定');
    return;
  }

  if (normalizedUrl === vrmRenderState.currentUrl) {
    // Already loaded.
    setHint('');
    return;
  }

  // Cancel previous load attempts (best-effort).
  const token = ++vrmRenderState.loadingToken;

  setHint('正在加载 VRM…');
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
          if (!vrm) throw new Error('Not a VRM (missing gltf.userData.vrm)');

          // Optimize and normalize orientation.
          VRMUtils.removeUnnecessaryJoints(vrm.scene);
          try {
            VRMUtils.removeUnnecessaryVertices(vrm.scene);
          } catch (_) {}
          VRMUtils.rotateVRM0(vrm);

          // Workaround: our vendored three-vrm MToon shaders are not compatible with Three r161.
          // Replace them before the scene is rendered.
          replaceMToonMaterialsWithStandard(vrm.scene);

          vrmRenderState.scene.add(vrm.scene);
          vrmRenderState.currentVrm = vrm;
          vrmRenderState.currentUrl = normalizedUrl;
          fitCameraToObject(vrm.scene);
          setHint('');
          log('VRM loaded', normalizedUrl);
        } catch (e) {
          console.error('[VRM Pet] VRM init failed', e);
          setHint(`模型初始化失败：${e instanceof Error ? e.message : String(e)}`);
        }
        resolve();
      },
      undefined,
      (err) => {
        if (token !== vrmRenderState.loadingToken) return resolve();
        console.error('[VRM Pet] VRM load failed', err);
        setHint('加载失败：请确认 VRM 已上传成功且路径可访问');
        resolve();
      },
    );
  });
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
                <input type="file" id="${MODULE_NAME}_file" accept=".vrm" style="display:none" />
                <button class="menu_button" id="${MODULE_NAME}_select_btn">选择 VRM 并上传</button>
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

function refreshSelectedFileText() {
  const el = document.getElementById(`${MODULE_NAME}_selected`);
  if (!el) return;
  const fileInput = /** @type {HTMLInputElement|null} */ (document.getElementById(`${MODULE_NAME}_file`));
  const file = fileInput?.files?.[0];
  el.textContent = file ? `已选择文件：${file.name} (${Math.round(file.size / 1024 / 1024)}MB)` : '未选择文件。';
}

function saveSettings() {
  const ctx = getContext();
  ctx.extensionSettings[MODULE_NAME] = pluginConfig;
  ctx.saveSettingsDebounced();
}

async function handleUploadSelectedFile() {
  const fileInput = /** @type {HTMLInputElement|null} */ (document.getElementById(`${MODULE_NAME}_file`));
  const file = fileInput?.files?.[0];
  if (!file) {
    // More convenient UX: clicking "upload" without selecting triggers file picker.
    fileInput?.click();
    toastr?.warning?.('请选择一个 .vrm 文件', 'VRM Pet');
    return;
  }

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
  loadVrmForCurrentCharacter().catch(() => {});
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

    // Auto-upload after file picked (button click opens the picker).
    if (t.id === `${MODULE_NAME}_file`) {
      refreshSelectedFileText();
      handleUploadSelectedFile().catch((err) => {
        const msg = err instanceof Error ? err.message : String(err);
        console.error('[VRM Pet] Upload failed', err);
        toastr?.error?.(msg, 'VRM Pet');
      });
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

    if (t.id === `${MODULE_NAME}_select_btn`) {
      e.preventDefault();
      const fileInput = /** @type {HTMLInputElement|null} */ (document.getElementById(`${MODULE_NAME}_file`));
      fileInput?.click();
      return;
    }

    if (t.id === `${MODULE_NAME}_upload_btn`) {
      e.preventDefault();
      try {
        await handleUploadSelectedFile();
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
      loadVrmForCurrentCharacter().catch(() => {});
    });
  }
}

async function loadVrmForCurrentCharacter() {
  const character = getCurrentCharacter();
  const ext = character ? getCharacterExtensionData(character) : null;
  const url = ext?.vrm?.url || '';
  await loadVrmFromUrl(url);
}

function init() {
  initConfig();
  createSettingsInterface();
  refreshSelectedFileText();
  ensureOverlay();
  bindCharacterChangeRefresh();
  loadVrmForCurrentCharacter().catch(() => {});
  log('Initialized');
}

$(document).ready(() => init());
