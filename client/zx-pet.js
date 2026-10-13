import * as THREE from './vendor/three.module.js';
import { GLTFLoader } from './vendor/loaders/GLTFLoader.js?v=20260905-002';

const STORAGE_KEY = 'zhixun_zx_pet_state_v1';
const PET_ASSET_VERSION = '20260908-004';
const MODEL_URL = `./assets/zx-pet/athena.glb?v=${PET_ASSET_VERSION}`;
const BASE_COLOR_URL = `./assets/zx-pet/athena-basecolor.png?v=${PET_ASSET_VERSION}`;
const METALLIC_ROUGHNESS_URL = `./assets/zx-pet/athena-metallic-roughness.png?v=${PET_ASSET_VERSION}`;
const FALLBACK_URL = `./assets/zx-pet/fallback.png?v=${PET_ASSET_VERSION}`;
const MODE_COPY = {
  beginner: { label: '新手模式', text: '将鼠标停留在系统区域时显示本地配置的引导内容。' },
  veteran: { label: '老手模式', text: '不主动显示提示，只在页面旁边安静陪伴。' },
};
const DEFAULT_STATE = { mode: 'beginner', mini: false, hidden: false };

let state = loadState();
let guideConfig = [];
let root;
let dialog;
let petInitStarted = false;
let modelReady = false;
let modelLoadFinished = false;
let renderHandle = 0;
let scene;
let camera;
let renderer;
let textureLoader;
let model;
let skeletonBones = [];
let restBonePose = new Map();
let waveArm;
let waveForearm;
let waveHand;
let otherArm;
let headBone;
const boneAxisZ = new THREE.Vector3(0, 0, 1);
const boneDelta = new THREE.Quaternion();
let baseModelY = 0;
let renderWidth = 0;
let renderHeight = 0;
let motion = 'idle';
let motionStarted = 0;
let guideHoverTarget = null;
let guideHoverShowTimer = 0;
let guideHoverHideTimer = 0;
const guideCycleIndexes = new Map();

function loadState() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
    const next = { ...DEFAULT_STATE, ...saved };
    if (!MODE_COPY[next.mode]) next.mode = 'beginner';
    delete next.left;
    delete next.top;
    return next;
  } catch (_) {
    return { ...DEFAULT_STATE };
  }
}

function saveState() {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch (_) {}
}

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
}

function currentRoute() {
  return (location.hash.replace(/^#\/?/, '').split('?')[0] || 'dashboard').split('/')[0];
}

function pageContext() {
  const app = document.querySelector('.zx-app');
  const activeNav = app?.querySelector('.zx-nav-item.active span')?.textContent?.trim() || currentRoute();
  const buttons = [...(app?.querySelectorAll('[data-action], [data-nav], [data-customer-tab], [data-knowledge-tab]') || [])]
    .map(item => item.textContent.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .slice(0, 14);
  return { route: currentRoute(), page: activeNav, controls: buttons };
}

function buildMarkup() {
  const mode = MODE_COPY[state.mode] || MODE_COPY.beginner;
  root = document.createElement('div');
  root.id = 'zxPetRoot';
  root.className = state.hidden ? 'zx-pet-hidden' : state.mini ? 'zx-pet-mini' : '';
  root.innerHTML = `
    <div class="zx-pet-dialog" id="zxPetDialog" role="dialog" aria-live="polite">
      <strong id="zxPetTitle">${mode.label}</strong>
      <span class="zx-pet-note" id="zxPetMessage">${mode.text}</span>
      <div class="zx-pet-mode-picker" id="zxPetModePicker">
        <button type="button" data-zx-pet-mode="beginner">新手</button>
        <button type="button" data-zx-pet-mode="veteran">老手</button>
      </div>
    </div>
    <div class="zx-pet-actions"><button type="button" id="zxPetMini" title="缩小桌宠" aria-label="缩小桌宠">−</button><button type="button" id="zxPetHide" title="隐藏桌宠" aria-label="隐藏桌宠">×</button></div>
    <button type="button" class="zx-pet-avatar" id="zxPetHandle" aria-label="志询 3D 桌宠"><img class="zx-pet-fallback" src="${FALLBACK_URL}" alt="志询小狐"><span class="zx-pet-loading" id="zxPetLoading" aria-label="正在加载"></span></button>`;
  document.body.appendChild(root);
  dialog = root.querySelector('#zxPetDialog');
  applyState();
  bindEvents();
}

function applyState() {
  if (!root) return;
  root.classList.toggle('zx-pet-mini', Boolean(state.mini));
  root.classList.toggle('zx-pet-hidden', Boolean(state.hidden));
  const mode = MODE_COPY[state.mode] || MODE_COPY.beginner;
  root.querySelector('#zxPetTitle').textContent = mode.label;
  root.querySelector('#zxPetMessage').textContent = mode.text;
  root.querySelector('#zxPetLoading').hidden = modelLoadFinished;
  root.querySelector('.zx-pet-fallback').hidden = modelReady;
  if (renderer) renderer.setAnimationLoop(state.hidden ? null : animate);
}

function showModePicker() {
  state.hidden = false;
  state.mini = false;
  saveState();
  applyState();
  dialog.querySelector('#zxPetTitle').textContent = '选择工作模式';
  dialog.querySelector('#zxPetMessage').textContent = '模式只改变交互方式，角色外观保持不变。';
  dialog.querySelector('#zxPetModePicker').style.display = 'flex';
  triggerMotion('wave');
}

function chooseMode(mode) {
  if (!MODE_COPY[mode]) return;
  state.mode = mode;
  state.hidden = false;
  state.mini = false;
  saveState();
  applyState();
  dialog.querySelector('#zxPetModePicker').style.display = 'none';
}

function showGuide(item) {
  if (state.mode !== 'beginner' || state.hidden || !item) return;
  state.hidden = false;
  state.mini = false;
  saveState();
  applyState();
  dialog.querySelector('#zxPetModePicker').style.display = 'none';
  dialog.querySelector('#zxPetTitle').textContent = item.title || '志询小狐';
  dialog.querySelector('#zxPetMessage').textContent = item.message || '';
  triggerMotion('wave');
}

function clearGuideHoverTimers() {
  clearTimeout(guideHoverShowTimer);
  clearTimeout(guideHoverHideTimer);
  guideHoverShowTimer = 0;
  guideHoverHideTimer = 0;
}

function resetGuideContent() {
  if (!dialog || state.mode !== 'beginner') return;
  const mode = MODE_COPY.beginner;
  dialog.querySelector('#zxPetTitle').textContent = mode.label;
  dialog.querySelector('#zxPetMessage').textContent = mode.text;
  dialog.querySelector('#zxPetModePicker').style.display = 'none';
}

function hideGuideAfterHover() {
  clearGuideHoverTimers();
  guideHoverTarget = null;
  resetGuideContent();
}

function guideArea(target) {
  return target?.closest?.('[data-action], [data-pet-guide-action], [data-nav], [data-customer-tab], [data-knowledge-tab], button, a, [role="button"]');
}

function bindGuideHover() {
  document.addEventListener('pointerover', event => {
    if (event.pointerType !== 'mouse' || event.target.closest?.('#zxPetRoot, #zxPetRestore')) return;
    const area = guideArea(event.target);
    if (!area || area.contains(event.relatedTarget)) return;
    const match = guideMatchForClick(area);
    if (!match.guides.length) return;
    clearGuideHoverTimers();
    guideHoverTarget = area;
    guideHoverShowTimer = window.setTimeout(() => {
      if (guideHoverTarget === area) showGuide(nextGuideForClick(area));
    }, 300);
  }, true);
  document.addEventListener('pointerout', event => {
    if (event.pointerType !== 'mouse') return;
    const area = guideArea(event.target);
    if (!area || area !== guideHoverTarget || area.contains(event.relatedTarget)) return;
    clearGuideHoverTimers();
    guideHoverHideTimer = window.setTimeout(hideGuideAfterHover, 300);
  }, true);
}

function guideMatchForClick(target) {
  const action = target.closest('[data-action]')?.dataset.action;
  const nav = target.closest('[data-nav]')?.dataset.nav;
  const customerTab = target.closest('[data-customer-tab]')?.dataset.customerTab;
  const knowledgeTab = target.closest('[data-knowledge-tab]')?.dataset.knowledgeTab;
  const customAction = target.closest('[data-pet-guide-action]')?.dataset.petGuideAction;
  if (!action && !customAction && !nav && !customerTab && !knowledgeTab && !target.closest('button, a, [role="button"]')) return { key: '', guides: [] };
  const key = action || customAction || (customerTab ? `customer-tab-${customerTab}` : knowledgeTab ? `knowledge-tab-${knowledgeTab}` : nav ? `nav-${nav}` : 'default');
  const route = currentRoute();
  const exact = guideConfig.filter(item => item.enabled !== false && item.route === route && item.action === key);
  const wildcard = guideConfig.filter(item => item.enabled !== false && item.route === '*' && item.action === key);
  const fallback = guideConfig.filter(item => item.enabled !== false && item.route === '*' && item.action === 'default');
  return { key: `${route}:${key}`, guides: exact.length ? exact : wildcard.length ? wildcard : fallback };
}

function nextGuideForClick(target) {
  const match = guideMatchForClick(target);
  if (!match.guides.length) return null;
  const index = guideCycleIndexes.get(match.key) || 0;
  guideCycleIndexes.set(match.key, (index + 1) % match.guides.length);
  return match.guides[index % match.guides.length];
}

function guideForClick(target) {
  return guideMatchForClick(target).guides[0] || null;
}

function bindEvents() {
  const handle = root.querySelector('#zxPetHandle');
  handle.addEventListener('click', showModePicker);
  root.querySelector('#zxPetMini').addEventListener('click', () => { state.mini = !state.mini; saveState(); applyState(); requestAnimationFrame(() => applyState()); });
  root.querySelector('#zxPetHide').addEventListener('click', () => { state.hidden = true; saveState(); applyState(); showRestore(); });
  root.querySelectorAll('[data-zx-pet-mode]').forEach(button => button.addEventListener('click', () => chooseMode(button.dataset.zxPetMode)));
  document.addEventListener('click', event => {
    if (event.target.closest('#zxPetRoot, #zxPetRestore')) return;
    if (window.matchMedia?.('(hover: hover) and (pointer: fine)').matches) return;
    const guide = nextGuideForClick(event.target);
    if (guide) showGuide(guide);
  }, true);
  bindGuideHover();
  addEventListener('resize', resizeRenderer);
}

function showRestore() {
  let button = document.querySelector('#zxPetRestore');
  if (!button) { button = document.createElement('button'); button.id = 'zxPetRestore'; button.className = 'zx-pet-restore'; button.type = 'button'; button.textContent = '显示桌宠'; document.body.appendChild(button); button.addEventListener('click', () => { state.hidden = false; state.mini = false; saveState(); applyState(); button.classList.remove('zx-pet-visible'); }); }
  button.classList.add('zx-pet-visible');
}

function setupThree() {
  const canvasHost = root.querySelector('#zxPetHandle');
  scene = new THREE.Scene();
  camera = new THREE.PerspectiveCamera(26, 1, 0.01, 1000);
  camera.position.set(0, 0.72, 8.4);
  camera.lookAt(0, 0.4, 0);
  renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'high-performance' });
  // Keep the small fixed canvas sharp on Retina and standard displays.
  renderer.setPixelRatio(Math.min(Math.max(devicePixelRatio, 1) * 2, 3));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.NoToneMapping;
  renderer.toneMappingExposure = 1;
  renderer.setAnimationLoop(animate);
  canvasHost.appendChild(renderer.domElement);
  textureLoader = new THREE.TextureLoader();
  scene.add(new THREE.HemisphereLight(0xf7fbff, 0x7891ab, 1.35));
  const key = new THREE.DirectionalLight(0xffffff, 1.75); key.position.set(3, 5, 5); scene.add(key);
  const fill = new THREE.DirectionalLight(0xbfdcff, 0.9); fill.position.set(-4, 2.5, 4); scene.add(fill);
  const rim = new THREE.DirectionalLight(0x65b7ff, 0.6); rim.position.set(-3, 2, -4); scene.add(rim);
  resizeRenderer();
  const finishModelFallback = error => {
    if (error) console.warn('ZX pet model unavailable; using fallback image', error);
    modelReady = false;
    modelLoadFinished = true;
    applyState();
  };
  const loadModel = () => new GLTFLoader().load(MODEL_URL, gltf => {
    model = gltf.scene;
    const box = new THREE.Box3().setFromObject(model);
    const size = box.getSize(new THREE.Vector3());
    const center = box.getCenter(new THREE.Vector3());
    model.position.sub(center);
    model.position.y -= size.y * 0.12;
    model.scale.setScalar(2.85 / Math.max(size.x, size.y, size.z));
    baseModelY = model.position.y;
    const materials = [];
    model.traverse(object => {
      if (object.isMesh) {
        object.castShadow = false;
        object.frustumCulled = false;
        const materialList = Array.isArray(object.material) ? object.material : [object.material];
        materialList.filter(Boolean).forEach(material => {
          // The embedded textures in this model fail to decode reliably in
          // the browser, so the same GLB textures are attached below from
          // stable static assets instead.
          material.map = null;
          material.metalnessMap = null;
          material.roughnessMap = null;
          if ('metalness' in material) material.metalness = Math.min(material.metalness, 0.28);
          if ('roughness' in material) material.roughness = Math.max(material.roughness, 0.72);
          if (material.emissive) {
            material.emissive.set(0x102d52);
            material.emissiveIntensity = 0.12;
          }
          material.needsUpdate = true;
          if (!materials.includes(material)) materials.push(material);
        });
      }
      if (object.isBone) skeletonBones.push(object);
    });
    captureBonePose();
    scene.add(model);
    textureLoader.load(BASE_COLOR_URL, texture => {
      texture.flipY = false;
      texture.colorSpace = THREE.SRGBColorSpace;
      texture.anisotropy = renderer.capabilities.getMaxAnisotropy();
      texture.minFilter = THREE.LinearMipmapLinearFilter;
      texture.magFilter = THREE.LinearFilter;
      materials.forEach(material => { material.map = texture; material.needsUpdate = true; });
      modelReady = true;
      modelLoadFinished = true;
      applyState();
    }, undefined, error => {
      console.error('ZX pet base color texture failed to load', error);
      modelReady = true;
      modelLoadFinished = true;
      applyState();
    });
    textureLoader.load(METALLIC_ROUGHNESS_URL, texture => {
      texture.flipY = false;
      texture.colorSpace = THREE.NoColorSpace;
      materials.forEach(material => {
        material.metalnessMap = texture;
        material.roughnessMap = texture;
        material.needsUpdate = true;
      });
    }, undefined, error => console.warn('ZX pet metallic roughness texture failed to load', error));
  }, undefined, finishModelFallback);
  fetch(MODEL_URL, { method: 'HEAD', cache: 'no-store' }).then(response => {
    if (!response.ok) { finishModelFallback(); return; }
    loadModel();
  }).catch(finishModelFallback);
}

function resizeRenderer() {
  if (!renderer || !root) return;
  const box = root.querySelector('#zxPetHandle').getBoundingClientRect();
  const width = Math.max(1, Math.round(box.width)); const height = Math.max(1, Math.round(box.height));
  if (width === renderWidth && height === renderHeight) return;
  renderWidth = width; renderHeight = height;
  renderer.setSize(width, height, false); camera.aspect = width / height; camera.updateProjectionMatrix();
}

function triggerMotion(name) {
  motion = name;
  motionStarted = performance.now() / 1000;
}

function captureBonePose() {
  restBonePose = new Map(skeletonBones.map(bone => [bone, {
    position: bone.position.clone(),
    quaternion: bone.quaternion.clone(),
    scale: bone.scale.clone(),
  }]));
  waveArm = model.getObjectByName('Bone_006') || null;
  waveForearm = model.getObjectByName('Bone_005') || null;
  waveHand = model.getObjectByName('Bone_003') || null;
  otherArm = model.getObjectByName('Bone_011') || null;
  headBone = model.getObjectByName('Bone_025') || null;
}

function restoreBonePose() {
  restBonePose.forEach((pose, bone) => {
    bone.position.copy(pose.position);
    bone.quaternion.copy(pose.quaternion);
    bone.scale.copy(pose.scale);
  });
}

function rotateBoneFromRest(bone, axis, angle) {
  const pose = restBonePose.get(bone);
  if (!bone || !pose) return;
  bone.quaternion.copy(pose.quaternion);
  boneDelta.setFromAxisAngle(axis, angle);
  bone.quaternion.multiply(boneDelta);
}

function animate(time) {
  const seconds = time / 1000;
  if (model && root && !state.hidden) {
    const idle = Math.sin(seconds * 1.8);
    restoreBonePose();
    model.rotation.y = Math.sin(seconds * 0.45) * 0.06;
    const elapsed = seconds - motionStarted;
    model.position.y = baseModelY + idle * 0.006;
    const armWave = Math.sin(elapsed * 8) * 0.11;
    if (motion === 'wave' && elapsed < 1.2) {
      rotateBoneFromRest(waveArm, boneAxisZ, 0.16 + armWave);
      rotateBoneFromRest(waveForearm, boneAxisZ, -0.22 - armWave * 0.8);
      rotateBoneFromRest(waveHand, boneAxisZ, armWave * 0.55);
    } else if (motion === 'think' && elapsed < 1.6) {
      rotateBoneFromRest(headBone, boneAxisZ, Math.sin(elapsed * 4) * 0.045);
      model.rotation.y += Math.sin(elapsed * 4) * 0.04;
    } else if (motion === 'cheer' && elapsed < 1.1) {
      const cheer = Math.abs(Math.sin(elapsed * 8));
      rotateBoneFromRest(waveArm, boneAxisZ, -0.2 - cheer * 0.18);
      rotateBoneFromRest(otherArm, boneAxisZ, 0.2 + cheer * 0.18);
      model.position.y = baseModelY + cheer * 0.06;
    } else {
      motion = 'idle';
    }
  }
  if (renderer && scene && camera) renderer.render(scene, camera);
}

async function loadConfig() {
  try { const response = await fetch(`./assets/zx-pet/guide-config.json?v=${PET_ASSET_VERSION}`); guideConfig = normalizeGuideConfig(await response.json()); } catch (_) { guideConfig = []; }
}

function normalizeGuideConfig(values) {
  return (Array.isArray(values) ? values : []).map((item, index) => ({
    id: String(item?.id || `pet-guide-${index}`),
    route: String(item?.route || '*').trim() || '*',
    action: String(item?.action || 'default').trim() || 'default',
    title: String(item?.title || '志询小狐').trim() || '志询小狐',
    message: String(item?.message || '').trim(),
    mode: 'beginner',
    enabled: item?.enabled !== false,
    sortOrder: Number(item?.sortOrder ?? index),
  })).filter(item => item.message).sort((a, b) => a.sortOrder - b.sortOrder);
}

function setGuideConfig(nextConfig) {
  guideConfig = normalizeGuideConfig(nextConfig);
  guideCycleIndexes.clear();
}

addEventListener('zx-pet-config-updated', event => setGuideConfig(event.detail));
window.ZhiXunPet = { setGuideConfig };

async function init() {
  await loadConfig();
  if (window.ZhiXunPetConfig) setGuideConfig(window.ZhiXunPetConfig);
  buildMarkup();
  setupThree();
  if (state.hidden) showRestore();
}

function waitForApp() {
  let observer = null;
  const start = () => {
    if (petInitStarted || !document.querySelector('.zx-app')) return;
    petInitStarted = true;
    observer?.disconnect();
    init();
  };
  if (document.querySelector('.zx-app')) { start(); return; }
  observer = new MutationObserver(() => {
    start();
  });
  const target = document.body || document.documentElement;
  if (target && typeof target.nodeType === 'number') {
    try {
      observer.observe(target, { childList: true, subtree: true });
    } catch (error) {
      observer.disconnect();
      document.addEventListener('DOMContentLoaded', waitForApp, { once: true });
    }
  } else {
    document.addEventListener('DOMContentLoaded', waitForApp, { once: true });
  }
}

waitForApp();
